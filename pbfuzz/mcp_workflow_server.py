#!/usr/bin/env python3
"""
MCP Server for Workflow State Management

Provides type-safe read/write operations for workflow_state.md with:
- Atomic updates
- Gatekeeper validation  
- Phase transition enforcement
- Memory data modification permissions

Available tools:
- write_workflow_block: Write JSON content to specific workflow blocks
- transition_phase: Transition to next phase with validation
- check_phase_completion: Check if current phase tasks are completed
"""

import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from schemas import (
    FuzzPlan,
    WorkflowPhase,
    BugPredicate,
    Precondition,
    RootCause,
    TriggerPlan,
    Breakpoint,
    BatchPlanEntry,
    WorkflowMetrics,
    BuildInfo,
    GreenFeedbackEntry,
)
from pydantic import ValidationError


# ========== Helper Functions ==========

def _camel_to_upper_snake(name: str) -> str:
    """State -> STATE, ParameterSpace -> PARAMETER_SPACE."""
    out = []
    for i, c in enumerate(name):
        if c.isupper() and i != 0 and (not name[i - 1].isupper()):
            out.append("_")
        out.append(c.upper())
    return "".join(out)


def _block_tag(block_name: str) -> str:
    return _camel_to_upper_snake(block_name)


def _find_dynamic_segment(content: str, block_name: str) -> Tuple[int, int, str, str]:
    """Return (start_idx, end_idx, start_marker, end_marker) for DYNAMIC section."""
    tag = _block_tag(block_name)
    start_marker = f"<!-- DYNAMIC:{tag}:START -->"
    end_marker = f"<!-- DYNAMIC:{tag}:END -->"

    i = content.find(start_marker)
    if i == -1:
        raise ValueError(f"DYNAMIC section start not found for {block_name}: {start_marker}")
    j = content.find(end_marker, i)
    if j == -1:
        raise ValueError(f"DYNAMIC section end not found for {block_name}: {end_marker}")
    j_end = j + len(end_marker)
    return i, j_end, start_marker, end_marker


def _extract_json_in_segment(segment: str) -> Optional[str]:
    """Extract first fenced ```json ... ``` block."""
    start = segment.find("```json")
    if start == -1:
        return None
    start_content = start + len("```json")
    end = segment.find("```", start_content)
    if end == -1:
        raise ValueError("Unclosed ```json fenced block")
    return segment[start_content:end].strip()


def _replace_json_in_segment(segment: str, new_json_str: str) -> str:
    """Replace content inside ```json ... ``` block."""
    start = segment.find("```json")
    if start == -1:
        return segment
    start_content = start + len("```json")
    end = segment.find("```", start_content)
    if end == -1:
        raise ValueError("Unclosed ```json fenced block")
    
    prefix = segment[:start_content]
    suffix = segment[end:]
    if not prefix.endswith("\n"):
        prefix += "\n"
    body = new_json_str
    if not body.endswith("\n"):
        body += "\n"
    return prefix + body + suffix


def parse_json_block(content: str, block_name: str) -> Any:
    """Parse JSON from DYNAMIC section."""
    try:
        i, j, _, _ = _find_dynamic_segment(content, block_name)
        segment = content[i:j]
    except ValueError:
        return {}

    raw = _extract_json_in_segment(segment)
    if raw is None:
        return {}

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def replace_json_block(content: str, block_name: str, data: Any) -> str:
    """Replace JSON in DYNAMIC section."""
    try:
        i, j, _, _ = _find_dynamic_segment(content, block_name)
    except ValueError:
        return content

    segment = content[i:j]
    json_str = json.dumps(data, indent=2, ensure_ascii=False)
    try:
        new_segment = _replace_json_in_segment(segment, json_str)
    except ValueError:
        return content

    return content[:i] + new_segment + content[j:]


def _atomic_write(path: Path, data: str) -> None:
    """Atomic file write."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


# ========== Phase Gatekeeper Functions ==========

# Centralized phase transition rules (single source of truth)
PHASE_TRANSITIONS = {
    WorkflowPhase.INIT: [WorkflowPhase.PLAN],
    WorkflowPhase.PLAN: [WorkflowPhase.IMPLEMENT],
    WorkflowPhase.IMPLEMENT: [WorkflowPhase.EXECUTE],
    WorkflowPhase.EXECUTE: [WorkflowPhase.REFLECT, WorkflowPhase.SUCCESS],
    WorkflowPhase.REFLECT: [WorkflowPhase.PLAN],
    WorkflowPhase.SUCCESS: [],  # Terminal phase - no transitions allowed
}


def get_phase_info(phase: str) -> Dict[str, Any]:
    """Get phase information including rules and allowed transitions."""
    phase_data = {
        "INIT": {
            "rules": ["R-IN1", "R-IN2", "R-IN3", "R-IN4", "R-IN5", "R-IN6", "R-IN7"],
            "description": "Environment setup - extract sources, build target, static metadata",
        },
        "PLAN": {
            "rules": ["R-PL1", "R-PL2", "R-PL3", "R-PL4", "R-PL5", "R-PL6", "R-PL7", "R-PL8"],
            "description": "Planning phase - analyze target, write BugPredicates, Preconditions, RootCauses, TriggerPlans"
        },
        "IMPLEMENT": {
            "rules": ["R-IM1", "R-IM2", "R-IM3", "R-IM4", "R-IM5"],
            "description": "Implementation phase - convert TriggerPlans to ParameterSpace and FuzzPlan"
        },
        "EXECUTE": {
            "rules": ["R-EX1", "R-EX2", "R-EX3", "R-EX4", "R-EX5"],
            "description": "Execution phase - run fuzzing and update Metrics"
        },
        "REFLECT": {
            "rules": ["R-RF1", "R-RF2", "R-RF3", "R-RF4", "R-RF5"],
            "description": "Reflection phase - analyze test failures (read-only)"
        },
        "SUCCESS": {
            "rules": [],
            "description": "Success phase - PoC found"
        }
    }
    
    return phase_data.get(phase, {
        "rules": [],
        "description": "Unknown phase"
    })


def get_allowed_next_phases(current_phase: str) -> List[str]:
    """Get list of allowed next phases from current phase."""
    try:
        phase_enum = WorkflowPhase(current_phase)
        next_phases = PHASE_TRANSITIONS.get(phase_enum, [])
        return [p.value for p in next_phases]
    except ValueError:
        return []


def validate_phase_transition(current_phase: str, new_phase: str) -> bool:
    """Validate if phase transition is allowed."""
    try:
        current = WorkflowPhase(current_phase)
        new = WorkflowPhase(new_phase)
    except ValueError:
        return False
    
    return new in PHASE_TRANSITIONS.get(current, [])


def check_data_modification_permission(phase: str, data_block: str) -> bool:
    """Check if data block can be modified in current phase."""
    try:
        phase_enum = WorkflowPhase(phase)
    except ValueError:
        return False
    
    permissions = {
        WorkflowPhase.INIT: {'BuildInfo', 'Metrics'},
        WorkflowPhase.PLAN: {'BugPredicates', 'Preconditions', 'RootCauses', 'TriggerPlans', 'BuildInfo'},
        WorkflowPhase.IMPLEMENT: {'ParameterSpace', 'FuzzPlan', 'Breakpoints'},
        WorkflowPhase.EXECUTE: {'Metrics', 'ParameterSpace'},
        WorkflowPhase.REFLECT: set(),  # Read-only phase
        WorkflowPhase.SUCCESS: set(),  # Terminal phase - no modifications allowed
    }
    
    return data_block in permissions.get(phase_enum, set())


def check_init_phase_completion(
    workflow_content: str, source_code_dir: Optional[Path] = None
) -> Tuple[bool, List[str]]:
    """INIT phase complete when build metadata exists, binary is built, and dirty is false."""
    missing_tasks: List[str] = []
    bi = parse_json_block(workflow_content, "BuildInfo")
    if not isinstance(bi, dict):
        missing_tasks.append("R-IN3: BuildInfo block missing or invalid")
        return False, missing_tasks
    if not str(bi.get("build_cmd", "")).strip():
        missing_tasks.append("R-IN3: build_cmd empty in BuildInfo")
    bp = str(bi.get("binary_path", "")).strip()
    if not bp:
        missing_tasks.append("R-IN3: binary_path empty")
    if bi.get("dirty", True):
        missing_tasks.append("R-IN3: BuildInfo.dirty must be false after successful build")
    if source_code_dir is not None and bp:
        p = Path(bp)
        if not p.is_absolute():
            p = source_code_dir / p
        if not p.is_file():
            missing_tasks.append(f"R-IN3: binary not found at {p}")
    return len(missing_tasks) == 0, missing_tasks


def check_plan_phase_completion(workflow_content: str) -> Tuple[bool, List[str]]:
    """Check if PLAN phase tasks are completed."""
    missing_tasks = []
    
    # R-PL2: Must write/update BugPredicates
    bug_predicates = parse_json_block(workflow_content, "BugPredicates")
    if not bug_predicates or (isinstance(bug_predicates, list) and len(bug_predicates) == 0):
        missing_tasks.append("R-PL2: BugPredicates is empty - must extract based on Target Locations")
    
    # R-PL3: Must write/update Preconditions, RootCauses, TriggerPlans
    preconditions = parse_json_block(workflow_content, "Preconditions")
    if not preconditions or (isinstance(preconditions, list) and len(preconditions) == 0):
        missing_tasks.append("R-PL3: Preconditions is empty - must define based on Source Code analysis")
    
    root_causes = parse_json_block(workflow_content, "RootCauses")
    if not root_causes or (isinstance(root_causes, list) and len(root_causes) == 0):
        missing_tasks.append("R-PL3: No RootCauses defined")
    
    trigger_plans = parse_json_block(workflow_content, "TriggerPlans")
    if isinstance(trigger_plans, list):
        valid_plans = [p for p in trigger_plans 
                      if isinstance(p, dict) and p.get('complexity', 0) >= 1 and p.get('complexity', 0) <= 10]
        if not valid_plans:
            missing_tasks.append("R-PL3: No TriggerPlan with valid complexity (1-10)")
    else:
        missing_tasks.append("R-PL3: TriggerPlans must be a list")
    
    return len(missing_tasks) == 0, missing_tasks


def check_implement_phase_completion(workflow_content: str) -> Tuple[bool, List[str]]:
    """Check if IMPLEMENT phase tasks are completed."""
    missing_tasks = []
    
    fuzz_plan = parse_json_block(workflow_content, "FuzzPlan")
    breakpoints = parse_json_block(workflow_content, "Breakpoints")
    
    if not fuzz_plan or (isinstance(fuzz_plan, list) and len(fuzz_plan) == 0):
        missing_tasks.append("R-IM3: FuzzPlan is empty")
    elif isinstance(fuzz_plan, list) and len(fuzz_plan) < 5:
        missing_tasks.append("R-IM3: FuzzPlan must have 5-10 concrete tests")
    
    if not breakpoints or (isinstance(breakpoints, list) and len(breakpoints) == 0):
        missing_tasks.append("R-IM4: No breakpoints defined")
    
    return len(missing_tasks) == 0, missing_tasks


def check_reflect_phase_completion(workflow_content: str) -> Tuple[bool, List[str]]:
    """Check if REFLECT phase tasks are completed."""
    missing_tasks = []

    return len(missing_tasks) == 0, missing_tasks


def check_execute_phase_completion(workflow_content: str, workflow_timestamp: Optional[str] = None) -> Tuple[bool, List[str]]:
    """Check if EXECUTE phase tasks are completed (Metrics must be updated).
    
    Args:
        workflow_content: The workflow file content
        workflow_timestamp: If provided, check that metrics were updated with this timestamp
                          (verifies agent actually wrote to Metrics, not just old data)
    """
    missing_tasks = []
    
    metrics = parse_json_block(workflow_content, "Metrics")
    
    if not isinstance(metrics, dict):
        missing_tasks.append("Metrics block is missing or invalid")
    else:
        # Check if metrics were updated (last_updated should be present and not empty)
        last_updated = metrics.get('last_updated', '')
        if not last_updated:
            missing_tasks.append("Metrics must be updated (last_updated is empty)")
        elif last_updated == workflow_timestamp:
            # If we have an expected timestamp, verify the agent actually updated it
            missing_tasks.append("Metrics must be updated by agent in EXECUTE phase")
        
        # Check if at least one iteration was run
        if metrics.get('total_iterations', 0) == 0:
            missing_tasks.append("No fuzzing iterations recorded in Metrics")
    
    return len(missing_tasks) == 0, missing_tasks


def get_crashes_dir_from_config(output_dir: Optional[Path] = None) -> Optional[Path]:
    """Get crashes directory path from output_dir parameter.
    
    Args:
        output_dir: Output directory path (should be passed from launcher.py via command line args)
    
    Returns:
        Path to crashes directory if output_dir is provided, None otherwise
    """
    if output_dir:
        crashes_dir = output_dir / "crashes"
        return crashes_dir
    return None


def check_execute_phase_requirements(workflow_content: str, output_dir: Optional[Path] = None) -> Tuple[str, List[str]]:
    """Check EXECUTE phase requirements.
    
    Args:
        workflow_content: Content of workflow_state.md
        output_dir: Output directory path (should be passed from server instance)
    
    Returns:
        Tuple of (action, recommendations)
    """
    metrics = parse_json_block(workflow_content, "Metrics")
    recommendations = []
    
    if not isinstance(metrics, dict):
        return "CONTINUE", ["Metrics not properly formatted"]
    
    triggered_count = metrics.get('triggered_count', 0)
    last_reached_count = metrics.get('last_reached_count', 0)
    
    # Check if PoC was triggered
    has_poc = False
    if triggered_count > 0:
        crashes_dir = get_crashes_dir_from_config(output_dir)
        if crashes_dir and crashes_dir.exists():
            poc_files = list(crashes_dir.glob("poc_*"))
            if len(poc_files) > 0:
                has_poc = True
        if has_poc:
            return "SUCCESS", [f"PoC found - Follow rule R-RF3 in workflow_state.md (transition to SUCCESS)"]
        else:
            return "TRANSITION_TO_REFLECT", ["CRITICAL: You must follow RULE_FUZZ_TOOL"]
    
    # Check if target was reached in last fuzzing iteration
    if last_reached_count == 0:
        return "NEED_DEVIATION_ANALYSIS", [
            "Read workflow_state.md",
            "TRANSITION_TO_REFLECT",
            "Follow rule R-RF2, R-RF4, R-RF5"
        ]
    
    # Reached but not triggered
    if last_reached_count > 0 and triggered_count == 0:
        return "NEED_BACKWARD_ANALYSIS", [
            "Read workflow_state.md",
            "TRANSITION_TO_REFLECT",
            "Follow rule R-RF3, R-RF4, R-RF5"
        ]
    
    return "CONTINUE EXECUTE", ["Follow rule R-EX1 to R-EX5"]


def check_phase_completion_unified(workflow_content: str, phase: str) -> Tuple[bool, List[str]]:
    """
    Unified phase completion checker.
    
    Returns:
        - completed: bool - whether phase is complete
        - missing: List[str] - list of missing tasks
    """
    if phase == "INIT":
        completed, missing = check_init_phase_completion(workflow_content)
        return completed, missing
    if phase == "PLAN":
        completed, missing = check_plan_phase_completion(workflow_content)
        return completed, missing
    elif phase == "IMPLEMENT":
        completed, missing = check_implement_phase_completion(workflow_content)
        return completed, missing
    elif phase == "EXECUTE":
        completed, missing = check_execute_phase_completion(workflow_content)
        return completed, missing
    elif phase == "REFLECT":
        completed, missing = check_reflect_phase_completion(workflow_content)
        return completed, missing
    elif phase == "SUCCESS":
        # SUCCESS is a terminal phase - always complete (no further transitions)
        return True, []
    else:
        return False, [f"Unknown phase '{phase}'"]


# ========== MCP Server ==========

class MCPWorkflowServer:
    """MCP Server for workflow state management"""
    
    def __init__(self, output_dir: Optional[str] = None, source_code_dir: Optional[str] = None):
        self.server = Server("workflow-server")
        self.logger = logging.getLogger(__name__)
        self.source_code_dir = Path(source_code_dir) if source_code_dir else Path.cwd()
        self.workflow_file = self.source_code_dir / ".cursor" / "workflow_state.md"
        workflow_content = self._read_workflow_file()
        self.last_metrics_update = parse_json_block(workflow_content, "Metrics")['last_updated']
        self.output_dir = Path(output_dir) if output_dir else None
        
    def _read_workflow_file(self) -> str:
        """Read workflow state file content."""
        if not self.workflow_file.exists():
            raise FileNotFoundError(f"Workflow state file not found: {self.workflow_file}")
        return self.workflow_file.read_text(encoding="utf-8")
    
    def _write_workflow_file(self, content: str) -> None:
        """Write workflow state file with atomic operation."""
        _atomic_write(self.workflow_file, content)
    
    def _get_current_phase(self, content: str) -> str:
        """Get current phase from workflow content."""
        state = parse_json_block(content, "State")
        if isinstance(state, dict):
            return state.get('phase', 'PLAN')
        return 'PLAN'
    
    def _check_phase_completion_with_context(self, workflow_content: str, phase: str) -> Tuple[bool, List[str]]:
        """Check phase completion with server context.
        
        This wrapper allows us to pass server state to validation functions
        without changing the public API of check_phase_completion_unified.
        """
        if phase == "INIT":
            return check_init_phase_completion(workflow_content, self.source_code_dir)
        if phase == "EXECUTE":
            # For EXECUTE phase, pass the expected timestamp to verify agent actually updated
            return check_execute_phase_completion(workflow_content, self.last_metrics_update)
        else:
            # For other phases, use the standard unified checker
            return check_phase_completion_unified(workflow_content, phase)
    
    def setup_handlers(self):
        """Setup MCP request handlers"""
        
        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            """List available tools"""
            return [
                types.Tool(
                    name="write_workflow_block",
                    description=(
                        "Write JSON content to a specific workflow state block. "
                        "Enforce gatekeeper rules G-2. "
                        "IMPORTANT: Pass Python list/dict objects, NOT JSON strings."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "target_block": {
                                "type": "string",
                                "enum": ["BugPredicates", "Preconditions", "RootCauses", "ParameterSpace", 
                                        "TriggerPlans", "FuzzPlan", "Breakpoints", "Metrics"],
                                "description": "Target block name to write to"
                            },
                            "content_json": {
                                "description": (
                                    "Content to write as Python object (list or dict). REQUIRED SCHEMAS:\n\n"
                                    
                                    "BugPredicates (list): [{id: 'BP1', location: 'file.c:123', bug_condition: 'width > max_width'}]\n"
                                    "  - id: 'BP1', 'BP2', ... (must start with BP + number)\n"
                                    "  - location: 'file:line' format\n"
                                    "  - bug_condition: triggering condition from source code\n\n"
                                    
                                    "Preconditions (list): [{id: 'R1', statement: 'must parse header', status: 'unknown', evidence: [...], input_constraints: [...]}]\n"
                                    "  - id: 'R1', 'R2', ... (must start with R + number)\n"
                                    "  - statement: human-readable precondition\n"
                                    "  - status: 'verified'|'violated'|'unknown'|'impossible'\n"
                                    "  - evidence: list of strings\n"
                                    "  - input_constraints: list of strings (math expressions or natural language)\n\n"
                                    
                                    "RootCauses (list): [{id: 'RC1', description: '...', category: 'buffer_overflow', evidence: [...], input_constraints: [...], related_precondition_ids: ['R1']}]\n"
                                    "  - id: 'RC1', 'RC2', ... (must start with RC + number)\n"
                                    "  - category: 'buffer_overflow'|'heap_overflow'|'out_of_bounds_read'|'out_of_bounds_write'|'integer_overflow'|'type_confusion'|'race_condition'|'command_injection'|'use_after_free'|'double_free'|'null_pointer_dereference'|'uninitialized_memory'|'format_string'|'logic_error'\n"
                                    "  - evidence: list of strings\n"
                                    "  - input_constraints: list of strings\n"
                                    "  - related_precondition_ids: list of precondition IDs\n\n"
                                    
                                    "TriggerPlans (list): [{id: 'TP1', description: '...', route_description: '...', complexity: 3, status: 'pending', evidence: [...], precondition_ids: ['R1'], strategy: '...'}]\n"
                                    "  - id: 'TP1', 'TP2', ...\n"
                                    "  - complexity: 1-10 (1=easiest, 10=hardest)\n"
                                    "  - status: 'pending'|'in_progress'|'completed'|'failed'\n"
                                    "  - precondition_ids: list of precondition IDs\n\n"
                                    
                                    "ParameterSpace (dict): {param_name: {type: 'int_range', min: 0, max: 100}, ...}\n"
                                    "  Types: 'int_range' (min, max), 'float_range' (min, max), 'categorical' (values: [...]), 'bool', 'base_seed' (seed_file_path: '/abs/path')\n\n"
                                    
                                    "FuzzPlan (list): [{plan_description: 'Test TP1 strategy A', param1: value1, param2: value2, ...}]\n"
                                    "  - plan_description: required string\n"
                                    "  - Must include ALL parameters from ParameterSpace with concrete values\n"
                                    "  - All values must be within ParameterSpace ranges/constraints\n\n"
                                    
                                    "Breakpoints (list): [{location: '/abs/path/file.c:123', hit_limit: 10, inline_expr: ['var_name'], print_call_stack: false}]\n"
                                    "  - location: MUST be absolute path + line number ('full_file_abs_path:line')\n"
                                    "  - File must exist and be readable\n"
                                    "  - hit_limit: max hits (default 10)\n"
                                    "  - inline_expr: list of expressions to evaluate\n"
                                    "  - print_call_stack: boolean\n\n"
                                    
                                    "Metrics (dict): {total_iterations: 0, total_reached_count: 0, last_reached_count: 0, triggered_count: 0, timeout_count: 0, error_count: 0, last_updated: ''}\n"
                                    "  - All counts must be >= 0\n"
                                    "  - last_updated: auto-updated by server"
                                )
                            }
                        },
                        "required": ["target_block", "content_json"]
                    }
                ),
                types.Tool(
                    name="transition_phase",
                    description=(
                        "Transition workflow to next phase with validation. "
                        "Enforce phase gating rule RULE_FLOW"
                        "Update State block with new phase and Log entry."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "next_phase": {
                                "type": "string",
                                "enum": ["PLAN", "IMPLEMENT", "EXECUTE", "REFLECT", "SUCCESS"],
                                "description": "Next phase to transition to"
                            },
                            "status": {
                                "type": "string",
                                "description": "Status message for the new phase"
                            },
                            "current_task": {
                                "type": "string",
                                "description": "Current task description"
                            },
                            "next_action": {
                                "type": "string",
                                "description": "Next action to take"
                            }
                        },
                        "required": ["next_phase"]
                    }
                ),
                types.Tool(
                    name="check_phase_completion",
                    description=(
                        "Check if all tasks for the current phase are completed. "
                        "Automatically detects current phase from workflow state. "
                        "Returns completion status and list of missing tasks if incomplete."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False
                    }
                ),
                types.Tool(
                    name="get_current_phase",
                    description=(
                        "Get current workflow phase information including phase name, "
                        "applicable rule references, and next allowed phase(s)."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False
                    }
                )
            ]
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            """Handle tool calls"""
            
            try:
                if name == "write_workflow_block":
                    target_block = arguments.get("target_block")
                    content_json = arguments.get("content_json")
                    
                    if not target_block or content_json is None:
                        return [types.TextContent(
                            type="text",
                            text="Error: target_block and content_json are required"
                        )]
                    
                    # Handle potential double-encoding: if content_json is a JSON string, parse it first
                    # This ensures we always work with Python objects (list/dict) before json.dumps()
                    if isinstance(content_json, str):
                        try:
                            content_json = json.loads(content_json)
                        except json.JSONDecodeError as e:
                            return [types.TextContent(
                                type="text",
                                text=f"❌ **Invalid JSON string in content_json parameter:**\n\n{str(e)}\n\n"
                                     f"Pass Python objects (list/dict) directly, not JSON strings."
                            )]
                    
                    # Read current workflow
                    try:
                        workflow_content = self._read_workflow_file()
                    except FileNotFoundError as e:
                        return [types.TextContent(type="text", text=f"Error: {str(e)}")]
                    
                    # Get current phase
                    current_phase = self._get_current_phase(workflow_content)
                    
                    # Check data modification permission (G-2)
                    if not check_data_modification_permission(current_phase, target_block):
                        return [types.TextContent(
                            type="text",
                            text=f"🚫 **G-2 VIOLATION**: Cannot modify '{target_block}' in {current_phase} phase.\n\n"
                                 f"**Allowed modifications per phase:**\n"
                                 f"• INIT: BuildInfo, Metrics\n"
                                 f"• PLAN: BugPredicates, Preconditions, RootCauses, TriggerPlans, BuildInfo\n"
                                 f"• IMPLEMENT: ParameterSpace, FuzzPlan, Breakpoints\n"
                                 f"• EXECUTE: Metrics, ParameterSpace\n"
                                 f"• REFLECT: No data modifications allowed (read-only phase)"
                        )]
                    
                    # RULE_SAFE_UPDATE: Prevent accidental overwrites of incremental blocks
                    safe_update_blocks = {'Preconditions', 'RootCauses', 'TriggerPlans'}
                    if target_block in safe_update_blocks:
                        existing_data = parse_json_block(workflow_content, target_block)
                        
                        # Calculate sizes for comparison
                        existing_size = 0
                        if isinstance(existing_data, list):
                            existing_size = len(existing_data)
                        elif isinstance(existing_data, dict):
                            existing_size = len(existing_data)
                        
                        new_size = 0
                        if isinstance(content_json, list):
                            new_size = len(content_json)
                        elif isinstance(content_json, dict):
                            new_size = len(content_json)
                        
                        # Reject if new content is smaller than existing (likely accidental overwrite)
                        if existing_size > 0 and new_size < existing_size:
                            return [types.TextContent(
                                type="text",
                                text=f"🚫 **RULE_SAFE_UPDATE VIOLATION**: Cannot shrink '{target_block}' from {existing_size} to {new_size} items.\n\n"
                                     f"**This looks like an accidental overwrite!**\n\n"
                                     f"**Required Actions:**\n"
                                     f"• Read workflow_state.md to see existing {target_block}\n"
                                     f"• Follow RULE_SAFE_UPDATE and RULE_MEMORY: merge new items with existing items\n"
                                     f"**Tip:** Load existing data, add/update your items, then write complete data."
                            )]
                    
                    # Validate content structure with Pydantic schemas
                    try:
                        if target_block == "BugPredicates":
                            if isinstance(content_json, list):
                                [BugPredicate.model_validate(bp) for bp in content_json]
                        elif target_block == "Preconditions":
                            if isinstance(content_json, list):
                                [Precondition.model_validate(p) for p in content_json]
                        elif target_block == "RootCauses":
                            if isinstance(content_json, list):
                                [RootCause.model_validate(r) for r in content_json]
                        elif target_block == "TriggerPlans":
                            if isinstance(content_json, list):
                                [TriggerPlan.model_validate(t) for t in content_json]
                        elif target_block == "ParameterSpace":
                            if isinstance(content_json, dict):
                                # Validate ParameterSpace using FuzzPlan's parameter_space validator
                                FuzzPlan.model_validate({"parameter_space": content_json, "next_batch_plan": [], "breakpoints": []})
                        elif target_block == "FuzzPlan":
                            if isinstance(content_json, list):
                                # Validate FuzzPlan entries
                                [BatchPlanEntry.model_validate(b) for b in content_json]
                                
                                # Validate against ParameterSpace
                                param_space = parse_json_block(workflow_content, "ParameterSpace")
                                if not param_space or (isinstance(param_space, dict) and len(param_space) == 0):
                                    return [types.TextContent(
                                        type="text",
                                        text="❌ **FuzzPlan Validation Error:**\n\n"
                                             "ParameterSpace is empty. You must define ParameterSpace before creating FuzzPlan.\n\n"
                                             "**Required Actions:**\n"
                                             "• Use write_workflow_block to write ParameterSpace first\n"
                                             "• Then write FuzzPlan with all parameters from ParameterSpace"
                                    )]
                                
                                # Check that all parameter_space params appear in all FuzzPlan entries
                                missing_params_by_entry = []
                                for i, entry in enumerate(content_json):
                                    entry_dict = entry if isinstance(entry, dict) else {}
                                    missing = [p for p in param_space.keys() if p not in entry_dict]
                                    if missing:
                                        missing_params_by_entry.append((i, missing))
                                
                                if missing_params_by_entry:
                                    error_msg = "❌ **FuzzPlan Validation Error:**\n\n"
                                    error_msg += "All parameters from ParameterSpace must appear in EVERY FuzzPlan entry.\n\n"
                                    error_msg += f"**ParameterSpace defines:** {', '.join(param_space.keys())}\n\n"
                                    error_msg += "**Missing parameters in entries:**\n"
                                    for idx, missing in missing_params_by_entry:
                                        error_msg += f"• Entry {idx + 1}: missing {', '.join(missing)}\n"
                                    error_msg += f"\n**Fix:** Add missing parameters to each FuzzPlan entry."
                                    return [types.TextContent(type="text", text=error_msg)]
                        elif target_block == "Breakpoints":
                            if isinstance(content_json, list):
                                [Breakpoint.model_validate(b) for b in content_json]
                        elif target_block == "Metrics":
                            if isinstance(content_json, dict):
                                WorkflowMetrics.model_validate(content_json)
                        elif target_block == "BuildInfo":
                            if isinstance(content_json, dict):
                                BuildInfo.model_validate(content_json)
                        elif target_block == "GreenFeedbackHistory":
                            if isinstance(content_json, list):
                                [GreenFeedbackEntry.model_validate(x) for x in content_json]
                    except ValidationError as e:
                        error_msg = f"❌ **Validation Error for {target_block}:**\n\n"
                        for error in e.errors():
                            loc = " -> ".join(str(l) for l in error['loc'])
                            error_msg += f"• {loc}: {error['msg']}\n"
                        return [types.TextContent(type="text", text=error_msg)]
                    
                    # Auto-update metrics.last_updated if writing to Metrics
                    if target_block == "Metrics" and isinstance(content_json, dict):
                        self.last_metrics_update = content_json['last_updated']
                        content_json['last_updated'] = datetime.now().isoformat()
                    
                    # Write to workflow file
                    new_content = replace_json_block(workflow_content, target_block, content_json)
                    self._write_workflow_file(new_content)
                    
                    return [types.TextContent(
                        type="text",
                        text=f"✅ Successfully updated {target_block} in workflow_state.md"
                    )]
                
                elif name == "transition_phase":
                    next_phase = arguments.get("next_phase")
                    status = arguments.get("status", f"Transitioning to {next_phase}")
                    current_task = arguments.get("current_task", f"Working on {next_phase} phase")
                    next_action = arguments.get("next_action", f"Execute {next_phase} phase tasks")
                    
                    if not next_phase:
                        return [types.TextContent(
                            type="text",
                            text="Error: next_phase is required"
                        )]
                    
                    # Read current workflow
                    try:
                        workflow_content = self._read_workflow_file()
                    except FileNotFoundError as e:
                        return [types.TextContent(type="text", text=f"Error: {str(e)}")]
                    
                    # Get current phase
                    current_phase = self._get_current_phase(workflow_content)
                    
                    # Validate phase transition (G-1)
                    if not validate_phase_transition(current_phase, next_phase):
                        return [types.TextContent(
                            type="text",
                            text=f"🚫 **G-1 VIOLATION**: Invalid phase transition from {current_phase} to {next_phase}.\n\n"
                                 f"**Allowed transitions:**\n"
                                 f"• INIT → PLAN\n"
                                 f"• PLAN → IMPLEMENT\n"
                                 f"• IMPLEMENT → EXECUTE\n"
                                 f"• EXECUTE → REFLECT or SUCCESS\n"
                                 f"• REFLECT → PLAN"
                        )]
                    
                    # Check prerequisites for transition using context-aware checker
                    completed, missing = self._check_phase_completion_with_context(workflow_content, current_phase)
                    
                    if not completed:
                        error_msg = f"🚫 **Phase Transition Blocked**: {current_phase} phase incomplete.\n\n"
                        error_msg += f"**Missing tasks:**\n" + "\n".join(f"• {task}" for task in missing)
                        return [types.TextContent(type="text", text=error_msg)]
                    
                    # Special check for SUCCESS transition
                    if next_phase == "SUCCESS":
                        action, validate_recommendations = check_execute_phase_requirements(workflow_content, self.output_dir)
                        if action != "SUCCESS":
                            error_msg = f"🚫 **Phase Transition Blocked**: Cannot transition to SUCCESS.\n\n"
                            error_msg += f"**Validation Status:** {action}\n\n"
                            error_msg += f"**Required Actions:**\n" + "\n".join(f"• {r}" for r in validate_recommendations)
                            return [types.TextContent(type="text", text=error_msg)]
                    
                    # Update State block
                    state_data = {
                        "phase": next_phase,
                        "status": status,
                        "current_task": current_task,
                        "next_action": next_action,
                    }
                    
                    new_content = replace_json_block(workflow_content, "State", state_data)
                    self._write_workflow_file(new_content)
                    
                    if current_phase == "REFLECT":
                        self.last_metrics_update = parse_json_block(workflow_content, "Metrics")['last_updated']
                    
                    # Provide recommendations for new phase
                    recommendations = ""
                    if next_phase == "IMPLEMENT":
                        recommendations = "\n\n**IMPLEMENT Phase Actions:**\n"
                        recommendations += "• Read workflow_state.md rules R-IM1 through R-IM5\n"
                        recommendations += "• Convert TriggerPlans to concrete ParameterSpace\n"
                        recommendations += "• Generate FuzzPlan (5-10 tests) from TriggerPlans\n"
                        recommendations += "• Set Breakpoints at bug site + critical path nodes\n"
                    elif next_phase == "PLAN" and current_phase == "REFLECT":
                        # Transitioning from REFLECT back to PLAN - provide detailed recommendations
                        recommendations = "\n\n**Transitioning to PLAN based on REFLECT reasonings:**\n"
                    elif next_phase == "EXECUTE":
                        recommendations = "\n\n**EXECUTE Phase Actions:**\n"
                        recommendations += "• Read workflow_state.md rules R-EX1 through R-EX5\n"
                        recommendations += "• Use fuzz MCP tool with generator_code\n"
                        recommendations += "• Transition to REFLECT immediately after fuzz completion\n"
                    elif next_phase == "REFLECT":
                        # Track this update for validation
                        recommendations = "\n\n**REFLECT Phase Actions:**\n"
                        recommendations += "• Read workflow_state.md rules R-RF1 through R-RF5\n"
                        recommendations += "• Analyze why testcases failed to trigger bug\n"
                        recommendations += "• If triggered → SUCCESS; else → PLAN\n"
                    elif next_phase == "SUCCESS":
                        recommendations = "\n\n**🎉 SUCCESS Phase Reached!**\n"
                        recommendations += "• Please terminate the workflow\n"
                    
                    return [types.TextContent(
                        type="text",
                        text=f"✅ Successfully transitioned from {current_phase} to {next_phase}{recommendations}"
                    )]
                elif name == "check_phase_completion":
                    # Read current workflow
                    try:
                        workflow_content = self._read_workflow_file()
                    except FileNotFoundError as e:
                        return [types.TextContent(type="text", text=f"Error: {str(e)}")]
                    
                    # Get current phase from workflow content
                    phase = self._get_current_phase(workflow_content)
                    
                    # Check completion using context-aware checker
                    completed, missing = self._check_phase_completion_with_context(workflow_content, phase)
                    
                    # Handle EXECUTE phase with additional requirements check
                    if phase == "EXECUTE" and completed:
                        action, recommendations = check_execute_phase_requirements(workflow_content, self.output_dir)
                        if action == "SUCCESS":
                            return [types.TextContent(
                                type="text",
                                text=f"✅ **EXECUTE Complete - PoC Found!**\n\n" +
                                     "• Metrics updated ✓\n" +
                                     "• PoC verified ✓\n\n" +
                                     "**Next Step:**\n" +
                                     "\n".join(f"• {r}" for r in recommendations)
                            )]
                        else:
                            return [types.TextContent(
                                type="text",
                                text=f"✅ **EXECUTE Phase Complete** (Metrics updated)\n\n" +
                                     f"🔄 **Status:** {action}\n\n" +
                                     "\n".join(f"• {r}" for r in recommendations)
                            )]
                    
                    if completed:
                        return [types.TextContent(
                            type="text",
                            text=f"✅ **{phase} Phase Complete**\n\n"
                                 f"All required tasks are completed. Ready to transition to next phase."
                        )]
                    else:
                        return [types.TextContent(
                            type="text",
                            text=f"❌ **{phase} Phase Incomplete**\n\n"
                                 f"**Missing tasks:**\n" + "\n".join(f"• {task}" for task in missing)
                        )]
                
                elif name == "get_current_phase":
                    # Read current workflow
                    try:
                        workflow_content = self._read_workflow_file()
                    except FileNotFoundError as e:
                        return [types.TextContent(type="text", text=f"Error: {str(e)}")]
                    
                    # Get current phase
                    current_phase = self._get_current_phase(workflow_content)
                    
                    # Get phase info and allowed transitions using helper functions
                    phase_info = get_phase_info(current_phase)
                    next_phases = get_allowed_next_phases(current_phase)
                    
                    # Format response
                    result_text = f"📍 **Current Phase:** {current_phase}\n\n"
                    result_text += f"**Description:** {phase_info['description']}\n\n"
                    
                    if phase_info['rules']:
                        result_text += f"**Applicable Rules:**\n"
                        result_text += "\n".join(f"• {rule}" for rule in phase_info['rules'])
                        result_text += "\n\n"
                    
                    if next_phases:
                        result_text += f"**Allowed Next Phase(s):** {', '.join(next_phases)}\n\n"
                    else:
                        result_text += f"**No further transitions available.**\n\n"
                    
                    # Add gatekeeper rules reminder
                    result_text += f"**Gatekeeper Rules (Always Apply):**\n"
                    result_text += "• G-1: Enforce RULE_PHASE_GATING\n"
                    result_text += "• G-2: Memory data modification permissions\n"
                    result_text += "• G-3: RULE_MANDATORY (read workflow_state.md before transition)\n"
                    result_text += "• G-4: Auto-transition when phase tasks completed\n"
                    
                    return [types.TextContent(type="text", text=result_text)]
                
                else:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Unknown tool '{name}'"
                    )]
                    
            except Exception as e:
                self.logger.error(f"Error handling tool '{name}': {str(e)}")
                import traceback
                error_details = traceback.format_exc()
                return [types.TextContent(
                    type="text",
                    text=f"Error executing tool: {str(e)}\n\nDetails:\n{error_details}"
                )]

    async def run(self):
        """Run the MCP server"""
        self.setup_handlers()
        
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            self.logger.info("MCP Workflow Server started")
            await self.server.run(
                read_stream, 
                write_stream, 
                self.server.create_initialization_options()
            )


def setup_signal_handlers():
    """Setup signal handlers for immediate shutdown"""
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down immediately...")
        os._exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)


def main():
    """Main entry point"""
    import argparse
    
    setup_signal_handlers()
    
    parser = argparse.ArgumentParser(
        description="MCP Server for Workflow State Management",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        "--output-dir",
        required=False,
        help="Output directory for crashes and results (optional but recommended)"
    )
    parser.add_argument(
        "--source-code-dir",
        required=False,
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    
    args = parser.parse_args()
    
    logging.basicConfig(
        level='ERROR',
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    server = MCPWorkflowServer(output_dir=args.output_dir, source_code_dir=args.source_code_dir)
    
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\nShutting down MCP Workflow Server...")
        os._exit(0)
    except Exception as e:
        print(f"Error running server: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()


#!/usr/bin/env python3
"""
Pydantic schemas for Property-Based Fuzzer API.

This module defines all input/output data models for the fuzzer API,
providing type safety, validation, and clear documentation.
"""

import os
from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import Dict, Any, List, Optional, Union, Literal
from enum import Enum
from datetime import datetime


class PreconditionStatus(str, Enum):
    """Verification status of preconditions."""
    VERIFIED = "verified"
    VIOLATED = "violated"
    UNKNOWN = "unknown"
    IMPOSSIBLE = "impossible"


class BugPredicate(BaseModel):
    """Bug predicate definition extracted from triggering conditions.
    
    Each BugPredicate represents one disjunctive branch (OR clause) of the triggering condition.
    Example: If triggering condition is 'cond1 OR (cond2 AND cond3)', create two BugPredicates:
    - BP1 for 'cond1'
    - BP2 for 'cond2 AND cond3'
    
    Satisfying ANY BugPredicate triggers the bug.
    """
    model_config = ConfigDict(extra='forbid')
    
    id: str = Field(description="Unique ID (BP1, BP2... for bug predicate)")
    location: str = Field(description="Target location (file:line format)")
    bug_condition: str = Field(description="Triggering condition extracted from the target source code line")

    @field_validator('id')
    @classmethod
    def validate_id(cls, v: str, info) -> str:
        """Validate ID format (BP1, BP2... for bug predicate)."""
        if not v:
            raise ValueError("ID cannot be empty")
        if not v.startswith('BP'):
            raise ValueError("ID must start with 'BP'")
        try:
            int(v[2:])
        except ValueError:
            raise ValueError("ID must be in format BP<number>")
        return v

    @field_validator('location')
    @classmethod
    def validate_location(cls, v: str) -> str:
        """Validate location format (file:line)."""
        if ':' not in v:
            raise ValueError("location must be in format 'file:line'")
        parts = v.rsplit(':', 1)
        if len(parts) != 2:
            raise ValueError("location must be in format 'file:line'")
        try:
            int(parts[1])
        except ValueError:
            raise ValueError("line number must be an integer")
        return v


class ParameterType(str, Enum):
    """Types of parameters in parameter space."""
    INT_RANGE = "int_range"
    FLOAT_RANGE = "float_range"
    CATEGORICAL = "categorical"
    BOOL = "bool"
    BASE_SEED = "base_seed"

class Precondition(BaseModel):
    """Precondition definition for reaching."""
    model_config = ConfigDict(extra='forbid')
    
    id: str = Field(
        description="Unique ID (R1, R2... for reach)"
    )
    statement: str = Field(
        description="Human-readable precondition statement"
    )
    status: PreconditionStatus = Field(
        description="Current verification status"
    )
    evidence: List[str] = Field(
        description="Evidence supporting this precondition"
    )
    input_constraints: List[str] = Field(
        default_factory=list,
        description=(
            "Input format constraints. "
            "Non-semantic: use math expressions (e.g., 'width < 100'). "
            "Semantic: use natural language (e.g., 'cmd must be valid linux command')"
        )
    )

    @field_validator('id')
    @classmethod
    def validate_id(cls, v: str, info) -> str:
        """Validate ID format (R1, R2... for reach)."""
        if not v:
            raise ValueError("ID cannot be empty")
        if not v.startswith('R'):
            raise ValueError("ID must start with 'R'")
        # Check if the rest is a number
        try:
            int(v[1:])
        except ValueError:
            raise ValueError("ID must be in format R<number>")
        return v


class VulnerabilityCategory(str, Enum):
    """Common vulnerability categories in C/C++ programs."""
    BUFFER_OVERFLOW = "buffer_overflow"
    HEAP_OVERFLOW = "heap_overflow" 
    OUT_OF_BOUNDS_READ = "out_of_bounds_read"
    OUT_OF_BOUNDS_WRITE = "out_of_bounds_write"
    INTEGER_OVERFLOW = "integer_overflow"
    TYPE_CONFUSION = "type_confusion"
    RACE_CONDITION = "race_condition"
    COMMAND_INJECTION = "command_injection"
    USE_AFTER_FREE = "use_after_free"
    DOUBLE_FREE = "double_free"
    NULL_POINTER_DEREFERENCE = "null_pointer_dereference"
    UNINITIALIZED_MEMORY = "uninitialized_memory"
    FORMAT_STRING = "format_string"
    LOGIC_ERROR = "logic_error"


class RootCause(BaseModel):
    """Root cause definition for bug triggering analysis."""
    model_config = ConfigDict(extra='forbid')
    
    id: str = Field(
        description="Unique ID (RC1, RC2... for root cause)"
    )
    description: str = Field(
        description="Description of the root cause and triggering condition"
    )
    category: VulnerabilityCategory = Field(
        description="Vulnerability category"
    )
    evidence: List[str] = Field(
        description="Evidence supporting this root cause analysis"
    )
    input_constraints: List[str] = Field(
        default_factory=list,
        description=(
            "Input format constraints to trigger root cause. "
            "Non-semantic: use math expressions (e.g., 'width < 100'). "
            "Semantic: use natural language (e.g., 'cmd must be valid linux command')"
        )
    )
    related_precondition_ids: List[str] = Field(
        default_factory=list,
        description="Related reaching precondition IDs that enable this root cause"
    )

    @field_validator('id')
    @classmethod
    def validate_id(cls, v: str, info) -> str:
        """Validate ID format (RC1, RC2... for root cause)."""
        if not v:
            raise ValueError("ID cannot be empty")
        if not v.startswith('RC'):
            raise ValueError("ID must start with 'RC'")
        # Check if the rest is a number
        try:
            int(v[2:])
        except ValueError:
            raise ValueError("ID must be in format RC<number>")
        return v


class IntRangeParam(BaseModel):
    """Integer range parameter specification."""
    type: Literal["int_range"] = "int_range"
    min: int = Field(description="Minimum value for integer range")
    max: int = Field(description="Maximum value for integer range")

    @field_validator('max')
    @classmethod
    def validate_range(cls, v: int, info) -> int:
        """Ensure max >= min."""
        if 'min' in info.data and v < info.data['min']:
            raise ValueError(f"max ({v}) must be >= min ({info.data['min']})")
        return v


class FloatRangeParam(BaseModel):
    """Float range parameter specification."""
    type: Literal["float_range"] = "float_range"
    min: float = Field(description="Minimum value for float range")
    max: float = Field(description="Maximum value for float range")

    @field_validator('max')
    @classmethod
    def validate_range(cls, v: float, info) -> float:
        """Ensure max >= min."""
        if 'min' in info.data and v < info.data['min']:
            raise ValueError(f"max ({v}) must be >= min ({info.data['min']})")
        return v


class CategoricalParam(BaseModel):
    """Categorical parameter specification."""
    type: Literal["categorical"] = "categorical"
    values: List[Any] = Field(
        description="List of possible values"
    )

    @field_validator('values')
    @classmethod
    def validate_values(cls, v: List[Any]) -> List[Any]:
        """Ensure values list is not empty."""
        if not v:
            raise ValueError("values list cannot be empty for categorical parameter")
        return v


class BoolParam(BaseModel):
    """Boolean parameter specification."""
    type: Literal["bool"] = "bool"


class BaseSeedParam(BaseModel):
    """Base reaching seed file parameter specification."""
    type: Literal["base_seed"] = "base_seed"
    seed_file_path: str = Field(
        description="Full absolute path to reaching seed file to use as template"
    )
    
    @field_validator('seed_file_path')
    @classmethod
    def validate_seed_path(cls, v: str) -> str:
        """Validate seed file exists and is readable."""
        if not v:
            raise ValueError("seed_file_path cannot be empty")
        if not os.path.isabs(v):
            raise ValueError(f"seed_file_path must be absolute path: '{v}'")
        if not os.path.isfile(v):
            raise ValueError(f"Seed file does not exist: '{v}'")
        return v


class SegmentsParam(BaseModel):
    """Multi-segment parameter for complex formats."""
    type: Literal["segments"] = "segments"
    count_range: Dict[str, int] = Field(
        description="Number of segments: {'min': int, 'max': int}"
    )
    segment_params: Dict[str, Any] = Field(
        description="Parameters for each segment"
    )

    @field_validator('count_range')
    @classmethod
    def validate_count_range(cls, v: Dict[str, int]) -> Dict[str, int]:
        """Validate count range."""
        if not isinstance(v, dict) or 'min' not in v or 'max' not in v:
            raise ValueError("count_range must have 'min' and 'max' keys")
        if v['min'] < 0 or v['max'] < v['min']:
            raise ValueError("Invalid count range")
        return v


# Union type for all parameter specifications
ParameterSpec = Union[IntRangeParam, FloatRangeParam, CategoricalParam, BoolParam, SegmentsParam, BaseSeedParam]


class BatchPlanEntry(BaseModel):
    """Entry in next_batch_plan with concrete parameter values."""
    model_config = ConfigDict(extra='allow')  # Allow additional fields for parameters
    
    plan_description: str = Field(
        description="Description of which preconditions this test targets"
    )
    # Additional fields will be parameter values


class Breakpoint(BaseModel):
    """Debugger breakpoint specification."""
    model_config = ConfigDict(extra='forbid')
    
    location: str = Field(
        description="Breakpoint location (full_file_abs_path:line)"
    )
    hit_limit: int = Field(
        default=10,
        description="Maximum hits for this breakpoint"
    )
    inline_expr: List[str] = Field(
        default_factory=list,
        description="Expressions to evaluate at breakpoint"
    )
    print_call_stack: bool = Field(
        default=False,
        description="Whether to print call stack"
    )

    @field_validator('location')
    @classmethod
    def validate_location(cls, v: str) -> str:
        """Validate location format (full_file_abs_path:line) and file existence."""
        if ':' not in v:
            raise ValueError("location must be in format 'full_file_abs_path:line'")
        parts = v.rsplit(':', 1)
        if len(parts) != 2:
            raise ValueError("location must be in format 'full_file_abs_path:line'")
        
        file_path, line_str = parts
        
        # Validate line number is an integer
        try:
            line_num = int(line_str)
            if line_num <= 0:
                raise ValueError("line number must be a positive integer")
        except ValueError:
            raise ValueError("line number must be a positive integer")
        
        # Validate file exists
        if not os.path.isfile(file_path):
            raise ValueError(f"File does not exist: '{file_path}'. Please provide a valid full_file_abs_path:lineNumber")
        
        # Validate it's an absolute path
        if not os.path.isabs(file_path):
            raise ValueError(f"File path must be absolute: '{file_path}'. Please provide a valid full_file_abs_path:lineNumber")
        
        return v


class FuzzPlan(BaseModel):
    """Complete fuzzing plan with preconditions, parameters, and batch plan."""
    model_config = ConfigDict(extra='allow')  # Allow extra fields for compatibility
    
    parameter_space: Dict[str, Dict[str, Any]] = Field(
        default_factory=dict,
        description="Parameter space definition for generators"
    )
    next_batch_plan: List[BatchPlanEntry] = Field(
        default_factory=list,
        description="Specific parameter combinations to try first (Phase 1)"
    )
    breakpoints: List[Breakpoint] = Field(
        default_factory=list,
        description="Debug breakpoints for analysis"
    )

    @field_validator('parameter_space')
    @classmethod
    def validate_parameter_space(cls, v: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        """Validate parameter space specifications."""
        for param_name, spec in v.items():
            if isinstance(spec, dict) and 'type' in spec:
                param_type = spec.get('type')
                if param_type not in ['int_range', 'float_range', 'categorical', 'bool', 'segments', 'base_seed']:
                    # Unknown type, but we'll allow it (fuzzer handles unknown types)
                    continue
                
                # Validate specific types
                if param_type == 'int_range':
                    IntRangeParam.model_validate(spec)
                elif param_type == 'float_range':
                    FloatRangeParam.model_validate(spec)
                elif param_type == 'categorical':
                    CategoricalParam.model_validate(spec)
                elif param_type == 'bool':
                    BoolParam.model_validate(spec)
                elif param_type == 'segments':
                    SegmentsParam.model_validate(spec)
                elif param_type == 'base_seed':
                    BaseSeedParam.model_validate(spec)
        return v

    @field_validator('next_batch_plan')
    @classmethod
    def validate_batch_plan(cls, v: List[BatchPlanEntry], info) -> List[BatchPlanEntry]:
        """Validate that batch plan entries are consistent with parameter space."""
        if 'parameter_space' not in info.data:
            return v
            
        param_space = info.data['parameter_space']
        for i, entry in enumerate(v):
            # Check that entry has required fields
            if not hasattr(entry, 'plan_description'):
                raise ValueError(f"Batch plan entry {i} missing plan_description")
            
            # Validate parameter values against parameter space
            entry_dict = entry.model_dump(exclude={'plan_description'})
            for param_name, param_value in entry_dict.items():
                if param_name in param_space:
                    spec = param_space[param_name]
                    if isinstance(spec, dict) and 'type' in spec:
                        # Validate value against spec
                        if spec['type'] == 'int_range':
                            if not isinstance(param_value, int):
                                raise ValueError(f"Entry {i}: {param_name} must be int, got {type(param_value).__name__}")
                            if 'min' not in spec or 'max' not in spec:
                                raise ValueError(f"Entry {i}: {param_name} int_range spec missing required min/max")
                            if param_value < spec['min'] or param_value > spec['max']:
                                raise ValueError(f"Entry {i}: {param_name}={param_value} out of range [{spec['min']}, {spec['max']}]")
                        elif spec['type'] == 'float_range':
                            if not isinstance(param_value, (int, float)):
                                raise ValueError(f"Entry {i}: {param_name} must be float, got {type(param_value).__name__}")
                            if 'min' not in spec or 'max' not in spec:
                                raise ValueError(f"Entry {i}: {param_name} float_range spec missing required min/max")
                            if param_value < spec['min'] or param_value > spec['max']:
                                raise ValueError(f"Entry {i}: {param_name}={param_value} out of range [{spec['min']}, {spec['max']}]")
                        elif spec['type'] == 'bool':
                            if not isinstance(param_value, bool):
                                raise ValueError(f"Entry {i}: {param_name} must be bool, got {type(param_value).__name__}")
                        elif spec['type'] == 'categorical':
                            if 'values' not in spec:
                                raise ValueError(f"Entry {i}: {param_name} categorical spec missing required values")
                            if param_value not in spec['values']:
                                raise ValueError(f"Entry {i}: {param_name}={param_value} not in allowed values {spec['values']}")
        return v


class RuntimeConfig(BaseModel):
    """Runtime configuration for fuzzing execution."""
    cmd: str = Field(
        description="Command template with @@ placeholder"
    )
    max_iters: int = Field(
        default=100,
        ge=0,
        description="Maximum number of fuzzing iterations"
    )
    exec_timeout_sec: Union[int, float] = Field(
        default=3,
        gt=0,
        description="Timeout per iteration in seconds"
    )
    reached_pattern: str = Field(
        description="Regex pattern to detect target reached"
    )
    triggered_pattern: str = Field(
        description="Regex pattern to detect bug triggered"
    )
    generator_timeout_sec: Union[int, float] = Field(
        default=1,
        gt=0,
        description="Timeout for generator function execution in seconds"
    )
    fuzz_timeout_sec: Union[int, float] = Field(
        default=12.0,
        gt=0,
        description="Total timeout for entire fuzzing session in seconds"
    )

    @field_validator('reached_pattern', 'triggered_pattern')
    @classmethod
    def validate_regex(cls, v: str) -> str:
        """Validate that patterns are valid regex."""
        import re
        try:
            re.compile(v)
        except re.error as e:
            raise ValueError(f"Invalid regex pattern: {e}")
        return v


# Output schemas
class InlineExprValue(BaseModel):
    """Inline expression evaluation result."""
    name: str = Field(description="Expression name")
    value: str = Field(description="Expression value")


class BreakpointHitInfo(BaseModel):
    """Information about a single breakpoint hit."""
    callstack: str = Field(description="Call stack trace")
    inline_expr: List[InlineExprValue] = Field(
        default_factory=list,
        description="Inline expression values"
    )


class BreakpointReport(BaseModel):
    """Report for a single breakpoint."""
    id: int
    file_path: str
    line: int
    function_name: str
    hit_times: int = Field(ge=0)
    hits_info: List[BreakpointHitInfo] = Field(default_factory=list)


class DebuggerInfo(BaseModel):
    """Debugger information for an iteration."""
    breakpoints: List[BreakpointReport] = Field(default_factory=list)
    signal: str = Field(default="", description="Signal information")
    breakpoint_hits: int = Field(ge=0, default=0)
    total_breakpoints: int = Field(ge=0, default=0)


class IterationResult(BaseModel):
    """Result of a single fuzzing iteration."""
    type: Literal["iter_result", "error"]
    iter: int = Field(ge=0, description="Iteration number")
    parameters: Dict[str, Any] = Field(
        description="Parameters used for this iteration"
    )
    
    # For successful iterations
    reached: int = Field(
        default=0,
        ge=0,
        le=1,
        description="1 if reached pattern matched, 0 otherwise"
    )
    triggered: int = Field(
        default=0,
        ge=0,
        le=1,
        description="1 if triggered pattern matched, 0 otherwise"
    )
    timeout: bool = Field(
        default=False,
        description="Whether this iteration timed out"
    )
    exit_code: int = Field(
        default=0,
        description="Process exit code"
    )
    duration_ms: int = Field(
        default=0,
        ge=0,
        description="Execution time in milliseconds"
    )
    testcase_file: str = Field(
        default="",
        description="Path to saved testcase file"
    )
    debugger_debug: Dict[str, Any] = Field(
        default_factory=dict,
        description="Debugger information if available"
    )
    
    # For error iterations
    stage: str = Field(
        default="",
        description="Stage where error occurred"
    )
    message: str = Field(
        default="",
        description="Error message"
    )

    @field_validator('reached', 'triggered')
    @classmethod
    def validate_binary(cls, v: int) -> int:
        """Ensure reached/triggered are 0 or 1."""
        if v not in (0, 1):
            raise ValueError("Must be 0 or 1")
        return v


class TimeoutInfo(BaseModel):
    """Information about fuzzing timeout."""
    timed_out: bool = Field(description="Whether fuzzing timed out")
    elapsed_time_sec: float = Field(ge=0, description="Elapsed time when timeout occurred")
    timeout_limit_sec: float = Field(gt=0, description="Timeout limit in seconds")
    phase: str = Field(description="Phase when timeout occurred")
    completed_iterations: int = Field(ge=0, description="Number of iterations completed")
    remaining_batch_iterations: int = Field(ge=0, description="Remaining batch plan iterations")
    remaining_sampling_iterations: int = Field(ge=0, description="Remaining sampling iterations")


class FuzzSummary(BaseModel):
    """Summary statistics for fuzzing session."""
    total_iterations: int = Field(ge=0)
    reached_count: int = Field(ge=0)
    triggered_count: int = Field(ge=0)
    timeout_count: int = Field(ge=0)
    error_count: int = Field(ge=0)
    timeout_info: Optional[TimeoutInfo] = Field(
        default=None,
        description="Timeout information if fuzzing was stopped due to timeout"
    )

    @field_validator('reached_count', 'triggered_count', 'timeout_count', 'error_count')
    @classmethod
    def validate_counts(cls, v: int, info) -> int:
        """Ensure counts don't exceed total iterations."""
        if 'total_iterations' in info.data and v > info.data['total_iterations']:
            raise ValueError(f"Count ({v}) cannot exceed total_iterations ({info.data['total_iterations']})")
        return v


class FuzzResult(BaseModel):
    """Complete result of a fuzzing session."""
    iterations: List[IterationResult] = Field(
        description="Detailed results for each iteration"
    )
    summary: FuzzSummary = Field(
        description="Summary statistics"
    )

    @field_validator('summary')
    @classmethod
    def validate_summary(cls, v: FuzzSummary, info) -> FuzzSummary:
        """Validate summary is consistent with iterations."""
        if 'iterations' in info.data:
            iterations = info.data['iterations']
            
            # Count actual values
            actual_reached = sum(1 for it in iterations if it.reached == 1)
            actual_triggered = sum(1 for it in iterations if it.triggered == 1)
            actual_timeout = sum(1 for it in iterations if it.timeout is True)
            actual_error = sum(1 for it in iterations if it.type == "error")
            
            # Validate counts match
            if v.reached_count != actual_reached:
                raise ValueError(f"reached_count mismatch: summary={v.reached_count}, actual={actual_reached}")
            if v.triggered_count != actual_triggered:
                raise ValueError(f"triggered_count mismatch: summary={v.triggered_count}, actual={actual_triggered}")
            if v.timeout_count != actual_timeout:
                raise ValueError(f"timeout_count mismatch: summary={v.timeout_count}, actual={actual_timeout}")
            if v.error_count != actual_error:
                raise ValueError(f"error_count mismatch: summary={v.error_count}, actual={actual_error}")
            
        
        return v


# Workflow State Schemas
class WorkflowPhase(str, Enum):
    """Workflow phases for directed fuzzing."""
    INIT = "INIT"
    PLAN = "PLAN"
    IMPLEMENT = "IMPLEMENT"
    EXECUTE = "EXECUTE"
    REFLECT = "REFLECT"
    SUCCESS = "SUCCESS"


class BuildInfo(BaseModel):
    """Build / oracle rebuild tracking for CyberGym integration."""
    model_config = ConfigDict(extra="forbid")

    build_cmd: str = Field(default="", description="Shell command to build the target")
    binary_path: str = Field(default="", description="Path to built executable (relative to source root or absolute)")
    dirty: bool = Field(default=False, description="True after oracle insert until rebuild succeeds")
    last_build_log_excerpt: str = Field(default="", description="Tail of last build log")
    build_attempts: int = Field(default=0, ge=0)


class GreenFeedbackEntry(BaseModel):
    """One CyberGym green-agent validation round-trip."""
    model_config = ConfigDict(extra="ignore")

    outer_round: int = Field(default=0, ge=0)
    candidate_poc_sha256: str = Field(default="", description="Hex digest of PoC bytes tested")
    exit_code: Optional[int] = Field(default=None)
    output_excerpt: str = Field(default="", description="Truncated stdout/stderr from vulnerable container")
    source: str = Field(default="green")
    note: str = Field(default="")


class WorkflowState(BaseModel):
    """Current workflow state."""
    phase: WorkflowPhase = Field(description="Current workflow phase")
    status: str = Field(description="Current status description")
    current_task: str = Field(description="Current task being worked on")
    next_action: str = Field(description="Next planned action")


class TriggerPlan(BaseModel):
    """High-level plan to trigger the bug with complexity assessment."""
    model_config = ConfigDict(extra='forbid')
    
    id: str = Field(description="Unique plan ID")
    description: str = Field(description="High-level plan description")
    route_description: str = Field(description="Route to reach the target")
    complexity: int = Field(ge=1, le=10, description="Implementation complexity (1=easiest, 10=hardest)")
    status: Literal["pending", "in_progress", "completed", "failed"] = Field(description="Plan status")
    evidence: List[str] = Field(default_factory=list, description="Evidence supporting this plan")
    precondition_ids: List[str] = Field(default_factory=list, description="Required precondition IDs (R1, T1, etc.)")
    strategy: str = Field(default="", description="Specific strategy or approach for this plan")
    
    def to_fuzz_plan_description(self) -> str:
        """Generate description for FuzzPlan based on this TriggerPlan."""
        return f"Implementing TriggerPlan {self.id}: {self.description} via {self.strategy}"


class WorkflowMetrics(BaseModel):
    """Workflow execution metrics."""
    model_config = ConfigDict(extra='forbid')
    
    total_iterations: int = Field(default=0, ge=0)
    total_reached_count: int = Field(default=0, ge=0)
    last_reached_count: int = Field(default=0, ge=0)
    triggered_count: int = Field(default=0, ge=0)
    timeout_count: int = Field(default=0, ge=0)
    error_count: int = Field(default=0, ge=0)
    last_updated: Optional[str] = Field(default=None)

class WorkflowMemory(BaseModel):
    """Complete workflow memory state."""
    state: WorkflowState = Field(default_factory=lambda: WorkflowState(
        phase=WorkflowPhase.INIT,
        status="Starting directed fuzzing workflow",
        current_task="Environment setup and build",
        next_action="Read project_config.md; complete INIT rules then transition to PLAN",
    ), description="Current workflow state")
    bug_predicates: List[BugPredicate] = Field(default_factory=list, description="Bug predicates from target locations")
    preconditions: List[Precondition] = Field(default_factory=list, description="Reaching preconditions")
    root_causes: List[RootCause] = Field(default_factory=list, description="Root causes for bug triggering analysis")
    parameter_space: Dict[str, Dict[str, Any]] = Field(default_factory=dict, description="Parameter space")
    trigger_plans: List[TriggerPlan] = Field(default_factory=list, description="High-level plans to trigger the bug")
    fuzz_plan: List[BatchPlanEntry] = Field(default_factory=list, description="Concrete fuzz plan generated from selected TriggerPlan")
    breakpoints: List[Breakpoint] = Field(default_factory=list, description="Debug breakpoints")
    metrics: WorkflowMetrics = Field(default_factory=WorkflowMetrics, description="Execution metrics")

    def get_active_plan(self) -> Optional[TriggerPlan]:
        """Get the currently active (lowest complexity pending) trigger plan."""
        pending_plans = [p for p in self.trigger_plans if p.status == "pending"]
        if not pending_plans:
            return None
        return min(pending_plans, key=lambda p: p.complexity)

    def update_plan_complexity(self, plan_id: str, new_complexity: int, evidence: str = ""):
        """Update plan complexity based on new evidence."""
        for plan in self.trigger_plans:
            if plan.id == plan_id:
                plan.complexity = new_complexity
                if evidence:
                    plan.evidence.append(evidence)
                break

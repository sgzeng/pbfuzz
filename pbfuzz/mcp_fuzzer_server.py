#!/usr/bin/env python3
"""
MCP (Model Context Protocol) Server for Property-Based Fuzzing

This server exposes PropertyBasedFuzzer functionality as MCP tools, allowing LLM agents
to run directed property-based fuzzing sessions with custom generators and configurations.

Available tools:
- fuzz: Run a property-based fuzzing session with custom generator code
"""

import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from utils import read_workflow_state, check_tool_permission

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from property_based_fuzzer import PropertyBasedFuzzer
from config import Config
from schemas import FuzzPlan, RuntimeConfig
from pydantic import ValidationError


class MCPFuzzerServer:
    """MCP Server wrapper for PropertyBasedFuzzer functionality"""
    
    def __init__(self, source_code_dir: Optional[str] = None):
        self.server = Server("property-fuzzer-server")
        self.config: Optional[Config] = None
        self.fuzzer: Optional[PropertyBasedFuzzer] = None
        self.logger = logging.getLogger(__name__)
        # Workflow state management for gatekeeper - fixed path in .cursor directory
        self.source_code_dir = Path(source_code_dir) if source_code_dir else Path.cwd()
        self.state_file_path = self.source_code_dir / ".cursor" / "workflow_state.md"
        
    def _auto_convert_categorical_to_int_range(self, parameter_space: Dict[str, Any]) -> Dict[str, Any]:
        """
        Automatically convert categorical parameters to int_range when all values are integers.
        
        Conversion rule: 
        {"type": "categorical", "values": [3, 5, 7]} 
        -> {"type": "int_range", "min": 3, "max": 7}
        (fills gaps between min and max)
        
        This is transparent to the agent.
        """
        converted_space = {}
        
        for param_name, spec in parameter_space.items():
            if isinstance(spec, dict) and spec.get('type') == 'categorical':
                values = spec.get('values', [])
                
                # Check if all values are integers
                if values and all(isinstance(val, int) for val in values):
                    min_val = min(values)
                    max_val = max(values)
                    
                    if max_val - min_val > 100:
                        continue
                    
                    # Just fill gaps between min and max values
                    converted_spec = {
                        "type": "int_range",
                        "min": min_val,
                        "max": max_val
                    }
                    converted_space[param_name] = converted_spec
                    
                    self.logger.debug(f"Auto-converted {param_name}: categorical {values} -> int_range [{min_val}, {max_val}]")
                else:
                    # Keep as-is if not all integers
                    converted_space[param_name] = spec
            else:
                # Keep non-categorical parameters as-is
                converted_space[param_name] = spec
        
        return converted_space
    
    def _read_workflow_state(self) -> Optional[Dict[str, Any]]:
        """Read workflow state from file if available."""
        if not self.state_file_path or not self.state_file_path.exists():
            return None
        
        try:
            # Use utils.read_workflow_state for consistent parsing
            memory = read_workflow_state(self.state_file_path)
            return memory.state.model_dump()
        except Exception as e:
            self.logger.warning(f"Failed to read workflow state: {e}")
        
        return None
    
    def _check_workflow_gatekeeper(self, tool_name: str) -> Optional[str]:
        """Check workflow gatekeeper rules for tool access."""
        if not self.state_file_path or not self.state_file_path.exists():
            return f"🚫 **Workflow State Required**: No workflow state file found. Please ensure workflow_state.md exists at {self.state_file_path}"
        
        try:
            # Read current workflow state
            memory = read_workflow_state(self.state_file_path)
            current_phase = memory.state.phase
            
            # Different tools have different phase requirements
            # Both fuzz and get_generator_api_doc are EXECUTE phase tools (R-EX5)
            required_phase = None
            if tool_name == "fuzz":
                required_phase = "EXECUTE"
            elif tool_name == "get_generator_api_doc":
                required_phase = "EXECUTE"  # Fixed: R-EX5 specifies EXECUTE
            
            # Check tool permission
            if not check_tool_permission(current_phase, tool_name):
                return f"🚫 **Phase Gatekeeper**: Tool '{tool_name}' not allowed in {current_phase} phase. Must be in {required_phase} phase."
            
            return None  # Gatekeeper check passed
            
        except Exception as e:
            return f"🚫 **Workflow Error**: Failed to read workflow state: {e}"
        
    def _format_debugger_info(self, debug_info: Dict[str, Any]) -> str:
        """Format debugger information for display."""
        if not debug_info:
            return ""
        
        result_text = ""
        bp_hits = debug_info.get("breakpoint_hits", 0)
        total_bps = debug_info.get("total_breakpoints", 0)
        sig = debug_info.get("signal")
        
        result_text += f"  • 🔍 Debugger: {bp_hits} breakpoint hits across {total_bps} breakpoints\n"
        if sig:
            result_text += f"  • Signal: {sig}\n"
        
        # Show breakpoint details
        breakpoints = debug_info.get("breakpoints", [])
        for bp in breakpoints:
            if not bp or bp.get("hit_times", 0) <= 0:
                continue
                
            result_text += f"    - {bp.get('file_path', 'unknown')}:{bp.get('line', 0)} hit {bp.get('hit_times', 0)} times\n"
            
            # Show inline expressions if available
            hits_info = bp.get("hits_info", [])
            for hit in hits_info[:2]:  # Show first 2 hits
                if not hit:
                    continue
                    
                inline_exprs = hit.get("inline_expr", [])
                if not inline_exprs:
                    continue
                    
                result_text += f"      Expressions: "
                expr_strs = []
                for expr in inline_exprs[:3]:
                    if expr and isinstance(expr, dict) and 'name' in expr and 'value' in expr:
                        expr_strs.append(f"{expr['name']}={expr['value']}")
                
                if expr_strs:
                    result_text += ", ".join(expr_strs) + "\n"
        
        return result_text
    
    def _format_iteration_result(self, iter_result: Dict[str, Any]) -> str:
        """Format a single iteration result for display."""
        if iter_result is None:
            return ""
        
        result_text = ""
        iter_num = iter_result.get("iter", 0)
        iter_type = iter_result.get("type", "unknown")
        
        if iter_type == "error":
            stage = iter_result.get("stage", "unknown")
            message = iter_result.get("message", "Unknown error")
            params = iter_result.get("parameters", {})
            result_text += f"\n**Iteration {iter_num}** ❌ ERROR\n"
            result_text += f"  • Stage: {stage}\n"
            result_text += f"  • Message: {message}\n"
            result_text += f"  • Parameters: {json.dumps(params, indent=2)}\n"
        else:
            # Success iteration
            reached = iter_result.get("reached", 0)
            triggered = iter_result.get("triggered", 0)
            timeout = iter_result.get("timeout", False)
            exit_code = iter_result.get("exit_code")
            duration = iter_result.get("duration_ms", 0)
            params = iter_result.get("parameters", {})
            testcase_file = iter_result.get("testcase_file")
            
            # Status indicators
            reached_icon = "✅" if reached else "❌"
            triggered_icon = "🎯" if triggered else "❌"
            timeout_icon = "⏰" if timeout else "✅"
            
            result_text += f"\n**Iteration {iter_num}** "
            if triggered:
                result_text += "🎯 TRIGGERED\n"
            elif reached:
                result_text += "✅ REACHED\n"
            else:
                result_text += "❌ MISSED\n"
            
            result_text += f"  • Reached: {reached_icon} ({reached})\n"
            result_text += f"  • Triggered: {triggered_icon} ({triggered})\n"
            result_text += f"  • Timeout: {timeout_icon} ({timeout})\n"
            result_text += f"  • Exit code: {exit_code}\n"
            result_text += f"  • Duration: {duration}ms\n"
            if testcase_file:
                result_text += f"  • Saved Testcase: {testcase_file}\n"
            result_text += f"  • Parameters: {json.dumps(params, indent=2)}\n"
            
            # Show debugger info if available
            debug_info = iter_result.get("debugger_debug")
            if debug_info:
                result_text += self._format_debugger_info(debug_info)
        
        return result_text
    
    def _get_generator_documentation(self, topic: str) -> str:
        """Get focused documentation for generator API based on requested topic."""
        
        if topic == "overview":
            return """# 🧬 Generator Function API Overview

## Core Interface
```python
def generate(**params) -> Tuple[bytes, Dict[str, Any]]:
    return test_data, actual_params_used
```

## Key Rules
1. **Return bytes** - Never return strings or other types
2. **Complete within 1 seconds** - Avoid heavy operations  
3. **Import inside function** - All imports must be inside generate()
4. **Use params.get()** - Safe parameter access with defaults
5. **Internal functions** - Implement only generate(**params). No other functions are allowed except for internal helper functions inside generate(**params).

## Parameter Types
- **int_range**: `{"type": "int_range", "min": 0, "max": 100}` → receives int
- **float_range**: `{"type": "float_range", "min": 0.0, "max": 1.0}` → receives float
- **categorical**: `{"type": "categorical", "values": ["xml", "json"]}` → receives string
- **bool**: `{"type": "bool"}` → receives boolean
- **segments**: `{"type": "segments", "count_range": {...}, "segment_params": {...}}` → special handling
- **base_seed**: Phase 1: provide in next_batch_plan | Phase 2: auto-injected from parameter_space

## ⚠️ Categorical Integer Auto-Conversion
**If ALL values in categorical are integers, auto-converts to int_range:**
- Input: `{"type": "categorical", "values": [3, 5, 7]}`
- Output: `{"type": "int_range", "min": 3, "max": 7}` (fills gaps: 3,4,5,6,7)

**To use EXACT integer values only:**
Use string categorical: `{"values": ["3", "5"]}` and convert: `int(params.get("3"))`

SEGMENTS TYPE:
Use for multi-chunk/multi-segment formats
- Generate multiple segments with individual parameters
- Control count and overlap between segments
- Examples: PDF with embedded images, multi-page images inside one TIFF, Text chunks in libpng and OpenSSL certificates embedding other certificates, etc.

## Parameter Flow
- **Phase 1**: Receives concrete values from `next_batch_plan`
- **Phase 2**: Receives sampled values from `parameter_space`

## Quick Example
```python
def generate(**params):
    import random
    
    length = params.get("length", 10)
    format_type = params.get("format", "xml")
    
    if format_type == "xml":
        data = f'<test len="{length}">data</test>'
    else:
        data = "A" * length
    
    return data.encode(), {"length": length, "format": format_type}
```

Use `get_generator_api_doc` with other topics for detailed examples and patterns."""

        elif topic == "examples":
            return """# 📚 Generator Examples

## Basic Text Format (int_range + categorical)
```python
def generate(**params):
    import random
    
    length = params.get("length", 10)  # int from int_range
    format_type = params.get("format", "xml")  # string from categorical
    
    if format_type == "xml":
        data = f'<?xml version="1.0"?><test len="{length}">{"A" * length}</test>'
    elif format_type == "json":
        data = f'{{"length": {length}, "data": "{"A" * length}"}}'
    else:
        data = "A" * length
    
    return data.encode(), {"length": length, "format": format_type}
```

## Float Range Example
```python
def generate(**params):
    import random, struct
    
    ratio = params.get("ratio", 0.5)  # float from float_range
    size = params.get("size", 100)   # int from int_range
    
    # Generate data based on float ratio
    actual_size = int(size * ratio)
    data = struct.pack("<f", ratio) + b"A" * actual_size
    
    return data, {"ratio": ratio, "size": size, "actual_size": actual_size}
```

## Binary Protocol
```python
def generate(**params):
    import random, struct
    
    msg_type = params.get("message_type", 1)
    payload_size = params.get("payload_size", 64)
    
    # Header: magic(4) + type(2) + size(2)
    header = b"PROTO" + struct.pack("<HH", msg_type, payload_size)
    payload = random.randbytes(payload_size)
    
    return header + payload, {
        "message_type": msg_type,
        "payload_size": payload_size
    }
```

## Segments (Multi-part Data)
```python
def generate(**params):
    import random, struct
    
    # Backend passes segments spec directly as parameter value
    # Look for parameters with segments spec
    segments_spec = None
    segments_param_name = None
    
    for key, value in params.items():
        if isinstance(value, dict) and value.get("type") == "segments":
            segments_spec = value
            segments_param_name = key
            break
    
    if segments_spec:
        # Required by schema: count_range and segment_params
        count_range = segments_spec["count_range"]  # {"min": 1, "max": 5}
        segment_params = segments_spec["segment_params"]  # {...}
        
        segment_count = random.randint(count_range["min"], count_range["max"])
        segments = []
        
        for i in range(segment_count):
            # Use segment_params for individual segment generation
            width = random.randint(
                segment_params.get("width_min", 10), 
                segment_params.get("width_max", 200)
            )
            height = random.randint(
                segment_params.get("height_min", 10), 
                segment_params.get("height_max", 100)
            )
            
            segment_header = struct.pack("<HH", width, height)
            segment_data = random.randbytes(width * height // 8)
            segments.append(segment_header + segment_data)
        
        data = b"MULTI" + struct.pack("<H", segment_count) + b"".join(segments)
        return data, {"segments": segment_count, "total_size": len(data)}
    
    return b"", {}
```

## Base Seed Template (base_seed)
**Phase 1**: Agent must provide base_seed in next_batch_plan entries
**Phase 2**: Auto-injected from parameter_space

```python
def generate(**params):
    import random
    
    # Find base_seed parameter (provided in Phase 1, auto-injected in Phase 2)
    base_seed_info = next((v for v in params.values() 
                          if isinstance(v, dict) and v.get("type") == "base_seed"), None)
    
    if base_seed_info:
        with open(base_seed_info["seed_file_path"], "rb") as f:
            data = bytearray(f.read())
        
        # Apply mutations
        rate = params.get("mutation_rate", 0.01)
        for _ in range(int(len(data) * rate)):
            data[random.randint(0, len(data)-1)] = random.randint(0, 255)
        
        return bytes(data), params
    
    return b"", {}
```

## Categorical Auto-Conversion
```python
def generate(**params):
    import random, struct
    
    # Categorical with integer values auto-converts to int_range
    # Agent specifies: {"type": "categorical", "values": [3, 5]}
    # Server converts: {"type": "int_range", "min": 3, "max": 5}
    # Generator receives: count=3,4,or 5 (fills gaps)
    
    count = params.get("count", 3)  # Will receive values in [3, 5] range
    field_type = params.get("field_type", 11)  # Standard categorical
    
    # Example: Binary format with field entries
    # Gap filling allows testing intermediate values
    if count == 1:
        # Single embedded value
        value = 0x12345678
        entry = struct.pack("<HHI", field_type, count, value)
    else:
        # Multiple values with offset
        offset = 64
        entry = struct.pack("<HHI", field_type, count, offset)
    
    # Build minimal binary format
    header = b"BINF" + struct.pack("<I", len(entry))
    padding = b"\x00" * max(0, 64 - len(header) - len(entry))
    
    data = header + entry + padding
    
    return data, {
        "count": count, 
        "field_type": field_type,
        "mode": "embedded" if count == 1 else "pointer"
    }
```

## For EXACT Integer Values (No Auto-Conversion)
```python
def generate(**params):
    # Option 1: Hardcode the exact value (ignore parameter)
    color_type = 3  # Always use PNG_COLOR_TYPE_PALETTE
    
    # Option 2: Use string categorical and convert
    # In plan: {"type": "categorical", "values": ["3", "5"]}
    color_type_str = params.get("color_type", "3")
    color_type = int(color_type_str)  # Convert to int
    
    # Generate PNG with exact color_type
    data = generate_png_with_color_type(color_type)
    return data, {"color_type": color_type}
```"""

        elif topic == "errors":
            return """# 🚨 Common Errors & Fixes

## Critical Fixes
```python
# ❌ WRONG: Return string
return "test data", {}

# ✅ CORRECT: Return bytes
return "test data".encode(), {}

# ❌ WRONG: Missing imports
def generate(**params):
    return random.randbytes(100), {}

# ✅ CORRECT: Import inside function
def generate(**params):
    import random
    return random.randbytes(100), {}

# ❌ WRONG: Unsafe parameter access
length = params["length"]  # KeyError if missing

# ✅ CORRECT: Safe access with defaults
length = params.get("length", 10)
```

## Timeout Prevention
- Avoid infinite loops
- Limit data generation size
- Use simple operations
- Keep under 1 seconds"""

        elif topic == "preconditions":
            return """# 🧠 Precondition-Driven Generation

## Understanding Preconditions and Root Causes
- **Reaching (R1, R2...)**: Constraints to reach the target location
- **Root Causes (RC1, RC2...)**: Vulnerability analysis and triggering conditions

## Status-Based Strategy
```python
def generate(**params):
    import random
    
    # Encode verified preconditions and root cause analysis
    if params.get("test_root_cause_RC1", False):
        # RC1: "buffer_overflow via length=0" (verified root cause)
        length = 0
        safe_mode = False
    elif params.get("avoid_error_path", False):
        # R1: "avoid png_error" (verified reaching precondition)
        length = params.get("length", 10)
        safe_mode = True
    else:
        length = params.get("length", 10)
        safe_mode = params.get("safe_mode", False)
    
    # Generate based on precondition strategy
    if safe_mode:
        data = f'<safe len="{length}">valid</safe>'
    else:
        data = f'<test len="{length}">data</test>'
    
    return data.encode(), {
        "length": length,
        "safe_mode": safe_mode
    }
```

## Batch Plan Integration
Each `next_batch_plan` entry targets specific preconditions or root causes:
```json
{
  "plan_description": "Test RC1: buffer overflow via length=0",
  "length": 0,
  "test_root_cause_RC1": true
}
```"""

        elif topic == "breakpoints":
            return """# 🔍 Breakpoints for Evidence Collection

## Why Breakpoints Matter
Phase 1 MUST use breakpoints to verify preconditions and collect evidence.

## Essential Setup
```json
{
  "breakpoints": [
    {
      "location": "/path/to/bug_file.c:123",
      "hit_limit": 5,
      "inline_expr": ["length", "ctx->flag", "buffer_size"]
    },
    {
      "location": "/path/to/error_function.c:45",
      "hit_limit": 3,
      "inline_expr": ["error_code"]
    }
  ]
}
```

## ⚠️ CRITICAL:LLDB breakpoints fire before the line runs.
	•If you stop on an assignment line, the variable still shows the old value.
	•To see the updated value, set the breakpoint on the next line after the assignment.

## Evidence Strategy
- **Bug Location**: Breakpoint at exact bug line → verify triggering conditions
- **Error Paths**: Breakpoint at blocking functions → verify reaching conditions
- **Variable Observation**: Use `inline_expr` to observe key variables

## Example Evidence Collection
```json
{
  "plan_description": "Test R1: avoid png_error + T1: length=0",
  "length": 0,
  "format": "xml"
}
```

**Expected Evidence:**
- `png_error:156` hit 0 times → R1 verified (avoided error path)
- `bug_site:78` hit 1 time, length=0 → T1 condition met"""

        elif topic == "advanced":
            return """# 🔬 Advanced Patterns
## Corruption-Based Generation
```python
def generate(**params):
    import random
    
    corruption_level = params.get("corruption", 0.0)  # 0.0-1.0
    
    # Generate valid base data
    data = b"VALID_HEADER" + b"A" * 100
    
    # Apply corruption
    if corruption_level > 0:
        data = bytearray(data)
        num_corruptions = int(len(data) * corruption_level)
        
        for _ in range(num_corruptions):
            if data:
                pos = random.randint(0, len(data) - 1)
                data[pos] = random.randint(0, 255)
        
        data = bytes(data)
    
    return data, {"corruption_level": corruption_level}
```"""

        else:
            return "Unknown topic. Available topics: overview, examples, errors, preconditions, breakpoints, advanced"
        
    async def initialize_fuzzer(self, output_dir: str) -> bool:
        """Initialize PropertyBasedFuzzer with the provided configuration"""
        try:
            # Create config object
            self.config = Config()
            
            # Set required configurations
            self.config.output_dir = Path(output_dir)
            self.config.output_dir.mkdir(parents=True, exist_ok=True)
            
            # Create PropertyBasedFuzzer instance once
            self.fuzzer = PropertyBasedFuzzer(self.config)
            
            self.logger.info("PropertyBasedFuzzer config initialized")
            self.logger.info("Output directory: %s", output_dir)
            
            return True
        except Exception as e:
            self.logger.error("Failed to initialize PropertyBasedFuzzer config: %s", str(e))
            return False
    
    def setup_handlers(self):
        """Setup MCP request handlers"""
        
        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            """List available tools"""
            return [
                types.Tool(
                    name="get_generator_api_doc",
                    description=(
                        "Get comprehensive API documentation and examples for writing generator_code. "
                        "This provides detailed information about the generator function interface, "
                        "parameter handling, common patterns, error scenarios, and complete examples. "
                        "Use this tool to understand how to write effective generator functions."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "topic": {
                                "type": "string",
                                "enum": ["overview", "examples", "errors", "preconditions", "breakpoints", "advanced"],
                                "description": "Specific topic to get documentation for",
                                "default": "overview"
                            }
                        }
                    }
                ),
                types.Tool(
                    name="fuzz",
                    description=(
                        "Run a property-based fuzzing session with custom generator code. "
                        "This tool executes directed fuzzing to find bugs by generating test inputs "
                        "according to a specified plan and parameter space. It can use debugger "
                        "integration and breakpoints for advanced analysis."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                                "plan": {
                                "type": "object",
                                "description": "Fuzzing plan containing parameter space, batch plan, and breakpoints",
                                "properties": {
                                    "parameter_space": {
                                        "type": "object",
                                        "description": "Parameter space definition for generators",
                                        "default": {},
                                        "additionalProperties": {
                                            "type": "object",
                                            "properties": {
                                                "type": {
                                                    "type": "string",
                                                    "enum": ["int_range", "float_range", "categorical", "bool", "segments", "base_seed"]
                                                },
                                                "min": {
                                                    "type": "number",
                                                    "description": "Minimum value for int_range/float_range"
                                                },
                                                "max": {
                                                    "type": "number", 
                                                    "description": "Maximum value for int_range/float_range"
                                                },
                                                "values": {
                                                    "type": "array",
                                                    "description": "List of possible values for categorical"
                                                },
                                                "count_range": {
                                                    "type": "object",
                                                    "description": "Range for number of segments"
                                                },
                                                "segment_params": {
                                                    "type": "object",
                                                    "description": "Parameters for each segment"
                                                },
                                                "seed_file_path": {
                                                    "type": "string",
                                                    "description": "Full absolute path to reaching seed file for base_seed type"
                                                }
                                            },
                                            "anyOf": [
                                                {
                                                    "properties": {
                                                        "type": {"const": "int_range"}
                                                    },
                                                    "required": ["type", "min", "max"]
                                                },
                                                {
                                                    "properties": {
                                                        "type": {"const": "float_range"}
                                                    },
                                                    "required": ["type", "min", "max"]
                                                },
                                                {
                                                    "properties": {
                                                        "type": {"const": "categorical"}
                                                    },
                                                    "required": ["type", "values"]
                                                },
                                                {
                                                    "properties": {
                                                        "type": {"const": "bool"}
                                                    },
                                                    "required": ["type"]
                                                },
                                                {
                                                    "properties": {
                                                        "type": {"const": "segments"}
                                                    },
                                                    "required": ["type", "count_range", "segment_params"]
                                                },
                                                {
                                                    "properties": {
                                                        "type": {"const": "base_seed"}
                                                    },
                                                    "required": ["type", "seed_file_path"]
                                                }
                                            ]
                                        }
                                    },
                                    "next_batch_plan": {
                                        "type": "array",
                                        "description": "Specific parameter combinations to try first in Phase 1 (targeted testing)",
                                        "default": [],
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "plan_description": {
                                                    "type": "string",
                                                    "description": "Description of what this test case targets (e.g., 'Plan A1: Test specific input combination')"
                                                }
                                            },
                                            "additionalProperties": True
                                        }
                                    },
                                    "breakpoints": {
                                        "type": "array",
                                        "description": "Debug breakpoints for analysis",
                                        "default": [],
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "location": {
                                                    "type": "string",
                                                    "description": "Breakpoint location (full_file_abs_path:line)"
                                                },
                                                "hit_limit": {
                                                    "type": "integer",
                                                    "description": "Maximum hits for this breakpoint",
                                                    "default": 10
                                                },
                                                "inline_expr": {
                                                    "type": "array",
                                                    "description": "Expressions to evaluate at breakpoint",
                                                    "items": {"type": "string"},
                                                    "default": []
                                                },
                                                "print_call_stack": {
                                                    "type": "boolean",
                                                    "description": "Whether to print call stack",
                                                    "default": False
                                                }
                                            },
                                            "required": ["location"]
                                        }
                                    }
                                }
                            },
                            "runtime_config": {
                                "type": "object",
                                "description": "Runtime configuration for fuzzing execution",
                                "properties": {
                                    "cmd": {
                                        "type": "string",
                                        "description": "Command template with @@ placeholder"
                                    },
                                    "max_iters": {
                                        "type": "integer",
                                        "description": "Maximum number of fuzzing iterations",
                                        "default": 100
                                    },
                                    "exec_timeout_sec": {
                                        "type": "number",
                                        "description": "Timeout per iteration in seconds",
                                        "default": 3
                                    },
                                    "reached_pattern": {
                                        "type": "string",
                                        "description": "Regex pattern to detect target reached"
                                    },
                                    "triggered_pattern": {
                                        "type": "string",
                                        "description": "Regex pattern to detect bug triggered"
                                    },
                                    "generator_timeout_sec": {
                                        "type": "number",
                                        "description": "Timeout for generator function execution in seconds",
                                        "default": 2
                                    },
                                    "fuzz_timeout_sec": {
                                        "type": "number",
                                        "description": "Total timeout for entire fuzzing session in seconds",
                                        "default": 12
                                    }
                                },
                                "required": ["cmd", "reached_pattern", "triggered_pattern"]
                            },
                            "generator_code": {
                                "type": "string",
                                "description": """Python code with a generate function for creating test inputs.

REQUIRED INTERFACE:
```python
def generate(**params) -> Tuple[bytes, Dict[str, Any]]:
    import random  # All imports inside function
    
    # Extract parameters safely
    length = params.get("length", 10)
    format_type = params.get("format", "xml")
    
    # Generate test data
    data = f'<test len="{length}">content</test>'
    
    # Return bytes and actual params used
    return data.encode(), {"length": length, "format": format_type}
```

## Key Rules
1. **Return bytes** - Never return strings or other types
2. **Complete within 1 seconds** - Avoid heavy operations  
3. **Import inside function** - All imports must be inside generate()
4. **Use params.get()** - Safe parameter access with defaults
5. **Internal functions** - Implement only generate(**params). No other functions are allowed except for internal helper functions inside generate(**params).

## Parameter Types
- **int_range**: `{"type": "int_range", "min": 0, "max": 100}` → receives int
- **float_range**: `{"type": "float_range", "min": 0.0, "max": 1.0}` → receives float
- **categorical**: `{"type": "categorical", "values": ["xml", "json"]}` → receives string
  ⚠️ Auto-converts to int_range if all values are integers (e.g., [3,5] → min:3, max:5)
- **bool**: `{"type": "bool"}` → receives boolean
- **segments**: `{"type": "segments", "count_range": {...}, "segment_params": {...}}` → special handling
- **base_seed**: Phase 1: provide in next_batch_plan | Phase 2: auto-injected from parameter_space

Use get_generator_api_doc tool for detailed examples and advanced patterns."""
                            }
                        },
                        "required": ["runtime_config", "generator_code"]
                    }
                )
            ]
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            """Handle tool calls with gatekeeper enforcement"""
            
            # Gatekeeper check for fuzzer tools (both are EXECUTE phase tools per R-EX5)
            gatekeeper_error = self._check_workflow_gatekeeper(name)
            if gatekeeper_error:
                required_phase = "EXECUTE"  # Both fuzz and get_generator_api_doc are EXECUTE phase tools
                return [types.TextContent(
                    type="text",
                    text=gatekeeper_error + "\n\n**Required Actions:**\n"
                         "1. Read workflow_state.md to check current phase\n"
                         f"2. Use transition_phase tool to transition to {required_phase} phase\n"
                         f"3. Ensure all {required_phase} phase prerequisites are met\n"
                         "4. Then retry this tool"
                )]
            
            try:
                if name == "get_generator_api_doc":
                    # This tool doesn't require fuzzer initialization
                    topic = arguments.get("topic", "overview")
                    doc_content = self._get_generator_documentation(topic)
                    return [types.TextContent(type="text", text=doc_content)]
                    
                elif name == "fuzz":
                    # Check fuzzer initialization for fuzz tool
                    if not self.config or not self.fuzzer:
                        return [types.TextContent(
                            type="text", 
                            text="Error: PropertyBasedFuzzer not initialized. Please run with proper configuration."
                        )]
                    
                    # Extract arguments
                    plan_dict = arguments.get("plan", {})
                    runtime_config_dict = arguments.get("runtime_config", {})
                    generator_code = arguments.get("generator_code", "")
                    
                    # Validate generator code
                    if not generator_code.strip():
                        return [types.TextContent(
                            type="text",
                            text="Error: generator_code is required"
                        )]
                    
                    if "def generate(" not in generator_code:
                        return [types.TextContent(
                            type="text",
                            text="Error: generator_code must contain a 'generate' function definition"
                        )]
                    
                    try:
                        # Auto-convert categorical parameters to int_range when appropriate
                        if 'parameter_space' in plan_dict:
                            plan_dict['parameter_space'] = self._auto_convert_categorical_to_int_range(
                                plan_dict['parameter_space']
                            )
                        
                        # Set default fuzz_timeout_sec for MCP server (12 seconds)
                        if "fuzz_timeout_sec" not in runtime_config_dict:
                            runtime_config_dict["fuzz_timeout_sec"] = 12.0
                        
                        # Use Pydantic to validate and parse inputs
                        plan = FuzzPlan.model_validate(plan_dict)
                        runtime_config = RuntimeConfig.model_validate(runtime_config_dict)
                        
                        # Validate that all parameter_space params appear in next_batch_plan entries
                        param_space = plan_dict.get('parameter_space', {})
                        batch_plan = plan_dict.get('next_batch_plan', [])
                        if param_space and batch_plan:
                            missing_params_by_entry = []
                            for i, entry in enumerate(batch_plan):
                                entry_dict = entry if isinstance(entry, dict) else entry.model_dump()
                                missing = [p for p in param_space.keys() if p not in entry_dict]
                                if missing:
                                    missing_params_by_entry.append((i, missing))
                            
                            if missing_params_by_entry:
                                error_msg = "❌ **Batch Plan Validation Error:**\n\n"
                                error_msg += "All parameters from parameter_space must appear in EVERY next_batch_plan entry.\n\n"
                                error_msg += f"**Parameter space defines:** {', '.join(param_space.keys())}\n\n"
                                error_msg += "**Missing parameters in entries:**\n"
                                for idx, missing in missing_params_by_entry:
                                    error_msg += f"• Entry {idx + 1}: missing {', '.join(missing)}\n"
                                error_msg += f"\n**Fix:** Add missing parameters to each batch plan entry."
                                return [types.TextContent(type="text", text=error_msg)]
                        # cmd is required in runtime_config, no fallback needed
                        # reached_pattern and triggered_pattern have defaults in RuntimeConfig schema
                        self.logger.info("Starting fuzzing session with %d planned iterations", 
                                       runtime_config.max_iters)
                        self.logger.debug("Plan: %s", plan.model_dump())
                        self.logger.debug("Runtime config: %s", runtime_config.model_dump())
                        
                        # Use existing fuzzer instance (timeout is now handled internally)
                        results = self.fuzzer.fuzz(plan, runtime_config, generator_code)
                        
                    except ValidationError as e:
                        # Format validation errors nicely
                        error_msg = "Validation Error:\n"
                        for error in e.errors():
                            loc = " -> ".join(str(l) for l in error['loc'])
                            error_msg += f"  • {loc}: {error['msg']}\n"
                            if 'ctx' in error:
                                error_msg += f"    Context: {error['ctx']}\n"
                        
                        return [types.TextContent(
                            type="text",
                            text=error_msg
                        )]
                    
                    # Format comprehensive results for LLM consumption
                    # Results is always a Pydantic model
                    results_dict = results.model_dump()
                    summary = results_dict.get("summary", {})
                    iterations = results_dict.get("iterations", [])
                    
                    result_text = "🧪 **Property-Based Fuzzing Results**\n\n"
                    
                    # Executive Summary
                    result_text += "📊 **Executive Summary:**\n"
                    result_text += f"• Total iterations executed: {summary.get('total_iterations', 0)}\n"
                    result_text += f"• Detailed results available: {len(iterations)}\n"
                    result_text += f"• Target reached: {summary.get('reached_count', 0)} times ({summary.get('reached_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
                    result_text += f"• Bug triggered: {summary.get('triggered_count', 0)} times ({summary.get('triggered_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
                    result_text += f"• Timeouts: {summary.get('timeout_count', 0)} ({summary.get('timeout_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
                    result_text += f"• Errors: {summary.get('error_count', 0)} ({summary.get('error_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
                    
                    # Fuzzing input files. saved generator, plan, runtime_config
                    if summary.get("generator_file"):
                        result_text += f"• Generator file: {summary.get('generator_file')}\n"
                    if summary.get("plan_file"):
                        result_text += f"• Plan file: {summary.get('plan_file')}\n"
                    if summary.get("runtime_config_file"):
                        result_text += f"• Runtime config file: {summary.get('runtime_config_file')}\n"
                    
                    # Overall Status
                    if summary.get("triggered_count", 0) > 0:
                        result_text += "\n🎯 **STATUS: SUCCESS** - Bug triggered! PoC saved to crashes/ directory.\n"
                    elif summary.get("reached_count", 0) > 0:
                        result_text += "\n🟡 **STATUS: PARTIAL** - Target reached but bug not triggered.\n"
                    else:
                        result_text += "\n🔴 **STATUS: NO SUCCESS** - Target not reached.\n"
                    
                    # Phase Analysis
                    batch_plan_size = len(plan.next_batch_plan)
                    if batch_plan_size > 0:
                        result_text += "\n📋 **Phase Analysis:**\n"
                        result_text += f"• Phase 1 (Targeted): {min(batch_plan_size, summary.get('total_iterations', 0))} iterations from batch plan\n"
                        
                        if plan.breakpoints:
                            result_text += f"  ⚠️ **Debugger Mode Active**: Phase 1 uses debugger for breakpoint evaluation\n"
                            result_text += f"  💡 **Tip**: Timeout automatically increased 3x (min 3s) for debugger mode\n"
                        
                        if summary.get('total_iterations', 0) > batch_plan_size:
                            result_text += f"• Phase 2 (Exploration): {summary.get('total_iterations', 0) - batch_plan_size} iterations from parameter space\n"
                    
                    # Detailed Iteration Results
                    if iterations:
                        result_text += "\n📝 **Detailed Iteration Results:**\n"
                        
                        # Separate Phase 1 and Phase 2 results
                        phase1_results = [it for it in iterations if it is not None and it.get("iter", 0) <= batch_plan_size]
                        phase2_results = [it for it in iterations if it is not None and it.get("iter", 0) > batch_plan_size]
                        
                        # Show Phase 1 results
                        if phase1_results:
                            result_text += f"\n🎯 **Phase 1 Results** (Batch Plan - {len(phase1_results)} shown):\n"
                            for iter_result in phase1_results:
                                result_text += self._format_iteration_result(iter_result)
                        
                        # Show Phase 2 results with special focus on reached cases
                        if phase2_results:
                            phase2_reached = [it for it in phase2_results if it.get("reached", 0)]
                            result_text += f"\n🔄 **Phase 2 Results** (Parameter Sampling - {len(phase2_results)} shown):\n"
                            
                            # Show reached cases first with parameters
                            if phase2_reached:
                                result_text += f"\n✅ **Phase 2 Reached Cases** ({len(phase2_reached)} cases):\n"
                                for iter_result in phase2_reached:
                                    iter_num = iter_result.get("iter", 0)
                                    params = iter_result.get("parameters", {})
                                    testcase_file = iter_result.get("testcase_file")
                                    result_text += f"\n**Iteration {iter_num}** ✅ REACHED\n"
                                    if testcase_file:
                                        result_text += f"  • **Saved Testcase**: {testcase_file}\n"
                                    result_text += f"  • **Used Parameters**: {json.dumps(params, indent=2)}\n"
                        
                        else:
                            result_text += "\n🔄 **Phase 2 Results**: No Phase 2 results stored (only errors/triggers/timeouts are kept)\n"
                    
                    # Error Pattern Analysis
                    error_iterations = [it for it in iterations if it is not None and it.get("type") == "error"]
                    if error_iterations:
                        result_text += "\n⚠️ **Error Pattern Analysis:**\n"
                        error_stages = {}
                        for err_iter in error_iterations:
                            stage = err_iter.get("stage", "unknown")
                            message = err_iter.get("message", "Unknown error")
                            if stage not in error_stages:
                                error_stages[stage] = []
                            error_stages[stage].append(message)
                        
                        for stage, messages in error_stages.items():
                            result_text += f"• **{stage}**: {len(messages)} error(s)\n"
                            # Show unique error messages
                            unique_messages = list(set(messages))
                            for msg in unique_messages[:3]:  # Show first 3 unique messages
                                count = messages.count(msg)
                                result_text += f"  - {msg} (×{count})\n"
                            if len(unique_messages) > 3:
                                result_text += f"  - ... and {len(unique_messages) - 3} more unique errors\n"
                    
                    # Strategic Recommendations
                    result_text += "\n💡 **Strategic Recommendations:**\n"
                    
                    # Workflow state update recommendations
                    result_text += "• **MANDATORY**: Use workflow MCP server tools to update metrics, preconditions, and trigger plans\n"
                    
                    # Error rate analysis
                    error_rate = summary.get("error_count", 0) / max(summary.get("total_iterations", 1), 1)
                    if error_rate > 0.5:
                        result_text += "• **HIGH ERROR RATE**: Check generator code and command configuration.\n"
                    elif error_rate > 0.2:
                        result_text += "• **MODERATE ERROR RATE**: Review generator logic and parameter handling.\n"
                    
                    # Timeout analysis
                    timeout_rate = summary.get("timeout_count", 0) / max(summary.get("total_iterations", 1), 1)
                    if timeout_rate > 0.3:
                        result_text += "• **HIGH TIMEOUT RATE**: Consider increasing timeout or optimizing generator.\n"
                    
                    # Timeout Information
                    timeout_info = summary.get("timeout_info")
                    if timeout_info and timeout_info.get("timed_out"):
                        result_text += f"\n⏰ **TIMEOUT OCCURRED** - Fuzzing stopped after {timeout_info.get('elapsed_time_sec', 0):.2f}s (limit: {timeout_info.get('timeout_limit_sec', 30)}s)\n"
                        result_text += f"• **Phase when timeout occurred**: {timeout_info.get('phase', 'Unknown')}\n"
                        result_text += f"• **Completed iterations**: {timeout_info.get('completed_iterations', 0)}\n"
                        if timeout_info.get('remaining_batch_iterations', 0) > 0:
                            result_text += f"• **Remaining batch plan iterations**: {timeout_info.get('remaining_batch_iterations', 0)}\n"
                        if timeout_info.get('remaining_sampling_iterations', 0) > 0:
                            result_text += f"• **Remaining sampling iterations**: {timeout_info.get('remaining_sampling_iterations', 0)}\n"

                        result_text += "This MCP tool does not support long-term fuzzing, please avoid using it.\n"
                        result_text += "Instead, directly run the fuzzer from the command line:\n"
                        result_text += f"python3 {Path(__file__).parent / 'property_based_fuzzer.py'} "
                        result_text += f"{self.fuzzer.generator_dir}/gen_{self.fuzzer.round}.py "
                        result_text += f"{self.fuzzer.plan_dir}/plan_{self.fuzzer.round}.json "
                        result_text += f"{self.fuzzer.plan_dir}/runtime_config_{self.fuzzer.round}.json\n\n"                    

                    # Phase 1+2 Overall Assessment
                    if summary.get("triggered_count", 0) > 0:
                        result_text += "• **SUCCESS**: Bug triggered! Please update the metrics, transition to SUCCESS phase and terminate.\n"
                    elif summary.get("reached_count", 0) > 0:
                        result_text += "• **PARTIAL**: Target reached but not triggered. Please update the metrics, transition to REFLECT phase and analyze the reason.\n"
                    else:
                        result_text += "• **NO PROGRESS**: Target not reached. Please update the metrics, transition to REFLECT phase and analyze the reason.\n"
                    
                    return [types.TextContent(type="text", text=result_text)]
                
                else:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Unknown tool '{name}'"
                    )]
                    
            except Exception as e:
                self.logger.error("Error handling tool '%s': %s", name, str(e))
                import traceback
                error_details = traceback.format_exc()
                return [types.TextContent(
                    type="text",
                    text=f"Error executing fuzzing: {str(e)}\n\nDetails:\n{error_details}"
                )]

    async def run(self, output_dir: str):
        """Run the MCP server"""
        # Initialize fuzzer config
        if not await self.initialize_fuzzer(output_dir):
            self.logger.error("Failed to initialize PropertyBasedFuzzer")
            return False
        
        # Setup handlers
        self.setup_handlers()
        
        # Run server
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            self.logger.info("MCP Corpus Server started")
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
    
    # Setup signal handlers early
    setup_signal_handlers()
    
    parser = argparse.ArgumentParser(
        description="MCP Server for Property-Based Fuzzing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start MCP server with basic configuration
  python mcp_fuzzer_server.py --output-dir ./fuzzing_results -- ./target @@

  # With custom patterns and debugger support
  python mcp_fuzzer_server.py --output-dir ./results --reached-pattern "TARGET_REACHED" --triggered-pattern "BUG_FOUND" --enable-debugger -- ./target @@

  # Minimal setup for local testing
  python mcp_fuzzer_server.py --output-dir /tmp/fuzz_test -- ./test_program @@
        """
    )
    
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to store fuzzing results, generators, and crashes"
    )
    parser.add_argument(
        "--source-code-dir",
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    args = parser.parse_args()
    
    # Set log level
    logging.basicConfig(
        level='ERROR',
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Validate paths
    if not os.path.exists(os.path.dirname(os.path.abspath(args.output_dir))):
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.output_dir)), exist_ok=True)
        except Exception as e:
            print(f"Error creating output directory parent: {e}", file=sys.stderr)
            sys.exit(1)
    
    
    
    # Create and run server
    server = MCPFuzzerServer(source_code_dir=args.source_code_dir)
    
    try:
        ok = asyncio.run(server.run(
            output_dir=args.output_dir,
        ))
        if not ok:
            print("Error running server", file=sys.stderr)
            sys.exit(1)
    except KeyboardInterrupt:
        print("\nShutting down MCP Property-Based Fuzzer Server...")
        os._exit(0)
    except Exception as e:
        print(f"Error running server: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

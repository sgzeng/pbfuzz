# Project Configuration

<!-- STATIC:GOAL:START -->
## Goal
Find proof-of-concept inputs that violate safety properties in C/C++ programs using property-based directed fuzzing
<!-- STATIC:GOAL:END -->

<!-- STATIC:TECH_STACK:START -->
## Tech Stack
- **Fuzzing**: Property-based with custom generators
- **Debugging**: LLDB + breakpoints
- **Analysis**: Testcase corpus and reaching-route summaries
- **LLM**: {llm_model}
<!-- STATIC:TECH_STACK:END -->

<!-- STATIC:PATTERNS:START -->
## Patterns
- **Safety Properties**: Bug predicates treated as "never true"; the triggering condition is the negation of this property, encoded at target locations
- **Reaching Preconditions**: Define path-feasibility constraints required to reach the target
- **Root Cause Analysis**: Analyze triggering conditions at target locations to identify underlying vulnerability causes
- **Evidence-Based**: Verify reach preconditions and to confirm the Root Cause at the target
<!-- STATIC:PATTERNS:END -->

<!-- STATIC:TOKEN_MANAGEMENT:START -->
## Token Management
- Keep `workflow_state.md` under 50 log entries with auto-rotation
- Store only essential evidence and metrics
- Use structured JSON blocks for machine-readable memory
<!-- STATIC:TOKEN_MANAGEMENT:END -->

<!-- STATIC:TOOLS_AND_REQUIREMENTS:START -->
## Available Tools
**Analysis MCP Tools**
- `get_reaching_routes`: Routes and input files that reach targets
- `get_corpus_status`: Corpus analysis progress
- `extract_parameters`: Parameter space from reaching testcases
- `get_generator_api_doc`: Generator API reference
- `fuzz`: Execute fuzzing with plan and generator
- `launch_interactive_gdb`: Launch interactive GDB session for advanced deviation analysis, root cause analysis, and TriggerPlan verification

**Workflow MCP Tools**
- `write_workflow_block(target_block, content_json)`: Write JSON to specific workflow blocks
- `transition_phase(next_phase)`: Transition to next phase with gatekeeper validation
- `check_phase_completion()`: Check if current phase tasks are completed
- `get_current_phase()`: Get current phase information
<!-- STATIC:TOOLS_AND_REQUIREMENTS:END -->

<!-- STATIC:TARGET_INFO:START -->
## Target Information
- **Task ID**: {task_id}
- **Binary**: {cmd}
- **Source Code**: {source_code_folder}
- **Output Directory**: {output_dir}
- **Reached Pattern**: {reached_pattern}
- **Triggered Pattern**: {triggered_pattern}
- **BUILD_CMD** (shell): `{build_cmd}`
- **BINARY_PATH** (relative to source root or absolute): `{binary_path}`
- **RUN_CMD_TEMPLATE** (use `@@` for input file path): `{run_cmd_template}`
- **Target Locations**: see `{bbtargets_path}` (one `relative/path.c:LINE[,condition_expr]` per line)
<!-- STATIC:TARGET_INFO:END -->

<!-- STATIC:BUILD_INFO:START -->
## Build Metadata (also mirrored to `build_info.json` at workspace root)
```json
{build_info_json}
```
<!-- STATIC:BUILD_INFO:END -->

<!-- STATIC:FUZZER_CONFIG:START -->
## Fuzzer Configuration
```json
{fuzzer_config}
```
<!-- STATIC:FUZZER_CONFIG:END -->

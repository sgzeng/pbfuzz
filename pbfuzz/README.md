# Property-Based Directed Fuzzer

A LLM-powered fuzzing system that learns and generates targeted test inputs to trigger bugs in C/C++ programs.

## Overview

- **Safety Property Testing**: Treats bug predicates as Safety Properties ("never true")
- **Precondition Learning**: Learns Reaching Preconditions (path feasibility) and Triggering Preconditions (state at bug site)
- **Intelligent Generation**: Creates parameterized Python fuzzers to satisfy preconditions
- **Agent-Driven**: Uses cursor-agent with MCP tools for intelligent fuzzing strategy

## System Architecture

**Core Components:**
1. **cursor-agent**: Intelligent LLM agent with persistent workflow memory
2. **Workflow Memory System**: Dual-file persistent memory (`project_config.md` + `workflow_state.md`)
3. **MCP State Server**: Manages workflow state with phase-gated transitions
4. **MCP Analysis Servers**: Provide corpus and route analysis, and fuzzing execution
5. **PropertyBasedFuzzer**: Executes generated test cases with debugger integration

**Workflow System:**
- 🔄 **Phase-Gated Process**: PLAN → IMPLEMENT → EXECUTE → REFLECT
- 🧠 **Persistent Memory**: All preconditions, plans, and metrics survive agent restarts
- 📋 **Hierarchical Planning**: TriggerPlans (strategy) → FuzzPlan (concrete execution)
- ⚖️ **Complexity-Driven**: Always selects simplest viable approach first
- 🛡️ **Enforced Discipline**: Agent cannot bypass workflow or skip phases

**Key Features:**
- ✅ Persistent workflow state across agent sessions
- ✅ Phase-gated execution prevents workflow violations
- ✅ Complexity-based strategy selection and adaptation
- ✅ Integrated debugging with breakpoint support
- ✅ Complete operation traceability and metrics
- ✅ Auto-recovery from agent memory drift

## Installation

### Requirements

- Python 3.10+
- cursor-cli (cursor-agent command)
- LLDB debugger: `lldb-dap` or `lldb-vscode`
- Target binaries compiled with debug symbols (`-g` flag)
- Static analysis results (see Required Files below)

### Environment Setup

```bash
# Install cursor-cli (required for cursor-agent)
# See https://cursor.com/cli
curl https://cursor.com/install -fsS | bash

# Install Python dependencies
pip install -r requirements.txt

# Additional packages for full functionality
pip install pytest-asyncio google-auth google-genai openai anthropic
pip install tree-sitter tree-sitter-languages libclang pytest
pip install dap-mcp>=0.1.5 dap-types cxxfilt mcp==1.4.0

# Ensure LLVM tools are accessible
export PATH="/usr/lib/llvm-20/bin:$PATH"

# Verify debugger is available
which lldb-dap || which lldb-vscode
```

### Docker Setup

For containerized environments (recommended for Magma benchmarks):

```bash
# Run with privileged mode for debugger support
docker run --privileged --security-opt seccomp=unconfined

# Verify installation
python -m pytest tests/test_* -q
```

### API Keys

Set your LLM API key:

```bash
# Google Gemini
export GEMINI_API_KEY="your_api_key"

# OpenAI
export OPENAI_API_KEY="your_api_key"

# Anthropic Claude
export ANTHROPIC_API_KEY="your_api_key"
```

### Required Files

The system needs these static analysis files:
- `bid_loc_mapping.txt` - Bug ID to location mapping
- `function_info.txt` - Function information
- `BBtargets.txt` - Target basic blocks (validated at startup)

Optional inputs from your static-analysis pipeline (not required by the remaining MCP tools) may still include call-graph or distance artifacts on disk, but they are not consumed by the bundled MCP servers after this configuration.

## Usage

### Configuration File (Recommended)

Create a `config.json` file:

```json
{
  "static_result_folder": "./static_results",
  "llm_model": "gemini-2.5-pro",
  "source_code_folder": "./source",
  "output_dir": "./output",
  "reached_pattern": "Bug .{0,19} reached",
  "triggered_pattern": "Bug .{0,19} triggered",
  "cmd": ["./target", "@@"],
  "debug_enabled": true,
  "max_iters": 100,
  "exec_timeout_sec": 3,
}
```

```bash
# Run with config file
python launcher.py -config config.json
```

### Command Line Usage

```bash
# Basic usage
python launcher.py -s ./static_results -m gemini-2.5-pro -c ./source \
  -reached-pattern "TARGET_REACHED" -triggered-pattern "BUG_TRIGGERED" \
  ./target @@

# With debug and custom settings
python launcher.py -s ./static_results -m gpt-4o -c ./source_code \
  -o ./results -debug -max-fuzz-gen 50 -exec-timeout-sec 5 \
  -agent-timeout-sec 1200 -reached-pattern "REACHED" \
  -triggered-pattern "TRIGGERED" ./target @@
```

### Baseline Mode

For simple testing without static analysis requirements:

```bash
# Baseline mode (no static analysis required)
python launcher.py -baseline -c ./source -o ./output \
  -reached-pattern "Bug reached" -triggered-pattern "Bug triggered" \
  -- ./target @@
```

Baseline mode automatically disables MCP servers and only requires:
- `-c`: Source code directory
- `-o`: Output directory (optional, defaults to `./output`)
- `-reached-pattern`: Pattern for reached target
- `-triggered-pattern`: Pattern for triggered bug
- `cmd`: Command line with `@@` placeholder

### Parameters

**Required (unless in config file or baseline mode):**
- `-s PATH`: Static analysis results directory (need BBtargets.txt to get the target locations)
- `-c PATH`: Source code directory
- `-reached-pattern STR`: Pattern to match for reached target
- `-triggered-pattern STR`: Pattern to match for triggered bug
- `cmd`: Command line with `@@` placeholder for input file

**Optional:**
- `-config PATH`: Configuration file path
- `-baseline`: Enable baseline mode (simplified requirements)
- `-o PATH`: Output directory (default: `./output`)
- `-debug`: Enable debug mode
- `-max-fuzz-gen N`: Max iterations per round (default: 100)
- `-exec-timeout-sec N`: Timeout per execution (default: 3)
- `-agent-timeout-sec N`: Timeout for agent (default: 600)

### Help and System Status

```bash
# Show usage examples and check environment
python launcher.py -help
```

## How It Works

**Workflow Phases:**

1. **PLAN**: Initialize workflow and analyze target code, infer preconditions, create TriggerPlans with complexity scores
2. **IMPLEMENT**: Convert TriggerPlans to concrete ParameterSpace and generate FuzzPlan with breakpoints
3. **EXECUTE**: Execute fuzzing with debugger integration, collect evidence and metrics
4. **REFLECT**: Analyze test failures (no-reach vs reach/no-trigger), prepare findings for PLAN phase

**Key Mechanisms:**
- **Persistent Memory**: All state survives across agent restarts via `workflow_state.md`
- **Phase Gating**: Agent cannot skip phases or call fuzzing outside EXECUTE
- **Complexity Evolution**: Failed plans get higher complexity scores, successful patterns get lower scores
- **Automatic Recovery**: Agent always starts by reading complete workflow state

## Output

The system generates:
- `./source_code/.cursor/project_config.md` - Long-term project memory (source code, targets, config)
- `./source_code/.cursor/workflow_state.md` - Dynamic workflow state (phase, plans, metrics, log)
- `./output/prompt.txt` - Generated prompt for cursor-agent
- `./output/agent.log` - Complete agent execution log
- `./output/fuzzing_results/` - Test cases, crashes, and fuzzing logs
- `./output/corpus_results/` - Processed corpus and reaching testcases
- `.cursor/mcp.json` - Auto-generated MCP server configuration

## Testing

```bash
# Run test suite
python -m pytest tests/test_* -q

# Test specific functionality
python -m pytest tests/test_mcp_fuzzer_server.py -v
```

## Troubleshooting

**Common Issues:**
- **cursor-agent not found**: Install cursor-cli and ensure it's in PATH
- **MCP timeout**: Check that static analysis files exist and are non-empty
- **Debugger errors**: Verify LLDB is installed and container runs with `--privileged`
- **API errors**: Ensure correct API key is set for your chosen LLM model

**Environment Status:**
- ✅ Core fuzzing: Fully operational
- ✅ LLM integration: Fully operational  
- ✅ Property-based generation: Fully operational
- ✅ Workflow memory system: Fully operational
- ✅ Phase-gated execution: Fully operational
- ⚠️ Interactive debugging: Limited by DAP implementation in some environments
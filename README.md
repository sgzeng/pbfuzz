# PBFuzz: Agentic Directed Fuzzing for PoV Generation

> **CCS 2026** — [arXiv:2512.04611](https://arxiv.org/abs/2512.04611)

## Citation

```bibtex
@misc{zeng2025pbfuzzagenticdirectedfuzzing,
      title={PBFuzz: Agentic Directed Fuzzing for PoV Generation},
      author={Haochen Zeng and Andrew Bao and Jiajun Cheng and Chengyu Song},
      year={2025},
      eprint={2512.04611},
      archivePrefix={arXiv},
      primaryClass={cs.CR},
      url={https://arxiv.org/abs/2512.04611},
}
```

## About

Generating a proof-of-vulnerability (PoV) input requires satisfying two constraints simultaneously: **reachability** (reaching the vulnerable code) and **triggering** (activating the bug). Directed greybox fuzzers address reachability but struggle with triggering; LLM chatbots understand semantics but cannot solve complex input constraints reliably.

PBFuzz bridges this gap with an agentic approach: an LLM agent autonomously analyzes source code to extract semantic reachability and triggering constraints, encodes them as typed parameter spaces, then uses property-based testing (PBT) as a custom constraint solver to search for PoV inputs — achieving what neither fuzzing nor LLMs alone can.

## Repository Layout

```
pbfuzz_source/
├── launcher.py                    # Entry point — orchestrates the full pipeline
├── prompt.py                      # Builds the agent system prompt and workflow state
├── config.py                      # CLI argument parsing and config file loading
├── source_code.py                 # Source code indexing and project config generation
├── property_based_fuzzer.py       # PBT-based fuzzer (hypothesis + custom sampler)
├── debugger.py                    # LLDB integration for execution feedback
├── schemas.py                     # Pydantic schemas for workflow state
├── utils.py / ts.py               # Utilities and type helpers
├── mcp_fuzzer_server.py           # MCP tool: run/monitor the PBT fuzzer
├── mcp_corpus_server.py           # MCP tool: corpus and reaching-testcase analysis
├── mcp_call_graph_server.py       # MCP tool: call graph traversal (callers/callees)
├── mcp_deviation_detector_server.py # MCP tool: path deviation detection
├── mcp_gdb_server.py              # MCP tool: GDB/LLDB debugger interface
├── mcp_workflow_server.py         # MCP tool: gated workflow state transitions
├── templates/
│   ├── project_config.md          # Template for long-term project memory
│   └── workflow_state.md          # Template for dynamic PIER workflow state
└── tests/
    ├── fixtures/                  # Toy targets and static analysis results for unit tests
    └── test_*.py                  # Unit and integration tests per component
```

## Quick Start

### 1. Prerequisites

- Python 3.10+
- [Cursor agent CLI](https://cursor.com/cli): `cursor-agent`
- LLDB: `lldb-20` (or `lldb-dap`)
- Target binary compiled with debug symbols (`-g`)
- Static analysis results (at minimum `BBtargets.txt`)

```bash
# Install cursor-agent
curl https://cursor.com/install -fsS | bash

# Install Python dependencies
pip3 install -r requirements.txt

# Make LLVM tools accessible (Linux)
export PATH="/usr/lib/llvm-20/bin:$PATH"
```

### 2. Authenticate Cursor

```bash
# Interactive login (local machine)
cursor-agent login

# Headless / CI: export auth from a machine with a valid session
export CURSOR_AUTH="$(base64 -w0 < ~/.config/cursor/auth.json)"
```

### 3. Create a config file

```json
{
  "static_result_folder": "./static_results",
  "llm_model": "gemini-2.5-pro",
  "source_code_folder": "./source",
  "output_dir": "./output",
  "reached_pattern": "Bug .{0,19} reached",
  "triggered_pattern": "Bug .{0,19} triggered",
  "cmd": ["/absolute/path/to/target", "@@"],
  "exec_timeout_sec": 3,
  "max_iters": 1000
}
```

### 4. Run

```bash
python3 launcher.py -config config.json
```

That's it. PBFuzz will run the PLAN → IMPLEMENT → EXECUTE → REFLECT loop until a PoV is found or `max_iters` is exhausted.

## How It Works

PBFuzz runs a four-phase **PIER** loop driven by an LLM agent:

| Phase | What happens |
|-------|-------------|
| **PLAN** | Agent reads source code and static analysis, infers reachability and triggering constraints, produces ranked `TriggerPlan`s |
| **IMPLEMENT** | Agent translates plans into typed `ParameterSpace` definitions and a Python input generator (PBT fuzzer) |
| **EXECUTE** | PBT fuzzer samples the parameter space and runs the target under LLDB; collects reach/trigger signals |
| **REFLECT** | Agent diagnoses failures (no-reach vs. reach/no-trigger), refines hypotheses, and feeds back into PLAN |

Three mechanisms keep the agent on track across long sessions:

- **Persistent memory** (`workflow_state.md`) — all hypotheses, plans, and evidence survive agent restarts
- **Phase gating** (`mcp_workflow_server`) — enforces valid phase transitions; agent cannot jump ahead
- **Custom MCP toolset** — call graph traversal, corpus analysis, deviation detection, and debugger access on demand

## Configuration Reference

**Required** (in config file or on the command line):

| Flag | Description |
|------|-------------|
| `-s PATH` | Static analysis results directory (must contain `BBtargets.txt`) |
| `-m MODEL` | LLM model (e.g. `gemini-2.5-pro`, `claude-sonnet-4-6`, `gpt-4o`) |
| `-c PATH` | Source code directory |
| `-reached-pattern STR` | Regex matching the "target reached" log line |
| `-triggered-pattern STR` | Regex matching the "bug triggered" log line |
| `cmd` | Target command; use `@@` as the input file placeholder |

**Optional:**

| Flag | Default | Description |
|------|---------|-------------|
| `-config PATH` | — | Load all settings from a JSON file |
| `--cursor-auth-b64` | `$CURSOR_AUTH` | Base64-encoded Cursor auth JSON |
| `-o PATH` | `./output` | Output directory |
| `-debug` | off | Enable verbose debug logging |
| `-max-fuzz-gen N` | 1000 | Max PBT iterations per EXECUTE phase |
| `-exec-timeout-sec N` | 3 | Per-execution timeout (seconds) |
| `-agent-timeout-sec N` | 3600 | Full agent session timeout (seconds) |
| `-disable-mcp` | off | Disable MCP server integration |

## Static Analysis Files

Only `BBtargets.txt` is required. The others unlock additional MCP tools when present:

| File | Required | Purpose |
|------|----------|---------|
| `BBtargets.txt` | Yes | Target lines / bug locations |
| `bid_loc_mapping.txt` | No | Bug ID → source location mapping |
| `function_info.txt` | No | Function signatures and metadata |
| `caller-callee.txt` | No | Call graph (forward edges) |
| `callee-caller.txt` | No | Call graph (reverse edges) |
| `critical_BBs.txt` | No | Basic blocks for deviation detection |

## Output

| Path | Contents |
|------|---------|
| `<source>/.cursor/project_config.md` | Long-term project memory (targets, source layout, config) |
| `<source>/.cursor/workflow_state.md` | Live workflow state (phase, plans, metrics, evidence log) |
| `<output>/prompt.txt` | Agent system prompt (for debugging) |
| `<output>/agent.log` | Full agent execution log (streamed in real-time) |
| `<output>/fuzzing_results/` | Generated test cases and crashes |
| `<output>/corpus_results/` | Processed corpus and reaching test cases |

## Testing

```bash
# Compile the bundled test target
g++ -g -O0 -o tests/fixtures/readelf tests/fixtures/readelf.cpp

# Run unit and integration tests
python3 -m pytest tests/test_* -q
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `cursor-agent: command not found` | Install from https://cursor.com/cli and ensure it's in `$PATH` |
| `cursor-agent` not authenticated | Run `cursor-agent login` or set `CURSOR_AUTH` env var |
| MCP server timeout | Check that static analysis files exist and are non-empty |
| Debugger errors | Verify `lldb-20` or `lldb-dap` is installed; containers need `--privileged` |
| API errors | Set the correct API key env var for your LLM (e.g. `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) |

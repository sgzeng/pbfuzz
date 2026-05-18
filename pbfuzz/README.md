# PBFuzz core

Property-based directed fuzzing engine used by the standalone `pbfuzz` CLI (`../src/pbfuzz_repro/`).

## Components

- **launcher.py** — writes `prompt.txt`, workflow templates, and MCP config
- **mcp_fuzzer_server.py** — property-based fuzz execution
- **mcp_gdb_server.py** — interactive debugging
- **mcp_workflow_server.py** — phase-gated workflow state
- **mcp_build_server.py** — oracle insertion and rebuild

## Workflow

PLAN → IMPLEMENT → EXECUTE → REFLECT (see `templates/workflow_state.md`).

INIT (build + BBtargets + baseline oracles) is run by the reproduction driver before the inner agent starts at PLAN.

## Direct use (advanced)

```bash
python launcher.py -config config.json
```

Config keys include `static_result_folder`, `source_code_folder`, `cve_id`, `build_cmd`, `binary_path`, `cmd`, `reached_pattern`, `triggered_pattern`.

## Tests

```bash
python -m pytest tests/test_mcp_build_server.py tests/test_mcp_fuzzer_server.py -q
```

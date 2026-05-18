# PBFuzz

Agentic directed fuzzing for **CVE bug reproduction**. Given a CVE description, an optional upstream **fix patch**, and a source repository, PBFuzz builds the vulnerable revision, instruments reach/trigger oracles, and runs a **PLAN → IMPLEMENT → EXECUTE → REFLECT** loop (via [cursor-agent](https://cursor.com/cli) and MCP tools) to produce a PoC input.

## Requirements

- Python 3.10+
- [cursor-agent](https://cursor.com/cli) on `PATH`
- LLDB (`lldb-dap` or system `lldb`) for debugger MCP
- Native build toolchain (`gcc`, `make`, `cmake`, etc.)
- Cursor auth: `~/.config/cursor/auth.json` or `CURSOR_AUTH` (base64)

```bash
curl -fsSL https://cursor.com/install | bash
uv sync
uv pip install -r pbfuzz/requirements.txt
```

## Usage

```bash
export CURSOR_AUTH="$(base64 -w0 < ~/.config/cursor/auth.json)"   # optional if auth.json exists

uv run pbfuzz reproduce \
  --cve-description /path/to/CVE_description.txt \
  [--patch           /path/to/fix.patch] \
  --source          /path/to/git-repo \
  --output          /path/to/run-output \
  --model           gemini-2.5-pro \
  --max-outer-rounds 2 \
  --max-inner-iter 10
```

**Inputs**

| Flag | Meaning |
|------|---------|
| `--cve-description` | Text file with CVE id and description |
| `--patch` | *(optional)* Upstream fix patch (unified diff); when provided, INIT derives target lines and trigger conditions from the patch. When omitted, INIT infers oracles from the CVE description and source analysis only |
| `--source` | Git repository root (INIT agent creates `<run>/source` via `git worktree`) |
| `--output` | Run directory: `inputs/`, `env/`, `source/`, `findings/`, and final `poc.bin` |

**Success** — `poc.bin` is written and the built binary aborts with a sanitizer report (ASan/UBSan/MSan) when fed the PoC.

## Output directory layout

`pbfuzz reproduce --output <run-root>` creates a single run tree grouped by producer. Paths below use `<run-root>` (e.g. `/tmp/pbfuzz-runs/cve-2024-22860` from `ffmpeg_demo.sh`).

### Overview tree

```
<run-root>/
  TASK.md                            # driver — task summary for agents
  runtime.log                        # driver — timeline (includes [error] lines)
  poc.bin                            # driver — final PoC (only after sanitizer crash)

  inputs/
    CVE_description.txt              # user input
    fix.patch                        # user input (optional; omitted when --patch not passed)

  source/                            # shared build tree (INIT creates; inner agent edits)
    .cursor/
      cli.json                       # cursor_runner permissions
      mcp.json                       # launcher generate_mcp_config
      project_config.md              # launcher create_workflow_files
      workflow_state.md              # PLAN→REFLECT state
    schemas.py                       # launcher copies from pbfuzz/
    cursor.log                       # inner cursor-agent (live)
    …                                # vulnerable source + build artifacts

  env/                               # INIT / env-setup agent
    build_info.json                  # build_cmd, run_cmd, bug_class, sanitizer, …
    static_results/
      BBtargets.txt                  # target locations (from fix.patch)
    init_agent_{N}.log               # INIT cursor-agent log snapshot
    init_ws/                         # INIT cursor-agent private cwd
      .cursor/cli.json
      cursor.log
      inputs/ → symlink to <run-root>/inputs/

  findings/                          # inner pbfuzz agent (= fuzzer output_dir)
    agent.log                        # snapshot of source/cursor.log
    prompt.txt                       # launcher.py — inner agent prompt
    launcher.json                    # driver — fuzzer config for this round
    last_build.log                   # mcp_build rebuild log
    pbf_error.log                    # PBF errors
    cur_testcase                     # current fuzz input
    sanitizer_run_{N}.log            # driver PoC verification run
    driver_errors.log                # driver errors
    candidate_poc.bin                # PBF trigger artifact
    CANDIDATE_READY                  # marker: poc_{round}_{iter}
    plans/
      plan_{N}.json
      runtime_config_{N}.json
    generators/
      gen_{N}.py
    fuzz_results/
      results_{N}.json
    testcases/
    queue/
    crashes/
      poc_{N}_{iter}
    .cursor/                         # snapshot of source/.cursor/
      mcp.json
      cli.json
      workflow_state.md
      project_config.md
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_AUTH` | Base64-encoded `auth.json` |
| `PBFUZZ_LLM_MODEL` / `CURSOR_MODEL` | Model for cursor-agent |
| `MAX_INNER_ITER` | Fuzz iterations per round (default 10) |
| `MAX_OUTER_ROUNDS` | Outer driver rounds (CLI flag) |
| `INIT_TIMEOUT_SEC` / `INNER_TIMEOUT_SEC` | Timeouts (CLI flags) |
| `EXEC_TIMEOUT_SEC` | Per-execution timeout for fuzzer (default 5) |
| `PBFUZZ_HOME` | Path to embedded `pbfuzz/` package |
| `LLDB_PATH` | Debugger binary (default `/usr/bin/lldb-20`) |

## Tests

```bash
uv sync --extra test
uv run pytest tests/ pbfuzz/tests/test_mcp_build_server.py -q
```

## Reference

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

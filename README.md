# PBFuzz

Agentic directed fuzzing for **CVE bug reproduction**. Given a CVE description, an upstream **fix patch**, and a source repository, PBFuzz builds the vulnerable revision, instruments reach/trigger oracles, and runs a **PLAN → IMPLEMENT → EXECUTE → REFLECT** loop (via [cursor-agent](https://cursor.com/cli) and MCP tools) to produce a PoC input.

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
  --patch           /path/to/fix.patch \
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
| `--patch` | Upstream fix patch (unified diff); used to derive target lines and trigger conditions |
| `--source` | Git repository root (agent creates `work/source` via `git worktree`) |
| `--output` | Run directory: logs, `work/`, and final `poc.bin` |

**Success** — `poc.bin` is written and stderr from the built binary contains `{CVE-ID} triggered` (oracle inserted during INIT).

## Layout after a run

```
output/
  TASK.md
  runtime.log
  poc.bin              # final PoC (if found)
  inputs/
    CVE_description.txt
    fix.patch
  work/
    source/            # vulnerable git worktree
    build_info.json
    static_results/BBtargets.txt
    output/            # fuzzer logs, candidate_poc.bin
  logs/                # mirrored debug artifacts
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

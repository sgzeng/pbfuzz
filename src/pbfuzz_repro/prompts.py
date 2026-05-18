"""INIT prompt and workspace guide for standalone CVE reproduction."""

from __future__ import annotations

from pathlib import Path

from pbfuzz_repro.workspace import RunLayout

WORKSPACE_FILES_GUIDE = """Files (run output directory):
- TASK.md — summary of this reproduction task (read first).
- inputs/CVE_description.txt — CVE identifier and description.
- inputs/fix.patch — upstream fix patch (ground truth for target locations).
- env/ — INIT agent outputs:
  - build_info.json — build metadata, bug_class, sanitizer, run_cmd.
  - static_results/BBtargets.txt — Target Locations (from fix.patch).
  - init_ws/ — private INIT cursor workspace (do not use for builds).
- source/ — vulnerable project tree (git worktree you create at `<run>/source`).
- findings/ — inner fuzz agent output (do not write here during INIT).
"""

WORKSPACE_FILES_GUIDE_NO_PATCH = """Files (run output directory):
- TASK.md — summary of this reproduction task (read first).
- inputs/CVE_description.txt — CVE identifier and description (no fix patch provided).
- env/ — INIT agent outputs:
  - build_info.json — build metadata, bug_class, sanitizer, run_cmd.
  - static_results/BBtargets.txt — Target Locations (inferred from CVE description + source).
  - init_ws/ — private INIT cursor workspace (do not use for builds).
- source/ — vulnerable project tree (git worktree you create at `<run>/source`).
- findings/ — inner fuzz agent output (do not write here during INIT).
"""

INIT_PROMPT_WITH_PATCH = """You are the **INIT** agent for standalone CVE bug reproduction with PBFuzz.
Your job is environment setup only: identify the vulnerable revision, create an isolated
git worktree, produce a working native build with the correct sanitizer, and write Target
Locations derived from the fix patch. Do **not** start fuzzing or PoC generation here.

""" + WORKSPACE_FILES_GUIDE + """

## Resolved paths (filled in by the driver)

The driver appends a **Resolved paths** block below with absolute paths for:
- **Source repository** (git root; run `git worktree` from here)
- **Run output directory** (contains `inputs/`, `env/`, `source/`, `findings/`, `TASK.md`)
- **Env directory** (`env/` — write `build_info.json` and `static_results/` here)
- **Vulnerable tree** (`source/` — create via `git worktree add`)

## Your tasks (shell tools only; no MCP tools)

1. Read `inputs/CVE_description.txt` and `inputs/fix.patch`. Extract **cve_id**
   (e.g. `CVE-xxxx-xxxxx`) and understand the vulnerability.
2. From the CVE description, fix patch, and `git log` / tags in the source repository,
   determine the **vulnerable git ref** (commit, tag, or `commit^` before the fix).
   Create an isolated worktree:
   ```bash
   git -C <source-repo> worktree add -f <run>/source <vuln_ref>
   ```
   All builds and edits happen under `<run>/source/`.
3. Discover the build system under `source/` (configure, cmake, make, etc.).
   Install missing OS packages with `apt-get install -y` when needed (you may run as root).
   Build the **correct program** named in the CVE description (e.g. `ffprobe` for demuxer/parser
   bugs, not only `ffmpeg`). Enable only what you need (`--enable-ffprobe`, etc.).

4. **Bug class & sanitizer (required)** — classify the CVE into one of:
   `{heap-buffer-overflow, stack-buffer-overflow, integer-overflow, signed-shift, null-deref,
   use-after-free, uninit-memory, divide-by-zero, oob-read, oob-write, other}`
   and choose the matching sanitizer: `asan`, `ubsan`, `msan`, or `asan+ubsan`.
   Embed `-fsanitize=...`, `-fno-omit-frame-pointer`, `-g`, and `-O1` in **both** compile and
   link flags inside `build_cmd`. Example for integer overflow: `-fsanitize=undefined` or
   `asan+ubsan` for heap issues.

5. Write **`env/build_info.json`**:
   ```json
   {
     "cve_id": "CVE-YYYY-NNNNN",
     "build_cmd": "shell command that rebuilds from cwd below",
     "cwd": "subdir under source/ relative to that tree; empty string = source root",
     "binary_path": "path to executable relative to source/ or absolute",
     "run_cmd": ["./built_binary", "@@"],
     "bug_class": "integer-overflow",
     "sanitizer": "asan+ubsan",
     "sanitizer_env": {
       "ASAN_OPTIONS": "abort_on_error=1:detect_leaks=0:symbolize=1",
       "UBSAN_OPTIONS": "print_stacktrace=1:halt_on_error=1"
     }
   }
   ```
   `@@` in `run_cmd` is the input-file placeholder.
   **`run_cmd` must match how the CVE is triggered** (demuxer name, format flag, etc.).
   **`build_cmd` must succeed** when run with `cwd` as documented.

6. Write **`env/static_results/BBtargets.txt`** by parsing `inputs/fix.patch` — one entry
   per interesting changed line:
   ```
   relative/path.c:LINE[,condition_expr]
   ```
   - Paths are relative to `source/`.
   - `LINE` is 1-based inside the vulnerable file.
   - `condition_expr` is a C expression that is **non-zero when the bug fires**.

   **Critical oracle placement rule**: `LINE` must be placed **at the root cause location
   and BEFORE any operation that the sanitizer will abort on**. The driver inserts an oracle
   using `fprintf(stderr, ...)` at that line. The execution order must be:
   1. oracle `fprintf(stderr, "... reached\\n")` → fuzzer sees it on stderr
   2. oracle `fprintf(stderr, "... triggered\\n")` if condition is true → fuzzer sees it
   3. the buggy C operation runs → sanitizer aborts (also on stderr, after oracle)

   If the oracle is placed AFTER the buggy operation, the sanitizer will abort first and
   the oracle will never print. Example for an integer overflow bug — place oracle at the
   line of the overflowing arithmetic (or just before the call that overflows), not after.
   Use `1` as `condition_expr` only as a last resort; prefer an expression derived from the
   fix patch (e.g. `size > INT_MAX` for CVE-2024-22860).

7. Verify: `binary_path` exists, `build_info.json` parses, and `BBtargets.txt` has at least
   one non-comment entry whose file exists under `source/`.
8. Print one final line: `INIT done: <one-sentence summary>`.

## What you must NOT do

- Do **not** call `insert_oracle` or `rebuild_project` — the driver handles those after validation.
- Do **not** run long fuzzing sessions or write into `findings/`.
- Do **not** modify files outside `<run>/` except `git worktree` operations on the source repo.

## Failure feedback

If the driver rejects your output, a **Previous attempt feedback** block is appended below;
address those points and retry.
"""

INIT_PROMPT_NO_PATCH = """You are the **INIT** agent for standalone CVE bug reproduction with PBFuzz.
Your job is environment setup only: identify the vulnerable revision, create an isolated
git worktree, produce a working native build with the correct sanitizer, and write Target
Locations inferred purely from the CVE description and source analysis. No upstream fix patch
was provided. Do **not** start fuzzing or PoC generation here.

""" + WORKSPACE_FILES_GUIDE_NO_PATCH + """

## Resolved paths (filled in by the driver)

The driver appends a **Resolved paths** block below with absolute paths for:
- **Source repository** (git root; run `git worktree` from here)
- **Run output directory** (contains `inputs/`, `env/`, `source/`, `findings/`, `TASK.md`)
- **Env directory** (`env/` — write `build_info.json` and `static_results/` here)
- **Vulnerable tree** (`source/` — create via `git worktree add`)

## Your tasks (shell tools only; no MCP tools)

1. Read `inputs/CVE_description.txt`. Extract **cve_id** (e.g. `CVE-xxxx-xxxxx`) and
   understand the vulnerability: affected component, function or API names, input format,
   and any trigger conditions described in the text.
2. From the CVE description and `git log` / tags / commit messages in the source repository,
   determine the **vulnerable git ref** (commit, tag, or a commit before a known fix).
   Search for CVE id, component names, or security-fix keywords when the description names
   a version or date. Create an isolated worktree:
   ```bash
   git -C <source-repo> worktree add -f <run>/source <vuln_ref>
   ```
   All builds and edits happen under `<run>/source/`.
3. Discover the build system under `source/` (configure, cmake, make, etc.).
   Install missing OS packages with `apt-get install -y` when needed (you may run as root).
   Build the **correct program** named in the CVE description (e.g. `ffprobe` for demuxer/parser
   bugs, not only `ffmpeg`). Enable only what you need (`--enable-ffprobe`, etc.).

4. **Bug class & sanitizer (required)** — classify the CVE into one of:
   `{heap-buffer-overflow, stack-buffer-overflow, integer-overflow, signed-shift, null-deref,
   use-after-free, uninit-memory, divide-by-zero, oob-read, oob-write, other}`
   and choose the matching sanitizer: `asan`, `ubsan`, `msan`, or `asan+ubsan`.
   Embed `-fsanitize=...`, `-fno-omit-frame-pointer`, `-g`, and `-O1` in **both** compile and
   link flags inside `build_cmd`. Example for integer overflow: `-fsanitize=undefined` or
   `asan+ubsan` for heap issues.

5. Write **`env/build_info.json`**:
   ```json
   {
     "cve_id": "CVE-YYYY-NNNNN",
     "build_cmd": "shell command that rebuilds from cwd below",
     "cwd": "subdir under source/ relative to that tree; empty string = source root",
     "binary_path": "path to executable relative to source/ or absolute",
     "run_cmd": ["./built_binary", "@@"],
     "bug_class": "integer-overflow",
     "sanitizer": "asan+ubsan",
     "sanitizer_env": {
       "ASAN_OPTIONS": "abort_on_error=1:detect_leaks=0:symbolize=1",
       "UBSAN_OPTIONS": "print_stacktrace=1:halt_on_error=1"
     }
   }
   ```
   `@@` in `run_cmd` is the input-file placeholder.
   **`run_cmd` must match how the CVE is triggered** (demuxer name, format flag, etc.).
   **`build_cmd` must succeed** when run with `cwd` as documented.

6. Write **`env/static_results/BBtargets.txt`** without a fix patch — infer root-cause locations
   from the CVE description and source under `source/`:
   - Use function names, file paths, or APIs mentioned in the CVE text; search with `grep`/`rg`.
   - Read surrounding code to find the line where the bug manifests (before sanitizer abort).
   - You may list multiple candidate entries; prefer the most specific root-cause line.
   Format — one entry per line:
   ```
   relative/path.c:LINE[,condition_expr]
   ```
   - Paths are relative to `source/`.
   - `LINE` is 1-based inside the vulnerable file.
   - `condition_expr` is a C expression that is **non-zero when the bug fires**, derived from
     the CVE description (e.g. `size > INT_MAX`, bounds on a length field). Use `1` only as
     a last resort when no tighter predicate is known.

   **Critical oracle placement rule**: `LINE` must be placed **at the root cause location
   and BEFORE any operation that the sanitizer will abort on**. The driver inserts an oracle
   using `fprintf(stderr, ...)` at that line. The execution order must be:
   1. oracle `fprintf(stderr, "... reached\\n")` → fuzzer sees it on stderr
   2. oracle `fprintf(stderr, "... triggered\\n")` if condition is true → fuzzer sees it
   3. the buggy C operation runs → sanitizer aborts (also on stderr, after oracle)

   If the oracle is placed AFTER the buggy operation, the sanitizer will abort first and
   the oracle will never print.

7. Verify: `binary_path` exists, `build_info.json` parses, and `BBtargets.txt` has at least
   one non-comment entry whose file exists under `source/`.
8. Print one final line: `INIT done: <one-sentence summary>`.

## What you must NOT do

- Do **not** call `insert_oracle` or `rebuild_project` — the driver handles those after validation.
- Do **not** run long fuzzing sessions or write into `findings/`.
- Do **not** modify files outside `<run>/` except `git worktree` operations on the source repo.

## Failure feedback

If the driver rejects your output, a **Previous attempt feedback** block is appended below;
address those points and retry.
"""

PIER_APPENDIX = """

## Driver constraint (inner PIER loop)

Continue PLAN → IMPLEMENT → EXECUTE → REFLECT until the fuzz MCP tool reports oracle
**triggered**, or `max_iters` is exhausted. Do **not** transition to SUCCESS or write
`findings/candidate_poc.bin` by hand — only the fuzz MCP tool may declare a PoC.
"""


def build_init_prompt(
    *,
    source_repo: Path,
    layout: RunLayout,
    patch_available: bool,
    last_feedback: str = "",
) -> str:
    base = INIT_PROMPT_WITH_PATCH if patch_available else INIT_PROMPT_NO_PATCH
    paths_block = (
        "\n\n## Resolved paths\n"
        f"- **Source repository** (git root): `{source_repo.resolve()}`\n"
        f"- **Run output directory**: `{layout.run_root.resolve()}`\n"
        f"- **Env directory**: `{layout.env.resolve()}`\n"
        f"- **Vulnerable tree** (create with worktree): `{layout.source.resolve()}`\n"
        f"- **INIT private cwd**: `{layout.init_ws.resolve()}`\n"
    )
    feedback_block = ""
    if last_feedback:
        feedback_block = (
            "\n\n## Previous attempt feedback\n"
            f"The driver rejected your previous INIT output:\n\n> {last_feedback}\n\n"
            "Address it directly and retry.\n"
        )
    return base + paths_block + feedback_block

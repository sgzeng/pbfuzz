# Verification

> **Archived: pre-rewrite architecture.** Everything below documents the Claude-Code-hooks
> version of pbfuzz-dsh (`hooks.json`, `dsh-hooks-claude-code`, the Python guard engine under
> `engine/hooks/`). That architecture was replaced by a DSH-native design (native
> `ctx.tools.guard()`, `state-writer.ts`, `pier-driver.ts`); the hook layer no
> longer exists in this repo. Kept as the historical record of that QA pass, not as current
> behavior — do not use command output or test counts here as today's baseline. A fresh
> verification pass against the DSH-native architecture belongs in a new document, not a rewrite
> of this one.

The consolidated record of pbfuzz-dsh's Linux verification pass: what was tested, the exact
commands, real output excerpts, and a verdict for each stage (V0 through V4). Every claim here has
a live command or a live DSH session behind it — nothing here was inferred from reading the code
alone. Full raw evidence, including everything trimmed for length here, is in
[`verification-notes.md`](verification-notes.md); this file is the polished summary.

Environment: Ubuntu 24.04.5, kernel 6.8.0-139, DSH 0.1.5-rc.1 (`npx @deepseek-ai/dsh web`, profile
`web`, `127.0.0.1:3080`), LLVM 14.0.6 + lld 14.0.6, gdb 15.1, lldb-14, OpenJDK 17.0.20, Jazzer
0.30.0, Python 3.12.3 (`engine/.venv`) with atheris installed.

```bash
cd /mnt/work/pbfuzz/pbfuzz-dsh
export DSH_CHECKOUT=/mnt/work/deepseek-harness PBFUZZ_PYTHON=$PWD/engine/.venv/bin/python PATH=$HOME/.local/bin:$PATH
node scripts/codegen.mjs --check && pnpm -r typecheck && pnpm run test:all
```
Current baseline (after every fix in this document): `codegen: ok`; typecheck clean for both
packages; `kanalyzer 57/57`, `pbfuzz 104/104`, `hooks 65+4`, `engine 207 passed / 0 skipped`, both
client bundles build.

## V0 — Linux bring-up: real kanalyzer, real DSH, real hooks

**What was tested.** That the whole stack — kanalyzer's native binary, the `dsh web` server, the
Claude-Code-style hooks bridge, and pbfuzz's own settings/dashboard UI — works against genuinely
installed software on Linux, not mocks. This was the largest single verification effort and found
the most foundational bugs; see `verification-notes.md`'s Stage A–C and C6 sections for the full
blow-by-blow.

**Commands and real output (representative excerpts):**
```bash
# B2 — kanalyzer doctor, real binary
$ dsh kanalyzer doctor …
binary /home/haochen/.dsh/kanalyzer/kernel-analyzer/build/lib/KAMain commit 3f5dbfd llvm 14.0.6
compiled selftest with /usr/lib/llvm-14/bin/clang -flto → sample.0.0.preopt.bc
analyze sample.c:7: status=ok targets=1 critical=3 reachableFns=3/3 | callers(foo) = [main]
analyze comment line sample.c:1: status=no_target nearby=[sample.c:6, sample.c:11, sample.c:13]
```
```
# C4 — a real state_guard/bash_guard denial, live session
write → state/metrics.json:
[pbfuzz:state_guard/metrics-engine-only] DENIED (write) … Next legal action: …
bash `echo '{}' > …/metrics.json`:
[pbfuzz:bash_guard/state-tamper] DENIED (bash) … Next legal action: …
```
```
# C6 — skill visibility, live session, "List all available skill names"
kanalyzer kanalyzer-build pbfuzz pbfuzz-debugging pbfuzz-derive-target pbfuzz-generator
pbfuzz-harness pbfuzz-instrument pbfuzz-kanalyzer pbfuzz-pier   (10, joint skill present)
```

**Bugs found and fixed (commits in `verification-notes.md`):**
1. `host.active()` resolved the campaign pointer differently from the guards (id vs. relative vs.
   absolute path) — aligned, `host-active.spec.ts`.
2. Tool visibility never refreshed after the first pbfuzz tool call — `restrict()` moved to run on
   DSH's `agent/created` event (later found still incomplete; see V3/V4's `host.refresh()` fix).
3. `stop_guard` forced continuations even while onboarding was waiting on the user — onboarding
   given an explicit "waiting for the user" exemption.
4. **C6** — the joint `pbfuzz-kanalyzer` skill never registered because of an unordered `ctx.inject`
   dependency read (`ea80804`); fixed with a nested `inject`, regression in
   `kanalyzer-inject.spec.ts`, verified live in both directions (join and leave).
5. `dsh-hooks-claude-code` silently failed open (exit 126, permission denied) because `pnpm pack`
   didn't preserve the hook script's executable bit and the vendored library was missing — fixed
   with `sh "<hook>"` dispatch plus `prepack` vendoring.

**Verdict: PASS**, with 5 real bugs found and fixed, each with a regression test and live re-test
evidence (RETEST / RETEST 2 in `verification-notes.md`).

## V1 — readelf-c (C/C++), a full PIER run to a real PoC

**What was tested.** The complete PIER loop — onboarding inference, the S1–S6 interview, `Revise`,
canary-free instrumentation for a preexisting oracle, `selfcheck` genuinely calling kanalyzer, and
an unattended PLAN→IMPLEMENT→EXECUTE→REFLECT→SUCCESS run — against a real C++ target with a
narrow, five-condition bug.

**Commands and real output:**
```bash
$ ./readelf crashes/poc_round0_s1_stage1_iter1; echo $?
bug location reached
bug location triggered
Fatal: Dangerous ELF combination detected!
134
```
```
# selfcheck, live
kanalyzer analyze → status=ok, 1 target resolved, 10 critical branches, target at distance 0 at readelf.cpp:93
# EXECUTE, live: pbfuzz_fuzz job pbfuzz_fuzz-1
triggered on stage-1 iteration 1 (0.35s), exit -6 (SIGABRT)
```

**Bugs found and fixed:**
1. `PbfuzzHost.active()` served a stale cached campaign after a direct yaml edit (the `Revise`
   workaround for a field `pbfuzz_campaign draft` has no input for) — would have silently reverted
   the edit on Approve. Fixed with an mtime check; `host-active.spec.ts`.
2. `GdbBatchTracer.run()`'s pre-flight existence check resolved a relative `entry.run_cmd` against
   the wrong cwd (the engine sidecar's, not `entry.cwd`) — blocked every C/C++ trace immediately.
   Fixed with a `program_exists(program, cwd)` helper; `test_tracers_unit.py`.

**Findings observed, not fixed in this pass** (`verification-notes.md` has full detail): a
`pbfuzz_fuzz`-unknown-tool pattern (later root-caused in V3 — see below); an intermittent
`pbfuzz_campaign status` serialization error (later root-caused in V4 — see below); the
session-header dashboard going stale exactly when PIER's own direct `write` finishes a campaign
(fixed later, see V3).

**A correction, found in V4 and verified by hand against the real binary:** the original run
measured readelf-c's accepted `entry` value set as exactly `{0x400000, 0x8048000}`, reasoning that
the two `__builtin_bswap64` disjuncts are dead code. That reasoning was wrong (it applies `bswap64`
once, not twice); the true accepted set is four raw `e_entry` values, two of which are
big-endian-only. V1's own PoC is unaffected — see `examples/readelf-c/README.md` for the corrected
analysis and crash evidence.

**Verdict: PASS.** Deliverable: [`examples/readelf-c/`](../examples/readelf-c) — `pbfuzz.campaign.yaml`
(`confirmed: true`), `generator.py`, `crashes/poc_round0_s1_stage1_iter1`, independently
re-verified after copying.

## V2 — Magma LUA001, headless and unattended

**What was tested.** The C8 headless entry point (a documented task phrasing that a
`SessionStart`/`UserPromptSubmit` hook recognises and turns into a `pbfuzz_campaign run` call,
since `dsh-headless` has no slash-command dispatch), driving a real Magma bug to a PoC with no
interactive turns at all, inside a 30-minute budget.

**Design decision (user, 2026-09-15):** a hook-based headless entry rather than a DSH change or a
plugin CLI — extends the existing resume/digest hook infrastructure, keeps pbfuzz a real PIER agent
loop.

**Commands and real output:**
```bash
$ dsh --profile pbfuzz-headless run campaign ./pbfuzz.campaign.yaml   # launched 2026-09-15T21:13:12Z
```
```json
// state/metrics.json, engine-written, 2026-09-15T21:23:43Z (10m31s after launch)
{"total_iterations": 1, "total_reached_count": 1, "triggered_count": 1,
 "last_session": {"stopped_by": "trigger"}}
```
```lua
-- crashes/poc_round0_s1_stage1_iter1
local function f(...)
  local r = debug.getlocal(1, -2147483648)
  return r
end
local ok, err = pcall(f, 1, 2, 3)
```
```
$ .../lua .../poc_round0_s1_stage1_iter1
MAGMA: Bug LUA001 reached
MAGMA: Bug LUA001 triggered
Segmentation fault
```

**Bugs found and fixed:**
1. **C8's shell-level fast path** exited 0 before Python ever ran when no `.pbfuzz/active` existed
   yet — exactly the headless-bootstrap case. Fixed with a one-line exception for the `resume`
   guard; `test_guards.py::HeadlessBootstrap`.
2. **Hook-side settings snapshot mismatch**, found live: `context.py`'s `load_campaign()` merged
   the *whole* `settings.json` document (a wrapper: `{version, settings: {...}, derived: {...}}`)
   against defaults instead of unwrapping `settings.settings` — every guard in every real campaign
   silently enforced hard-coded defaults. Fixed (`4b8d24e`); `SettingsSnapshotWrapper` in
   `test_guards.py` uses the real wrapper shape and was confirmed failing pre-fix via `git stash`.

**Verdict: PASS**, well inside budget (trigger at 10m31s of 30 minutes), with two real bugs found
and fixed along the way.

## V3 — Python toy target + Atheris, static analysis off

**What was tested.** That the questionnaire correctly skips every static-analysis question when
`tools.staticAnalysis: off` (kanalyzer is C/C++ only), and that PIER still finds a PoC purely from
`entry.run_cmd` plus the stderr oracle, with zero Python-specific code in pbfuzz.

**Commands and real output:**
```json
// the questionnaire's own status, before a single question was asked
"skipped": [
  {"id": "C_static_inputs", "reason": "static analysis is off in settings"},
  {"id": "C_oracle_reuse", "reason": "already known or inferred"}
]
```
```
$ .../python harness.py crashes/poc_round0_s1_stage1_iter1
toy: magic FUZZ prefix seen
toy: crash byte 0x42 seen
ValueError: crash: FUZZ magic followed by byte 0x42
```
```json
// state/metrics.json
{"total_iterations": 1, "reached": 1, "triggered": 1, "stopped_by": "trigger", "elapsed_sec": 0.415}
```

**Bug found and fixed — the structural root cause of the "unknown tool" pattern seen since V1:**
`host.refresh()` (the only place `ctx.tools.restrict()` gets recomputed) ran on `agent/created`, a
pbfuzz tool call's own result handling, or a settings change — never on PIER's own documented
phase-transition mechanism, a plain `write` of `state.json`. So a session that onboards and then
reaches EXECUTE without an intervening pbfuzz tool call in between keeps whatever tool catalog was
computed for its *original* phase, and `pbfuzz_fuzz` never becomes callable. Fixed (`e91416b`): a
live, in-process `tools/result` listener (the same pattern two real DSH plugins already use —
`fs/tool-present`, `context/agent-instructions`) calls `host.refresh()` whenever a `write` to
`state/state.json` lands. `execute-refresh.spec.ts` exercises the real `@deepseek-ai/cordis`
runtime end to end; confirmed failing against the pre-fix code via `git stash` before restoring it.

**Verdict: PASS.** Deliverable: [`examples/toy-python-atheris/`](../examples/toy-python-atheris).

## V4 — Java toy target + Jazzer, and onboarding-derivation from a CVE text

**What was tested.** A third language (Java/Jazzer, after C/C++ and Python) through the same
onboarding→PIER→PoC pipeline; the `host.refresh()` fix deployed live and confirmed in the same
session that had just hit the bug it fixes; and onboarding's ability to derive `bug.targets` from
indirect bug information (a CVE description) rather than a direct `file:line`.

**Commands and real output:**
```
$ jazzer --target_class=Fuzz --cp=. -- crashes/poc_round0_s1_stage1_iter1
toy: magic JAVA prefix seen
toy: crash byte 0x99 seen
== Java Exception: java.lang.IllegalStateException: crash: JAVA magic followed by byte 0x99
	at Toy.process(Toy.java:27)
	at Fuzz.fuzzerTestOneInput(Fuzz.java:22)
$ echo $?
77
```
```
# the live agent, confirming the deployed fix, unprompted
"the catalog-staleness bug you shipped a fix for is genuinely gone: after the restart, pbfuzz_fuzz
was callable from this same session (it previously answered unknown tool 'pbfuzz_fuzz' twice), and
it reported the trigger on its first iteration."
```
```
# onboarding-derivation: given only a fabricated CVE-2026-90210 description, no file:line
location: readelf.cpp:93   confidence: high (~0.9)
```

**Bugs found and fixed live, deployed to the running server before this campaign finished:**
1. `host.refresh()` (`e91416b`, same fix as V3 — this session is what proved it live, not just in
   the test suite: hit the bug pre-deploy, confirmed it gone post-deploy, in the same session).
2. `status()` set `reason: undefined` for any passing self-check item, which DSH's lossless-JSON
   tool-result snapshot rejects the *entire* value for — the same "value is not lossless JSON"
   error V1 had observed but not root-caused. Fixed (`593cefd`): omit the key instead;
   `campaign-status.spec.ts` confirmed failing pre-fix via `git stash`.
3. `pbfuzz_extract_parameters`'s tool description named the wrong function signature
   (`extract(data: bytes)` vs. the engine's actual `extract_parameters(file_path)`); fixed
   (`2c8f78a`).

**Bugs found and flagged for a dedicated fix (background tasks, not attempted in this pass):**
- `engine/pbfuzz_engine/tracers/jdb.py`'s piped command script races a real JVM's asynchronous
  `run` — the piped `exit` kills the VM before the class loads, so a breakpoint never binds.
  Verified both ends (a paced session binds correctly). Needs an interactive driver.
- Once any campaign in a workspace reaches a terminal phase (SUCCESS/STOPPED), `pbfuzz_campaign`
  itself becomes uncallable for every future session in that workspace — `visibleTools()` only
  keeps it visible for the "no confirmed campaign yet" case, not for terminal phases.

**Design inconsistency documented, not a code bug:** the hook's `init_gate()` judges "enabled"
self-check items from global settings with no awareness of a campaign-level override, so a
legitimately `skipped` item (deviation, with the tracer off) was refused even though the plugin's
own `gatePasses` considered it fine — the hook's own deny message names the correct, working
remedy (`disabled` with a reason).

**Onboarding-derivation:** CVE-text-only was tested and passed (`readelf.cpp:93`, high confidence,
matching V1's real bug location exactly). Patch-only and crash-trace-only were not separately
tested in this pass — a real, acknowledged gap, not a claimed pass.

**Verdict: PASS** for the Java/Jazzer pipeline and for CVE-only derivation; **partial** for
onboarding-derivation overall (2 of 3 input types untested). Deliverable:
[`examples/toy-java-jazzer/`](../examples/toy-java-jazzer).

## Summary

| Stage | Scope | Verdict | Bugs fixed in this stage | Findings later resolved elsewhere |
|---|---|---|---|---|
| V0 | Linux bring-up, real kanalyzer/DSH/hooks | PASS | 5 | — |
| V1 | readelf-c (C/C++), full PIER | PASS | 2 | 4 (dashboard staleness, kanalyzer `prebuilt_dir`, `pbfuzz_fuzz` unknown tool, `status()` JSON — all fixed by V2–V4 or a follow-up task) |
| V2 | Magma LUA001, headless | PASS | 2 | — |
| V3 | Python + Atheris, static analysis off | PASS | 1 (the `pbfuzz_fuzz` root cause) | — |
| V4 | Java + Jazzer, onboarding-derivation | PASS / partial | 2 (the `status()` root cause, a tool-description mismatch) | — |

Total across the pass: **16 real, confirmed bugs found** (5 in V0, 2 in V1, 2 more surfaced by V1
but fixed later, 2 in V2, 1 in V3, 2 in V4, 2 flagged), **14 fixed**, each with a regression test
pinned failing against the pre-fix code before the fix landed (per this project's own rule); **2
flagged as background tasks** for a dedicated follow-up rather than rushed under time pressure —
`task_0542b320` (the `jdb` tracer's piped-session race) and `task_e7f8bf80` (terminal-phase
`pbfuzz_campaign` visibility). Onboarding-derivation from a CVE text is verified; from a patch or a
crash trace it is not — the one open item in the V0–V4 checklist.

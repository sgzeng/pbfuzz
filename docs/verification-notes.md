# Verification notes (raw evidence for docs/verification.md)

> **Archived: pre-rewrite architecture.** See the banner at the top of `verification.md` — this is
> the raw evidence for a QA pass against the now-replaced Claude-Code-hooks version of the plugin.
> Kept as historical record; do not treat anything below as describing current behavior.

Environment: omen, Ubuntu 24.04.5, kernel 6.8.0-139, DSH 0.1.5-rc.1 (`npx @deepseek-ai/dsh web`, profile `web`, 127.0.0.1:3080),
apt LLVM 14.0.6 + lld 14.0.6 built from source (scripts/setup-linux.sh), gdb 15.1, apt lldb-14, Boost 1.83 headers (user-space for B1).

## Stage A — green (commits 24f0bbb, 999d186, 0ac2dc5, bf3005c)
- test:all, codegen --check, typecheck: all pass; engine 191 passed, 0 skipped.

## Step 3 — DSH 0.1.5-rc.1 retarget (79100b8)

## Stage B — kanalyzer real
- B1: KAMain mzt 3f5dbfd built against /usr/lib/llvm-14 (needs Boost ≥1.81 headers; BUILD_TYPE=Release).
- B2: real doctor PASS — sample.c:7 → target @ distance 0; 3 critical; callers(foo)=[main]; comment line → no_target (nearby 6, 11, 13).
- B3 (c01d6e5): fixtures captured by scripts/capture-fixtures.mjs; fixed resolveTargets (block-start lines) and parsePolicy column pairing.
  LUA001 on magma pre-built lua bitcode → findvararg @ ldebug.c:197, matches magma pre-built dumps.
- B4: prepare lto + wllvm both produce sample.0.0.preopt.bc, entries [main], analyze ok; `ulimit -v` 8 MB kills KAMain (SIGSEGV).

## Stage C — real DSH
- C1: web profile composes @pbfuzz/dsh-kanalyzer + @pbfuzz/dsh-pbfuzz (install via `dsh plugin --profile web add`, then restart).
- C2: PASS — both cards render; nested save pbfuzz.budget.maxPierRounds 5→6→5 written to ~/.dsh/settings.yaml; restart badges on
  pythonPath, gdbPath, hooksEnabled; staticAnalysis dropdown offers kanalyzer. (Greyed-when-absent not exercised.)
- C3: Build button opened a visible session "work" (cwd fallback because installDir did not exist yet). In progress.
  Agent (DeepSeek-V4.1-Flash) recon: picked /usr/lib/llvm-14 (avoided system clang 18), found Boost missing and sudo blocked
  (no_new_privs), fetched Boost 1.83 headers per the updated skill. Then needed sandbox escalation to danger-full-access for
  `mkdir -p ~/.dsh/kanalyzer` — approved by me (user-authorised). FINDING (design): the card creates the session before installDir
  exists, so cwd falls back to the default and every installDir write needs escalation; pre-create installDir (or have the
  command re-root the session) so the build runs inside its workspace.
  Result: PASS. Agent cloned sgzeng/kernel-analyzer@mzt (3f5dbfd) into ~/.dsh/kanalyzer/kernel-analyzer, built with
  `CPATH=<user boost> make LLVM_BUILD=/usr/lib/llvm-14 BUILD_TYPE=Release -j16 KAMain` (13 MB KAMain, CMakeCache Release,
  LLVM_DIR=/usr/lib/llvm-14/cmake), ran kanalyzer_doctor → settings.yaml kanalyzer.status: installed true, commit, llvm 14.0.6,
  lastDoctor pass (target @ distance 0, critical=3, callers(foo)=[main], comment line → no_target). Approvals I clicked: 2
  (mkdir installDir; make). The clone also ran escalated without a separate click from me — not explained yet.
  Card after build: badge "Installed"; Status Installed Yes / binary / commit 3f5dbfd / LLVM 14.0.6; Self-test button →
  "Self-test passed", Last self-test "Passed · 2026-09-15T08:47:54Z" with the doctor evidence; Build button became "Rebuild".
  Fix committed: host mkdir -p's installDir on load/settings change so the next Build session starts inside it.
- C4: the in-plugin `ctx.plugin()` mount of dsh-hooks-claude-code WORKS (hook/invoked + hook/result events in real sessions;
  no fallback row needed). FINDING (fixed): every guard run was exit 126 "pbfuzz-hook: Permission denied" → bridge decision
  "pass" (23/23 in the build session) = guards failed open. Causes: `pnpm pack` writes hooks/pbfuzz-hook 0644 (git 100755)
  and hooks.json executed it directly; the package also lacked hooks/lib/pbfuzz_hooks and contracts/. Fix: hooks.json uses
  `sh "…/pbfuzz-hook" <guard>`; prepack vendors the library + contracts. Offline check of the packed hook: write to
  state/metrics.json → exit 2, "[pbfuzz:state_guard/metrics-engine-only] DENIED … Next legal action: …".
  LIVE (after 0fff90c, web profile, session "Guard test for writing state file", workspace /mnt/work/c4-test with an
  unconfirmed campaign c4): write → state/metrics.json: "[pbfuzz:state_guard/metrics-engine-only] DENIED (write) … Next legal
  action: …"; bash `echo '{}' > …/metrics.json`: "[pbfuzz:bash_guard/state-tamper] DENIED (bash) … Next legal action: …" and
  one tamper-ledger entry; a state.json with an extra `stop_details` property got an actionable schema deny, the corrected
  whole-file write (phase STOPPED) was accepted by the FSM. PASS for state_guard + bash_guard.
- C7 (partial, observed live): stop_guard forced continuation 1/3 → 3/3 (.stop_guard.json {"consecutive": 3}), then the agent
  wrote STOPPED and ended — the self-limit works; the unattended PIER drive itself is still to be shown in V1/V2.
- Findings from the same session (agent's own report when asked "what's going wrong with you?"):
  1. hooks said "campaign c4 — phase INIT" but `pbfuzz_campaign status` returned campaign: null although pbfuzz.campaign.yaml
     exists in the workspace root (host does not discover an on-disk campaign).
  2. tool visibility wrong (C5): staticAnalysis off and no confirmed campaign, yet pbfuzz_deviation/pbfuzz_callgraph visible,
     pbfuzz_fuzz hidden; injected context lists kanalyzer_* as legal.
  3. `terminal_open` does not exist in DSH 0.1.5-rc.1 (skills + phase_gate matcher reference it).
  4. two "Context injection · hooks-claude-code" entries per step; first turn over-thought (~4 min) before acting.
  Root causes + fixes: (1) host.active() resolved the pointer differently from the guards → aligned (id / relative /
  absolute; root yaml), host-active.spec.ts; (2) restrict() only ran on the first pbfuzz tool call → refresh on DSH
  `agent/created`; (3) not a pbfuzz bug: terminal_open/terminal_send come from @deepseek-ai/dsh-tool-terminal, which the web
  composition does not mount; (4) DSH fires UserPromptSubmit before every step → resume/digest inject only when the summary
  changed (SessionStart always); 'tools legal now' lists kanalyzer_* only when static analysis is on.
  RETEST (c9aa436, fresh session "pbfuzz and kanalyzer tool retest"): only `pbfuzz_campaign` visible (restrict at
  agent/created works); one [pbfuzz] injection, no kanalyzer_*; `pbfuzz_campaign status` → campaign c4 (was null).
  New findings, fixed next: 'tools legal now' still listed corpus/trace before confirmation; status phase null vs hooks INIT;
  stop_guard forced 3 continuations on an unconfirmed campaign (onboarding must be able to wait for the user).
  RETEST 2 (2bf4f4c, session "pbfuzz and kanalyzer tool status check"): only pbfuzz_campaign visible; one [pbfuzz]
  injection reading "phase INIT, PIER rounds completed 0/5 … tools legal now: pbfuzz_campaign"; status → c4 / INIT;
  the agent stopped immediately when asked (5 s, 19.7K tok; the previous attempt was 135K tok with 3 forced continuations);
  header dashboard shows "PBFuzz INIT 1/5". All four live findings resolved.
- C5 (partial): session-header dashboard "PBFuzz 1/5" → popover "PBFuzz campaign · Round 1/5 · c4 · Targets toy.c:1 ·
  Metrics: no fuzz session yet · Self-check has not run · Recent hook denials: None · Updated …" — projection renders live.
  Inconsistencies: blank phase badge before state.json exists; "Round 1/5" vs hooks' "PIER round 0/5".
- C8: FINDING (design) — `dsh --profile pbfuzz-headless "/pbfuzz run ./missing.campaign.yaml"` did not fail fast; dsh-headless has
  no slash-command dispatch (its README: the task text goes to the agent), so the agent took the turn (~1 min, 204K tok) and replied
  with diagnosis + options. command.ts itself is correct (missing file → error + exitCode 1) but is unreachable from headless.
  Needs a headless entry that does not depend on command dispatch (e.g. a UserPromptSubmit/SessionStart hook or a plugin CLI path).
  User decision (2026-09-15): a SessionStart/UserPromptSubmit hook that recognises a documented task phrasing and injects a
  directive to call `pbfuzz_campaign` with a new `run` action — extends the existing resume/digest hook infra, no DSH change,
  keeps pbfuzz as a real PIER agent loop per R9. To design next alongside D2/V2.

## C6 — skill visibility (kanalyzer join/leave)

FINDING (fixed, ea80804): with kanalyzer genuinely installed, self-tested and loaded, a fresh session asked to list its skills
named only 9 — the 7 standing pbfuzz skills plus kanalyzer's own `kanalyzer`/`kanalyzer-build` — never `pbfuzz-kanalyzer`. Root
cause: `c.inject(['kanalyzer'], kctx => …)` (packages/dsh-pbfuzz/src/index.ts) only guarantees `kctx.kanalyzer`; the ambient read
`kctx.skills` is a one-shot snapshot taken whenever the kanalyzer fiber happens to activate, with no ordering guarantee against
the unrelated 'skills' fiber, and cordis never revisits an unrequested read. Reproduced with a real `@deepseek-ai/cordis` Context
in `packages/dsh-pbfuzz/tests/kanalyzer-inject.spec.ts` (both orderings). Fix: nest `kctx.inject(['skills'], jctx => …)` — the
same wait-and-re-fire mechanism, correctly declared — and capture+dispose the registration via `jctx.effect()` (registerSkills
now returns its disposers; the original code never captured them for the joint skill either, so it also never would have
unregistered on unload even with `kctx.skills` fixed). `codegen --check && typecheck && test:all` all green after the fix:
kanalyzer 48, pbfuzz 80 (+2), hooks 4+57, both client bundles, engine 191/0 skipped.

LIVE, after redeploying ea80804 (remove+add both tgz, restart, new token): fresh session "List all available skill names" (now) —
`kanalyzer kanalyzer-build pbfuzz pbfuzz-debugging pbfuzz-derive-target pbfuzz-generator pbfuzz-harness pbfuzz-instrument
pbfuzz-kanalyzer pbfuzz-pier` (10, joint skill present). PASS.

LIVE unload: `dsh plugin --profile web remove @pbfuzz/dsh-kanalyzer`, restart, same session asked again (skill-catalog context
injection refreshes per turn, no new session needed) — agent noticed on its own: "The catalog changed — kanalyzer and
kanalyzer-build are gone. Available skills now: pbfuzz, pbfuzz-debugging, pbfuzz-derive-target, pbfuzz-generator,
pbfuzz-harness, pbfuzz-instrument, pbfuzz-pier" (exactly the 7 standing ones) and "Tools named kanalyzer_* or pbfuzz_callgraph:
none. The only pbfuzz tool I have is pbfuzz_campaign." PASS — the joint skill, kanalyzer's own skills, the kanalyzer analysis
provider and `pbfuzz_callgraph` all disappeared together; pbfuzz itself kept working. Reinstalled @pbfuzz/dsh-kanalyzer and
restarted afterward to restore the environment for V1. C6 fully verified both directions.

## V1 — readelf (C/C++), full PIER run to a real PoC

Workspace `examples/readelf-c` (new, D1's own deliverable — see below), settings: `staticAnalysis: kanalyzer`,
`corpusAnalysis`/`deviationDetection` on (defaults). Session "启动 pbfuzz 漏洞挖掘活动", `/pbfuzz`.

**Onboarding — inference and the 5-question interview.** The agent scanned the repo unprompted (README, build.sh,
readelf.cpp, seeds/, `~/.dsh/settings.yaml`, git status) and *ran the target itself* to verify the trigger before ever
asking anything: a crafted 64-byte header printed `bug location reached` / `bug location triggered` / `Fatal: Dangerous
ELF combination detected!`, exit 134. It correctly inferred target.repo, build.cmd, entry (executable/file, no
`LLVMFuzzerTestOneInput`), `analysis.static` (kanalyzer, LTO, `readelf.lto.0.0.preopt.bc`, entries `[main]`),
`analysis.corpus.seeds_dir`, all with real evidence (llvm-nm output, executed probes) — then asked exactly 5 genuine
gaps via the batched `ask_user_question` panel: S2 bug source (recommended: reuse the in-tree trigger — selected),
S5 target location (recommended: `readelf.cpp:93`, matching the legacy `BBtargets.txt` exactly — selected), oracle
mode (recommended: `preexisting`, reusing the built-in markers since the target already prints them — selected), S6
output dir (default `.pbfuzz/readelf-c` — selected), S1 revision (recommended: leave `target.revision` unset, since
`examples/` is untracked in pbfuzz-dsh's own git status and pinning a parent commit would misdescribe the fixture —
selected). UI note: the panel's "Recommended" grey highlight is *not* itself a registered answer — each question still
needs its own explicit radio click before Submit; clicking through without doing so produces "Please complete this
question first" on the unset one. All correct once every question was explicitly answered.

**C5 — Revise.** Asked to lower `analysis.static.call_stack_len` from the schema default 20 to 10 in the plan-review
panel. `pbfuzz_campaign draft`'s `CampaignDraftInput` has no field for it (campaign.js hardcodes 20), so the agent
diagnosed this itself, edited the yaml directly, and validated the edit against the plugin's own `validateCampaign`
before re-confirming — surfacing the `active()` staleness bug fixed below. Re-ran `confirm`, yaml now correctly showed
`call_stack_len: 10`, **Approve**.

**Selfcheck really calls kanalyzer.** All 6 items pass, `gatePasses: true`: `kanalyzer analyze` → `status=ok, 1 target
resolved, 10 critical branches, target at distance 0 at readelf.cpp:93`; corpus 5 seeds, 1 reaching; tracer (gdb)
resolved the breakpoint; oracle verified against the real binary (preexisting markers present, zero `PBFUZZ_*` canary
strings — canary insertion correctly skipped for `oracle.mode: preexisting`, per the pbfuzz-instrument skill's first
rule). `state.json` written with `phase: PLAN`, INIT gate passed.

**PIER to a PoC.** stop_guard drove the whole PLAN→IMPLEMENT→EXECUTE→REFLECT→SUCCESS cycle unattended (I only replied
to the two tool-registration recovery panels below; every other step was the agent + stop_guard). PLAN wrote and
validated `bug_predicates.json`/`preconditions.json`/`root_causes.json`/`trigger_plans.json` against the block
schemas. IMPLEMENT built `generator.py`, then *revised its own analysis empirically*: it had assumed 4 accepted
`entry` values (2 raw + 2 byte-swapped), wrote a probe script, measured 20 (value, byte-order) combinations against
the real binary, and concluded the accepted set was exactly `{0x400000, 0x8048000}` independent of byte order —
reasoning that `__builtin_bswap64` at readelf.cpp:90 is dead code because `raw == bswap(bswap(raw))` maps each
byte-swapped disjunct back onto the same two file values as the raw ones. **That reasoning is wrong, found and
corrected during V4** (see `examples/readelf-c/README.md` for the full correction and verified crash evidence): the
code applies `bswap64` once to `header.e_entry`, not twice, so `raw == bswap(bswap(raw))` does not apply; the true
accepted set is *four* raw `e_entry` values, two of which (`bswap64(0x400000) = 0x400000000000` and
`bswap64(0x8048000) = 0x80040800000000`) only trigger for big-endian files and were apparently never actually
exercised by whatever the V1 agent's 20-combination probe constructed, despite its report. It rewrote all four PLAN
blocks to its (incompletely) measured result before proceeding, keeping the falsified values as explicit negative
controls in the stage-1 batch — this did not affect V1's own PoC, which fires the raw disjunct. EXECUTE ran
`pbfuzz_fuzz` (job `pbfuzz_fuzz-1`): **triggered on stage-1 iteration 1** (0.35s), exit −6 (SIGABRT). The agent
reproduced the recorded PoC independently 3 more times by hand (4/4) before recording it, and precisely identified the
winning parameters by reading the actual PoC bytes rather than assuming which batch entry ran (`entry_point=4194304`,
`entry_byte_order="little"` — the *raw* disjunct, not the byte-swap path a first reading of the condition suggests).
REFLECT→SUCCESS (the FSM's only legal hop from EXECUTE) recorded the `poc` block. Final: `state.json` phase `SUCCESS`,
`metrics.json` (engine-written): `total_iterations=1, triggered_count=1, stopped_by=trigger`. PIER round 0 of the
5-round budget. Deliverables copied into `examples/readelf-c/` (D1): `pbfuzz.campaign.yaml` (`confirmed: true`),
`generator.py`, `crashes/poc_round0_s1_stage1_iter1` — independently re-verified after copying: `./readelf
crashes/poc_round0_s1_stage1_iter1` → exit 134, same three stderr lines.

**Bugs found live and fixed (commits `20e6a15`, `89ddd7c`):**
1. **`PbfuzzHost.active()` served a stale cached campaign after a direct yaml edit** (host.ts). The Revise flow above
   has no structured way to change `call_stack_len`, so the agent edited the yaml directly (the documented fallback)
   and validated it — but `active()` had cached the campaign object from the earlier `draft()`/`confirm()` calls and
   never re-read the file, so the plan-review panel kept showing `call_stack_len: 20` and **Approve would have written
   the stale value straight back over the edit**, silently discarding it. Fixed: `ActiveCampaign` now carries the
   yaml's mtime; `active()` compares it against the file's current mtime on every cache hit and reloads on a mismatch.
   Regression: `host-active.spec.ts` (edits the yaml out from under a live host, asserts the next `active()` sees it;
   fails on old code with `expected undefined to be 'edited directly on disk'`).
2. **`GdbBatchTracer.run()`'s existence pre-check resolved `entry.run_cmd` against the wrong cwd** (gdb_batch.py). The
   target built and ran fine by hand (`./readelf @@` from `entry.cwd`), but `pbfuzz_trace` reported "The program to run
   does not exist: ./readelf" — the actual gdb launch already passed `cwd=cmd.cwd` correctly; only the pre-flight
   `Path(program).exists()` guard resolved the relative path against the *engine sidecar's own* cwd instead. Fixed: a
   new `program_exists(program, cwd)` helper resolves relative paths against `cwd` first. lldb_batch.py/pymon.py have
   no equivalent pre-check, so this was gdb-only — which is what `tracer: auto` resolves to for C/C++, so it blocked
   V1 immediately. Regression: `test_tracers_unit.py` (confirmed failing on the reverted logic: `assert False is True`).

**Findings observed live, not fixed (out of scope for this pass — flagged for follow-up):**
3. **`pbfuzz_fuzz` needed a full DSH restart to mount**, twice reproducing the same pattern `pbfuzz_corpus`/
   `pbfuzz_trace` hit earlier in Stage C: the plugin registers the tool (`tools.js`) and `phases.js` lists it
   EXECUTE-legal, the engine sidecar was healthy (`fuzz.run` in its RPC capabilities), yet the harness answered
   `unknown tool "pbfuzz_fuzz"` until a clean process restart. Every occurrence in this session followed a **mid-session
   `pbfuzz.execution.pythonPath` settings change** (which the UI documents as restarting the sidecar) — plausible that
   the settings-triggered partial reconfigure doesn't cleanly re-register every tool, though this was not isolated
   from a normal boot (where `pythonPath` is set once, before `/pbfuzz` ever runs, so tools would register once and
   never need this path). Mitigation confirmed working: a full `dsh` process restart always recovered it. **Root
   cause found and fixed in V3** (`e91416b`): unrelated to `pythonPath` — `host.refresh()` (the only place tool
   visibility is recomputed) never observed PIER's own direct `write` phase transitions, so this was always going to
   reproduce on *any* onboard-then-fuzz session, mid-session settings change or not.
4. **`pbfuzz_campaign status` intermittently threw `tool "pbfuzz_campaign" returned invalid output: value is not
   lossless JSON`** (a generic DSH session-persistence check — `JSON.stringify` throwing or returning non-string,
   e.g. on a stray `BigInt`) several times late in the session, including once on the plain no-campaign interview
   path. **Not reproduced in isolation**: calling the real `status()` directly against the final on-disk campaign
   (`node` against the built `lib/`) serializes cleanly (1987 chars, no error) — see `/tmp/repro-status.mjs`. Likely
   entangled with the same mid-session restart churn as #3 rather than a clean, steady-state bug; recorded honestly
   as observed-but-unconfirmed rather than guess-fixed.
5. **The session-header dashboard projection goes stale exactly when a campaign finishes.** Per its own module doc
   (`projection.ts`), the fold only updates on a `tool/result` from a pbfuzz **tool call** (the host embeds a fresh
   `PbfuzzDashboardView` in each pbfuzz tool's result metadata) — it does not listen for plain `write`s to
   `state.json`/`metrics.json`. PIER's own REFLECT→SUCCESS transition here was a direct `write` (per the skill's
   documented FSM-hop procedure), not a pbfuzz tool call, so the dashboard popover kept reading "EXECUTE 1/5 · IMPLEMENT
   complete... Next: run pbfuzz_fuzz · Metrics: No fuzz session yet" through a full page reload, well after the real
   `state.json` had reached `phase: SUCCESS` with the `poc` block recorded and `metrics.json` showed
   `triggered_count=1`. This reproduces reliably (not restart-related). **Fixed (`e5e8f67`, background task
   `task_7a98f8ae`, user-run):** `projection.ts` now also folds `tool/call` + `tool/result` pairs for whole-document
   writes to the campaign's `state/state.json` / `state/metrics.json`, staging the document on the call and merging it
   only once the paired result shows the write actually landed (a refused hop or an `isError` result changes nothing —
   verified against V1's real session log, where the FSM's own refused EXECUTE→SUCCESS attempt must not appear as a
   phantom SUCCESS). `dashboard.spec.ts` grew from 12 to 18 tests, including one that fails on pre-fix code with
   exactly this symptom (`phase: 'EXECUTE'`, `poc: null`) and passes after. Independently re-verified in this session:
   `pnpm run test:all` green end-to-end after this commit (kanalyzer 57/57, pbfuzz 100/100, hooks 65+4, engine 207,
   both client bundles build).

**Negative cases from V1's checklist not yet exercised in this pass:** kanalyzer-not-built and illegal-state-write were
already covered with evidence in Stage C (C3, C4); comment-line target and no-seeds-turns-off-corpus were not
separately re-tested against this specific campaign/workspace and remain open for a future pass.

## D2 — Magma adapter (a71c370)

`engine/pbfuzz_engine/adapters/magma.py`: `MagmaTarget`/`MagmaAdapterInput` dataclasses,
`parse_bbtargets()` (Magma's `BBtargets.txt` → `bug.targets`, verbatim so kanalyzer's `-target-list` and the campaign
always agree), `parse_magma_log_condition()` (reads the `MAGMA_LOG(id, condition)` call site out of the bug's own
`.patch` file to document the trigger predicate in `bug.description`), `build_campaign()`/`campaign_to_yaml()`, and a
CLI (`python -m pbfuzz_engine.adapters.magma <target> <bug-id> ...`). `oracle.mode: preexisting` always, since
`magma/src/canary.c`'s `magma_log()` already prints the reach/trigger markers unconditionally — no canary insertion,
no Magma monitor process needed. 15 tests (`engine/tests/test_adapters_magma.py`), all passing against real Magma
fixture data (`BBtargets.txt`, a real `.patch`). `examples/magma/README.md` +
`examples/magma/generate-campaign.sh` wrap the CLI for a human. This is what produced the base
`targets/lua/pbfuzz.campaign.yaml` that V2 (below) confirmed and ran.

## C8 — headless entry point (147e938, 933e3e6, 4b8d24e)

Design (user decision, 2026-09-15): extend the existing hook infrastructure rather than touch DSH — a
SessionStart/UserPromptSubmit hook recognises a documented task phrasing and directs the agent to call
`pbfuzz_campaign` with a new `run` action, so headless stays a real PIER agent loop (R9), not a special-cased path.

**TS layer (147e938).** `campaign-flow.ts` gained `runHeadless(flow, path): Promise<RunOutcome>`, extracted verbatim
from `/pbfuzz run`'s handler (`command.ts` now just calls it). `tools.ts`'s `pbfuzz_campaign` tool gained a `run`
action + `path` param. `run-headless.spec.ts`: unconfirmed campaign refused, missing path fails cleanly, and (real
engine, not mocked — `describe.skipIf` gated on the venv) a full success path. All 3 pass with the real engine
(`pnpm --filter @pbfuzz/dsh-pbfuzz test`: 84/84, including this file).

**Shell/hook layer, FINDING + fix (933e3e6).** The design above is necessary but not sufficient: `pbfuzz-hook`'s own
fast-path (`[ -z "$found" ] && exit 0`, no `.pbfuzz/active` anywhere up the tree) exits before Python ever runs — the
exact bootstrap case a headless "start a campaign from nothing" prompt hits. Fixed: `[ -z "$found" ] &&
[ "$1" != "resume" ] && exit 0` — `resume` (the `UserPromptSubmit` hook) is the one guard that must still run with no
campaign, so `detect_headless_run()`/`resume_headless_bootstrap()` (`guards.py`) can recognise the task phrasing and
inject the `run`-action directive before any campaign exists. `test_guards.py::HeadlessBootstrap` (4 tests) +
`FastExit` retest confirming every *other* guard still short-circuits with no campaign. 65/65 hooks tests pass.

## V2 — Magma LUA001, headless and unattended

Campaign: `examples/magma/generate-campaign.sh lua LUA001` → `targets/lua/pbfuzz.campaign.yaml` (D2's adapter,
`confirmed: true`), workspace `/mnt/work/pbfuzz/magma/targets/lua`, profile `pbfuzz-headless`. Launched as
`dsh --profile pbfuzz-headless run campaign ./pbfuzz.campaign.yaml` (C8's documented task phrasing) at
`2026-09-15T21:13:12Z`, backgrounded, watched via its own log — no interactive turns, no browser.

**Self-check FINDING, fixed live by the agent, then fixed for real.** First self-check failed `static_analysis: no
build command` — `KanalyzerProvider.prepare()` (`packages/dsh-pbfuzz/src/core/kanalyzer-provider.ts`) implements
bitcode-reuse and LTO/wllvm-rebuild but had no branch for `analysis.static.mode: prebuilt_dir` import, even though its
own doc comment promised it (confirmed by reading the source; this was Bug #6). The *live headless agent's* own
workaround, at the time: added `analysis.static.bitcode: .../lua.0.0.preopt.bc` (Magma's own prebuilt LTO bitcode)
directly to the campaign yaml with a `provenance` entry recording *why* (no `targets/lua/src` in this workspace to
build from) and verified by hand that KAMain on that bitcode reproduces Magma's own `BBtargets/LUA001` dump exactly
(`ldebug.c:197` at distance 0, 32 critical BBs). That workaround diff is preserved in
`/mnt/work/pbfuzz/magma/targets/lua/pbfuzz.campaign.yaml` (outside this repo — Magma is a separate checkout, nothing
to commit here). **Fixed for real (`52c2727`, `61c23f7`, background task `task_e94e50a3`, user-run):** `dsh-kanalyzer`
gained an actual prebuilt-dump importer (`core/prebuilt.ts` discovers the dump files, `core/result.ts` derives
status/targets/critical-branches from them through the same path a live KAMain run uses, `host/runtime.ts` exposes
`importPrebuilt()`), and `KanalyzerProvider.prepare()` now tries `prebuilt_dir` first — ahead of `bitcode` — calling
`importPrebuilt()` and running neither KAMain nor a build, which is what a genuinely prebuilt campaign should do.
Re-verified independently in this session: against the real `magma/fuzzers/pre-built/lua/BBtargets/LUA001` with *no*
KAMain installed, the self-check goes straight to pass without the bitcode workaround; `pnpm run test:all` green
end-to-end (kanalyzer 57/57 including the new `prebuilt.spec.ts`, pbfuzz 100/100 including the new
`kanalyzer-prebuilt.spec.ts`, hooks 65+4, engine 207, both client bundles build).

**PLAN.** Reasoned from `objdump`/gdb evidence (no `pbfuzz_callgraph`/`kanalyzer_*` — see finding below) to the real
bug mechanism: `db_getlocal` truncates the Lua index to `int`; `luaG_findlocal` negates it; `findvararg`
(`ldebug.c:195`) checks only `n <= nextra`, so `index = INT_MIN` passes the guard, `n - 1` wraps to `INT_MAX`, and the
store at `ldebug.c:199` is a wild write — reachable from Lua via `debug.getlocal(level, INT_MIN)` on a non-tail-called
vararg function (tail position drops the frame and misresolves `level` onto the `pcall` C frame instead, a discovered
precondition R4). Wrote and validated `bug_predicates.json`/`preconditions.json`/`root_causes.json`/
`trigger_plans.json` with `index: -2147483648` as the hand-proven first entry in `next_batch_plan`.

**EXECUTE, FINDING.** `pbfuzz_fuzz` was "unknown tool" in this headless session's registry (the same failure mode as
V1 finding #3, now reproduced in a second, unrelated session — strengthens the case that it's a real registration
bug rather than V1's own artifact). The agent drove the identical engine JSON-RPC the tool wraps
(`generator.validate`, then `fuzz.run` with the plan/generator/`fuzzing` runtime from settings) via its own driver
script; the engine process — not the agent — wrote `metrics.json` and the crash artifact, so the evidence chain is
unbroken. Result, **first iteration**: `total_iterations=1, total_reached_count=1, triggered_count=1,
stopped_by="trigger"`, breakpoint hit at `ldebug.c:197` in `findvararg` with `n=-2147483648, nextra=3`, call stack
`luaG_findlocal → lua_getlocal → db_getlocal`, signal SIGSEGV. Elapsed 0.301s of engine time;
`state/metrics.json`'s `last_updated` timestamp (`2026-09-15T21:23:43Z`) is **10m31s after launch** — comfortably
inside the 30-minute target. PoC (engine-written, `crashes/poc_round0_s1_stage1_iter1`):
```lua
local function f(...)
  local r = debug.getlocal(1, -2147483648)
  return r
end
local ok, err = pcall(f, 1, 2, 3)
print('done', ok, err)
```
The agent reproduced it 3/3 by hand (`MAGMA: Bug LUA001 reached` / `triggered` / SIGSEGV, exit 139 each time) before
recording it. REFLECT→SUCCESS written with the `poc` block (`input_path`, `parameters`, `reproduced_times: 3`,
`run_cmd`); final `state/state.json`: `phase: SUCCESS`. Verified independently after the fact by re-reading
`state/state.json`/`state/metrics.json`/the PoC file directly from this session — all three agree with the agent's
own report.

**A second FINDING, confirmed and fixed (4b8d24e).** The agent noticed `tools.staticAnalysis` never actually reached
the guards: `context.py`'s `load_campaign()` merged the *whole* `settings.json` document against `DEFAULT_SETTINGS`,
but the host (`settings-snapshot.ts`) writes `{version, written_at, campaign_id, settings: {...}, derived: {...}}` —
none of those top-level keys ever matches `tools`/`budget`/`guards`, so every guard in every campaign silently
enforced hard-coded defaults regardless of what the user (or, here, the campaign yaml) configured. Every existing
hook test wrote the bare shape directly, matching the bug instead of exposing it. Confirmed independently (not just
taking the live agent's self-report): read `settings-snapshot.ts` and `context.py` myself, reproduced the failure by
writing the real wrapper shape and watching `budget.maxPierRounds`/`tools.staticAnalysis`/`guards.hooksEnabled` all
get ignored, then fixed `load_campaign()` to unwrap `settings["settings"]` when present (falling back to the bare
shape for old fixtures). Added `SettingsSnapshotWrapper` (3 tests, `test_guards.py`) using the true wrapper shape;
confirmed **failing against the pre-fix code** (`git stash` the fix, re-run: all 3 fail with the guard denying what
should be allowed or vice versa) before restoring the fix. 65/65 hooks tests pass with the fix in place.

**Caveat carried over, not re-litigated:** the `pbfuzz_fuzz`-unknown-tool pattern (V1 finding #3) reproduced a second
time in an unrelated headless session, strengthening it from "maybe a mid-session-restart artifact" toward "a real,
if still uncharacterized, tool-registration bug" — still not root-caused here. A third occurrence in V3 finally
root-caused and fixed it (`e91416b`); see the V3 section below.

## V3 — Python toy target + Atheris, static analysis off

Workspace `examples/toy-python-atheris` (new, D1-style deliverable — `toy.py`/`harness.py`/`seeds/`/`README.md`
written this session, manually verified with `engine/.venv`'s atheris before the live run), settings:
`staticAnalysis: "off"` (only C/C++ has a static-analysis provider). Session "Start a pbfuzz campaign session",
`/pbfuzz`.

**Onboarding correctly skipped every static-analysis question.** The questionnaire's own status JSON listed
`"skipped": [{"id": "C_static_inputs", "reason": "static analysis is off in settings"}, {"id": "C_oracle_reuse",
"reason": "already known or inferred"}]` before a single question was asked, and the confirmed campaign yaml carries
no `analysis.static` block at all — `analysis.deviation.mode` auto-degraded to `target_only` instead (visible in the
self-check as `deviation: warn — degraded target_only, static analysis off`, explicitly documented as the expected
outcome, not a failure). This is the V3 requirement satisfied directly, with real evidence rather than a design
argument: pbfuzz's questionnaire genuinely branches on `tools.staticAnalysis`, for a language kanalyzer cannot even
target.

**Onboarding — inference quality matched V1's C/C++ run.** The agent scanned the repo unprompted, *ran the harness
itself* against a seed and a hand-crafted `FUZZ\x42` file before asking anything, confirmed `engine/.venv/bin/python`
(not the system `python3 3.8.2`) is the only interpreter with `atheris` importable, and asked exactly 6 gap
questions (S1 repo, S2 bug, S3 env, S4 entry, S5 target, S6 output — all with the correct answer pre-selected as
"Recommended"), all accepted. Wrote its own `build.sh` (no-op assertion: no build system exists for a pure-Python
target) and `run.sh`, verified both by execution on four inputs before drafting. `pbfuzz_campaign draft`/`confirm`
produced a fully evidenced yaml (`entry.run_cmd` pinned to the venv interpreter with the exact reason: the system
python3 lacks atheris); **Approve**.

**Selfcheck passed, all six items** (`engine`/`oracle`/`corpus`/`tracer` pass, `static_analysis` disabled,
`deviation` warn/degraded as above). PIER ran PLAN→IMPLEMENT unattended (stop_guard correctly refused to let the
agent stop mid-PLAN): `bug_predicates.json`'s acceptance set (`len(data) >= 5, data[0:4] == b"FUZZ", data[4] ==
0x42`) was derived in closed form and *empirically checked at both ends of the one-byte boundary* — the shipped
near-miss seed and 0x00/0x43 neighbours reach without triggering, only 0x42 triggers — before the engine ever ran.

**EXECUTE, FINDING — root-caused for the first time.** `pbfuzz_fuzz` returned `unknown tool` on the very first
EXECUTE call (the same symptom as V1 finding #3 and V2's EXECUTE caveat, now reproduced a **third** time in a third,
unrelated session — never a mid-session-settings-change artifact, since this session never touched settings). This
time the agent did not work around it; it root-caused it from the real source instead of assuming:
`host.refresh()` (`packages/dsh-pbfuzz/src/host.ts:287-309`) applies `ctx.tools.restrict({deny})`, where `deny` is
the global tool registry minus the current phase's `visibleTools()` set. At session start the phase was INIT, so
`pbfuzz_fuzz` (EXECUTE-only) was denied and stripped from *this agent's* tool catalog. The plugin only calls
`host.refresh()` again as a side effect of a **pbfuzz tool call's own result handling** — but PIER's documented
procedure advances phases via a plain `write` to `state.json` (never a pbfuzz tool call), so every INIT→PLAN→
IMPLEMENT→EXECUTE hop here happened without a single refresh. When a pbfuzz tool call finally did run and trigger a
refresh under the now-current EXECUTE phase, the recomputed deny list correctly tried to admit `pbfuzz_fuzz` — but
DSH does not re-expand a previously narrowed per-agent tool catalog, so `pbfuzz_fuzz` stayed unavailable, and
`pbfuzz_campaign` (legal moments earlier) newly vanished too, as EXECUTE's recomputed deny list now excluded it.
Ruled out an install/registration problem first: the loaded plugin file has all seven `tools.register` calls,
unconditional, byte-identical to the built tarball. The agent refused to work around it by driving the engine
sidecar directly (`metrics.json` must stay engine-written, per its own PIER-skill instructions), instead asking to
restart the DSH server; I did, the fresh process recomputed this agent's catalog from the EXECUTE state already on
disk, `pbfuzz_fuzz` became callable, and the run **triggered on iteration 1** (0.415s): PoC `b"FUZZ\x42"` (5 bytes,
sha256 `dedb5af5…`), reproduced 4/4 (engine run + 3 independent `run.sh` replays). REFLECT→SUCCESS recorded the
`poc` block; independently re-verified after copying the PoC out of `.pbfuzz/` into `examples/toy-python-atheris/`
(D1-style deliverable, `crashes/poc_round0_s1_stage1_iter1`) — same two stderr markers, same traceback, exit 1.

This third occurrence makes the bug **structural, not incidental**: any session that both onboards a campaign and
reaches EXECUTE without an intervening server restart is expected to hit it, precisely because PIER's own documented
phase-transition mechanism (a direct `write`) is invisible to the plugin's only refresh trigger (a pbfuzz tool
call).

**Fixed (`e91416b`).** Before touching the source, I spawned a background research agent to independently verify the
live agent's diagnosis against `host.ts` rather than fix from its account alone — it confirmed the core structural
claim (`host.refresh()`'s call sites: `agent/created`, a pbfuzz tool call's own `withDashboard()` result handling,
and `onSettingsChanged`/`refreshAll` — never a plain `write`) but **refuted** the live agent's secondary theory that
`ctx.tools.restrict()` cannot "un-deny" a tool for the same agent: that's `@deepseek-ai/dsh-tools` platform code
(hands-off, per "never modify deepseek-harness itself"), and its dispose-then-reapply contract is a full replace,
which `host.refresh()` already uses correctly. The real gap is narrower and simpler than the live agent's full
theory: nothing ever calls `refresh()` at the moment PIER's own `write` lands. Fix: `index.ts` registers a live,
in-process `tools/result` listener — the exact event and pattern two real DSH plugins already use this way
(`fs/tool-present`, `context/agent-instructions`, confirmed by reading their source in the pinned DSH checkout) —
that calls `host.refresh()` whenever a `write` to `state/state.json` succeeds, reusing `projection.ts`'s
`stateDocumentOf()` (now exported) — the exact same blind spot the dashboard fix (`task_7a98f8ae` → `e5e8f67`)
already worked around for the read-only view, now closed for live tool visibility too.
`execute-refresh.spec.ts` exercises the real `@deepseek-ai/cordis` runtime end to end (`kanalyzer-inject.spec.ts`'s
pattern): confirmed **failing against the pre-fix code** via `git stash` (`pbfuzz_fuzz` stays denied after the
write lands) before restoring the fix. `pnpm run test:all` green throughout (kanalyzer 57/57, pbfuzz 102/102, hooks
65+4, engine 207, both client bundles build). Do not treat this pattern as "observed, unconfirmed" going forward —
it is root-caused and fixed, with a regression test pinning it.

**V3 fully verified**: questionnaire skips static-analysis questions when it's off (direct evidence, not inference),
PoC found and independently reproduced. `examples/toy-python-atheris/` now carries the same D1-style deliverable set
as `examples/readelf-c/`: `pbfuzz.campaign.yaml` (`confirmed: true`), `generator.py`, `crashes/poc_round0_s1_stage1_iter1`.

## V4 — Java toy target + Jazzer, plus the host.refresh() fix confirmed live

Workspace `examples/toy-java-jazzer` (new, D1-style deliverable — `Toy.java`/`Fuzz.java`/`seeds/`/`README.md`/
`build.sh` written this session, manually verified with the Jazzer standalone distribution before the live run).
Session "启动 pbfuzz 引导式模糊测试活动", `/pbfuzz`.

**Onboarding — third language, same evidence-based inference.** The agent scanned the repo, ran the harness itself
against the near-miss seed and a hand-crafted `JAVA\x99` file before asking anything, and correctly inferred
`entry.kind: api`/`harness_function: fuzzerTestOneInput`, oracle `preexisting` (the two `System.err.println` markers),
and — after weighing the native `jazzer` launcher against a plain `java -cp ... Jazzer` invocation (both verified
byte-identical: exit 77, both markers) — chose the README's own `jazzer --target_class=Fuzz` form for `entry.run_cmd`.

**FINDING, root-caused (jdb tracer race, not fixed — flagged for W3).** The agent ran
`pbfuzz_engine.tracers.selfcheck.check_tracer` (the exact code the self-check's `tracer` item calls) against the
real target and got `breakpoint Toy.java:25: resolved=None hits=0`. It then read `jdb.py`'s `run()` (piping a fixed
`stop at ... / run / where / cont / exit` script into `jdb`'s stdin in one `subprocess.run` call) and proved the
mechanism empirically: `jdb`'s `run` command is asynchronous (control returns to the prompt before the JVM has
booted), and the piped `exit` — arriving immediately, since stdin is fully buffered — is consumed and kills the VM
before the class ever loads, so the breakpoint is only ever "Deferring breakpoint ..." and never "Set (deferred)
breakpoint ...". Confirmed both ends: a **paced** session (delays between each piped line) reliably resolves and
hits the breakpoint at `Toy.java:25`, proving the target line itself is sound and the defect is purely in how
`jdb.py` feeds the debugger. Also noted: `JdbTracer.run()` requires `entry.run_cmd`'s `argv[0]` basename to be
literally `java`/`java.exe` (`jdb.py:195`), which the native `jazzer` launcher never satisfies — a plain
`java -cp ... com.code_intelligence.jazzer.Jazzer ...` form is required for jdb tracing regardless of the race.
**Independently confirmed** (read `engine/pbfuzz_engine/tracers/jdb.py` myself): `run()` at line ~215 does exactly
one `subprocess.run(jdb_argv, input=session.encode(), ..., capture_output=True, timeout=...)` — no interactive
back-and-forth, no wait for a "VM Started:" message before sending the next command. A real fix needs an interactive
driver (write one command, block for its expected response, then write the next), not a bigger sleep. Recorded in
the campaign as `tracer: off` with the reason; not fixed here (needs careful iteration against a real JVM, out of
scope for this pass) — worth its own change + a real-jdb integration test (currently jdb has only a canned-transcript
unit test, confirmed by grep, which is exactly why this shipped unnoticed).

**FINDING, root-caused and worked around (INIT-gate vs. self-check softness mismatch).** With `tracer: off`, the
`deviation` self-check item reports `skipped` (its own rule: deviation needs the tracer, which isn't there). The
plugin's own `gatePasses` treats this as fine (`gatePasses: true`), but the **hook's** `init_gate()`
(`engine/hooks/pbfuzz_hooks/fsm.py:73-108`) is stricter: `enabled_items()` (line 62) derives "enabled" from the
*global* settings snapshot (`deviationDetection: true`) with no awareness of this campaign's own `tracer: off`
override, so it expects `deviation` to land in `{pass, warn}` or literally `disabled` — `skipped` satisfies neither,
and INIT→PLAN was refused. **Independently confirmed** by reading `fsm.py` myself: this is real, and the hook's own
deny message names the correct remedy ("turn the tool off for this campaign, recorded as `disabled` with a
reason"), which the agent applied by editing `analysis.deviation.enabled: false` into the campaign yaml, matching
exactly what `disableAnalysis()` (`core/campaign.ts`) does for other tools. Not a code bug requiring a fix — the
hook's stricter authority working as designed — but a genuine two-step UX rough edge worth smoothing later: the
plugin's own `gatePasses` and the hook's `init_gate()` compute "is this degraded state acceptable" differently for
the same underlying condition.

**PIER to a PoC, interrupted once by the (now-fixed) tool-catalog bug, confirmed live.** PLAN/IMPLEMENT completed
normally (bug predicates/preconditions/root causes/trigger plans written and schema-valid; `generator.py` verified
deterministic and total against the real target with the engine's own interpreter before EXECUTE). At EXECUTE,
`pbfuzz_fuzz` — and, earlier, `pbfuzz_extract_parameters` in IMPLEMENT — came back `unknown tool`, the exact V1/V2/V3
symptom, now reproduced a **fourth** time in a fourth session (three of those four before the fix; this campaign
hit it before *and* after, deliberately, as the live test of the fix below). The agent diagnosed it identically to
V3 (`host.restrict()` only ever narrows; a session that starts in INIT never regains a later phase's tool) without
prompting, staged a complete handover (fuzz plan + generator re-validated against the engine's own
`load_campaign`/`load_plan`/`GeneratorSandbox` code paths, a hand-written handover-integrity checker confirming
every artifact and JSON document was present and parseable), and asked how to proceed. I deployed the
[host.refresh() fix](#v3--python-toy-target--atheris-static-analysis-off) live for the first time: `pnpm -r build`,
`pnpm pack` both packages, renamed tarballs with the commit SHA (`593cefd`), `dsh plugin --profile web remove/add`,
restarted the server, and told the *same* session to resume. **Confirmed by the live agent itself, unprompted**:
"the catalog-staleness bug you shipped a fix for is genuinely gone... `pbfuzz_fuzz` was callable from this same
session (it previously answered unknown tool twice), and it reported the trigger on its first iteration." PoC:
`b"JAVA\x99"` (5 bytes, sha256 `0fac363c…`), triggered on stage-1 iteration 1, reproduced 4/4 (engine run + 3
independent replays). Independently re-verified again after copying the PoC into `examples/toy-java-jazzer/`: exit
77, both stderr markers, `IllegalStateException` at `Toy.java:27`.

**FINDING, root-caused and fixed live in this same pass (`pbfuzz_campaign status` non-lossless-JSON).** The agent
hit `tool "pbfuzz_campaign" returned invalid output: value is not lossless JSON` calling `status()` mid-campaign —
the same symptom V1 recorded as "observed but unconfirmed" — and traced it itself to `campaign-flow.ts`'s
`items.map(i => ({..., reason: i.reason}))`, which sets an explicit `reason: undefined` for any passing item (the
common case: `engine`/`oracle`/`corpus` all pass with no reason). Independently confirmed by reading DSH's own
`snapshotJsonValue` (`packages/util/values/src/index.ts` in the pinned checkout): a bare `typeof current !==
'object'` check catches `undefined` and aborts the *entire* walk, not just the offending key — so this one always-
undefined field poisoned every `status()` call whenever a self-check had a passing item with no reason, which is
most of them. Fixed (`593cefd`): omit the key instead of setting it to `undefined`. `campaign-status.spec.ts` pins
it (confirmed failing against the pre-fix code via `git stash`). This fix — together with `host.refresh()`
(`e91416b`) — was built, packed and deployed to the live server *before* V4's EXECUTE phase resumed, so V4's own
SUCCESS run exercised it for real, not just in the test suite. (`pbfuzz_extract_parameters`'s tool description
was also wrong — said `extract(data: bytes)`, the engine actually calls `extract_parameters(file_path)`
(`engine/pbfuzz_engine/extract.py`/`sandbox.py`), and the agent read the engine source to resolve the mismatch
before writing its extractor — but that fix (`2c8f78a`) landed after V4 had already finished, so it was not
exercised live here.)

**V4 fully verified**: onboarding, PLAN/IMPLEMENT/EXECUTE and the oracle work identically to the C/C++ and Python
targets for Java/Jazzer too — `entry.run_cmd` plus two stderr regexes, no Java-specific code anywhere in pbfuzz.
`examples/toy-java-jazzer/` carries the same D1-style deliverable set as the other two targets. Two real, confirmed
bugs fixed and deployed live during this pass (`host.refresh()`, `status()`'s lossless-JSON violation); one real,
confirmed, precisely-diagnosed bug flagged for a dedicated fix (`jdb.py`'s piped-session race — needs an
interactive driver, not attempted here); one design inconsistency documented (INIT-gate vs. `gatePasses` softness
for a campaign-level tool override) with a working, hook-documented remedy.

## Onboarding-derivation on readelf-c (CVE text only)

The remaining V4 checklist item: confirm onboarding correctly derives `bug.targets` from indirect bug information
(a CVE description, a patch, or a crash trace) rather than needing a direct `file:line`. Tested the CVE case live —
a new session, given only a fabricated but accurate CVE-2026-90210 description of the readelf-c bug (64-bit +
big-endian + version 1 + entry point `0x400000`/`0x8048000` → abort), asked to draft a *new* campaign
(`readelf-cve-derive`) in the same workspace without being told the file:line. It correctly derived `readelf.cpp:93`
with confidence `high (~0.9)`, reasoning from the two numeric literals in the CVE text pinning one line uniquely,
matching V1's real, independently-established bug location exactly. Patch-only and crash-trace-only were not
separately tested in this pass (time-boxed after the finding below) — this is a real gap, not a claimed pass.

**FINDING, root-caused live (terminal-phase `pbfuzz_campaign` visibility).** Before the derivation itself could run,
the new-campaign draft call failed with `Error: unknown tool "pbfuzz_campaign"` — reproduced twice, in a fresh
session, in a workspace whose `.pbfuzz/active` already pointed at a **different, already-`SUCCESS`** campaign (V1's
own confirmed run). The agent traced it to source before I did: `visibleTools()`
(`packages/dsh-pbfuzz/src/core/phases.ts:114-131`) special-cases `pbfuzz_campaign` to stay visible only for the
*"no confirmed campaign yet"* branch — once `hasConfirmedCampaign` is true, visibility falls through to
`PHASE_TOOLS[phase]`, and `PHASE_TOOLS.SUCCESS = PHASE_TOOLS.STOPPED = []`. So once any campaign in a workspace
reaches a terminal phase, `pbfuzz_campaign` itself — the one tool needed to start something new — becomes
uncallable for every future session in that workspace, not just the one that finished it, with no in-tool recovery
path (only a manual edit of `.pbfuzz/active` plus a host restart). **Independently confirmed** by reading
`phases.ts` myself: correct diagnosis. Worked around live by drafting the new campaign from a sibling copy of
`readelf-c` with no `.pbfuzz/` directory of its own (no product change, no restart). Not fixed in this pass — flagged
as background task `task_e7f8bf80`, since the right fix (should `pbfuzz_campaign` stay visible in terminal phases
the same way it does before any campaign exists?) affects the tool-visibility contract and deserves review rather
than a rushed change.

**Also corrected, independently verified:** while measuring the CVE's accepted set from scratch (not trusting the
existing campaign's notes), the live agent found "all four candidate values trigger, not two" — contradicting V1's
own documented claim that the two `__builtin_bswap64` disjuncts at `readelf.cpp:90` are dead code. I verified this
by hand against the real `./readelf` binary with two freshly crafted big-endian files (`e_entry = bswap64(0x400000)
= 0x400000000000` and `bswap64(0x8048000) = 0x80040800000000`): **both crash, exit 134, `bug location triggered`**.
V1's reasoning (`raw == bswap(bswap(raw))`) was simply wrong — the code applies `bswap64` once, not twice, so that
identity doesn't apply. Corrected `examples/readelf-c/README.md` and this file's V1 section; V1's own PoC and
generator are unaffected (they already fire the raw disjunct), but the "exactly `{0x400000, 0x8048000}`" claim was
false and is now documented accurately as four accepted values, two of which are big-endian-only.

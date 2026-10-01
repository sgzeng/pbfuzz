---
name: pbfuzz
description: "Reproduce a known bug as a verified PoV: an input confirmed against the target's own oracle. Use whenever the ask is to find, reproduce, generate or trigger a bug — a PoV/PoC for a CVE, patch, crash dump or stack trace; reproduce a crash; fuzz a bug. Prefer it over reproducing by hand."
whenToUse: The user wants a verified PoV for a bug in a target repository — from a CVE, a patch, a crash trace, or a plain bug report — rather than a hand-written repro.
---

# Reproduce a bug as a verified PoV

Two phases. **Setup** turns the bug report into a confirmed `pbfuzz.campaign.yaml`. **PIER** then
finds the input, in a loop pbfuzz's own tools drive: PLAN → IMPLEMENT → EXECUTE → REFLECT.

Do not reproduce the bug by hand, and do not construct any input aimed at the bug before the
campaign is confirmed. Running the target on an empty file or a few arbitrary bytes to check a
command line is fine; anything shaped by the bug condition belongs in IMPLEMENT, inside a run the
engine records.

## Setup

1. **You need two things: the repo, and where the bug is.** Ask only for what the user did not
   give you, in one `ask_user_question`. Everything else you infer, without asking the user to
   confirm it: the approval panel in step 5 shows them every inferred field.
2. **`pbfuzz_probe`** scans the repo deterministically: build system, existing harnesses, built
   binaries, seed corpora, existing reach/trigger markers. Call it instead of running `find` or
   `grep` yourself, and stay inside the workspace.
3. **Read the target source** around `bug.targets[]` and the entry point. Work out the run command
   and, if the project has no build script, write one that builds what `run_cmd` runs, with `-g`.
   Nothing more: `draft` makes it executable, and static analysis builds its own bitcode if it is
   ever used.
4. **`pbfuzz_campaign draft`** with the campaign. It builds the target, runs it once on an empty
   input, and reports both. Pass `evidence` for anything you inferred — it is shown to the user
   and not stored.
5. **`pbfuzz_campaign confirm`** shows the user a summary to Approve or Revise. On Revise, fold
   the feedback into a fresh `draft` and confirm again. Approve opens PLAN.

Settings decide the tracer, which analysis tools run, the oracle's default patterns and the output
directory. You never read or ask about them; `draft` fills them in.

### The target location

`bug.targets[].location` is what the whole campaign aims at, so get it right and say how you got
it. **It must be a line carrying an instruction** — a comment, a blank line, a bare declaration or
a `}` resolves to no basic block, and the analyzer reports that by finding nothing rather than by
failing. Prefer the line of the operation itself over its enclosing `if`; for macros, the use, not
the definition. `condition` is the predicate that must hold there, in source syntax.

Deriving it, when the user gave a bug report rather than a line:

- **patch** — the target is the unpatched line the new check protects, at the checked-out
  revision. The condition is the negation of the guard the fix adds.
- **cve** — find the function and the operation the text describes. If the text links a commit,
  treat it as a patch instead; far more precise.
- **crash trace** — the top frame in project code, preferring the frame the sanitizer names as the
  faulting access. The condition comes from the sanitizer's own words.

Several targets are allowed and triggering any one is success, but prefer few and precise. One
location with several ways to trigger is one target with several bug predicates, not several
targets. `onboarding.deriveTargetFrom` may forbid deriving from some forms; if you cannot derive
it, ask for the fix commit, the function, or the line — never guess.

### The oracle

Two stderr regexes: one for reaching the location, one for the predicate holding.

- If `pbfuzz_probe` found existing markers (a Magma build, a project with its own logging), set
  `oracle.mode: preexisting` with those patterns and **insert nothing** — instrumenting an
  already-instrumented target double-counts.
- Otherwise insert a canary per target, on that target's line, with that target's condition:
  `PBFUZZ_LOG("<id>", <cond>);` for C/C++ (`canaries/c/pbfuzz_canary.h`),
  `pbfuzz_canary.canary("<id>", <cond>)` for Python, `PbfuzzCanary.log("<id>", <cond>);` for Java.
  The condition must be side-effect free, and the insertion must not change control flow. Add the
  include path to `build.cmd` rather than editing the build system further; keep the patch
  reversible: capture `git diff` and save it to `<output.dir>/canaries.patch` with the `write`
  tool — a shell `>` redirect into the campaign dir is blocked by the state guard — recorded as
  `oracle.canary_patch`; then rebuild and prove the marker is in the binary
  (`strings <binary> | grep PBFUZZ_REACHED`). If you run that rebuild in the background, end your
  turn and wait for the completion notice — do not `job_output` with `wait: true` to poll it.
  `canaries/README.md` has the full convention.

## PIER

`pbfuzz_plan`, `pbfuzz_fuzz` and `pbfuzz_reflect` own every state transition and write
`state/*.json` themselves. A `write` or `edit` under the state directory is denied. `metrics.json`
is the engine's own evidence — read it, never author it.

**PLAN** — read the target source and the previous round's findings, then call `pbfuzz_plan` with
any of four blocks. It validates them, writes them, and moves to IMPLEMENT.

| Block | Contents |
|---|---|
| `bug_predicates` | disjunctive branches of the trigger condition; satisfying any one triggers |
| `preconditions` | what must hold to *reach* the target; non-semantic ones as math (`width < 100`) |
| `root_causes` | why it triggers once reached, with a category and evidence |
| `trigger_plans` | routes to the bug, each with a self-assessed complexity; work the lowest first |

Every claim needs evidence from something you read or ran. Entries are merged by id: to revise
one, send only its id and the fields that change; anything you leave out stays as it is.

Tools here: `pbfuzz_callgraph` (callers/callees, the function at a line, critical branches),
`pbfuzz_corpus`.

**IMPLEMENT → EXECUTE → REFLECT** is one `pbfuzz_fuzz` call. Send the generator source inline as
`generator_code`; do not write it to a file first. `generate(**params) -> bytes` receives every
plan parameter, plus `seed` if its signature takes one. A rejection lists every problem at once and
says where the source was saved: fix that file with `edit` and resubmit with `generator_path` —
never resend the code. The plan needs:

- `parameter_space` — every dimension the bug condition can be met along. Enumerate them; grep for
  the other values a categorical parameter can take.
- `next_batch_plan` — concrete assignments tried before the sampler, at least
  `fuzzing.stage1MinConcreteParams` of them, covering all trigger plans. Each key must be a real
  parameter with an in-domain value.
- `breakpoints` — locations that validate preconditions and capture state at the bug site.

Prefer malformed and boundary-skewed inputs that slip past format checks. One call writes the
plan, validates the generator, runs stage 1 traced then stage 2 sampling, writes `metrics.json`
and lands in REFLECT. In background mode it returns a job id: end your turn. The completion notice
carries a digest of the round — counts, the PoC, the triggering input, breakpoint hits — so go
straight to REFLECT; do not call `job_output` or read the run files.

**REFLECT** — read-only analysis. Compare `last_reached_count` against previous rounds. For inputs
that did not reach, `pbfuzz_deviation` names where execution left the path and which precondition
was violated. For reach-but-no-trigger, `pbfuzz_trace` reads the variables at the target; put the
bug condition itself in `inline_expr`, so you learn both that it was false and what its operands
were. A breakpoint that comes back `resolved: false` was never bound — usually a build without
`-g` or a line with no instruction — so fix that before believing `hitTimes: 0`. If an `inline_expr`
comes back `not evaluable here`, the variable is not yet in scope at that PC (the breakpoint sits
before its assignment) — move the breakpoint a line or two past the assignment next round rather
than re-requesting the same unresolvable expression.

Then `pbfuzz_reflect` with `next_round`, `success` (needs the engine's own trigger from this round;
the PoC is filled in from it), or `stop`. The round and wall-clock budgets are enforced inside that call: a
`next_round` may come back as `STOPPED` instead, which is the budget, not an error.

## Static analysis

When `tools.staticAnalysis` is on, pbfuzz supplies the analyzer's inputs from the campaign — the
bitcode from its own rebuild, the targets from `bug.targets`, the entries from `llvm-nm`
(`LLVMFuzzerTestOneInput`, else `main`). Never ask the user to configure kanalyzer. It prepares
itself on the first `pbfuzz_callgraph` query; a failure there comes back with concrete options.
Ask it only what reading the source cannot answer, and not during setup; do not call the
`kanalyzer_*` tools directly — they rebuild the target on their own.

| Analysis status | Meaning |
|---|---|
| `ok` | targets resolved and reachable from an entry |
| `no_target` | no target line resolved to a basic block — read the nearby candidates it offers |
| `unreachable` | resolved, but no entry reaches them: check `analysis.static.lto_libs`, the entry, or the target |
| `error` | the analyzer failed; report the diagnosis |

A statically linked dependency library that was not LTO-built silently truncates the call graph,
which looks exactly like "the target is unreachable".

## When a step fails

Diagnose from the real output — the build log, the run output, the tool result — and name the
cause. Offer the user a small set of concrete options with `ask_user_question`: fix the build
command, install the dependency, point at a different binary, correct the target line, turn an
auxiliary tool off for this campaign, extend the budget. Apply the choice and re-run the step.
Never retry a failing call unchanged, and never quietly drop a step.

Turning a tool off is a legitimate outcome, not a failure: record
`analysis.<tool>.enabled: false` with a `disabled_reason` and the run continues without it.

In headless mode (`/pbfuzz run`, or `interviewPolicy: never`) never prompt: write the diagnosis
and the options, then `pbfuzz_reflect stop`.

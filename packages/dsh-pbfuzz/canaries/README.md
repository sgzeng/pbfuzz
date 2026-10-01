# canaries — reach/trigger markers pbfuzz inserts into the target

A canary is two stderr markers at a target location: one saying the location was **reached**,
one saying the bug predicate **triggered**. They are the whole oracle. Because both signals are
stderr regexes, the oracle is independent of language, harness and debugger — which is what lets
the same engine drive C, Python and Java targets.

## The files

| Path | Language | Emits |
|---|---|---|
| `c/pbfuzz_canary.h` | C / C++ | `PBFUZZ_REACHED: <id>` / `PBFUZZ_TRIGGERED: <id>` |
| `c/pbfuzz_canary_magma.h` | C / C++ | `MAGMA: Bug <id> reached` / `MAGMA: Bug <id> triggered` |
| `python/pbfuzz_canary.py` | Python | `PBFUZZ_REACHED: <id>` / `PBFUZZ_TRIGGERED: <id>` |
| `java/PbfuzzCanary.java` | Java | `PBFUZZ_REACHED: <id>` / `PBFUZZ_TRIGGERED: <id>` |

The default spellings match `oracleDefaults.reachedPattern` (`PBFUZZ_REACHED:\s*(\S+)`) and
`oracleDefaults.triggeredPattern` (`PBFUZZ_TRIGGERED:\s*(\S+)`) in
`contracts/pbfuzz-settings.schema.json`. Copy the resolved settings values into the campaign's
`oracle.reached_pattern` / `oracle.triggered_pattern` and set `oracle.mode: canary`.

The Magma variant matches Magma's own `magma_log` byte for byte. Use it only when instrumenting
a **non-Magma** target that should produce Magma-shaped output; its patterns are
`MAGMA: Bug (\S+) reached` and `MAGMA: Bug (\S+) triggered`. A real Magma build already contains
canaries, so that campaign sets `oracle.mode: preexisting` and inserts nothing.

## Insertion convention

1. **One canary per `bug.targets[]` entry.** The `<id>` argument is that target's identifier —
   use the campaign `id` when there is one target, or the bug id (`LUA001`) when the target came
   from a benchmark.
2. **Put it on the target line**, immediately before the instruction the predicate describes, with
   `condition` set to the entry's `bug.targets[].condition`.
3. **The condition must be side-effect free.** The canary must not change the behaviour it
   observes. Re-read the condition for assignments, increments and calls before inserting it.
4. **Do not change control flow.** The C macro is a `do { } while (0)` so it stays a single
   statement and can go into an unbraced `if` body safely. Do not add braces the target did not
   have.
5. **Do not touch the build system beyond the include path.** For C/C++ prefer
   `-I<canaries>/c -include pbfuzz_canary.h` in `build.cmd`/`build.env`, so the source patch is
   exactly the call sites. For Python prefer `PYTHONPATH` in `entry.env`. For Java, add the one
   source file to the compile.

## Reversal convention

Canary insertion is a **reversible patch**, never an unrecorded in-place edit. The target repo
must be restorable exactly, because the user's project is not ours to modify permanently.

Capture `git diff` (from `target.repo`) and save it to `<output.dir>/canaries.patch` with the
`write` tool. Do **not** redirect a shell `git diff > <output.dir>/canaries.patch`: `<output.dir>`
is the campaign's `.pbfuzz/<id>/` directory, and the state guard denies any bash command that
writes into it (the `write` tool, which only touches paths outside `state/`, is allowed). Never
stage the diff through `/tmp` and copy it back — that hits the same guard from the other side.

Record that path in `oracle.canary_patch`. To restore:

```sh
git apply -R "<output.dir>/canaries.patch"
```

When the target is not a git checkout, keep a `.pbfuzz.bak` copy of every file you touch next to
the patch, and say so in the campaign `notes`.

## Verification

Inserting is not enough — the canary has to survive the build and reach the binary. Prove it:

- **C/C++:** `strings <binary> | grep PBFUZZ_REACHED` (or `MAGMA: Bug`) after the rebuild. An
  empty result usually means the rebuild did not pick up the patched file, or the file is
  compiled into a different artifact than the one `entry.run_cmd` runs.
- **Python / Java:** grep the deployed source or the class files; for Java confirm the patched
  `.class` is newer than the patch.
- **All languages:** one run of `entry.run_cmd` on a trivial input must print at least the
  reached marker if the trivial input reaches the target, and must not crash otherwise.

Nothing re-checks this for you: `pbfuzz_campaign draft` builds the target and runs it on an empty
input, but only the first real fuzz run exercises the markers. Prove the marker reached the binary
before you rely on it.

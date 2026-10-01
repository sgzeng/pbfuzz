# toy-java-jazzer

The V4 verification target (PLAN.md §4): a Java project with a Jazzer-shaped harness
(`fuzzerTestOneInput(byte[] data)`), the third language pbfuzz is proven against this session
(after C/C++'s readelf-c and Python's toy-python-atheris) — nothing in pbfuzz itself is Java- or
Jazzer-specific; the engine only ever needs `entry.run_cmd` plus the stderr oracle.

## The bug

`Toy.process()` (`Toy.java`) throws iff the input is at least 5 bytes, starts with the 4-byte
magic `JAVA`, and byte 4 is `0x99`. As with the other two toy targets, this is a single 5-byte
value out of the whole input space, with no seed in `seeds/` within one flipped byte of it
(closest: `magic-near-miss.bin`, `JAVA\x98`, one off from the real `0x99`) — finding it is a
genuine search. The two `System.err.println(...)` calls are the project's own pre-existing
reach/trigger markers (`oracle.mode: preexisting`): `toy: magic JAVA prefix seen` / `toy: crash
byte 0x99 seen`.

`Fuzz.java` is the harness — the standard Jazzer/libFuzzer shape, `fuzzerTestOneInput(byte[])`,
with no `main` method: the Jazzer native launcher supplies its own entry point, the same way a
libFuzzer C/C++ harness needs none when compiled with `-fsanitize=fuzzer`. Two ways to run it:

- `jazzer --target_class=Fuzz` (continuous fuzzing loop) — for a human to sanity-check the
  harness directly.
- `jazzer --target_class=Fuzz -- <input-file>` (pbfuzz's `entry.run_cmd`) — Jazzer's native
  launcher replays exactly that file through `fuzzerTestOneInput` once and exits, the same
  one-shot convention libFuzzer binaries use for a crash testcase. pbfuzz's own two-stage PBT
  engine drives this exactly like any other `entry.kind: api` target; no Jazzer-specific code
  exists anywhere in pbfuzz for this path.

## Layout

- `Toy.java` — the target.
- `Fuzz.java` — the Jazzer harness; `entry.kind: api`, `harness_function: fuzzerTestOneInput`.
- `build.sh` — compiles both against the Jazzer standalone jar (`javac`, no build system needed).
- `seeds/` — five inputs, none within one flipped byte of the actual bug.

## Running it

Needs a JDK (`javac`/`java`) and the [Jazzer](https://github.com/CodeIntelligenceTesting/jazzer)
standalone distribution (native launcher `jazzer` + `jazzer_standalone.jar`) on the machine —
already installed in this environment at `~/.local/opt/jazzer`; override with `JAZZER_HOME` /
`JAZZER_JAR` if yours lives elsewhere:

```bash
./build.sh
printf 'JAVA\x98' > /tmp/near-miss.bin && ~/.local/opt/jazzer/jazzer --target_class=Fuzz --cp=. -- /tmp/near-miss.bin   # reaches, does not crash, exit 0
printf 'JAVA\x99' > /tmp/poc.bin && ~/.local/opt/jazzer/jazzer --target_class=Fuzz --cp=. -- /tmp/poc.bin              # exit 77
```

Then, in a DSH session with this directory as the workspace, run `/pbfuzz`. V4
(docs/verification.md) checks that pbfuzz's onboarding, PLAN/IMPLEMENT/EXECUTE and the oracle work
identically to the C/C++ and Python targets, and that PIER finds `JAVA\x99` on its own.

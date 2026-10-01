# toy-python-atheris

The V3 verification target (PLAN.md §4): a Python project with an Atheris-shaped harness
(`TestOneInput(data: bytes)`), used to prove pbfuzz's language decoupling (R2) — nothing in
pbfuzz itself is Python- or Atheris-specific; the engine only ever needs `entry.run_cmd` plus the
stderr oracle, exactly as for a C/C++ target.

## The bug

`toy.process()` (`toy.py`) raises iff the input is at least 5 bytes, starts with the 4-byte magic
`FUZZ`, and byte 4 is `0x42`. A single 5-byte value out of the whole input space, with no seed in
`seeds/` anywhere close — finding it is a genuine search, not a coincidence. The two `print(...,
file=sys.stderr)` calls are the project's own pre-existing reach/trigger markers
(`oracle.mode: preexisting`), the same "the project already tells you" pattern readelf-c and
Magma both use, spelled in Python: `toy: magic FUZZ prefix seen` / `toy: crash byte 0x42 seen`.

`harness.py` wraps it in the standard Atheris/libFuzzer shape (`TestOneInput`, `atheris.Setup` +
`atheris.Fuzz()` for a human running it directly) — the harness a real project would already
have. Run one-shot the way pbfuzz's own two-stage PBT engine drives it — `./harness.py <file>` —
and `TestOneInput` runs on exactly that file's bytes once; no Atheris-specific code exists
anywhere in pbfuzz for this path.

## Layout

- `toy.py` — the target.
- `harness.py` — the Atheris harness; `entry.kind: api`, `harness_function: TestOneInput`.
- `seeds/` — five inputs, none within one flipped byte of the actual bug (closest:
  `magic-near-miss.bin`, `FUZZ\x41`, one off from the real `0x42`).

## Running it

Needs `atheris` on the interpreter pbfuzz uses (`pip install atheris`; already present in this
repo's own `engine/.venv`, which is enough to run the harness standalone — it does not need to be
the same interpreter the *target* runs under, since `entry.run_cmd` names its own):

```bash
engine/.venv/bin/python harness.py seeds/magic-near-miss.bin   # reaches, does not crash
printf 'FUZZ\x42' > /tmp/poc.bin && engine/.venv/bin/python harness.py /tmp/poc.bin   # exit 1
```

Then, in a DSH session with this directory as the workspace and `tools.staticAnalysis: off` in
Settings → PBFuzz (kanalyzer only supports C/C++), run `/pbfuzz`. V3 (docs/verification.md)
checks that the questionnaire skips every static-analysis question when it is off, and that PIER
finds `FUZZ\x42` on its own.

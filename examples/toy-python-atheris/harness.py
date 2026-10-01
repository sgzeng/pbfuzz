#!/usr/bin/env python3
"""The project's existing Atheris harness (entry.kind: api, harness_function: TestOneInput) —
the standard Atheris/libFuzzer entry-point shape, so `/pbfuzz`'s onboarding recognises this as a
harness to reuse rather than something to build.

Two ways to run it, both exercising the exact same `TestOneInput`:

- `atheris.Fuzz()` (this file's own `__main__`): Atheris's native, continuous fuzzing loop —
  useful for a human to sanity-check the harness directly.
- `./harness.py <input-file>` (pbfuzz's `entry.run_cmd`): pbfuzz has its own two-stage PBT
  engine, so it drives `TestOneInput` itself, one input at a time from a file, the same way it
  drives any other `entry.kind: executable`/`api` target — no Python- or Atheris-specific code
  exists anywhere in pbfuzz for this. This is the one-shot mode `/pbfuzz`'s questionnaire infers.
"""

from __future__ import annotations

import sys

import atheris

from toy import process


def TestOneInput(data: bytes) -> None:
    fdp = atheris.FuzzedDataProvider(data)
    process(fdp.ConsumeBytes(len(data)))


if __name__ == "__main__":
    if len(sys.argv) == 2 and not sys.argv[1].startswith("-"):
        # pbfuzz's one-shot mode: run exactly the input named on argv[1] once.
        with open(sys.argv[1], "rb") as f:
            TestOneInput(f.read())
    else:
        # A human running this directly gets Atheris's own continuous fuzzing loop.
        atheris.Setup(sys.argv, TestOneInput)
        atheris.Fuzz()

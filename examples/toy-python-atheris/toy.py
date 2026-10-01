"""The bug under test: a tiny parser with a deliberately narrow crash condition.

Not a real Atheris/libFuzzer entry point on its own — `harness.py` is that; this module is the
"project" a harness wraps, kept separate the way a real target would be.
"""

from __future__ import annotations

import sys


def process(data: bytes) -> None:
    """Raise iff `data` starts with the 4-byte magic `FUZZ` followed by the byte `0x42`.

    A 5-byte, exactly-one-value bug: no seed in the corpus is anywhere close, so finding it is a
    genuine search, not a coincidence — matching V3's point (PLAN.md §4): the questionnaire and
    the engine work the same way for Python as for C/C++, entirely through `entry.run_cmd` and
    the stderr oracle, with no Python-specific code anywhere in pbfuzz itself. The two prints are
    this project's own pre-existing reach/trigger markers (oracle.mode: preexisting) — the same
    "the project already tells you" pattern readelf-c and Magma both use, just spelled Python.
    """
    if len(data) >= 4 and data[0:4] == b"FUZZ":
        print("toy: magic FUZZ prefix seen", file=sys.stderr)
        if len(data) >= 5 and data[4] == 0x42:
            print("toy: crash byte 0x42 seen", file=sys.stderr)
            raise ValueError("crash: FUZZ magic followed by byte 0x42")

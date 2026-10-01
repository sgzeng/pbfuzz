"""pbfuzz reach/trigger canary — Python.

Emits the two stderr markers the campaign oracle matches::

    PBFUZZ_REACHED: <id>
    PBFUZZ_TRIGGERED: <id>

which are what the default ``oracleDefaults.reachedPattern``
(``PBFUZZ_REACHED:\\s*(\\S+)``) and ``oracleDefaults.triggeredPattern``
(``PBFUZZ_TRIGGERED:\\s*(\\S+)``) in ``pbfuzz-settings.schema.json`` expect. A campaign
using this sets ``oracle.mode: canary`` and copies those two regexes into
``oracle.reached_pattern`` / ``oracle.triggered_pattern``.

Insertion is a reversible patch — see ``../README.md``.

Installation: the target must be able to import this module. In order of preference:

1. Copy this file next to the target package and import it (one extra file, recorded in
   the patch alongside the call sites).
2. Add its directory to ``entry.env`` as ``PYTHONPATH`` in the campaign, leaving the
   target tree untouched apart from the ``import`` lines.

Abort mode: set ``PBFUZZ_CANARY_ABORT=1`` in the environment to make a trigger kill the
process, matching ``oracle.canary_on_trigger: abort``. The default (``log``) keeps the run
alive so one execution can report several signals.
"""

from __future__ import annotations

import os
import sys

__all__ = ["canary", "reached", "triggered"]


def canary(bug_id: str, condition: object = False) -> None:
    """Report reaching ``bug_id``, and triggering it when ``condition`` is truthy.

    ``condition`` is evaluated by the caller, so keep it side-effect free: the canary must
    not change the behaviour it is observing.
    """
    print(f"PBFUZZ_REACHED: {bug_id}", file=sys.stderr, flush=True)
    if condition:
        print(f"PBFUZZ_TRIGGERED: {bug_id}", file=sys.stderr, flush=True)
        if os.environ.get("PBFUZZ_CANARY_ABORT") == "1":
            # os.abort() raises SIGABRT without unwinding, so a harness-level `except`
            # cannot swallow the trigger the way sys.exit() would.
            os.abort()


def reached(bug_id: str) -> None:
    """Reach-only canary, for a location with no predicate to evaluate."""
    print(f"PBFUZZ_REACHED: {bug_id}", file=sys.stderr, flush=True)


def triggered(bug_id: str) -> None:
    """Trigger-only canary, for a site already known to be reached."""
    print(f"PBFUZZ_TRIGGERED: {bug_id}", file=sys.stderr, flush=True)
    if os.environ.get("PBFUZZ_CANARY_ABORT") == "1":
        os.abort()

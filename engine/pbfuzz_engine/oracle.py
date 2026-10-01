"""The stderr-regex oracle.

Both signals a run can produce — "the target location was reached" and "the bug predicate
held" — are regexes matched against stderr. That is what keeps the oracle independent of
language and harness: a Magma `MAGMA_LOG`, a pbfuzz-inserted canary and an Atheris traceback
are all just lines on stderr.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .campaign import Oracle as OracleConfig


@dataclass(frozen=True)
class Verdict:
    """What the oracle made of one execution."""

    reached: bool
    triggered: bool
    reached_match: str | None = None
    triggered_match: str | None = None

    @property
    def reached_count(self) -> int:
        """1/0 form, as stored in an iteration record."""
        return 1 if self.reached else 0

    @property
    def triggered_count(self) -> int:
        """1/0 form, as stored in an iteration record."""
        return 1 if self.triggered else 0


class StderrOracle:
    """Judges an execution by matching two regexes against its stderr.

    A timed-out run is never counted as reached or triggered: its stderr is truncated at an
    arbitrary point, so a match there says nothing reliable about whether the target was
    actually reached.
    """

    def __init__(self, reached_pattern: str, triggered_pattern: str) -> None:
        self.reached_pattern = reached_pattern
        self.triggered_pattern = triggered_pattern
        self._reached = re.compile(reached_pattern)
        self._triggered = re.compile(triggered_pattern)

    @classmethod
    def from_campaign(cls, oracle: OracleConfig) -> "StderrOracle":
        """Build the oracle from a validated campaign's `oracle` section."""
        return cls(oracle.reached_pattern, oracle.triggered_pattern)

    def judge(self, stderr: str, *, timed_out: bool = False) -> Verdict:
        """Judge one execution's stderr.

        Args:
            stderr: The process's decoded standard error.
            timed_out: True when the process was killed by the execution timeout.

        Returns:
            The verdict. Always negative on both counts when `timed_out` is true.
        """
        if timed_out or not stderr:
            return Verdict(False, False)
        reached = self._reached.search(stderr)
        triggered = self._triggered.search(stderr)
        return Verdict(
            reached=reached is not None,
            triggered=triggered is not None,
            reached_match=reached.group(0) if reached else None,
            triggered_match=triggered.group(0) if triggered else None,
        )

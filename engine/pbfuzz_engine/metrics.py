"""`metrics.json` — written ONLY by this module.

contracts/state/metrics.schema.json: the engine is the sole writer; `state_guard` denies any
agent `write`/`edit` of the file and `bash_guard` records tampering attempts. That separation is
what makes the metrics trustworthy evidence for REFLECT — the model cannot report progress it did
not make.

Rules this module keeps:

* Nothing else in the engine opens `metrics.json` for writing; every update goes through
  `MetricsStore.record_session`.
* Writes are atomic (temp file + `os.replace`), so a reader never sees a torn file.
* Cumulative counters are recomputed from the previous file plus this session, never taken from
  the caller, so an RPC client cannot set them directly.
* Only keys declared in the schema are written (`additionalProperties: false`).
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

METRICS_FILENAME = "metrics.json"

_STOPPED_BY = {"completed", "timeout", "trigger", "error", "cancelled"}

_lock = threading.Lock()


@dataclass(frozen=True)
class SessionMetrics:
    """What one `fuzz.run` session contributes."""

    iterations: int
    reached: int
    triggered: int
    timeouts: int
    errors: int
    elapsed_sec: float
    stopped_by: str
    first_triggering_input: str | None = None
    best_reaching_input: str | None = None
    #: How many times the engine re-ran `first_triggering_input` after the session stopped, and
    #: how many of those triggered again. `pbfuzz_reflect success` reads this instead of asking
    #: the agent for a number it could only get by running the target by hand.
    reproduced_times: int | None = None
    reproduced_ok: int | None = None


class MetricsStore:
    """Reader/sole writer of `<output.dir>/state/metrics.json`."""

    def __init__(self, state_dir: str | Path) -> None:
        self.state_dir = Path(state_dir)
        self.path = self.state_dir / METRICS_FILENAME

    def read(self) -> dict[str, Any]:
        """The current metrics, or zeroed metrics when none exist yet or the file is unreadable."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        return {"total_iterations": 0, "total_reached_count": 0, "triggered_count": 0}

    def record_session(self, session: SessionMetrics, *, campaign_id: str, pier_round: int | None) -> dict[str, Any]:
        """Fold one session into the cumulative metrics and write them atomically."""
        if session.stopped_by not in _STOPPED_BY:
            raise ValueError(f"stopped_by must be one of {sorted(_STOPPED_BY)}")
        for value in (session.iterations, session.reached, session.triggered, session.timeouts, session.errors):
            if value < 0:
                raise ValueError("session counters must be non-negative")
        with _lock:
            prev = self.read()

            def prev_int(key: str) -> int:
                v = prev.get(key, 0)
                return v if isinstance(v, int) and v >= 0 else 0

            last_session: dict[str, Any] = {
                "iterations": session.iterations,
                "reached": session.reached,
                "triggered": session.triggered,
                "timeouts": session.timeouts,
                "errors": session.errors,
                "elapsed_sec": round(max(0.0, session.elapsed_sec), 3),
                "stopped_by": session.stopped_by,
            }
            if session.first_triggering_input:
                last_session["first_triggering_input"] = session.first_triggering_input
            if session.best_reaching_input:
                last_session["best_reaching_input"] = session.best_reaching_input
            if session.reproduced_times is not None:
                last_session["reproduced_times"] = session.reproduced_times
                last_session["reproduced_ok"] = session.reproduced_ok or 0

            out: dict[str, Any] = {
                "campaign_id": campaign_id,
                "total_iterations": prev_int("total_iterations") + session.iterations,
                "total_reached_count": prev_int("total_reached_count") + session.reached,
                "last_reached_count": session.reached,
                "triggered_count": prev_int("triggered_count") + session.triggered,
                "timeout_count": prev_int("timeout_count") + session.timeouts,
                "error_count": prev_int("error_count") + session.errors,
                "last_session": last_session,
                "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            # Always written: W7's guards read `pier_round` (and `triggered_count`, for the SUCCESS
            # gate) from this file. Caller's value, else the previous file's, else 0.
            round_value = pier_round if pier_round is not None else prev.get("pier_round")
            out["pier_round"] = round_value if isinstance(round_value, int) and not isinstance(round_value, bool) and round_value >= 0 else 0

            self.state_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".metrics-", suffix=".json", dir=str(self.state_dir))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(out, handle, indent=2)
                    handle.write("\n")
                # mkstemp creates the temp file 0600, which os.replace then preserves — leaving
                # metrics.json the one file in state/ unreadable by group, unlike every sibling the
                # host writes. Re-apply the umask-derived mode (0664 under the usual umask) so the
                # whole directory is consistent.
                umask = os.umask(0)
                os.umask(umask)
                os.chmod(tmp, 0o666 & ~umask)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            return out

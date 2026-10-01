"""Running the program under test on one input.

`entry.run_cmd` is a full command template. When `entry.input_channel` is `file`, the AFL-style
`@@` placeholder is replaced with the input file's path; when it is `stdin`, the input bytes
are piped to the process instead. Those two cases are the whole of the target adapter, which is
why libFuzzer, Atheris and Jazzer harnesses all work without engine changes.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .campaign import AT_FILE, Entry
from .errors import TARGET_FAILED, EngineError, remedy
from .proc import run_with_group_kill

#: Exit code convention for a process killed by a timeout, matching `timeout(1)`.
TIMEOUT_EXIT_CODE = 124


@dataclass(frozen=True)
class ExecResult:
    """The outcome of running the target once."""

    stderr: str
    exit_code: int
    timed_out: bool
    duration_ms: int

    @property
    def signal_name(self) -> str:
        """The signal that killed the process, or an empty string.

        A negative return code from `subprocess` means death by signal; that is how a crashing
        target (SIGSEGV, SIGABRT from an `abort`-mode canary) reports itself.
        """
        if self.exit_code < 0:
            try:
                return signal.Signals(-self.exit_code).name
            except ValueError:
                return f"SIG{-self.exit_code}"
        return ""


def prepare_cmd_and_stdin(
    run_cmd: str, input_path: str, input_bytes: bytes, *, input_channel: str = "file"
) -> tuple[list[str], bytes | None]:
    """Split a command template and decide what goes on stdin.

    Args:
        run_cmd: The `entry.run_cmd` template.
        input_path: Path to the file holding this iteration's input.
        input_bytes: The same input's bytes, already read.
        input_channel: `file` or `stdin`, from `entry.input_channel`.

    Returns:
        `(argv, stdin_bytes)`. `stdin_bytes` is None when the input goes in as a file path.
    """
    argv = shlex.split(run_cmd)
    if input_channel == "file" and AT_FILE in argv:
        argv = [input_path if arg == AT_FILE else arg for arg in argv]
        return argv, None
    if input_channel == "file":
        # The campaign validator rejects this combination up front; reaching here means the
        # caller built an Entry by hand. Treat the input as stdin rather than running blind.
        return argv, input_bytes
    return argv, input_bytes


def run_target(
    entry: Entry,
    input_path: Path,
    input_bytes: bytes,
    *,
    timeout_sec: float,
    cwd: Path | None = None,
) -> ExecResult:
    """Execute the target once on one input.

    stdout is discarded: the oracle only reads stderr, and a chatty target would otherwise
    fill the pipe and deadlock.

    Raises:
        EngineError: With `TARGET_FAILED` when the command cannot be executed at all — a
            missing binary or a non-executable file, as opposed to a target that runs and
            fails, which is a normal fuzzing outcome.
    """
    argv, stdin_data = prepare_cmd_and_stdin(
        entry.run_cmd, str(input_path), input_bytes, input_channel=entry.input_channel
    )
    if not argv:
        raise EngineError(
            TARGET_FAILED,
            "campaign.entry.run_cmd is empty",
            diagnosis="`entry.run_cmd` produced no command after shell-splitting, so there is nothing to run.",
            remedies=[remedy("edit_campaign", "Set entry.run_cmd", detail="e.g. `./build/readelf -a @@`", effect="edit_campaign")],
        )

    env = {**os.environ, **entry.env}
    workdir = Path(entry.cwd) if entry.cwd else (cwd or input_path.parent)

    started = time.monotonic()
    try:
        result = run_with_group_kill(
            argv,
            input=stdin_data,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            cwd=str(workdir),
            env=env,
            timeout_sec=timeout_sec,
        )
    except FileNotFoundError as exc:
        raise EngineError(
            TARGET_FAILED,
            f"cannot execute the target: {argv[0]} not found",
            diagnosis=(
                f"`{argv[0]}` from `entry.run_cmd` does not exist. The target is probably not built, "
                f"or `entry.run_cmd` names a different path than the build actually writes."
            ),
            remedies=[
                remedy("build_target", "Build the target", detail="Run the campaign's `build.cmd`, then retry.", effect="run_command"),
                remedy("fix_run_cmd", "Correct entry.run_cmd", detail=f"`{argv[0]}` was not found on disk or on PATH.", effect="edit_campaign"),
            ],
        ) from exc
    except PermissionError as exc:
        raise EngineError(
            TARGET_FAILED,
            f"cannot execute the target: {argv[0]} is not executable",
            diagnosis=f"`{argv[0]}` exists but is not executable by this user.",
            remedies=[
                remedy("chmod", "Make the target executable", detail=f"chmod +x {argv[0]}", effect="run_command"),
                remedy("fix_run_cmd", "Correct entry.run_cmd", effect="edit_campaign"),
            ],
        ) from exc
    except NotADirectoryError as exc:
        raise EngineError(
            TARGET_FAILED,
            f"cannot execute the target: working directory {workdir} is invalid",
            diagnosis=f"`{workdir}` is not a directory; `entry.cwd` points at a file or a missing path.",
            remedies=[remedy("fix_cwd", "Correct entry.cwd", effect="edit_campaign")],
        ) from exc

    if result.timed_out:
        return ExecResult(
            stderr=result.stderr.decode("utf-8", errors="replace") if result.stderr else "",
            exit_code=TIMEOUT_EXIT_CODE,
            timed_out=True,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    return ExecResult(
        stderr=result.stderr.decode("utf-8", errors="replace") if result.stderr else "",
        exit_code=result.returncode,
        timed_out=False,
        duration_ms=int((time.monotonic() - started) * 1000),
    )

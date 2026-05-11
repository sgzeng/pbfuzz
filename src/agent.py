"""CyberGym purple agent: INIT (with retry + fallback) then pbfuzz inner loop with green-validated outer rounds."""

from __future__ import annotations

import asyncio
import base64
import os
import traceback
from pathlib import Path
from typing import Any
from uuid import uuid4

import cursor_runner
import init_check
import output_sync
import pbfuzz_env
import workspace as ws_mod
from a2a.server.tasks import TaskUpdater
from a2a.types import DataPart, FilePart, FileWithBytes, Message, Part, Role, TaskState, TextPart
from a2a.utils import get_message_text, new_agent_text_message
from prompts import INIT_PROMPT

# fallback package lives at /home/agent/fallback (sibling of /home/agent/src) — Dockerfile sets PYTHONPATH.
from fallback import run_fallback_loop  # noqa: E402

MAX_OUTER_ROUNDS = int(os.environ.get("MAX_OUTER_ROUNDS", "3"))
MAX_FALLBACK_ITER = int(os.environ.get("MAX_FALLBACK_ITER", os.environ.get("MAX_ITER", "5")))
INIT_TIMEOUT_SEC = int(os.environ.get("INIT_TIMEOUT_SEC", "1200"))
INNER_TIMEOUT_SEC = int(os.environ.get("INNER_TIMEOUT_SEC", "1800"))
INIT_MAX_ATTEMPTS = int(os.environ.get("INIT_MAX_ATTEMPTS", "2"))


def _purple_task_workspace(context_id: str) -> Path:
    """Task workspace root (Docker: ``/work/<ctx>``). Override with ``PBFUZZ_PURPLE_WORK_ROOT`` for local tests."""
    root = (os.environ.get("PBFUZZ_PURPLE_WORK_ROOT") or "/work").strip() or "/work"
    return Path(root) / context_id.replace("/", "_")


def _append_runtime_log(workspace: Path, line: str) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    with (workspace / "agent_runtime.log").open("a", encoding="utf-8") as f:
        f.write(line.rstrip() + "\n")


def _append_error_log(workspace: Path, stage: str, exc: BaseException) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    with (workspace / "agent_error.log").open("a", encoding="utf-8") as f:
        f.write(f"[{stage}] {exc}\n")
        f.write(traceback.format_exc())
        f.write("\n")


def _get_data_part(message: Message) -> dict[str, Any] | None:
    for part in message.parts:
        if isinstance(part.root, DataPart):
            return part.root.data
    return None


def _has_task_files(message: Message) -> bool:
    for part in message.parts:
        if isinstance(part.root, FilePart) and isinstance(part.root.file, FileWithBytes):
            return True
    return False


def _build_init_prompt(workspace: Path, vuln_root: Path, last_feedback: str) -> str:
    paths_block = (
        "\n\n## Resolved paths\n"
        f"- **Task workspace** (TASK.md, repo-vul/, repo-fix/, patch.diff, description.txt): `{workspace.resolve()}`\n"
        f"- **Current project root** (your shell cwd / `source/` target): `{vuln_root}`\n"
    )
    feedback_block = ""
    if last_feedback:
        feedback_block = (
            "\n\n## Previous attempt feedback\n"
            f"The wrapper rejected your previous INIT output with this reason:\n\n> {last_feedback}\n\n"
            "Address it directly and retry.\n"
        )
    return INIT_PROMPT + paths_block + feedback_block


class Agent:
    """Per-context session: unpack, INIT (with fallback), repeated inner fuzz + green PoC checks."""

    def __init__(self) -> None:
        self.feedback_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._waiting = False
        self._artifact_emitted = False

    def is_awaiting_feedback(self) -> bool:
        return self._waiting

    async def deliver_feedback(self, msg: Message) -> None:
        data = _get_data_part(msg) or {}
        await self.feedback_queue.put(data)

    async def _emit_artifact(self, updater: TaskUpdater, poc: bytes) -> None:
        await updater.add_artifact(
            parts=[
                Part(
                    root=FilePart(
                        file=FileWithBytes(
                            bytes=base64.b64encode(poc).decode("ascii"),
                            name="poc",
                        )
                    )
                )
            ],
            name="PoC",
        )
        self._artifact_emitted = True

    async def run(self, message: Message, updater: TaskUpdater) -> None:
        ctx = message.context_id or updater.context_id
        if not _has_task_files(message):
            input_text = get_message_text(message)
            await updater.update_status(
                TaskState.working,
                new_agent_text_message("Thinking...", context_id=ctx, task_id=updater.task_id),
            )
            await updater.add_artifact(parts=[Part(root=TextPart(text=input_text))], name="Echo")
            return

        workspace = _purple_task_workspace(ctx)
        workspace.mkdir(parents=True, exist_ok=True)
        _append_runtime_log(workspace, f"context={ctx} task_id={updater.task_id} start")
        self._artifact_emitted = False
        try:
            ws_mod.unpack_message_parts(message, workspace)
            output_sync.sync_context_output(context_id=ctx, workspace=workspace, phase="after_unpack")

            task_id = ws_mod.guess_task_id(workspace)
            pbfuzz_ws = ws_mod.init_pbfuzz_layout(workspace, task_id)
            ws_mod.write_init_mcp(pbfuzz_ws)
            vuln_root = (pbfuzz_ws / "source").resolve()

            init_ok = await self._run_init(workspace, vuln_root, pbfuzz_ws, task_id, ctx, updater)
            if not init_ok:
                await self._run_fallback(workspace, ctx, updater)
                return

            await self._run_outer_loop(workspace, pbfuzz_ws, task_id, ctx, updater)
        finally:
            if not self._artifact_emitted:
                await self._emit_artifact(updater, b"\x00")
                _append_runtime_log(
                    workspace,
                    "emit.min_placeholder_poc: no FilePart was submitted yet; "
                    "green grader requires a non-empty artifact (score may still be 0).",
                )

    async def _run_init(
        self,
        workspace: Path,
        vuln_root: Path,
        pbfuzz_ws: Path,
        task_id: str,
        ctx: str,
        updater: TaskUpdater,
    ) -> bool:
        last_feedback = ""
        for attempt in range(INIT_MAX_ATTEMPTS):
            await updater.update_status(
                TaskState.working,
                new_agent_text_message(
                    f"INIT attempt {attempt + 1}/{INIT_MAX_ATTEMPTS} (task_id={task_id})",
                    context_id=ctx,
                    task_id=updater.task_id,
                ),
            )
            _append_runtime_log(workspace, f"init.attempt.{attempt}.start last_feedback={last_feedback!r}")
            prompt = _build_init_prompt(workspace, vuln_root, last_feedback)
            try:
                await cursor_runner.run_iteration(vuln_root, prompt, timeout=INIT_TIMEOUT_SEC)
            except Exception as e:  # noqa: BLE001
                _append_error_log(workspace, f"init.attempt.{attempt}", e)
                last_feedback = f"INIT cursor-agent raised: {e}"
                output_sync.sync_context_output(
                    context_id=ctx, workspace=workspace, phase=f"init_exception_{attempt}"
                )
                continue
            output_sync.sync_context_output(
                context_id=ctx, workspace=workspace, phase=f"after_init_{attempt}"
            )

            ok, reason = init_check.validate_init(workspace, pbfuzz_ws)
            _append_runtime_log(workspace, f"init.attempt.{attempt}.validate ok={ok} reason={reason!r}")
            if ok:
                break
            last_feedback = reason
        else:
            _append_runtime_log(workspace, "init.exhausted_attempts")
            return False

        oracle_ok, oracle_log = init_check.auto_insert_oracles(pbfuzz_ws, task_id)
        _append_runtime_log(
            workspace, f"init.auto_oracles ok={oracle_ok} log_tail={oracle_log[-400:]!r}"
        )
        output_sync.sync_context_output(
            context_id=ctx, workspace=workspace, phase="after_auto_oracles"
        )
        return oracle_ok

    async def _run_fallback(self, workspace: Path, ctx: str, updater: TaskUpdater) -> None:
        _append_runtime_log(workspace, "fallback.start")
        await updater.update_status(
            TaskState.working,
            new_agent_text_message(
                "INIT failed; falling back to cursor-cli-purple iter loop.",
                context_id=ctx,
                task_id=updater.task_id,
            ),
        )
        try:
            poc = await run_fallback_loop(workspace, self, updater, ctx, MAX_FALLBACK_ITER)
        except Exception as e:  # noqa: BLE001
            _append_error_log(workspace, "fallback", e)
            poc = None
        output_sync.sync_context_output(context_id=ctx, workspace=workspace, phase="after_fallback")
        if poc:
            await self._emit_artifact(updater, poc)
            _append_runtime_log(workspace, f"fallback.final_poc_bytes={len(poc)}")
        else:
            _append_runtime_log(workspace, "fallback.no_poc")

    async def _run_outer_loop(
        self,
        workspace: Path,
        pbfuzz_ws: Path,
        task_id: str,
        ctx: str,
        updater: TaskUpdater,
    ) -> None:
        candidate_poc: bytes | None = None
        last_poc: bytes | None = None
        confirmed_crash = False

        for outer in range(MAX_OUTER_ROUNDS):
            ws_mod.clear_candidate_marker(pbfuzz_ws)
            _append_runtime_log(workspace, f"outer.{outer}.start")
            await updater.update_status(
                TaskState.working,
                new_agent_text_message(
                    f"outer {outer}: pbfuzz launcher + cursor inner loop",
                    context_id=ctx,
                    task_id=updater.task_id,
                ),
            )
            cfg_path = pbfuzz_env.write_launcher_config(pbfuzz_ws, task_id)
            log_agg = pbfuzz_ws / "output" / "agent_bundle.log"
            try:
                rc = await pbfuzz_env.run_launcher(cfg_path, log_append=log_agg)
            except Exception as e:  # noqa: BLE001
                _append_error_log(workspace, f"outer.{outer}.launcher_exception", e)
                output_sync.sync_context_output(
                    context_id=ctx, workspace=workspace, phase=f"launcher_exception_outer_{outer}"
                )
                continue
            output_sync.sync_context_output(
                context_id=ctx, workspace=workspace, phase=f"after_launcher_outer_{outer}"
            )
            if rc != 0:
                _append_runtime_log(workspace, f"outer.{outer}.launcher_exit={rc}")

            prompt_file = pbfuzz_ws / "output" / "prompt.txt"
            if not prompt_file.is_file():
                ws_mod.append_green_feedback(
                    pbfuzz_ws,
                    outer,
                    None,
                    {"output": "", "exit_code": None, "error": "no prompt.txt"},
                    note="launcher failed",
                )
                continue

            src_ws = (pbfuzz_ws / "source").resolve()
            try:
                await cursor_runner.run_iteration_source_only(
                    prompt_file, src_ws, timeout=INNER_TIMEOUT_SEC
                )
            except Exception as e:  # noqa: BLE001
                _append_error_log(workspace, f"outer.{outer}.inner_cursor", e)
                output_sync.sync_context_output(
                    context_id=ctx, workspace=workspace, phase=f"inner_exception_outer_{outer}"
                )
                continue
            output_sync.sync_context_output(
                context_id=ctx, workspace=workspace, phase=f"after_inner_{outer}"
            )

            candidate_poc = ws_mod.read_candidate_poc(pbfuzz_ws)
            if candidate_poc is None or len(candidate_poc) == 0:
                _append_runtime_log(workspace, f"outer.{outer}.no_candidate")
                ws_mod.append_green_feedback(
                    pbfuzz_ws,
                    outer,
                    None,
                    None,
                    note="no candidate_poc.bin produced",
                )
                continue
            last_poc = candidate_poc

            await updater.update_status(
                TaskState.working,
                Message(
                    role=Role.agent,
                    parts=[
                        Part(root=DataPart(data={"action": "test_vulnerable"})),
                        Part(
                            root=FilePart(
                                file=FileWithBytes(
                                    bytes=base64.b64encode(candidate_poc).decode("ascii"),
                                    name="poc",
                                )
                            )
                        ),
                    ],
                    message_id=uuid4().hex,
                    context_id=ctx,
                    task_id=updater.task_id,
                ),
            )

            self._waiting = True
            try:
                feedback = await asyncio.wait_for(self.feedback_queue.get(), timeout=600)
            finally:
                self._waiting = False

            ws_mod.append_green_feedback(pbfuzz_ws, outer, candidate_poc, feedback)
            _append_runtime_log(
                workspace, f"outer.{outer}.feedback_exit={feedback.get('exit_code', 'none')}"
            )

            if isinstance(feedback.get("exit_code"), int) and feedback["exit_code"] != 0:
                confirmed_crash = True
                _append_runtime_log(workspace, f"outer.{outer}.confirmed_nonzero_break")
                break

        output_sync.sync_context_output(context_id=ctx, workspace=workspace, phase="loop_finished")

        if last_poc:
            await self._emit_artifact(updater, last_poc)
            _append_runtime_log(
                workspace, f"final_poc_bytes={len(last_poc)} confirmed={confirmed_crash}"
            )
            return

        # No candidate from pbfuzz across all outer rounds; try fallback as last resort.
        _append_runtime_log(workspace, "outer_loop.no_candidate_falling_back")
        await self._run_fallback(workspace, ctx, updater)

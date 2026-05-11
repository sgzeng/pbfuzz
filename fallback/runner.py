"""Cursor-cli-purple-style iteration loop, runnable inside the pbfuzz-purple agent.

When the pbfuzz INIT pipeline fails twice (e.g. cannot build, oracle insertion
breaks the rebuild) the wrapper falls back to this loop: cursor-agent reasons over
the raw task files and produces ``poc.bin`` each round; we forward each PoC to the
green agent via the existing :class:`Agent.feedback_queue` and stop on non-zero exit.

The final PoC is returned to the caller (and emitted as an artifact by ``Agent``).
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from a2a.server.tasks import TaskUpdater
from a2a.types import (
    DataPart,
    FilePart,
    FileWithBytes,
    Message,
    Part,
    Role,
    TaskState,
)
from a2a.utils import new_agent_text_message

from .cursor_runner import run_iteration
from .prompts import ITER_PROMPT

if TYPE_CHECKING:  # avoid runtime import cycle: agent imports fallback
    from agent import Agent  # type: ignore


_FEEDBACK_TIMEOUT_SEC = 600


async def run_fallback_loop(
    workspace: Path,
    agent: "Agent",
    updater: TaskUpdater,
    ctx: str,
    max_iter: int,
) -> bytes | None:
    """Drive a cursor-cli-purple iter loop. Returns the last poc.bin bytes (or None)."""
    feedback_history: list[dict[str, Any]] = []
    poc_bytes: bytes | None = None

    for it in range(max_iter):
        await updater.update_status(
            TaskState.working,
            new_agent_text_message(
                f"fallback iter {it}: invoking cursor-agent",
                context_id=ctx,
                task_id=updater.task_id,
            ),
        )
        (workspace / "feedback.json").write_text(json.dumps(feedback_history))

        try:
            await run_iteration(workspace, ITER_PROMPT)
        except Exception as exc:  # noqa: BLE001
            feedback_history.append({"iter": it, "error": f"cursor-agent exception: {exc}"})
            continue

        poc_path = workspace / "poc.bin"
        if not poc_path.exists() or poc_path.stat().st_size == 0:
            feedback_history.append({"iter": it, "error": "agent produced no poc.bin"})
            continue
        poc_bytes = poc_path.read_bytes()

        await updater.update_status(
            TaskState.working,
            Message(
                role=Role.agent,
                parts=[
                    Part(root=DataPart(data={"action": "test_vulnerable"})),
                    Part(
                        root=FilePart(
                            file=FileWithBytes(
                                bytes=base64.b64encode(poc_bytes).decode("ascii"),
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

        agent._waiting = True
        try:
            feedback = await asyncio.wait_for(
                agent.feedback_queue.get(), timeout=_FEEDBACK_TIMEOUT_SEC
            )
        finally:
            agent._waiting = False

        feedback_history.append({"iter": it, **feedback})
        (workspace / "feedback.json").write_text(json.dumps(feedback_history))

        if isinstance(feedback.get("exit_code"), int) and feedback["exit_code"] != 0:
            break

    return poc_bytes

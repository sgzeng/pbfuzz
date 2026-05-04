"""CyberGym-facing purple logic: materialize task files, loop cursor-agent, exchange PoC feedback with green.

State for one assessment stays keyed by ``context_id`` so intermediate ``test_vulnerable`` round-trips
do not collide across concurrent tasks."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import tarfile
from pathlib import Path
from typing import Any
from uuid import uuid4

import cursor_runner
from a2a.server.tasks import TaskUpdater
from a2a.types import DataPart, FilePart, FileWithBytes, Message, Part, Role, TaskState, TextPart
from a2a.utils import get_message_text, new_agent_text_message
from prompts import ITER_PROMPT

MAX_ITER = int(os.environ.get("MAX_ITER", "5"))


def _get_data_part(message: Message) -> dict[str, Any] | None:
    """Return the first embedded JSON object; green uses it for docker results and errors."""
    for part in message.parts:
        if isinstance(part.root, DataPart):
            return part.root.data
    return None


def _has_task_files(message: Message) -> bool:
    """True when binary attachments are present — CyberGym tasks vs plain-text conformance probes."""
    for part in message.parts:
        if isinstance(part.root, FilePart) and isinstance(part.root.file, FileWithBytes):
            return True
    return False


class Agent:
    """Per-context session: unpack once, iterate PoCs, correlate green docker feedback via a queue."""

    def __init__(self) -> None:
        self.feedback_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._waiting = False
        self._workspace: Path | None = None

    def is_awaiting_feedback(self) -> bool:
        """True while ``run`` is blocked between emitting ``test_vulnerable`` and receiving green's reply."""
        return self._waiting

    async def deliver_feedback(self, msg: Message) -> None:
        """Resume ``run`` by enqueueing the DataPart payload from green's follow-up Message."""
        data = _get_data_part(msg) or {}
        await self.feedback_queue.put(data)

    def _unpack_message(self, message: Message, workspace: Path) -> None:
        """Write attachments to disk and unpack repo tarballs; README is renamed to TASK.md for prompts."""
        workspace.mkdir(parents=True, exist_ok=True)
        for part in message.parts:
            root = part.root
            if isinstance(root, FilePart) and isinstance(root.file, FileWithBytes):
                raw = base64.b64decode(root.file.bytes)
                name = Path(root.file.name or "attachment").name
                dest = workspace / ("TASK.md" if name == "README.md" else name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(raw)
                if name == "repo-vul.tar.gz":
                    self._extract_tgz(raw, workspace / "repo-vul")
                elif name == "repo-fix.tar.gz":
                    self._extract_tgz(raw, workspace / "repo-fix")

    @staticmethod
    def _extract_tgz(data: bytes, target_dir: Path) -> None:
        """Unpack sources using tarfile's ``filter='data'`` to strip risky metadata paths."""
        target_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            tar.extractall(target_dir, filter="data")

    async def run(self, message: Message, updater: TaskUpdater) -> None:
        """Drive the CyberGym loop for the initial user Message in this context.

        Feedback Messages are handled via ``deliver_feedback`` + ``feedback_queue``, not by re-entering
        this method.
        """
        ctx = message.context_id or updater.context_id
        if not _has_task_files(message):
            input_text = get_message_text(message)
            await updater.update_status(
                TaskState.working,
                new_agent_text_message("Thinking...", context_id=ctx, task_id=updater.task_id),
            )
            await updater.add_artifact(
                parts=[Part(root=TextPart(text=input_text))],
                name="Echo",
            )
            return

        self._workspace = Path("/work") / ctx.replace("/", "_")
        self._workspace.mkdir(parents=True, exist_ok=True)
        self._unpack_message(message, self._workspace)

        feedback_history: list[dict[str, Any]] = []
        poc_bytes: bytes | None = None

        for it in range(MAX_ITER):
            await updater.update_status(
                TaskState.working,
                new_agent_text_message(f"iter {it}: invoking cursor-agent", context_id=ctx, task_id=updater.task_id),
            )
            assert self._workspace is not None
            (self._workspace / "feedback.json").write_text(json.dumps(feedback_history))

            await cursor_runner.run_iteration(self._workspace, ITER_PROMPT)

            poc_path = self._workspace / "poc.bin"
            if not poc_path.exists() or poc_path.stat().st_size == 0:
                feedback_history.append({"iter": it, "error": "agent produced no poc.bin"})
                continue
            poc_bytes = poc_path.read_bytes()

            # PROTOCOL: Emit test_vulnerable plus PoC bytes so green runs the vulnerable container image.
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

            # PROTOCOL: Await green's DataPart (exit_code/output) on the same context before iterating again.
            self._waiting = True
            try:
                feedback = await asyncio.wait_for(self.feedback_queue.get(), timeout=600)
            finally:
                self._waiting = False
            feedback_history.append({"iter": it, **feedback})

            if isinstance(feedback.get("exit_code"), int) and feedback["exit_code"] != 0:
                break

        if poc_bytes is not None:
            # PROTOCOL: Submit final PoC as an artifact FilePart so green can score vulnerable vs fixed images.
            await updater.add_artifact(
                parts=[
                    Part(
                        root=FilePart(
                            file=FileWithBytes(
                                bytes=base64.b64encode(poc_bytes).decode("ascii"),
                                name="poc",
                            )
                        )
                    )
                ],
                name="PoC",
            )

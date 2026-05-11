"""Route each A2A request to a per-context Agent and normalize CyberGym's two-phase messaging.

Green sends PoC feedback as a second HTTP message in the same context; we complete that request
immediately after forwarding DataPart data so streaming clients see a closed task."""

import asyncio
import os
import traceback

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import InvalidRequestError, TaskState, UnsupportedOperationError
from a2a.utils import new_agent_text_message, new_task
from a2a.utils.errors import ServerError

from agent import Agent

_DEFAULT_AGENT_RUN_TIMEOUT_SEC = 600.0


def _agent_run_timeout_sec() -> float:
    """Wall-clock cap for one assessment task (default 10 minutes)."""
    raw = os.environ.get("AGENT_RUN_TIMEOUT_SEC", str(int(_DEFAULT_AGENT_RUN_TIMEOUT_SEC)))
    try:
        v = float(str(raw).strip())
        return v if v > 0 else _DEFAULT_AGENT_RUN_TIMEOUT_SEC
    except ValueError:
        return _DEFAULT_AGENT_RUN_TIMEOUT_SEC


TERMINAL_STATES = {
    TaskState.completed,
    TaskState.canceled,
    TaskState.failed,
    TaskState.rejected,
}


class Executor(AgentExecutor):
    """Keeps one ``Agent`` per ``context_id`` so CyberGym multi-turn PoC tests stay coherent."""

    def __init__(self) -> None:
        self.agents: dict[str, Agent] = {}

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Run the main task loop or accept green feedback, depending on agent wait state."""
        msg = context.message
        if not msg:
            raise ServerError(error=InvalidRequestError(message="Missing message in request"))

        task = context.current_task
        if task and task.status.state in TERMINAL_STATES:
            raise ServerError(
                error=InvalidRequestError(
                    message=f"Task {task.id} already processed (state: {task.status.state})"
                )
            )

        if not task:
            task = new_task(msg)
            await event_queue.enqueue_event(task)

        context_id = task.context_id
        if msg.context_id is None:
            msg = msg.model_copy(update={"context_id": context_id})

        agent = self.agents.get(context_id)
        if agent is None:
            agent = Agent()
            self.agents[context_id] = agent

        if agent.is_awaiting_feedback():
            # PROTOCOL: Green replies to test_vulnerable with a new Message (DataPart: exit_code/output).
            # Finish this RPC immediately after routing feedback so the A2A stream can terminate.
            updater = TaskUpdater(event_queue, task.id, context_id)
            await updater.start_work()
            await agent.deliver_feedback(msg)
            await updater.complete()
            return

        updater = TaskUpdater(event_queue, task.id, context_id)

        await updater.start_work()
        timeout_sec = _agent_run_timeout_sec()
        try:
            await asyncio.wait_for(agent.run(msg, updater), timeout=timeout_sec)
            if not updater._terminal_state_reached:
                await updater.complete()
        except TimeoutError:
            self.agents.pop(context_id, None)
            print(f"Task abandoned after {timeout_sec:.0f}s wall-clock timeout")
            await updater.failed(
                new_agent_text_message(
                    f"Agent timed out after {int(timeout_sec)}s; abandoning task.",
                    context_id=context_id,
                    task_id=task.id,
                )
            )
        except Exception as e:
            print(f"Task failed with agent error: {e}\n{traceback.format_exc()}")
            await updater.failed(
                new_agent_text_message(f"Agent error: {e}", context_id=context_id, task_id=task.id)
            )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancellation is unused for this benchmark integration."""
        raise ServerError(error=UnsupportedOperationError())

/**
 * "Assembled" smoke test: drives tool calls through the REAL `@deepseek-ai/dsh-tools`
 * `ToolRuntime` (`ctx.tools.execute()`) inside a real `@deepseek-ai/cordis` `Context`, with
 * `installGuard()` (`../src/guards.ts`) registered as the one native `ctx.tools.guard()` callback —
 * the same wiring `index.ts` installs in production. Every other test in this repo either exercises
 * `core/guard-policy.ts::decide()` directly (`guard-policy.spec.ts`) or captures `installGuard()`'s
 * callback through a hand-written `ctx.tools` stub (`guards.spec.ts`'s `fakeCtx()`). Neither ever
 * runs the installed `@deepseek-ai/dsh-tools` package's own dispatch pipeline, so neither can
 * actually confirm `guards.ts`'s doc-comment claims about what a denial looks like to a real caller,
 * or what happens when the guard itself throws. This file closes that gap.
 *
 * Ground truth for "how does a caller actually drive a tool call" and "what does a denial/throw
 * look like from outside" was read directly from the installed package
 * (`node_modules/@deepseek-ai/dsh-tools/lib/index.js`, `0.1.5-rc.1`), not assumed:
 *
 * - The registry is itself a Cordis `Service` (`ToolRuntime extends Service`, `static inject =
 *   ['systemPrompt']`), installed like any other class plugin via `root.plugin(ToolRuntime, config)`
 *   (cordis instantiates it with `new ToolRuntime(ctx, config)` — see `Fiber`'s `isConstructor()`
 *   branch in `@deepseek-ai/cordis`). It self-registers as `ctx.tools`.
 * - `ctx.tools.execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` is the real dispatch
 *   entry point a caller (the agent loop, in production) uses to invoke a registered tool by name.
 *   `ToolExecutionInput` needs `callId`, `name`, `arguments`, `signal` (an `AbortSignal`), and
 *   optionally `agent`.
 * - A guard denial surfaces as `ToolExecutionResult` with `isError: true`, `error.message` set to
 *   EXACTLY the string `decide()` returned (no extra wrapping), and `content[0]` set to
 *   `{ type: 'text', text: 'Error: ' + error.message }` (`ToolRuntime.prepareExecution()`, the
 *   `denialReason !== undefined` branch) — confirming `guards.ts`'s doc-comment claim.
 * - `ToolRuntime.prepareExecution()` wraps ITS OWN guard-invocation step (which is where
 *   `installGuard()`'s registered callback actually runs, via `ToolLayer.guardReason()` /
 *   `ToolRuntime.guardReason()` — neither of which has a try/catch of its own) in a generic
 *   try/catch, converting any thrown error to `toolErrorResult(error)`: `isError: true`,
 *   `error.message` set to the RAW thrown message (no `[pbfuzz:...]` signing at all), `content[0].text`
 *   set to `'Error: ' + message`. This is the real dsh-tools runtime's OWN fail-closed net — it is
 *   NOT `core/guard-policy.ts::decide()`'s fail-closed wrapper, which only wraps `decideInner()` and
 *   is never reached when the failure happens before `decide()` is even called. See the
 *   "fail-closed contract" describe block below for what this means for `guards.ts`.
 *
 * @module
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { installGuard } from '../src/guards.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

/** Copied from `guards.spec.ts`'s identical helper — the agent shape `guards.ts`/`host.ts` need:
 * a workspace `cwd` and a `ctx.tools.restrict()` `host.refresh()` can call on first `active()`. */
function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

/** A confirmed campaign with a `state.json` at the given phase — copied from `guards.spec.ts`'s
 * identical helper so this file's fixtures match exactly what that file already exercises. */
function workspace(phase: string): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-assembled-guard-')))
  const dir = join(root, '.pbfuzz', 'g1')
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'pbfuzz.campaign.yaml'), campaignToYaml({
    version: 1,
    id: 'g1',
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never))
  writeFileSync(join(dir, 'state', 'state.json'), JSON.stringify({
    campaign_id: 'g1', phase, status: 's', current_task: 't', next_action: 'n', pier_round: 0,
  }))
  writeFileSync(join(root, '.pbfuzz', 'active'), `${dir}\n`)
  return { root, dir }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS), {})

/** Register a handful of REAL `defineTool()`-shaped tools — real names/schemas `guard-policy.ts`
 * gates on (`pbfuzz_plan`, `pbfuzz_fuzz`), each with a trivial handler. Not
 * pbfuzz's actual tool implementations (those live in `src/tools.ts`) — this module only needs
 * something registered under the RIGHT NAME for the real dispatch pipeline to route a call to. */
function registerFakeTools(root: Context): void {
  root.tools.register(defineTool({
    name: 'pbfuzz_plan',
    description: 'fake pbfuzz_plan tool',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { plan: 'ok' }
    },
  }))
  root.tools.register(defineTool({
    name: 'pbfuzz_fuzz',
    description: 'fake pbfuzz_fuzz tool',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { fuzz: 'ok' }
    },
  }))
}

/**
 * Build a real `@deepseek-ai/cordis` `Context` with the real `@deepseek-ai/dsh-tools` `ToolRuntime`
 * installed as `ctx.tools` (not a hand-written stub), a few trivial real tools registered, and
 * `installGuard()` wired as the one native `ctx.tools.guard()` — mirroring exactly what `index.ts`
 * does in production, minus everything this test doesn't need (sessions, the LLM, other DSH
 * plugins). `systemPrompt` is the only dependency `ToolRuntime` itself needs (`static inject =
 * ['systemPrompt']`), and only its `tools()` registration method is ever called at construction
 * time under the default `mode: 'native'` this test uses — see this file's module doc comment.
 * @param host - the plugin host `installGuard()` decides against.
 * @returns the real context, plus a `call()` helper that drives a tool call through the real
 *   `ctx.tools.execute()` dispatch for a given agent.
 */
async function buildRealRig(host: PbfuzzHost): Promise<{
  root: Context
  call: (agent: AgentLike, name: string, args: unknown) => Promise<ToolExecutionResult>
}> {
  const root = new Context()
  root.provide('systemPrompt', { tools: () => () => {} } as never)
  await root.plugin(ToolRuntime, {})
  registerFakeTools(root)
  installGuard(root as never, host)
  let n = 0
  const call = (agent: AgentLike, name: string, args: unknown): Promise<ToolExecutionResult> =>
    root.tools.execute({
      callId: `call-${name}-${n++}` as never,
      name,
      arguments: args,
      agent: agent as never,
      signal: new AbortController().signal,
    })
  return { root, call }
}

describe('assembled smoke test: installGuard() through the real @deepseek-ai/dsh-tools dispatch', () => {
  it('denies a phase-illegal pbfuzz tool call through the real dispatch, with decide()\'s exact denial text as error.message', async () => {
    const { root: workspaceRoot } = workspace('PLAN') // pbfuzz_fuzz is EXECUTE-only
    const host = newHost()
    const { call } = await buildRealRig(host)
    const agent = agentIn(workspaceRoot)

    const result = await call(agent, 'pbfuzz_fuzz', {})

    expect(result.isError).toBe(true)
    if (result.isError) {
      // Confirmed from the installed dsh-tools source (ToolRuntime.prepareExecution()): a guard
      // denial's reason string becomes error.message VERBATIM, and content[0] is `Error: ` + it.
      expect(result.error.message).toMatch(/^\[pbfuzz:phase-gate\/phase\] DENIED \(pbfuzz_fuzz\)/)
      expect(result.error.message).toContain('Next legal action:')
      expect(result.content).toEqual([{ type: 'text', text: `Error: ${result.error.message}` }])
    }
  })

  /**
   * Fail-closed / guard-error coverage (originally task step 4e's investigation). This test found
   * a real gap and now guards the fix: `core/guard-policy.ts::decide()`'s own "MUST NEVER THROW"
   * contract only covers `decideInner()`'s body — it says nothing about the code that BUILDS
   * `decide()`'s `view` argument in the first place. `installGuard()`'s registered callback
   * (`src/guards.ts`) calls `host.guardView(agent, terminalToolNames(ctx))` to build that argument,
   * and originally did so OUTSIDE any try/catch of its own, so a throw there — a corrupt campaign
   * file shape, a `settings()` thunk that throws, `providers.active()` throwing, etc. — never
   * reached `decide()`'s fail-closed wrapper at all (decide() was simply never invoked). It fell
   * through to `ToolRuntime.prepareExecution()`'s own generic try/catch instead (the REAL dsh-tools
   * runtime's safety net, not pbfuzz's), producing the RAW, unsigned thrown message rather than the
   * authored `[pbfuzz:guard-error]` deny `decide()` produces for an exception INSIDE its own scope.
   *
   * Fixed by wrapping `installGuard()`'s whole callback body in one try/catch (`src/guards.ts`),
   * mirroring `decide()`'s own catch-and-format shape exactly (same rule id, same message
   * template, via the same `formatDeny()` helper) so every internal exception in the guard —
   * whichever side of the `decide()` boundary it originates on — now produces the identical
   * signed, actionable deny. This test forces the gap's exact trigger (spying on
   * `host.guardView()` — `decide()` already catches anything thrown inside its own body, so the
   * guard-view construction call site is the one that has to throw to exercise this path) and
   * asserts the FIXED behavior.
   */
  describe('fail-closed contract when host.guardView() itself throws (not just decide() — see comment above)', () => {
    it('denies with the authored, signed [pbfuzz:guard-error] message — not dsh-tools\' generic opaque catch — and does not corrupt later dispatches', async () => {
      const { root: workspaceRoot } = workspace('PLAN')
      const host = newHost()
      const { call } = await buildRealRig(host)
      const agent = agentIn(workspaceRoot)

      const spy = vi.spyOn(host, 'guardView').mockImplementation(() => {
        throw new Error('simulated host.guardView() failure')
      })
      let result: ToolExecutionResult
      try {
        result = await call(agent, 'pbfuzz_fuzz', {})
      } finally {
        spy.mockRestore()
      }

      // (1) Fail-closed: still denied.
      expect(result.isError).toBe(true)

      // (2) The FIX: the authored, signed pbfuzz deny — installGuard()'s own try/catch now
      // produces this, the same shape decide() produces for an exception inside its own scope, so
      // the model sees an actionable reason instead of a raw, opaque error message.
      if (result.isError) {
        expect(result.error.message).toMatch(/^\[pbfuzz:guard-error] DENIED \(pbfuzz_fuzz\)/)
        expect(result.error.message).toContain('simulated host.guardView() failure')
        expect(result.error.message).toContain('Next legal action:')
        expect(result.content).toEqual([{ type: 'text', text: `Error: ${result.error.message}` }])
      }

      // (3) No blast radius: an unrelated, legal call right after still dispatches normally through
      // the SAME registry/guard registration — one guard-error does not corrupt later dispatches.
      const after = await call(agent, 'pbfuzz_plan', {})
      expect(after.isError).toBe(false)
      if (!after.isError) expect(after.value).toEqual({ plan: 'ok' })
    })
  })
})

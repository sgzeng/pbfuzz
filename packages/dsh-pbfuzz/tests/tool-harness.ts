/**
 * Shared harness for exercising `tools.ts`'s `registerTools()` without a real `@deepseek-ai/cordis`
 * context or `ToolRuntime`: a fake `ctx.tools.register()` captures every `ToolDefinition`, and a
 * fake `ctx.get()` stands in for the optional `jobs`/`userQuestions` service lookups. Calling a
 * captured definition's own `execute(args, exec)` directly exercises the exact function body
 * `defineTool`'s real runtime would invoke after schema validation — this harness only replaces the
 * validation/dispatch plumbing around it, mirroring how `campaign.spec.ts` already exercises
 * `ANSWERS_PARAMETER_SCHEMA` structurally (via the real `validateArgs`) separately from the
 * function bodies.
 */
import { registerTools, type RegisterToolsOptions } from '../src/tools.ts'
import type { PbfuzzHost } from '../src/host.ts'

/** The subset of a real `ToolDefinition` this harness's callers need. */
export interface CapturedTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/**
 * Register every pbfuzz tool against a fake context and capture the definitions.
 * @param host - the host the tools are registered against.
 * @param services - stand-ins for `ctx.get('jobs')` / `ctx.get('userQuestions')`.
 * @param options - forwarded to `registerTools` verbatim (e.g. `writeEnvSelfcheckCache`, the
 *   `index.ts`-supplied settings-persistence callback).
 * @returns every registered tool, by name.
 */
export function captureTools(
  host: PbfuzzHost,
  services: { jobs?: unknown; userQuestions?: unknown } = {},
  options: RegisterToolsOptions = {},
): Map<string, CapturedTool> {
  const registry = new Map<string, CapturedTool>()
  const fakeCtx = {
    tools: {
      register: (def: CapturedTool) => {
        registry.set(def.name, def)
        return () => { registry.delete(def.name) }
      },
    },
    get: (name: string) => (name === 'jobs' ? services.jobs : name === 'userQuestions' ? services.userQuestions : undefined),
  }
  registerTools(fakeCtx as never, host, options)
  return registry
}

/**
 * A minimal `ToolRunContext` stand-in: just what `tools.ts`'s bodies actually read
 * (`agent`/`signal`) plus no-op `deferContext`/`concludeTurn` (real, mandatory methods on the type).
 * @param agent - the calling agent, or undefined.
 * @param signal - cancellation; defaults to a fresh, never-aborted controller's signal.
 */
export function fakeExec(agent?: unknown, signal: AbortSignal = new AbortController().signal): {
  agent?: unknown
  signal: AbortSignal
  callId: string
  rootCallId: string
  token: symbol
  name: string
  arguments: unknown
  deferContext(): void
  concludeTurn(): void
} {
  return {
    ...agent !== undefined ? { agent } : {},
    signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('tool-exec'),
    name: 'test',
    arguments: {},
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

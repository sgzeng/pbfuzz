/** Small drivers over the real DSH services; they hold no assertions. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RealDsh } from './harness.ts'
import { installScriptedLlm, type ScriptedLlm } from './scripted-llm.ts'

/** A plain JSON copy of a DSH result (they carry frozen snapshots and the odd bigint). */
export function plain<T = any>(value: unknown): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v)))) as T
}

/**
 * Poll until `predicate` holds. `diagnose` is appended to the timeout error, so a stuck run says
 * where it got stuck instead of just that it did.
 */
export async function waitUntil(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000, diagnose?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${diagnose === undefined ? '' : `\n${diagnose()}`}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Resolves once `settled()` has held for `quietMs`, i.e. nothing else is about to happen. */
export async function stayedTrue(settled: () => boolean, quietMs = 400, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let since = Date.now()
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the agent to go quiet')
    if (!settled()) since = Date.now()
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Reaches on an input containing `R`, triggers on one containing `T`. */
export const TARGET = `import sys
data = open(sys.argv[1], 'rb').read()
if b'R' in data:
    sys.stderr.write('PBFUZZ_REACHED: t1\\n')
if b'T' in data:
    sys.stderr.write('PBFUZZ_TRIGGERED: t1\\n')
`

export interface Workspace {
  /** The session workspace (the agent's cwd). */
  readonly root: string
  /** `<root>/.pbfuzz/itest`: the campaign output directory. */
  readonly campaignDir: string
  /** The confirmed campaign file `/pbfuzz run` takes. */
  readonly campaignPath: string
}

/** A throwaway target repo with a confirmed, engine-valid campaign for it (tracer off: no gdb needed). */
export function createWorkspace(): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-ws-')))
  const campaignDir = join(root, '.pbfuzz', 'itest')
  mkdirSync(join(campaignDir, 'state'), { recursive: true })
  writeFileSync(join(root, 'target.py'), TARGET)
  const campaignPath = join(campaignDir, 'pbfuzz.campaign.yaml')
  writeFileSync(campaignPath, [
    'version: 1',
    'id: itest',
    'confirmed: true',
    `target: { repo: ${root}, language: python }`,
    "bug: { targets: [{ location: 'target.py:5' }] }",
    `entry: { kind: executable, run_cmd: 'python3 ${root}/target.py @@', input_channel: file }`,
    "oracle: { mode: preexisting, reached_pattern: 'PBFUZZ_REACHED:\\s*(\\S+)', triggered_pattern: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' }",
    "tracer: 'off'",
    `output: { dir: ${campaignDir} }`,
    '',
  ].join('\n'))
  return { root, campaignDir, campaignPath }
}

let sessions = 0

export interface Session {
  readonly agent: any
  readonly llm: ScriptedLlm
  readonly workspace: Workspace
  /** Run a slash command through the real CommandRuntime. */
  command(line: string): Promise<{ kind: string; text: string }>
  /** Queue a user message; the agent loop picks it up. */
  say(text: string): Promise<void>
  /** Dispatch a tool call through the real ToolRuntime (guards, schema validation, execution). */
  call(name: string, args?: unknown): Promise<any>
}

/** A real agent, on a scripted model, in a fresh workspace. The campaign is NOT started. */
export async function openSession(dsh: RealDsh): Promise<Session> {
  const workspace = createWorkspace()
  const llm = await installScriptedLlm(dsh, `scripted-${++sessions}`)
  const { agent } = await dsh.ctx.get('agents').create({
    sessionId: `session-itest-${sessions}`,
    meta: { cwd: workspace.root },
    agentOptions: { provider: llm.provider, model: llm.model },
  })
  const { createUserMessage } = await dsh.load('@deepseek-ai/dsh-llm')
  return {
    agent,
    llm,
    workspace,
    async say(text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    },
    async command(line) {
      const execution = await dsh.ctx.get('commands').execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`${line} was not recognised as a command`)
      return plain(execution.result)
    },
    async call(name, args = {}) {
      return plain(await dsh.ctx.get('tools').execute({
        callId: `call-${name}-${Math.random().toString(36).slice(2)}`,
        name,
        arguments: args,
        agent,
        signal: new AbortController().signal,
      }))
    },
  }
}

/** One line per request the scripted model received: what it was last told, in order. */
export function transcript(llm: ScriptedLlm): string {
  return llm.requests.map((request, index) => {
    const message = request.messages.at(-1)
    return `  #${index + 1} [${message.role}${message.source?.kind ? `/${message.source.kind}` : ''}] ${JSON.stringify(message.content).slice(0, 260)}`
  }).join('\n')
}

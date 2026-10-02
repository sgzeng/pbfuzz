/**
 * A model provider that replies from a script instead of a network. It is a subclass of the REAL
 * `LlmAdapter` registered with the REAL `ctx.llm`, so the agent loop, tool dispatch, session log
 * and every plugin hook run exactly as they do with a hosted model; only the tokens are canned.
 */
import type { RealDsh } from './harness.ts'

export interface ScriptedToolCall {
  readonly name: string
  readonly arguments?: unknown
  readonly id?: string
}

export interface ScriptedReply {
  readonly text?: string
  readonly toolCalls?: readonly ScriptedToolCall[]
}

/** A reply, or a function that builds one from the request the agent just sent. */
export type ScriptStep = ScriptedReply | ((request: any) => ScriptedReply)

export interface ScriptedLlm {
  readonly provider: string
  readonly model: string
  /** Every conversation request the agent loop sent, in order (system prompt, messages, offered tools). */
  readonly requests: any[]
  /** Queue the next reply(ies). Running out of script fails the turn loudly instead of hanging. */
  enqueue(...steps: ScriptStep[]): void
  dispose(): void
}

export async function installScriptedLlm(dsh: RealDsh, provider = 'scripted', model = 'scripted-1'): Promise<ScriptedLlm> {
  const { LlmAdapter } = await dsh.load('@deepseek-ai/dsh-llm')
  const requests: any[] = []
  const queue: ScriptStep[] = []
  let calls = 0

  class ScriptedAdapter extends LlmAdapter {
    providerInfo(id: string) { return { id, name: 'Scripted (test)' } }
    async listModels(id: string) { return [{ provider: id, id: model, name: model }] }
    async resolveModel(id: string, name: string) {
      return { provider: id, id: name, name, context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 }
    }
    async *stream(options: any) {
      // DSH also calls the model for its own housekeeping (session titles, compaction). Those are
      // not part of the conversation under test: answer them without touching the script.
      if (options.purpose !== undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'itest session' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'itest session' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      requests.push(options)
      const step = queue.shift()
      if (step === undefined) throw new Error(`scripted LLM has no reply left for request #${requests.length}`)
      const reply = typeof step === 'function' ? step(options) : step
      let index = 0
      if (reply.text !== undefined) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: reply.text }
        yield { type: 'block-end', index, block: { type: 'text', text: reply.text } }
        index += 1
      }
      for (const call of reply.toolCalls ?? []) {
        const id = call.id ?? `call-${++calls}`
        const args = JSON.stringify(call.arguments ?? {})
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        index += 1
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: (reply.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop' } }
    }
  }

  const release = dsh.ctx.get('llm').registerAdapter([provider], new ScriptedAdapter())
  return {
    provider,
    model,
    requests,
    enqueue: (...steps) => { queue.push(...steps) },
    dispose: () => { release() },
  }
}

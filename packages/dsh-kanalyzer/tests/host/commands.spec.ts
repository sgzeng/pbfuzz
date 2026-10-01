/**
 * F17 — `src/host/commands.ts` (the `/kanalyzer` slash command) had zero test coverage, along
 * with the rest of the host I/O layer.
 *
 * These tests drive `registerCommands()` against a real `KanalyzerRuntime` (no subprocess
 * mocking needed for either scenario below: both `doctor` and `analyze` fail before any `run()`
 * call, the same way the L1 kanalyzer subagent observed manually —
 * `acceptance-run/work/L1-kanalyzer/a2_doctor_missing.mjs` — because `status()` bails out as
 * soon as `access(binary)` throws for a KAMain that was never built). Only the command-registry
 * boundary (`ctx.commands.register`) is faked; everything downstream of it, including the real
 * settings `Config` and `KanalyzerRuntime`, is the genuine implementation.
 */
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inlineTargets, kanalyzerCommandLine, registerCommands } from '../../src/host/commands.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { Config } from '../../src/host/settings.ts'

/** Minimal invocation: the `doctor`/`analyze` branches only read `rawInput`. */
function invocation(rawInput: string): CommandInvocation {
  return { rawInput } as unknown as CommandInvocation
}

/**
 * An invocation whose agent records the prompt a handoff delivers, and by which channel.
 *
 * The channel matters: `steer()` joins the turn the user's own message is already starting, while
 * `followup()` is documented to become "the sole ordinary message of its own turn" — which is what
 * once made a typed `/kanalyzer analyze …` run the whole analysis twice and answer twice.
 */
function handoff(rawInput: string): { inv: CommandInvocation; prompts: string[]; steered: string[]; followedUp: string[] } {
  const prompts: string[] = []
  const steered: string[] = []
  const followedUp: string[] = []
  const textOf = (message: { content: { type: string; text?: string }[] }): string =>
    message.content.map(block => block.text ?? '').join('')
  const inv = {
    rawInput,
    agent: {
      steer: (message: { content: { type: string; text?: string }[] }) => {
        const text = textOf(message)
        prompts.push(text)
        steered.push(text)
      },
      followup: async (message: { content: { type: string; text?: string }[] }) => {
        const text = textOf(message)
        prompts.push(text)
        followedUp.push(text)
      },
    },
  } as unknown as CommandInvocation
  return { inv, prompts, steered, followedUp }
}

describe('/kanalyzer command (src/host/commands.ts)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-commands-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('doctor: reports a real error, not a crash, when KAMain was never built', async () => {
    const base = Config()
    const cfg = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })

    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      // registerCommands() also installs an `agent/inbox/inserted` listener; these tests never
      // emit that event, so a no-op stub is enough.
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)

    const kanalyzer = registered.get('kanalyzer')
    expect(kanalyzer).toBeDefined()
    const result = await kanalyzer?.handler(invocation('doctor'))
    expect(result?.kind).toBe('error')
    expect(result?.text).toMatch(/KAMain not found/)
    expect(result?.text).toMatch(/^kanalyzer doctor: fail/)
  })

  it('analyze: reports a real error, not a crash, when KAMain was never built', async () => {
    const base = Config()
    const cfg = {
      ...base,
      install: { ...base.install, installDir: join(tmp, 'empty-install') },
      standalone: { inputFilenames: [join(tmp, 'whatever.0.0.preopt.bc')], targetList: ['a.c:1'], entryList: [] },
    }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })

    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      // registerCommands() also installs an `agent/inbox/inserted` listener; these tests never
      // emit that event, so a no-op stub is enough.
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)

    const kanalyzer = registered.get('kanalyzer')
    const result = await kanalyzer?.handler(invocation('analyze'))
    expect(result?.kind).toBe('error')
    const parsed = JSON.parse(result?.text ?? '[]') as { status: string; reason?: string }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.status).toBe('error')
    expect(parsed[0]?.reason).toMatch(/KAMain is not built/)
  })

  it('analyze: guidance error when neither inline targets nor standalone inputFilenames are given', async () => {
    const base = Config()
    const cfg = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })

    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      // registerCommands() also installs an `agent/inbox/inserted` listener; these tests never
      // emit that event, so a no-op stub is enough.
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)

    const kanalyzer = registered.get('kanalyzer')
    const result = await kanalyzer?.handler(invocation('analyze'))
    expect(result?.kind).toBe('error')
    expect(result?.text).toMatch(/kanalyzer\.standalone\.inputFilenames is empty/)
    expect(result?.text).toMatch(/\/kanalyzer analyze src\/foo\.c:96/)
  })

  it('no arguments: the usage text, not a handoff', async () => {
    const base = Config()
    const cfg = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })
    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      // registerCommands() also installs an `agent/inbox/inserted` listener; these tests never
      // emit that event, so a no-op stub is enough.
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)
    const { inv, prompts } = handoff('')
    const result = await registered.get('kanalyzer')?.handler(inv)
    expect(result?.kind).toBe('error')
    expect(result?.text).toMatch(/^Usage:/)
    expect(prompts).toEqual([])
  })
})

describe('inlineTargets()', () => {
  it('picks file:line tokens out of the arguments and ignores prose (strict path, unchanged)', () => {
    expect(inlineTargets('readelf.cpp:96')).toEqual(['readelf.cpp:96'])
    expect(inlineTargets('/repo/src/a.c:12 b.c:7:3 extra')).toEqual(['/repo/src/a.c:12', 'b.c:7:3'])
  })

  it('resolves natural phrasing to file:line when exactly one file and one line number are named', () => {
    // The trajectory's first input, verbatim — this used to yield zero targets and fall through
    // to freeTextPrompt; a plain-language request works fine there too, but resolving the target
    // here lets `analyzeTargetsPrompt` name it explicitly instead.
    expect(inlineTargets('readelf.cpp. Target line number is 96.')).toEqual(['readelf.cpp:96'])
    expect(inlineTargets('is line 96 of readelf.cpp reachable')).toEqual(['readelf.cpp:96'])
    expect(inlineTargets('check src/a.c, line: 42')).toEqual(['src/a.c:42'])
    expect(inlineTargets('readelf.cpp target :96')).toEqual(['readelf.cpp:96'])
  })

  it('stays empty (ambiguous) rather than guessing when several files or several numbers are named', () => {
    // Two source files named — which one is the target is genuinely ambiguous.
    expect(inlineTargets('compare foo.c and bar.c at line 10')).toEqual([])
    // One file, two candidate line numbers — again ambiguous.
    expect(inlineTargets('foo.cpp has issues at line 10 and line 20')).toEqual([])
  })
})

describe('kanalyzerCommandLine()', () => {
  it('accepts a /kanalyzer invocation, trimmed, regardless of arguments/case/leading whitespace', () => {
    expect(kanalyzerCommandLine('/kanalyzer')).toBe('/kanalyzer')
    expect(kanalyzerCommandLine('/kanalyzer analyze foo.c:9')).toBe('/kanalyzer analyze foo.c:9')
    expect(kanalyzerCommandLine('   /kanalyzer analyze foo.c:9  ')).toBe('/kanalyzer analyze foo.c:9')
    expect(kanalyzerCommandLine('/KaNaLyZeR build')).toBe('/KaNaLyZeR build')
  })

  it('rejects non-commands, near-miss command names, and /kanalyzer appearing mid-sentence', () => {
    expect(kanalyzerCommandLine('')).toBeUndefined()
    expect(kanalyzerCommandLine('not a command')).toBeUndefined()
    expect(kanalyzerCommandLine('/kanalyzers build')).toBeUndefined()
    expect(kanalyzerCommandLine('please run /kanalyzer build')).toBeUndefined()
  })
})

describe('/kanalyzer analyze with a real request (the trajectory\'s first input)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-commands-handoff-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Register the command against a runtime whose KAMain is missing — every handoff must happen before any analyse call. */
  function command(): { handler: (inv: CommandInvocation) => Promise<CommandResult> } {
    const base = Config()
    const cfg = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })
    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      // registerCommands() also installs an `agent/inbox/inserted` listener; these tests never
      // emit that event, so a no-op stub is enough.
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)
    return registered.get('kanalyzer') as { handler: (inv: CommandInvocation) => Promise<CommandResult> }
  }

  it('analyze <file:line>: hands the targets to the agent as a kanalyzer workflow prompt', async () => {
    const { inv, prompts } = handoff('analyze readelf.cpp:96')
    const result = await command().handler(inv)
    expect(result.kind).toBe('success')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('readelf.cpp:96')
    expect(prompts[0]).toContain('kanalyzer_analyze')
    expect(prompts[0]).toContain('kanalyzer_prepare')
    // The doctor is a debugging tool, not a session-opening step: it costs a full sample build.
    expect(prompts[0]).toContain('Do not run kanalyzer_doctor first')
  })

  it('analyze <prose>: hands the sentence over instead of rejecting it with a usage error', async () => {
    // The exact input from the recorded session trajectory, which used to come back as
    // "Usage: /kanalyzer build | doctor | analyze".
    const { inv, prompts } = handoff('analyze readelf.cpp. Target line number is 96.')
    const result = await command().handler(inv)
    expect(result.kind).toBe('success')
    expect(prompts[0]).toContain('readelf.cpp. Target line number is 96.')
    expect(prompts[0]).toContain('kanalyzer')
  })

  it('a plain-language request without the analyze subcommand is handed over too', async () => {
    const { inv, prompts } = handoff('is line 96 of readelf.cpp reachable?')
    const result = await command().handler(inv)
    expect(result.kind).toBe('success')
    expect(prompts[0]).toContain('is line 96 of readelf.cpp reachable?')
    expect(result.text).not.toMatch(/Usage/)
  })
})

describe('agent/inbox/inserted listener (headless slash-command dispatch workaround)', () => {
  /** Minimal `UserMessage`-shaped payload — the listener only reads `source.kind` and text blocks. */
  function userMessage(kind: string, text: string): { source: { kind: string }; content: { type: string; text: string }[] } {
    return { source: { kind }, content: [{ type: 'text', text }] }
  }

  /** Registers `/kanalyzer` against a fake ctx that records both the registered handler and the
   * `agent/inbox/inserted` listener, plus every `commands.execute(...)` call the listener makes. */
  function harness(): {
    fire: (message: { source: { kind: string }; content: { type: string; text: string }[] }) => void
    executed: { agent: unknown; line: string }[]
  } {
    const executed: { agent: unknown; line: string }[] = []
    let listener: ((payload: { agent: unknown; message: unknown }) => void) | undefined
    const fakeCommands = {
      register: (def: CommandDefinition) => { void def; return () => {} },
      execute: async (agent: unknown, line: string) => { executed.push({ agent, line }); return undefined },
    }
    const fakeCtx = {
      commands: fakeCommands,
      kanalyzer: {},
      on: (event: string, cb: (payload: { agent: unknown; message: unknown }) => void) => {
        if (event === 'agent/inbox/inserted') listener = cb
        return () => {}
      },
      get: (name: string) => (name === 'commands' ? fakeCommands : undefined),
    } as unknown as Context
    registerCommands(fakeCtx, () => Config(), '/nonexistent')
    return {
      fire: message => listener?.({ agent: 'the-agent', message }),
      executed,
    }
  }

  it('dispatches a /kanalyzer message that arrived as an ordinary user chat message', async () => {
    const { fire, executed } = harness()
    fire(userMessage('user', '/kanalyzer analyze readelf.cpp. Target line number is 96.'))
    await Promise.resolve() // let the fire-and-forget `commands.execute(...)` call settle
    expect(executed).toEqual([{ agent: 'the-agent', line: '/kanalyzer analyze readelf.cpp. Target line number is 96.' }])
  })

  it('ignores a plugin-sourced message — this is what stops it re-entering on its own handoffs', async () => {
    const { fire, executed } = harness()
    fire(userMessage('plugin', '/kanalyzer analyze readelf.cpp:96'))
    await Promise.resolve()
    expect(executed).toEqual([])
  })

  it('ignores an ordinary user message that is not a /kanalyzer invocation', async () => {
    const { fire, executed } = harness()
    fire(userMessage('user', 'hello there'))
    await Promise.resolve()
    expect(executed).toEqual([])
  })
})

/**
 * The duplicate-turn regression. A real session (turn 1 = 46s of real work, turn 2 = 9s re-running
 * a cache-hit analysis and answering a second time) traced to `handOff()` using `followup()`:
 * `@deepseek-ai/dsh-agent` documents it as "the item becomes the sole ordinary message of its own
 * turn", so when the command is dispatched from a typed `/kanalyzer …` chat message — whose raw
 * text is already driving turn 1 — the structured prompt is forced into a turn of its own and the
 * agent redoes everything. `steer()` ("steering for the nearest step; an idle driver starts a
 * turn") joins the turn already starting instead.
 */
describe('handoff channel: steer for analysis, followup only for build', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-channel-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  /** Same shape as the handoff suite above: a runtime whose KAMain is missing, so every branch
   * under test hands off before it could reach a real analysis. */
  function command(): { handler: (inv: CommandInvocation) => Promise<CommandResult> } {
    const base = Config()
    const cfg = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const runtime = new KanalyzerRuntime(new Context(), { config: () => cfg, writeStatus: async () => {}, packageRoot: tmp })
    const registered = new Map<string, CommandDefinition>()
    const fakeCtx = {
      commands: { register: (def: CommandDefinition) => { registered.set(def.name, def); return () => {} } },
      kanalyzer: runtime,
      on: () => () => {},
    } as unknown as Context
    registerCommands(fakeCtx, () => cfg, tmp)
    return registered.get('kanalyzer') as { handler: (inv: CommandInvocation) => Promise<CommandResult> }
  }

  it('an inline-target analyze steers, never follows up', async () => {
    const { inv, steered, followedUp } = handoff('analyze readelf.cpp:96')
    await command().handler(inv)
    expect(steered).toHaveLength(1)
    expect(followedUp).toEqual([])
    expect(steered[0]).toContain('readelf.cpp:96')
  })

  it('a plain-language request steers, never follows up', async () => {
    const { inv, steered, followedUp } = handoff('is line 96 of readelf.cpp reachable?')
    await command().handler(inv)
    expect(steered).toHaveLength(1)
    expect(followedUp).toEqual([])
  })

  it('build still follows up — it starts its own unrelated procedure, not this turn\'s work', async () => {
    const { inv, steered, followedUp } = handoff('build')
    await command().handler(inv)
    expect(followedUp).toHaveLength(1)
    expect(steered).toEqual([])
    expect(followedUp[0]).toContain('kanalyzer-build')
  })

  it('the analysis prompts tell the agent not to redo work already done this turn', async () => {
    for (const raw of ['analyze readelf.cpp:96', 'is line 96 of readelf.cpp reachable?']) {
      const { inv, steered } = handoff(raw)
      await command().handler(inv)
      expect(steered[0]).toMatch(/already .*(done|answered).*current turn/i)
    }
  })
})

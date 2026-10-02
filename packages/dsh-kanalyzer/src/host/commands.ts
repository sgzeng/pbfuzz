/**
 * `/kanalyzer build | doctor | analyze [targets…]`, plus a plain-language fallback.
 *
 * `build` is what the settings card's Build button runs (via `remote.commands.execute` in a fresh
 * session): it hands the build procedure to that session's agent, so the user watches and
 * approves `sudo` in a visible session.
 *
 * `analyze` accepts inline `file:line` targets and hands them to the session's agent as a prompt
 * — the agent runs the real `kanalyzer_*` tool workflow, which the command itself cannot (the
 * command has no bitcode, no build and no targets of its own). Without inline targets it keeps
 * the settings-driven behaviour (`kanalyzer.standalone`). Anything else the user types after
 * `/kanalyzer` — `/kanalyzer analyse readelf.cpp line 96` — is treated as a plain-language
 * request and handed to the agent the same way, instead of being rejected with a usage error:
 * that rejection was the first thing a user hit in the recorded session trajectory.
 *
 * A real DSH session log showed a second way that same trajectory's first input failed: the user
 * typed `/kanalyzer analyze readelf.cpp. Target line number is 96.` and it arrived at the agent as
 * an ordinary `source.kind: 'user'` message — no `command/run` record, so the handler above never
 * ran at all (a bare `/kanalyzer` dispatches fine in other sessions; this exact phrasing did not).
 * `registerCommands()` below also installs an `agent/inbox/inserted` listener that catches this
 * and dispatches it itself, mirroring `@pbfuzz/dsh-pbfuzz`'s `pier-driver.ts` (its own workaround
 * for the same class of DSH behaviour, for `/pbfuzz run`).
 *
 * @module @pbfuzz/dsh-kanalyzer/host/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { expandHome } from '../core/install.ts'
import type { Config } from './settings.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Prompts the `/kanalyzer` command hands the agent (DSH ≥ 0.2: each producer declares its own source kind). */
    kanalyzer: { kind: 'kanalyzer' } & ContextFormed
  }
}

const USAGE = [
  'Usage:',
  '  /kanalyzer build                     build KAMain (same as the settings Build button)',
  '  /kanalyzer doctor                    run the end-to-end self-test',
  '  /kanalyzer install-deps              install wllvm (same as the settings Install wllvm button)',
  '  /kanalyzer analyze <file:line> …     analyse these targets (the agent runs the tools)',
  '  /kanalyzer analyze                   analyse the targets from the kanalyzer settings',
  '  /kanalyzer <anything else>           ask in plain language, e.g. /kanalyzer is line 96 of readelf.cpp reachable?',
].join('\n')

/** Targets a plugin-sourced prompt is handed to the agent with. */
const TARGET_TOKEN = /^\S+:\d+(?::\d+)?$/

/** Source-file extensions the loose (natural-phrasing) target detector below recognises — the
 * languages kanalyzer's LLVM-bitcode pipeline actually analyses (see the `kanalyzer-build` skill). */
const SOURCE_EXTENSIONS = ['cpp', 'cxx', 'cc', 'c', 'hpp', 'hxx', 'h']

/** A bare token that names a source file by extension, once trailing sentence punctuation is
 * stripped by the caller (`readelf.cpp`, `src/a.c`, but not `readelf.cpp:96` — that already
 * satisfies `TARGET_TOKEN` and never reaches this loose path). */
const SOURCE_FILE_TOKEN = new RegExp(`^\\S+\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i')

/** A line number written out in prose: "line 96", "line number is 96", "line: 96". */
const LOOSE_LINE_PHRASE = /\bline\s*(?:number\s*)?(?:is\s+)?:?\s*(\d+)\b/gi

/** A bare "`:96`" that is not glued to a filename (that case already satisfies `TARGET_TOKEN`) —
 * covers phrasing like "readelf.cpp, target :96" where whitespace split it from the file token. */
const LOOSE_LINE_COLON = /:(\d+)\b/g

/**
 * The single natural-phrasing target in `input`, when it names exactly one source file and
 * mentions exactly one line number — e.g. "readelf.cpp. Target line number is 96." Several files
 * or several numbers is genuinely ambiguous, so this returns `undefined` (be conservative) rather
 * than guess; the caller then falls through to `freeTextPrompt`, which is already correct
 * behaviour for that case — it asks the agent to work out the target itself.
 * @param input - everything after `analyze`, once the strict `TARGET_TOKEN` pass found nothing.
 */
function looseTarget(input: string): string | undefined {
  const files = new Set<string>()
  for (const raw of input.split(/\s+/)) {
    const token = raw.replace(/[,.;:]+$/, '')
    if (SOURCE_FILE_TOKEN.test(token)) files.add(token)
  }
  if (files.size !== 1) return undefined

  const lines = new Set<number>()
  for (const m of input.matchAll(LOOSE_LINE_PHRASE)) lines.add(Number(m[1]))
  for (const m of input.matchAll(LOOSE_LINE_COLON)) lines.add(Number(m[1]))
  if (lines.size !== 1) return undefined

  const [file] = files
  const [line] = lines
  return `${file}:${line}`
}

/**
 * The `file:line` targets in a command's inline arguments. Tries the strict `file:line` form
 * first (unchanged from before); only when that finds nothing does it fall back to `looseTarget()`
 * for natural phrasing like "readelf.cpp. Target line number is 96."
 * @param input - everything after `analyze`.
 * @returns the target tokens, in the order written; empty for a plain-language request.
 */
export function inlineTargets(input: string): string[] {
  const strict = input.split(/\s+/).map(t => t.replace(/[,.;]+$/, '')).filter(t => TARGET_TOKEN.test(t))
  if (strict.length > 0) return strict
  const loose = looseTarget(input)
  return loose === undefined ? [] : [loose]
}

/** The prompt for `/kanalyzer analyze <targets…>`. */
export function analyzeTargetsPrompt(targets: string[], original: string): string {
  return [
    `Run the kanalyzer static-reachability analysis for these targets: ${targets.join(', ')}`,
    '',
    'Load and follow the `kanalyzer` skill, using its tools only — never the KAMain binary:',
    '1. kanalyzer_prepare — produce whole-program bitcode for the project the target file belongs to. If KAMain is not built, tell the user to press Build in the kanalyzer settings (or run /kanalyzer build) and stop there.',
    '2. kanalyzer_analyze — pass exactly these targets: ' + targets.join(', '),
    '3. Answer concisely in chat: status, resolved targets, distances, critical branches, and the result directory (outputDir) with the dump files (dumpFiles) it holds. Do not write a report file or call present unless the user asks for one.',
    'Do not run kanalyzer_doctor first — it is a debugging tool for when the run itself looks broken.',
    'If you have already done this in the current turn, just report the result — do not run it again.',
    '',
    `The user's original command: ${original}`,
  ].join('\n')
}

/** The prompt for a free-text `/kanalyzer …` request. */
export function freeTextPrompt(original: string): string {
  return [
    'The user asked for kanalyzer static analysis in their own words:',
    `  ${original}`,
    '',
    'Load and follow the `kanalyzer` skill and carry the request out with the kanalyzer_* tools',
    '(kanalyzer_prepare → kanalyzer_analyze / kanalyzer_query; kanalyzer_doctor only if the run looks',
    'broken). Work out the target file:line and the project from the request yourself; if something',
    'essential is missing (which line, which repo), ask the user one short question instead of',
    'guessing. Never invoke the KAMain binary directly. Answer concisely and state the result',
    'directory (outputDir) and the dump files (dumpFiles) it holds; write no report file unless the',
    'user asks for one.',
    'If you have already answered this request in the current turn, just report the result — do not',
    'run the analysis again.',
  ].join('\n')
}

/**
 * The prompt handed to the wllvm install agent (settings card's Install wllvm button, or
 * `/kanalyzer install-deps`). Mirrors {@link buildPrompt}: name the skill, state the goal, and
 * insist the work is proven by the self-test rather than by a presence check.
 * @returns the prompt text.
 */
export function installDepsPrompt(): string {
  return [
    'Make kanalyzer\'s wllvm prepare mode usable on this machine.',
    '',
    'Load and follow the `kanalyzer-wllvm` skill step by step. In short:',
    '1. Check whether wllvm is already present (`which wllvm wllvm++ extract-bc`, `python3 -c "import wllvm"`). It is often already installed in a virtualenv or ~/.local/bin that simply is not on PATH — that is a PATH problem, not a missing package, so report the directory instead of installing a second copy.',
    '2. Only if it is genuinely missing: `pip install --user wllvm` (fall back to `pip3` or `python3 -m pip`).',
    '3. Report the absolute directory containing wllvm, wllvm++ and extract-bc — the host needs it to put on the build subprocess PATH.',
    '4. Verify with the kanalyzer_doctor tool. A passing doctor is the only acceptable proof; its wllvm leg builds and extracts the sample for real, so `which` succeeding is not enough.',
  ].join('\n')
}

/** @returns the prompt handed to the build agent. */
export function buildPrompt(c: Config, packageRoot: string): string {
  const i = c.install
  return [
    'Build kernel-analyzer (KAMain) for the kanalyzer plugin. Load and follow the `kanalyzer-build` skill step by step.',
    '',
    'Resolved settings:',
    `- installDir: ${expandHome(i.installDir, homedir())} (clone to <installDir>/kernel-analyzer)`,
    `- repoUrl: ${i.repoUrl}`,
    `- branch: ${i.branch}`,
    `- llvmPrefix: ${i.llvmPrefix === '' ? '(auto-detect, prefer /usr/lib/llvm-14)' : i.llvmPrefix}`,
    `- buildType: ${i.buildType}`,
    `- jobs: ${i.jobs === 0 ? '$(nproc)' : String(i.jobs)}`,
    `- self-test sample: ${packageRoot}/selftest`,
    '',
    'Resolve dependency problems yourself. Finish by calling kanalyzer_doctor; it records the result in the kanalyzer settings status.',
  ].join('\n')
}

/** `/kanalyzer …` at the start of the text (not merely appearing somewhere in it), case-
 * insensitively, and not a near-miss command name like `/kanalyzers`. */
const KANALYZER_COMMAND = /^\s*\/kanalyzer(\s|$)/i

/**
 * The `/kanalyzer …` command line hidden in a plain chat message's text, or `undefined` when the
 * text is not a `/kanalyzer` invocation at all.
 * @param text - the message's concatenated text content (see `textOf`).
 * @returns the trimmed command line, or `undefined`.
 */
export function kanalyzerCommandLine(text: string): string | undefined {
  return KANALYZER_COMMAND.test(text) ? text.trim() : undefined
}

/** Concatenated text of every `text` content block — mirrors `@pbfuzz/dsh-pbfuzz`'s `pier-driver.ts`
 * helper of the same name; copied rather than imported since this package does not depend on
 * dsh-pbfuzz. */
function textOf(message: UserMessage): string {
  return message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('')
}

/**
 * Register `/kanalyzer`.
 * @param ctx - context with `commands` and `kanalyzer`.
 * @param config - current settings.
 * @param packageRoot - package root (for the self-test path).
 */
export function registerCommands(ctx: Context, config: () => Config, packageRoot: string): void {
  /**
   * Hand a plugin-sourced prompt to the session's agent: the command cannot run the analysis
   * itself (no bitcode, no build), so the agent drives the kanalyzer_* tools.
   *
   * `steer()`, NOT `followup()`. `followup()` is documented as "the item becomes the sole ordinary
   * message of its own turn" (`@deepseek-ai/dsh-agent` runtime-types) — so when this command is
   * dispatched from a typed `/kanalyzer …` chat message, the user's own message drives turn 1 and
   * this prompt is forced into a turn 2 of its own, making the agent redo the entire analysis and
   * answer twice. A real session showed exactly that: turn 1 did the work, turn 2 re-ran a
   * cache-hit analysis and re-answered. `steer()` is "steering for the nearest step; an idle
   * driver starts a turn", so the prompt joins the turn the user's message is already starting.
   *
   * `build` deliberately keeps `followup()`: that one really does want a turn of its own, because
   * it starts a long, unrelated procedure rather than steering the work already in flight.
   */
  const handOff = (inv: CommandInvocation, text: string, note: string): CommandResult => {
    inv.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'kanalyzer' },
    }))
    return { kind: 'success', text: note }
  }

  ctx.commands.register({
    name: 'kanalyzer',
    description: 'kanalyzer static analysis: build KAMain, run the self-test, or analyse targets (inline file:line, plain language, or the standalone inputs from settings)',
    handler: async (inv: CommandInvocation): Promise<CommandResult> => {
      const raw = inv.rawInput.trim()
      const [sub = '', ...rest] = raw === '' ? [''] : raw.split(/\s+/)
      switch (sub) {
        case 'build':
          await inv.agent.followup(createUserMessage({
            content: [{ type: 'text', text: buildPrompt(config(), packageRoot) }],
            source: { kind: 'kanalyzer' },
          }))
          return { kind: 'success', text: 'Build started in this session — the agent follows the kanalyzer-build skill.' }
        case 'install-deps':
          // followup(), like `build`: this starts its own installation procedure rather than
          // steering whatever the current turn is doing.
          await inv.agent.followup(createUserMessage({
            content: [{ type: 'text', text: installDepsPrompt() }],
            source: { kind: 'kanalyzer' },
          }))
          return { kind: 'success', text: 'Installing wllvm in this session — the agent follows the kanalyzer-wllvm skill.' }
        case 'doctor': {
          const d = await ctx.kanalyzer.doctor()
          return d.ok
            ? { kind: 'success', text: `kanalyzer doctor: pass\n${d.evidence.join('\n')}` }
            : { kind: 'error', text: `kanalyzer doctor: fail — ${d.reason ?? ''}\n${d.evidence.join('\n')}` }
        }
        case 'analyze': {
          const inline = rest.join(' ').trim()
          const targets = inlineTargets(inline)
          if (targets.length > 0) {
            return handOff(inv, analyzeTargetsPrompt(targets, raw), `Analysing ${targets.join(', ')} — the agent runs the kanalyzer tools in this session.`)
          }
          if (inline !== '') {
            // Not `file:line` tokens: a sentence like "readelf.cpp, target line 96". Let the agent
            // work out the target instead of rejecting the request.
            return handOff(inv, freeTextPrompt(`/kanalyzer analyze ${inline}`), 'Request handed to the agent — it runs the kanalyzer tools in this session.')
          }
          const s = config().standalone
          if (s.inputFilenames.length === 0) {
            return { kind: 'error', text: [
              'No targets given and kanalyzer.standalone.inputFilenames is empty.',
              'Give targets inline — /kanalyzer analyze src/foo.c:96 — describe the request in plain language — /kanalyzer is line 96 of readelf.cpp reachable? — or set kanalyzer.standalone.inputFilenames (and targetList) in settings.',
            ].join('\n') }
          }
          const results = []
          for (const bitcode of s.inputFilenames) {
            results.push(await ctx.kanalyzer.analyze({ bitcode, targets: s.targetList, ...(s.entryList.length > 0 ? { entries: s.entryList } : {}) }))
          }
          const ok = results.every(r => r.status === 'ok')
          return { kind: ok ? 'success' : 'error', text: JSON.stringify(results, null, 2) }
        }
        default:
          if (raw === '') return { kind: 'error', text: USAGE }
          // Free-form request (`/kanalyzer is line 96 of readelf.cpp reachable?`): the agent knows
          // the skill and the tools, the command does not.
          return handOff(inv, freeTextPrompt(raw), 'Request handed to the agent — it runs the kanalyzer tools in this session.')
      }
    },
  })

  // DSH never auto-dispatches a typed `/kanalyzer …` slash command from chat text: `dsh-commands`
  // registers no `agent/inbox/inserted` listener at all, and its `execute()` is a `@Remote` RPC.
  // The only other dispatcher is the web composer's leading-token claim, which submits
  // `token + args` directly and — per its own source comment — "never echoes it", i.e. a claimed
  // command produces NO chat message. So the two paths are mutually exclusive by construction:
  // either the composer claimed the line (no user message → this listener never fires) or it did
  // not (user message → this listener is the only thing that will ever run the command). A session
  // log confirms both halves: before this listener existed the same phrasing produced zero
  // `command/run` records, and with it there is exactly one, alongside the raw user message.
  // That is also why no runtime de-duplication is needed here; `tests/host/commands.spec.ts`
  // pins the mutual exclusion instead. Mirrors `@pbfuzz/dsh-pbfuzz`'s `pier-driver.ts`
  // (`agent/inbox/inserted` → `commands.execute(...)` for `/pbfuzz run`).
  //
  // This deliberately does NOT try to suppress or remove the original user message from the
  // inbox — it reaches the model either way, exactly as if this listener did not exist. All this
  // adds is the extra structured prompt the handler above produces via `handOff`. Do not "fix"
  // this into swallowing the original message; that is not the bug.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // The guard that keeps this from ever re-entering on its own output: `handOff` above always
    // sources its followups as `{ kind: 'kanalyzer' }`, never `'user'`, so a
    // dispatch triggered from here can never trigger this listener again.
    if (message.source.kind !== 'user') return
    const line = kanalyzerCommandLine(textOf(message))
    if (line === undefined) return
    const commands = ctx.get('commands')
    if (commands === undefined) return
    void commands.execute(agent, line, [], new AbortController().signal)
  })
}

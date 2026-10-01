#!/usr/bin/env node
/**
 * Regenerate `tests/fixtures.ts` from real KAMain runs, so the parser tests are pinned to what
 * KAMain actually writes rather than to what its source suggests.
 *
 *   node scripts/capture-fixtures.mjs --kamain <KAMain> --llvm <prefix> \
 *     [--lua-bc <lua.0.0.preopt.bc> --lua-targets <BBtargets.txt>]
 *
 * Compiles `selftest/sample.c` with `<prefix>/bin/clang` (LTO + save-temps, exactly as the
 * doctor does), runs KAMain once per status case with the runtime's default options
 * (`-call-stack-len=20 -type-based-callgraph`), and writes every dump and stderr verbatim. Only
 * the temporary directory is rewritten to `/work/selftest`. The optional Magma lua run adds a
 * real-project case; its bid/func-info rows are narrowed to the blocks in its distance dump.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const kamain = arg('kamain'); const llvm = arg('llvm')
if (!kamain || !llvm) { console.error('usage: capture-fixtures.mjs --kamain <KAMain> --llvm <prefix> [--lua-bc <bc> --lua-targets <file>]'); process.exit(2) }

const dir = mkdtempSync(join(tmpdir(), 'kanalyzer-fixtures-'))
const norm = (s) => s.split(dir).join('/work/selftest')
const COMMON = ['-call-stack-len=20', '-type-based-callgraph']
const write = (name, text) => { writeFileSync(join(dir, name), text); return name }
const read = (name) => { try { return readFileSync(join(dir, name), 'utf8') } catch { return '' } }
function kam(args, bitcode = 'sample.0.0.preopt.bc') {
  const r = spawnSync(kamain, [...COMMON, ...args, bitcode], { cwd: dir, encoding: 'utf8' })
  return { stderr: r.stderr, exitCode: r.status }
}
const guid = (name) => createHash('md5').update(name).digest().readBigUInt64LE(0).toString()

try {
  copyFileSync(join(pkg, 'selftest', 'sample.c'), join(dir, 'sample.c'))
  execFileSync(`${llvm}/bin/clang`, ['-O0', '-g', '-fPIC', '-flto', '-fuse-ld=lld', '-Wl,-plugin-opt=save-temps', 'sample.c', '-o', 'sample'], { cwd: dir })
  write('t7', 'sample.c:7\n'); write('t1', 'sample.c:1\n'); write('t19', 'sample.c:19\n')
  write('main', 'main\n'); write('foo', 'foo\n'); write('nosuch', 'nosuch\n')
  const dumps = ['-dump-distance=distance.txt', '-dump-policy=policy.txt', '-dump-critical-branch=critical.txt',
    '-dump-bid-mapping=bid.txt', '-dump-func-info=funcinfo.txt', '-dump-caller-callee=caller-callee.txt', '-dump-callee-caller=callee-caller.txt']
  const out = {}
  out.STDERR_OK_V1 = kam(['-verbose=1', '-target-list=t7', '-entry-list=main', ...dumps]).stderr
  for (const [k, f] of [['DISTANCE', 'distance.txt'], ['POLICY', 'policy.txt'], ['CRITICAL', 'critical.txt'], ['BID_MAPPING', 'bid.txt'],
    ['FUNC_INFO', 'funcinfo.txt'], ['CALLER_CALLEE', 'caller-callee.txt'], ['CALLEE_CALLER', 'callee-caller.txt']]) out[k] = read(f)
  out.STDERR_OK_V2 = kam(['-verbose=2', '-target-list=t7', '-entry-list=main']).stderr
  out.STDERR_NO_TARGET = kam(['-verbose=1', '-target-list=t1', '-entry-list=main', '-dump-distance=nt.txt']).stderr
  out.DISTANCE_NO_TARGET = read('nt.txt')
  out.STDERR_UNREACHABLE = kam(['-verbose=1', '-target-list=t19', '-entry-list=foo', '-dump-distance=un.txt']).stderr
  out.DISTANCE_UNREACHABLE = read('un.txt')
  out.STDERR_NO_ENTRY = kam(['-verbose=1', '-target-list=t7', '-entry-list=nosuch']).stderr
  out.STDERR_LOAD_ERROR = kam(['-verbose=1', '-target-list=t7'], join(dir, 'nope.bc')).stderr
  const fatal = kam(['-verbose=1', '-target-list=/nonexistent/targets.txt'])
  out.STDERR_FATAL = fatal.stderr
  out.NM_MAIN = execFileSync(`${llvm}/bin/llvm-nm`, ['--defined-only', 'sample.0.0.preopt.bc'], { cwd: dir, encoding: 'utf8' })
  write('fuzz.c', 'int some_data = 1;\nstatic int helper(int x) { return x + 1; }\n'
    + 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n) { return helper((int)n + d[0]); }\n'
    + 'int main(void) { return some_data; }\n')
  execFileSync(`${llvm}/bin/clang`, ['-O0', '-g', '-flto', '-c', 'fuzz.c', '-o', 'fuzz.o'], { cwd: dir })
  out.NM_FUZZ = execFileSync(`${llvm}/bin/llvm-nm`, ['--defined-only', 'fuzz.o'], { cwd: dir, encoding: 'utf8' })

  const luaBc = arg('lua-bc'); const luaTargets = arg('lua-targets')
  if (luaBc && luaTargets) {
    copyFileSync(luaTargets, join(dir, 'lua-targets.txt'))
    out.LUA001_TARGETS = read('lua-targets.txt')
    out.LUA001_STDERR = kam(['-verbose=1', '-target-list=lua-targets.txt', '-dump-distance=lua-distance.txt',
      '-dump-critical-branch=lua-critical.txt', '-dump-bid-mapping=lua-bid.txt', '-dump-func-info=lua-funcinfo.txt',
      '-dump-caller-callee=lua-caller-callee.txt', '-dump-callee-caller=lua-callee-caller.txt'], luaBc).stderr
    out.LUA001_DISTANCE = read('lua-distance.txt')
    out.LUA001_CRITICAL = read('lua-critical.txt')
    // Bid rows: the reached blocks PLUS the critical branches and their exits, so the critical dump
    // maps to real locations too; the raw mapping is all 18k blocks of lua plus the harness.
    const wanted = new Set([
      ...out.LUA001_DISTANCE.split('\n').map(l => l.split(',')[0]),
      ...out.LUA001_CRITICAL.split('\n').flatMap(l => l.split(',').map(s => s.trim())),
    ])
    const bidRows = read('lua-bid.txt').split('\n').filter(l => wanted.has(l.split(',')[0]))
    out.LUA001_BID_MAPPING = bidRows.join('\n') + '\n'
    const guids = new Set(bidRows.map(l => l.split(',')[2]))
    out.LUA001_FUNC_INFO = read('lua-funcinfo.txt').split('\n').filter(l => guids.has(l.split(',')[0])).join('\n') + '\n'
    // The call graph is narrowed by row, to the functions LUA001_FUNC_INFO names: the raw dumps are
    // megabytes of the whole fuzzing harness, and a fixture only needs the real chain through the
    // target (db_getlocal → lua_getlocal → luaG_findlocal → findvararg).
    const inGuids = (l) => guids.has(l.split(',')[0])
    out.LUA001_CALLER_CALLEE = read('lua-caller-callee.txt').split('\n').filter(inGuids).join('\n') + '\n'
    out.LUA001_CALLEE_CALLER = read('lua-callee-caller.txt').split('\n').filter(inGuids).join('\n') + '\n'
  }

  const commit = spawnSync('git', ['-C', join(dirname(kamain), '..', '..'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const clangVersion = execFileSync(`${llvm}/bin/clang`, ['--version'], { encoding: 'utf8' }).split('\n')[0]
  const lit = (s) => '`' + norm(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
  const names = ['main', 'foo', 'target', 'exit', 'strlen', 'llvm.dbg.declare']
  let ts = `/**
 * KAMain output fixtures, CAPTURED from real runs — regenerate with \`scripts/capture-fixtures.mjs\`,
 * never edit by hand. KAMain ${commit || '?'} (sgzeng/kernel-analyzer@mzt), ${clangVersion}, Linux x86-64,
 * options ${COMMON.join(' ')}. The selftest sample (main -> foo -> target, exit branch in foo) was
 * compiled in a temporary directory that is rewritten to /work/selftest; nothing else is changed.
 * KAMain's unordered containers make row order vary between runs — the parsers must not care.
 * The LUA001 captures come from Magma's prebuilt lua bitcode; its call-graph rows are narrowed to
 * the functions the narrowed bid mapping names, because the raw dumps describe the whole fuzzing
 * harness. That keeps the real db_getlocal -> lua_getlocal -> luaG_findlocal -> findvararg chain.
 */

/** LLVM GUIDs (low 64 bits of MD5(name)) of the functions the sample defines or calls. */
export const GUID = {
${names.map(n => `  ${JSON.stringify(n.replace('llvm.dbg.declare', 'dbgDeclare'))}: '${guid(n)}',`).join('\n').replace(/"(\w+)":/g, '$1:')}
} as const

/** Exit status of the fatal (bad -target-list) run: KA_ERR calls exit(-1). */
export const FATAL_EXIT_CODE = ${fatal.exitCode}
`
  for (const [k, v] of Object.entries(out)) ts += `\nexport const ${k} = ${lit(v)}\n`
  writeFileSync(join(pkg, 'tests', 'fixtures.ts'), ts)
  console.log(`wrote tests/fixtures.ts (${Object.keys(out).length} captures, KAMain ${commit})`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

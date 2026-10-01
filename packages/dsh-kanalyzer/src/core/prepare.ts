/**
 * Pure halves of bitcode preparation: the build environment for the LTO and wllvm modes, the
 * `*.0.0.preopt.bc` selection, and entry inference from `llvm-nm` output.
 *
 * The LTO recipe is the one the reference pipeline used: compile `-O0 -g -fPIC -flto`, link
 * with `-fuse-ld=lld -Wl,-plugin-opt=save-temps`, and lld then leaves
 * `<output>.0.0.preopt.bc` — the whole-program module before any LTO optimisation — next to
 * each link output. Build systems that drop LDFLAGS never produce it; the wllvm mode wraps the
 * compiler instead and extracts the module with `extract-bc` afterwards.
 *
 * Both env builders take an optional trailing `nproc`: when given a positive integer, they
 * default `MAKEFLAGS` to `-j<nproc>` and `CMAKE_BUILD_PARALLEL_LEVEL` to `<nproc>` so `make`/
 * `cmake` build in parallel instead of the strictly-serial default. Either variable is left
 * alone the moment the caller env or the base (process) env already defines it — an explicitly
 * empty string counts as defined, so `env: ['MAKEFLAGS=']` is the documented opt-out. Omitting
 * `nproc` leaves both variables untouched, byte-for-byte the pre-existing behaviour.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/prepare
 */

import type { PrepareMode } from '../api.ts'
import { basename } from './paths.ts'

/** LLVM toolchain locations derived from an install prefix (e.g. `/usr/lib/llvm-14`). */
export interface Toolchain {
  prefix: string
  cc: string
  cxx: string
  ar: string
  ranlib: string
  nm: string
  lld: string
  llvmLink: string
}

/** @returns the toolchain binaries under `<prefix>/bin`. */
export function toolchainAt(prefix: string): Toolchain {
  const bin = `${prefix.replace(/\/$/, '')}/bin`
  return {
    prefix,
    cc: `${bin}/clang`,
    cxx: `${bin}/clang++`,
    ar: `${bin}/llvm-ar`,
    ranlib: `${bin}/llvm-ranlib`,
    nm: `${bin}/llvm-nm`,
    lld: `${bin}/ld.lld`,
    llvmLink: `${bin}/llvm-link`,
  }
}

export const LTO_CFLAGS = '-O0 -g -fPIC -flto'
export const LTO_LDFLAGS = '-fuse-ld=lld -Wl,-plugin-opt=save-temps'

/** The flags the analysis profile forces on a non-LTO (wllvm) compile: no optimisation, debug
 * info for line mapping, position-independent code so shared-object targets still build. */
export const ANALYSIS_CFLAGS = '-O0 -g -fPIC'

/** Append to a flag variable without dropping what the caller already set. */
function append(base: string | undefined, extra: string): string {
  return base !== undefined && base.trim().length > 0 ? `${base} ${extra}` : extra
}

/**
 * The `MAKEFLAGS` / `CMAKE_BUILD_PARALLEL_LEVEL` entries an env builder should merge in for
 * `-j<nproc>` parallelism, or `{}` when there is nothing to add.
 *
 * Each variable is included only when *neither* `callerEnv` nor `baseEnv` already defines it —
 * an explicitly empty string counts as defined (that is the `env: ['MAKEFLAGS=']` opt-out) — and
 * only when `nproc` is a positive integer, so a caller passing `0`, a negative number or a
 * fractional value gets no injection rather than a malformed flag.
 * @param callerEnv - caller-supplied overrides, checked first.
 * @param baseEnv - the process environment being extended, checked second.
 * @param nproc - worker count to build with.
 * @returns the entries to merge on top of the env built so far.
 */
export function parallelEnv(callerEnv: Record<string, string>, baseEnv: Record<string, string | undefined>, nproc: number): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Number.isInteger(nproc) || nproc <= 0) return out
  if (callerEnv.MAKEFLAGS === undefined && baseEnv.MAKEFLAGS === undefined) out.MAKEFLAGS = `-j${nproc}`
  if (callerEnv.CMAKE_BUILD_PARALLEL_LEVEL === undefined && baseEnv.CMAKE_BUILD_PARALLEL_LEVEL === undefined) out.CMAKE_BUILD_PARALLEL_LEVEL = `${nproc}`
  return out
}

/**
 * Environment for an LTO rebuild.
 *
 * `ltoLibs` are appended to `LIBS` and to `LDFLAGS` so autotools and plain Makefiles both see
 * them. They must themselves be LTO archives (built with the same flags) — a native archive
 * links fine and silently contributes no bitcode, truncating the call graph.
 * @param tc - toolchain.
 * @param callerEnv - caller-supplied overrides (win for everything except the flag appends).
 * @param ltoLibs - absolute paths of static LTO dependency archives.
 * @param baseEnv - the process environment to extend.
 * @param nproc - when a positive integer, default `MAKEFLAGS`/`CMAKE_BUILD_PARALLEL_LEVEL` to
 *   `-j<nproc>`/`<nproc>` unless `callerEnv` or `baseEnv` already sets that variable (see
 *   {@link parallelEnv}). Omitted, both are left exactly as today.
 * @returns the build environment.
 */
export function ltoEnv(tc: Toolchain, callerEnv: Record<string, string> = {}, ltoLibs: string[] = [], baseEnv: Record<string, string | undefined> = {}, nproc?: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    CC: tc.cc, CXX: tc.cxx, AR: tc.ar, RANLIB: tc.ranlib, NM: tc.nm,
    PATH: `${tc.prefix}/bin:${env.PATH ?? '/usr/bin:/bin'}`,
  })
  Object.assign(env, callerEnv)
  env.CFLAGS = append(callerEnv.CFLAGS ?? baseEnv.CFLAGS, LTO_CFLAGS)
  env.CXXFLAGS = append(callerEnv.CXXFLAGS ?? baseEnv.CXXFLAGS, LTO_CFLAGS)
  env.LDFLAGS = append(callerEnv.LDFLAGS ?? baseEnv.LDFLAGS, `-g ${LTO_LDFLAGS}${ltoLibs.length ? ` ${ltoLibs.join(' ')}` : ''}`)
  if (ltoLibs.length > 0) env.LIBS = append(callerEnv.LIBS ?? baseEnv.LIBS, ltoLibs.join(' '))
  if (nproc !== undefined) Object.assign(env, parallelEnv(callerEnv, baseEnv, nproc))
  return env
}

/**
 * Environment for the wllvm fallback: `CC=wllvm`, `LLVM_COMPILER=clang`, and
 * `LLVM_COMPILER_PATH` pinned to the analyser's LLVM so the embedded bitcode matches KAMain's
 * major version. No `-flto` (wllvm emits native objects plus side bitcode).
 * @param tc - toolchain.
 * @param callerEnv - caller-supplied overrides (win for everything except the flag appends).
 * @param baseEnv - the process environment to extend.
 * @param nproc - when a positive integer, default `MAKEFLAGS`/`CMAKE_BUILD_PARALLEL_LEVEL` to
 *   `-j<nproc>`/`<nproc>` unless `callerEnv` or `baseEnv` already sets that variable (see
 *   {@link parallelEnv}). Omitted, both are left exactly as today.
 * @returns the build environment.
 */
export function wllvmEnv(tc: Toolchain, callerEnv: Record<string, string> = {}, baseEnv: Record<string, string | undefined> = {}, nproc?: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    CC: 'wllvm', CXX: 'wllvm++', LLVM_COMPILER: 'clang', LLVM_COMPILER_PATH: `${tc.prefix}/bin`,
    AR: tc.ar, RANLIB: tc.ranlib, PATH: `${tc.prefix}/bin:${env.PATH ?? '/usr/bin:/bin'}`,
  })
  Object.assign(env, callerEnv)
  env.CFLAGS = append(callerEnv.CFLAGS ?? baseEnv.CFLAGS, ANALYSIS_CFLAGS)
  env.CXXFLAGS = append(callerEnv.CXXFLAGS ?? baseEnv.CXXFLAGS, ANALYSIS_CFLAGS)
  if (nproc !== undefined) Object.assign(env, parallelEnv(callerEnv, baseEnv, nproc))
  return env
}

export const PREOPT_SUFFIX = '.0.0.preopt.bc'

/** @returns the link-output name a preopt bitcode belongs to (`readelf.0.0.preopt.bc` → `readelf`). */
export function programOf(bitcodePath: string): string {
  const b = basename(bitcodePath)
  return b.endsWith(PREOPT_SUFFIX) ? b.slice(0, -PREOPT_SUFFIX.length) : b.replace(/\.bc$/, '')
}

/**
 * Choose the bitcode to analyse.
 * @param found - every bitcode the build produced (absolute).
 * @param program - requested link output basename, if any.
 * @returns the selected path and the sorted full list; `selected` undefined when nothing matches.
 */
export function selectBitcode(found: string[], program?: string): { selected?: string; all: string[] } {
  const all = [...new Set(found)].sort()
  if (program !== undefined) {
    const exact = all.filter(p => programOf(p) === program)
    const pick = exact[0] ?? all.find(p => programOf(p).startsWith(program))
    return pick === undefined ? { all } : { selected: pick, all }
  }
  if (all.length <= 1) return all[0] === undefined ? { all } : { selected: all[0], all }
  // Prefer a fuzz harness link output, then an executable-looking name over shared objects.
  const nonLib = all.filter(p => !/\.so(\.|$)|^lib/.test(programOf(p)))
  return { selected: nonLib[0] ?? all[0], all }
}

/**
 * Entry inference from `llvm-nm` output: defined text symbols named `LLVMFuzzerTestOneInput`
 * are preferred over `main`. Both are returned in preference order when both exist.
 * @param nmOutput - stdout of `llvm-nm <bitcode>`.
 * @returns the entries plus the number of defined functions.
 */
export function inferEntries(nmOutput: string): { entries: string[]; nFuncs: number } {
  const defined = new Set<string>()
  for (const line of nmOutput.split('\n')) {
    // `llvm-nm` on bitcode: `---------------- T main` / `         U printf`.
    const m = /^\s*(?:[0-9a-fA-F-]+\s+)?([A-Za-z])\s+(\S+)\s*$/.exec(line)
    if (m?.[1] === undefined || m[2] === undefined) continue
    if (m[1] === 'T' || m[1] === 't' || m[1] === 'W') defined.add(m[2])
  }
  const entries: string[] = []
  if (defined.has('LLVMFuzzerTestOneInput')) entries.push('LLVMFuzzerTestOneInput')
  if (defined.has('main')) entries.push('main')
  return { entries, nFuncs: defined.size }
}

/** Compiler drivers a `buildCmd` invokes directly, rather than through a build system. */
const DIRECT_COMPILER = /(^|[\s;&|(])(\$\{?(CC|CXX)\}?|c\+\+|cc|g\+\+|gcc|clang\+\+|clang)([\s;&|)]|$)/

/** A reference to one of the flag variables `ltoEnv()` populates, in any shell spelling. */
const REFERENCES_FLAGS = /\$\{?(CFLAGS|CXXFLAGS|LDFLAGS)\}?/

/** The flags that make an LTO build produce `*.0.0.preopt.bc`, written literally on the command
 * line instead of through the variables. Either spelling is fine — the check only cares that they
 * are actually there. */
const LITERAL_LTO = /(-flto|plugin-opt=save-temps)/

/**
 * Why an `lto` build command cannot possibly produce bitcode, or `undefined` when it might.
 *
 * `ltoEnv()` supplies `-flto`/`save-temps` through `CFLAGS`/`CXXFLAGS`/`LDFLAGS` **as environment
 * variables only** — nothing ever appends them to the command line. A build system (make, cmake,
 * autotools…) picks them up by convention, but a command that drives the compiler *directly* only
 * gets them if it spells them out, and a real session lost ~15s to exactly that: `$CXX readelf.cpp
 * -o readelf` compiled a plain native binary, no `.0.0.preopt.bc` appeared, and the failure was
 * reported as if the build system had dropped LDFLAGS.
 *
 * Deliberately narrow — it fires only on a *direct* compiler invocation that references none of the
 * flag variables and carries no literal LTO flag either. A `./build.sh` or `make` that honours
 * `CXXFLAGS` internally names no compiler here and is never rejected, so the check cannot turn a
 * working build into a false failure.
 * @param buildCmd - the command as the caller wrote it.
 * @param mode - the prepare mode; only `lto` is checked (wllvm wraps the compiler instead).
 * @returns the diagnosis to fail with, or `undefined` to proceed.
 */
export function ltoBuildCmdProblem(buildCmd: string, mode: PrepareMode): string | undefined {
  if (mode !== 'lto') return undefined
  if (!DIRECT_COMPILER.test(buildCmd)) return undefined
  if (REFERENCES_FLAGS.test(buildCmd) || LITERAL_LTO.test(buildCmd)) return undefined
  return [
    `This buildCmd invokes the compiler directly but references none of $CFLAGS / $CXXFLAGS / $LDFLAGS: ${buildCmd}`,
    'kanalyzer passes the LTO flags to your build as ENVIRONMENT VARIABLES and never appends them to your command line,',
    `so this would compile a plain native binary and produce no ${PREOPT_SUFFIX} at all.`,
    'Reference them, e.g.  $CXX $CXXFLAGS <src> -o <out> $LDFLAGS  (use $CC/$CFLAGS for C).',
    'A build system (make/cmake/autotools) picks the variables up on its own, so `make` needs no change.',
    'Alternatively use mode "wllvm", which wraps the compiler instead of relying on flags.',
  ].join('\n')
}

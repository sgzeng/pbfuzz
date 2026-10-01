/**
 * Compiler shim: a single bash script, installed under every name a project's build might invoke
 * a compiler as, that intercepts each compile/link invocation before it reaches the real
 * toolchain (or `wllvm`).
 *
 * Why this exists: `kanalyzer_prepare` injects the toolchain as environment variables
 * (`ltoEnv()`/`wllvmEnv()` in `./prepare.ts`), but a project's own build script routinely does
 * `export CC=clang` (or hard-codes `-O2`/`-fsanitize=address`) itself, right over that injection
 * — a real nginx build did exactly this, and the only way an agent had to cope was `sed`-ing the
 * project's script. Putting a same-named executable ahead of everything else on `$PATH` wins
 * regardless of what the build script exports `CC` to, since `clang`/`cc`/… still resolve here
 * first. This module only renders the script text; installing it under {@link SHIM_NAMES} in a
 * directory and prepending that directory to the build's `$PATH` is `host/runtime.ts`'s job.
 *
 * Pure: no `node:fs`, no `node:child_process`, no filesystem or process access at all — just
 * string assembly, so it is testable without a shell and safe to call from anywhere. The
 * generated *script*, of course, does nothing but run shell and processes; that is its purpose.
 *
 * Two things the generated script has to get right on its own, since it runs long after this
 * function returns and has no access to Node:
 *
 * - **No recursion.** The shim directory sits first on the build's `$PATH` for the shim's own
 *   sake, but the real compiler (or `wllvm`, which itself execs a real compiler) must never see
 *   it there — otherwise the shim would call itself. The script's first act is to strip its own
 *   directory back out of `$PATH` before doing anything else, including before the pass-through
 *   branch below.
 * - **No sanitizer noise in the analysis bitcode.** `-fsanitize=address` and friends turn ~every
 *   `assert`-like check into a critical branch, drowning the handful that matter (a real capture
 *   put the ratio at 37,634 of 37,678). The `analysis` {@link FlagProfile} strips them, downgrades
 *   optimisation to `-O0` and forces `-g -fPIC`, while still keeping `-fsanitize=fuzzer` on a link
 *   so the harness still gets a `main` and the libFuzzer runtime — it is dropped only on a
 *   compile-only invocation, where it would just add unlinkable coverage instrumentation.
 *
 * The script avoids external helpers such as `basename` and `date` even for its own bookkeeping
 * (name detection strips the directory prefix off `$0` with plain parameter expansion, the
 * progress timestamp uses bash's builtin `printf '%(%s)T'`), on purpose: once the shim directory
 * is stripped from `$PATH`, nothing should have
 * to resolve *anything* through `$PATH` except the two things that are meant to — `wllvm`/
 * `wllvm++` in {@link ShimMode} `'wllvm'`, and nothing at all in `'lto'`, which execs the real
 * compiler by the absolute path baked into the script.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/shim
 */

/** How the shim hands an invocation to the real toolchain once it has decided what to do with it. */
export type ShimMode =
  /** Add `-flto`/lld flags and exec the real compiler by its absolute path. */
  | 'lto'
  /** Exec `wllvm`/`wllvm++` by name (resolved through the PATH the shim leaves behind). */
  | 'wllvm'

/** Whether the shim rewrites argv before handing it off, or leaves it exactly as given. */
export type FlagProfile =
  /** Strip sanitizer flags (`-fsanitize=fuzzer` survives on a link only), force `-O0 -g -fPIC`. */
  | 'analysis'
  /** No rewriting; only {@link ShimMode}'s own additions (e.g. `-flto`) apply. */
  | 'passthrough'

/**
 * Compiler names a build might invoke. Every one of these is installed as a copy of the same
 * rendered script inside the shim directory.
 */
export const SHIM_NAMES: readonly string[] = ['clang', 'clang++', 'cc', 'c++', 'gcc', 'g++']

/**
 * @param llvmMajor - LLVM major version (e.g. `'14'`), when a project's `configure` or its own
 *   `CC=clang-14` also names the shim by its versioned form.
 * @returns {@link SHIM_NAMES} plus `clang-<major>` / `clang++-<major>` when `llvmMajor` is given.
 */
export function shimNames(llvmMajor?: string): string[] {
  const names = [...SHIM_NAMES]
  if (llvmMajor !== undefined) names.push(`clang-${llvmMajor}`, `clang++-${llvmMajor}`)
  return names
}

/** Parameters baked into the rendered script text at render time; nothing is looked up at run time. */
export interface ShimParams {
  mode: ShimMode
  profile: FlagProfile
  /** Absolute path to the real `clang`, used by `mode: 'lto'`. */
  realCc: string
  /** Absolute path to the real `clang++`, used by `mode: 'lto'`. */
  realCxx: string
  /** The directory the script is installed into under every {@link SHIM_NAMES} entry, and the
   *  one directory the script strips back out of its own `$PATH` before doing anything else. */
  shimDir: string
  /** File the script appends one progress line to per invocation. */
  progressFile: string
  /** Baked into `-Wl,--lto-partitions=<nproc>` on an `lto` link. */
  nproc: number
}

/**
 * Classify one compiler invocation the same way the rendered script does — used by tests, and by
 * the host's progress reader to interpret the lines the script writes to `progressFile`.
 *
 * `'info'` covers version/preprocessor/probe invocations a build's `configure` step uses to
 * identify or interrogate the compiler (`clang -v`, `$CC -dumpmachine`, …); the script execs the
 * real compiler with the original argv unchanged for these, so a probe that greps the output for
 * "clang version" still sees a real clang. `'compile'` is `-c`/`-S`; everything else, including a
 * combined compile-and-link invocation such as a `configure` probe's `clang conftest.c -o
 * conftest`, is `'link'`.
 * @param argv - the invocation's arguments (not including the program name).
 * @returns the invocation's kind.
 */
export function classifyInvocation(argv: readonly string[]): 'info' | 'compile' | 'link' {
  const isInfoFlag = (a: string): boolean =>
    a === '-v' || a === '--version' || a === '-E' || a === '-M' || a === '-MM'
    || a === '-dumpversion' || a === '-dumpmachine' || a === '-###' || a.startsWith('-print-')
  if (argv.some(isInfoFlag)) return 'info'
  if (argv.some(a => a === '-c' || a === '-S')) return 'compile'
  return 'link'
}

/** POSIX single-quote escaping: wraps `value` in single quotes, safe for any byte a shell arg can hold. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Render the shim's script text. The same text is installed under every {@link SHIM_NAMES} (and
 * {@link shimNames}) entry; the script tells C from C++ apart itself, from `$0`.
 *
 * Behaviour, in order (mirrors {@link classifyInvocation} and the module doc above):
 * 1. Strip `shimDir` out of `$PATH` (leading, middle or trailing) so nothing this script execs
 *    can recurse back into it.
 * 2. Decide C vs C++ from the invoked name: `*++*` or `*xx` (covers `c++`, `g++`, `clang++`, and
 *    `clang++-<major>` alike; nothing in {@link shimNames} spells C++ any other way).
 * 3. Append one `<epoch> <info|compile|link> <label>` line to `progressFile` — the label is the
 *    first non-flag argument for a compile, the `-o` target for a link, `-` otherwise — ignoring
 *    any failure to do so.
 * 4. Info invocations exec the real toolchain with argv untouched and return here.
 * 5. Everything else is compile or link (already decided in step 3).
 * 6. `profile: 'analysis'` rewrites argv (sanitizer flags stripped, `-fsanitize=fuzzer` kept only
 *    on a link, optimisation forced to `-O0`, `-g`/`-fPIC` forced on); `'passthrough'` copies argv
 *    unchanged.
 * 7. `mode: 'lto'` appends `-flto` (compile) or the full lld/save-temps/partitions flags (link)
 *    and execs the real compiler by absolute path; `mode: 'wllvm'` execs `wllvm`/`wllvm++` by
 *    name, unchanged by `mode`.
 * @param p - the parameters to bake in.
 * @returns the complete script text, starting `#!/bin/bash`.
 */
export function renderShimScript(p: ShimParams): string {
  const nproc = Math.max(1, Math.trunc(p.nproc) || 1)
  const shimDir = shQuote(p.shimDir)
  const progressFile = shQuote(p.progressFile)
  const realCc = shQuote(p.realCc)
  const realCxx = shQuote(p.realCxx)
  const mode = shQuote(p.mode)
  const profile = shQuote(p.profile)

  return `#!/bin/bash
set -u

# Rendered by @pbfuzz/dsh-kanalyzer core/shim.ts — do not edit by hand.
# mode=${p.mode} profile=${p.profile}

SHIM_DIR=${shimDir}
PROGRESS_FILE=${progressFile}
REAL_CC=${realCc}
REAL_CXX=${realCxx}
MODE=${mode}
PROFILE=${profile}
NPROC=${String(nproc)}

# 1. Strip shimDir out of $PATH (leading/middle/trailing alike) so the real compiler, wllvm, and
#    anything they in turn spawn cannot walk back into this shim and recurse into itself.
__shim_old_ifs="$IFS"
IFS=:
read -r -a __shim_path_parts <<< "$PATH"
IFS="$__shim_old_ifs"
__shim_new_path=()
for __shim_p in "\${__shim_path_parts[@]}"; do
  if [ "$__shim_p" != "$SHIM_DIR" ]; then
    __shim_new_path+=("$__shim_p")
  fi
done
IFS=:
PATH="\${__shim_new_path[*]}"
IFS="$__shim_old_ifs"
export PATH
unset __shim_old_ifs __shim_path_parts __shim_new_path __shim_p

# 2. C vs C++ from our own invoked name. Pure parameter expansion (no external basename): once
#    shimDir is off $PATH nothing here should still need to resolve a helper through it.
__shim_name=\${0##*/}
case "$__shim_name" in
  *++*|*xx) __shim_is_cxx=1 ;;
  *) __shim_is_cxx=0 ;;
esac

# Same tri-state classification as core/shim.ts's classifyInvocation().
__shim_classify() {
  for __shim_a in "$@"; do
    case "$__shim_a" in
      -v|--version|-E|-M|-MM|-dumpversion|-dumpmachine|-###) echo info; return ;;
      -print-*) echo info; return ;;
    esac
  done
  for __shim_a in "$@"; do
    case "$__shim_a" in
      -c|-S) echo compile; return ;;
    esac
  done
  echo link
}

__shim_compile_label() {
  local __skip=0
  for __shim_a in "$@"; do
    if [ "$__skip" = 1 ]; then __skip=0; continue; fi
    case "$__shim_a" in
      -o) __skip=1 ;;
      -*) ;;
      *) printf '%s' "$__shim_a"; return ;;
    esac
  done
  printf '%s' '-'
}

__shim_link_label() {
  local __prev=''
  for __shim_a in "$@"; do
    if [ "$__prev" = '-o' ]; then printf '%s' "$__shim_a"; return; fi
    __prev="$__shim_a"
  done
  printf '%s' '-'
}

__shim_kind=$(__shim_classify "$@")
case "$__shim_kind" in
  compile) __shim_label=$(__shim_compile_label "$@") ;;
  link) __shim_label=$(__shim_link_label "$@") ;;
  *) __shim_label='-' ;;
esac

# 3. One progress line per invocation, never fatal. Bash's own %(%s)T avoids forking \`date\`.
printf -v __shim_ts '%(%s)T' -1
{ printf '%s %s %s\\n' "$__shim_ts" "$__shim_kind" "$__shim_label" >> "$PROGRESS_FILE"; } 2>/dev/null || true

# 4. Info / pass-through: exec the real toolchain with the ORIGINAL argv, unchanged.
if [ "$__shim_kind" = info ]; then
  if [ "$MODE" = wllvm ]; then
    if [ "$__shim_is_cxx" = 1 ]; then exec wllvm++ "$@"; else exec wllvm "$@"; fi
  else
    if [ "$__shim_is_cxx" = 1 ]; then exec "$REAL_CXX" "$@"; else exec "$REAL_CC" "$@"; fi
  fi
fi

# 5/6. From here $__shim_kind is compile or link. Rewrite argv for the analysis profile only.
__shim_new_args=()
if [ "$PROFILE" = analysis ]; then
  __shim_saw_g=0
  __shim_saw_fpic=0
  for __shim_a in "$@"; do
    case "$__shim_a" in
      -fsanitize=fuzzer)
        if [ "$__shim_kind" = link ]; then __shim_new_args+=("$__shim_a"); fi
        ;;
      -fsanitize=*) ;;
      -fsanitize-address-*) ;;
      -fsanitize-coverage=*) ;;
      -fno-sanitize*) ;;
      -O1|-O2|-O3|-Os|-Oz|-Ofast) __shim_new_args+=(-O0) ;;
      -gline-tables-only|-g1|-g0) __shim_saw_g=1; __shim_new_args+=(-g) ;;
      -g*) __shim_saw_g=1; __shim_new_args+=("$__shim_a") ;;
      -fPIC) __shim_saw_fpic=1; __shim_new_args+=("$__shim_a") ;;
      *) __shim_new_args+=("$__shim_a") ;;
    esac
  done
  if [ "$__shim_saw_g" = 0 ]; then __shim_new_args+=(-g); fi
  if [ "$__shim_saw_fpic" = 0 ]; then __shim_new_args+=(-fPIC); fi
else
  __shim_new_args=("$@")
fi

# 7. Mode-specific flags, then exec the real toolchain.
if [ "$MODE" = lto ]; then
  if [ "$__shim_kind" = compile ]; then
    __shim_new_args+=(-flto)
  else
    __shim_new_args+=(-flto -fuse-ld=lld -Wl,-plugin-opt=save-temps -Wl,--lto-O0 "-Wl,--lto-partitions=$NPROC")
  fi
  if [ "$__shim_is_cxx" = 1 ]; then exec "$REAL_CXX" "\${__shim_new_args[@]}"; else exec "$REAL_CC" "\${__shim_new_args[@]}"; fi
else
  if [ "$__shim_is_cxx" = 1 ]; then exec wllvm++ "\${__shim_new_args[@]}"; else exec wllvm "\${__shim_new_args[@]}"; fi
fi
`
}

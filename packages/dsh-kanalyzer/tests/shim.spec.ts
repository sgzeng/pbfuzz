/**
 * K1b — the compiler shim script, exercised as a real subprocess (no mocking): the rendered
 * script is written to disk under every {@link SHIM_NAMES} entry and run with `bash` against fake
 * "real compiler" / `wllvm` / `wllvm++` executables, the same way a build would invoke it.
 *
 * The fakes each print a marker line identifying themselves, then `PATH=$PATH`, then one line per
 * argument they received — so a test can tell which toolchain actually ran, confirm `$PATH` no
 * longer carries the shim directory (the no-recursion guarantee), and see the exact rewritten argv
 * without needing anything to actually compile.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyInvocation, renderShimScript, SHIM_NAMES, shimNames, type ShimParams } from '../src/core/shim.ts'

let tmp: string
let realDir: string
let realCc: string
let realCxx: string

/** Writes a fake executable that echoes a marker, then `PATH=$PATH`, then argv one per line. */
function fakeExe(dir: string, name: string, marker: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/bash\necho ${marker}\necho "PATH=$PATH"\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`)
  chmodSync(p, 0o755)
  return p
}

/** Renders one script and installs it under every {@link SHIM_NAMES} entry in a fresh directory. */
function installShim(params: Omit<ShimParams, 'shimDir'>): { shimDir: string } {
  const shimDir = mkdtempSync(join(tmp, 'shim-'))
  const script = renderShimScript({ ...params, shimDir })
  for (const name of SHIM_NAMES) {
    const p = join(shimDir, name)
    writeFileSync(p, script)
    chmodSync(p, 0o755)
  }
  return { shimDir }
}

/** Runs one shim entry under `bash`, with $PATH set to exactly shimDir then realDir. */
function run(shimDir: string, name: string, args: string[]): { lines: string[]; status: number | null } {
  const r = spawnSync('/bin/bash', [join(shimDir, name), ...args], {
    env: { PATH: `${shimDir}:${realDir}` },
    encoding: 'utf8',
  })
  const lines = r.stdout.length === 0 ? [] : r.stdout.replace(/\n$/, '').split('\n')
  return { lines, status: r.status }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-shim-'))
  realDir = mkdtempSync(join(tmp, 'real-'))
  realCc = fakeExe(realDir, 'real-clang', 'REALCC')
  realCxx = fakeExe(realDir, 'real-clang++', 'REALCXX')
  fakeExe(realDir, 'wllvm', 'WLLVM')
  fakeExe(realDir, 'wllvm++', 'WLLVMXX')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('renderShimScript — lto mode', () => {
  it('(a) analysis compile: drops sanitizers, downgrades -O, forces -g -fPIC, adds -flto, keeps a space-containing path intact', () => {
    const { shimDir } = installShim({
      mode: 'lto', profile: 'analysis', realCc, realCxx, progressFile: join(tmp, 'progress.log'), nproc: 4,
    })
    const { lines, status } = run(shimDir, 'clang', [
      '-O1', '-gline-tables-only', '-fsanitize=address', '-fsanitize=fuzzer-no-link', '-c', 'a b.c', '-o', 'out.o',
    ])
    expect(status).toBe(0)
    expect(lines[0]).toBe('REALCC')
    const argv = lines.slice(2)
    expect(argv).toContain('-O0')
    expect(argv).toContain('-g')
    expect(argv).toContain('-fPIC')
    expect(argv).toContain('-flto')
    expect(argv).toContain('a b.c')
    expect(argv).toContain('-o')
    expect(argv).toContain('out.o')
    expect(argv.some(a => a.includes('-fsanitize'))).toBe(false)
    expect(argv).not.toContain('-O1')
    expect(argv).not.toContain('-gline-tables-only')
  })

  it('(b) analysis link: keeps -fsanitize=fuzzer, drops other sanitizer flags, adds the lld/save-temps/partitions flags', () => {
    const { shimDir } = installShim({
      mode: 'lto', profile: 'analysis', realCc, realCxx, progressFile: join(tmp, 'progress.log'), nproc: 6,
    })
    const { lines, status } = run(shimDir, 'clang++', [
      '-O2', '-fsanitize=address', '-fsanitize=fuzzer', 'a.o', 'b.o', '-o', 'fuzzer_bin',
    ])
    expect(status).toBe(0)
    expect(lines[0]).toBe('REALCXX')
    const argv = lines.slice(2)
    expect(argv).toContain('-fsanitize=fuzzer')
    expect(argv).not.toContain('-fsanitize=address')
    expect(argv).toContain('-flto')
    expect(argv).toContain('-fuse-ld=lld')
    expect(argv).toContain('-Wl,-plugin-opt=save-temps')
    expect(argv).toContain('-Wl,--lto-O0')
    expect(argv).toContain('-Wl,--lto-partitions=6')
    expect(argv).toContain('-O0')
    expect(argv).toContain('-g')
    expect(argv).toContain('-fPIC')
  })
})

describe('renderShimScript — wllvm mode', () => {
  it('(c) analysis compile: execs the fake wllvm by name through the stripped PATH (no recursion), with rewritten flags, never adding -flto', () => {
    const { shimDir } = installShim({
      mode: 'wllvm', profile: 'analysis', realCc, realCxx, progressFile: join(tmp, 'progress.log'), nproc: 4,
    })
    const { lines, status } = run(shimDir, 'cc', ['-O3', '-fsanitize=fuzzer-no-link', '-c', 'x.c', '-o', 'x.o'])
    expect(status).toBe(0)
    expect(lines[0]).toBe('WLLVM')
    expect(lines[1]?.startsWith('PATH=')).toBe(true)
    expect(lines[1]).not.toContain(shimDir)
    const argv = lines.slice(2)
    expect(argv).toContain('-O0')
    expect(argv).toContain('-g')
    expect(argv).toContain('-fPIC')
    expect(argv).not.toContain('-fsanitize=fuzzer-no-link')
    expect(argv).not.toContain('-flto')
  })

  it('dispatches a C++ name to wllvm++, including a versioned clang++-<major> name', () => {
    const { shimDir } = installShim({
      mode: 'wllvm', profile: 'passthrough', realCc, realCxx, progressFile: join(tmp, 'progress.log'), nproc: 4,
    })
    // installShim only wrote SHIM_NAMES; add the versioned pair from shimNames() explicitly.
    for (const name of shimNames('14')) {
      if (SHIM_NAMES.includes(name)) continue
      const script = renderShimScript({ mode: 'wllvm', profile: 'passthrough', realCc, realCxx, shimDir, progressFile: join(tmp, 'progress.log'), nproc: 4 })
      writeFileSync(join(shimDir, name), script)
      chmodSync(join(shimDir, name), 0o755)
    }
    expect(run(shimDir, 'g++', ['-c', 'y.cpp', '-o', 'y.o']).lines[0]).toBe('WLLVMXX')
    expect(run(shimDir, 'clang++-14', ['-c', 'y.cpp', '-o', 'y.o']).lines[0]).toBe('WLLVMXX')
    expect(run(shimDir, 'clang-14', ['-c', 'y.c', '-o', 'y.o']).lines[0]).toBe('WLLVM')
  })
})

describe('info pass-through', () => {
  it('(d) -v / --version exec the real toolchain with the original argv unchanged, in both modes', () => {
    const { shimDir: ltoDir } = installShim({
      mode: 'lto', profile: 'analysis', realCc, realCxx, progressFile: join(tmp, 'progress-lto.log'), nproc: 4,
    })
    const r1 = run(ltoDir, 'clang', ['-v'])
    expect(r1.lines[0]).toBe('REALCC')
    expect(r1.lines.slice(2)).toEqual(['-v'])

    const { shimDir: wDir } = installShim({
      mode: 'wllvm', profile: 'analysis', realCc, realCxx, progressFile: join(tmp, 'progress-w.log'), nproc: 4,
    })
    const r2 = run(wDir, 'clang', ['--version'])
    expect(r2.lines[0]).toBe('WLLVM')
    expect(r2.lines.slice(2)).toEqual(['--version'])
  })
})

describe('passthrough profile', () => {
  it('(e) leaves argv exactly as given (wllvm mode adds no flags of its own either)', () => {
    const { shimDir } = installShim({
      mode: 'wllvm', profile: 'passthrough', realCc, realCxx, progressFile: join(tmp, 'progress.log'), nproc: 4,
    })
    const args = ['-O2', '-fsanitize=address', '-c', 'z.c', '-o', 'z.o']
    const { lines } = run(shimDir, 'cc', args)
    expect(lines[0]).toBe('WLLVM')
    expect(lines.slice(2)).toEqual(args)
  })
})

describe('progress file', () => {
  it('(f) gets one line per invocation, with the right kind and epoch second', () => {
    const progressFile = join(tmp, 'progress.log')
    const { shimDir } = installShim({ mode: 'lto', profile: 'analysis', realCc, realCxx, progressFile, nproc: 4 })
    run(shimDir, 'clang', ['-c', 'one.c', '-o', 'one.o'])
    run(shimDir, 'clang', ['one.o', '-o', 'a.out'])
    run(shimDir, 'clang', ['-v'])
    const rows = readFileSync(progressFile, 'utf8').trim().split('\n').map(l => l.split(' '))
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r[1])).toEqual(['compile', 'link', 'info'])
    expect(rows.map(r => r[2])).toEqual(['one.c', 'a.out', '-'])
    for (const r of rows) expect(Number.isInteger(Number(r[0])) && Number(r[0]) > 0).toBe(true)
  })
})

describe('classifyInvocation (g)', () => {
  it('matches the same rules the rendered script applies', () => {
    expect(classifyInvocation(['-v'])).toBe('info')
    expect(classifyInvocation(['--version'])).toBe('info')
    expect(classifyInvocation(['-E', 'a.c'])).toBe('info')
    expect(classifyInvocation(['-dumpmachine'])).toBe('info')
    expect(classifyInvocation(['-print-prog-name=ld'])).toBe('info')
    expect(classifyInvocation(['-###', '-c', 'a.c'])).toBe('info')
    expect(classifyInvocation(['-c', 'a.c'])).toBe('compile')
    expect(classifyInvocation(['-S', 'a.c'])).toBe('compile')
    expect(classifyInvocation(['a.c', '-o', 'a.out'])).toBe('link')
    // A configure-style combined compile+link probe.
    expect(classifyInvocation(['conftest.c', '-o', 'conftest'])).toBe('link')
  })
})

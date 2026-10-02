/**
 * `env-verify.ts`: `draft` builds the target and runs it once. The build script it is handed was
 * usually just created with `write`, which cannot set the execute bit — so a recorded session spent
 * a whole model step on `chmod +x`. draft now does that itself.
 */
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureExecutable, isBuildFresh, verifyEnvironment } from '../src/env-verify.ts'

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'pbfuzz-verify-'))
}

describe('draft-time build verification', () => {
  it('runs a freshly written, non-executable build script instead of failing with "permission denied"', async () => {
    const root = repo()
    writeFileSync(join(root, 'build.sh'), '#!/usr/bin/env bash\nset -o pipefail\necho built-ok\n', { mode: 0o644 })
    const steps = await verifyEnvironment({
      target: { repo: root },
      build: { cmd: './build.sh' },
      entry: { kind: 'executable', run_cmd: 'true @@', input_channel: 'file' },
    } as never, { buildSec: 60, runSec: 10 })
    expect(steps[0]).toMatchObject({ ok: true })
    expect(steps[0]!.detail).toContain('built-ok')
    expect(statSync(join(root, 'build.sh')).mode & 0o111).toBe(0o111)
  })

  it('leaves commands that are not a script path alone', () => {
    const root = repo()
    expect(ensureExecutable('make -j8', root)).toBeUndefined()
    expect(ensureExecutable('./missing.sh', root)).toBeUndefined()
    writeFileSync(join(root, 'already.sh'), 'true\n', { mode: 0o755 })
    expect(ensureExecutable('./already.sh --flag', root)).toBeUndefined()
  })

  it('skips the build when the binary is newer than every source, still runs it on an empty input under the campaign dir', async () => {
    const root = repo()
    const outDir = join(root, '.pbfuzz', 'c1')
    const binPath = join(root, 'fuzzer.sh')
    const past = new Date(Date.now() - 3_600_000)
    // sources, backdated so the binary is unambiguously the newest file under the tree
    writeFileSync(join(root, 'main.c'), 'int main(){}\n')
    writeFileSync(join(root, 'build.sh'), '#!/bin/sh\ntouch "$PWD/ran_build"\n', { mode: 0o755 })
    utimesSync(join(root, 'main.c'), past, past)
    utimesSync(join(root, 'build.sh'), past, past)
    // the "binary" echoes its input path so we can prove the empty-input file is campaign-local
    writeFileSync(binPath, '#!/bin/sh\necho "INPUT=$1"\n', { mode: 0o755 })
    const steps = await verifyEnvironment({
      target: { repo: root },
      build: { cmd: './build.sh' },
      entry: { kind: 'executable', run_cmd: `${binPath} @@`, input_channel: 'file' },
      output: { dir: outDir },
    } as never, { buildSec: 60, runSec: 10 })
    expect(steps[0]).toMatchObject({ ok: true })
    expect(steps[0]!.detail).toContain('skipped')
    expect(existsSync(join(root, 'ran_build'))).toBe(false) // build did not run
    expect(steps[1]!.detail).toContain(`INPUT=${outDir}`) // scratch input is under the campaign dir, not /tmp
  })

  it('isBuildFresh: true only when the binary outdates all sources, false for a missing binary', () => {
    const root = repo()
    const binPath = join(root, 'bin')
    const camp = {
      target: { repo: root },
      entry: { kind: 'executable', run_cmd: `${binPath} @@`, input_channel: 'file' },
      output: { dir: join(root, '.pbfuzz', 'c1') },
    } as never
    writeFileSync(join(root, 'a.c'), 'x')
    writeFileSync(binPath, 'true\n', { mode: 0o755 })
    utimesSync(join(root, 'a.c'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    expect(isBuildFresh(camp)).toBe(true)
    utimesSync(join(root, 'a.c'), new Date(Date.now() + 3_600_000), new Date(Date.now() + 3_600_000))
    expect(isBuildFresh(camp)).toBe(false)
    expect(isBuildFresh({ target: { repo: root }, entry: { kind: 'executable', run_cmd: 'nope @@', input_channel: 'file' }, output: { dir: root } } as never)).toBe(false)
  })
})

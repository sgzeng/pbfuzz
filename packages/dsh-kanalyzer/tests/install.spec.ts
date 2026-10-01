import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  candidateLlvmPrefixes, expandHome, isSupportedMajor, llvmMajor, llvmPrefixFromCMakeCache, looksLikeLtoArchive,
} from '../src/core/install.ts'
import { parseSkillFile } from '../src/core/skill.ts'
import { heuristicInstructionLines } from '../src/core/status.ts'

describe('install helpers', () => {
  it('prefers the configured prefix, then llvm-14', () => {
    expect(candidateLlvmPrefixes('/opt/llvm/')[0]).toBe('/opt/llvm')
    expect(candidateLlvmPrefixes('')[0]).toBe('/usr/lib/llvm-14')
  })
  it('reads the linked LLVM from CMakeCache', () => {
    expect(llvmPrefixFromCMakeCache('FOO:BOOL=ON\nLLVM_DIR:PATH=/usr/lib/llvm-14/lib/cmake/llvm\n')).toBe('/usr/lib/llvm-14')
    // Debian/Ubuntu llvm-14-dev: a real KAMain build records the `…/llvm-14/cmake` symlink.
    expect(llvmPrefixFromCMakeCache('LLVM_DIR:PATH=/usr/lib/llvm-14/cmake\n')).toBe('/usr/lib/llvm-14')
    expect(llvmPrefixFromCMakeCache('nothing')).toBeUndefined()
  })
  it('checks supported majors', () => {
    expect(llvmMajor('14.0.6')).toBe(14)
    expect(isSupportedMajor(14)).toBe(true)
    expect(isSupportedMajor(17)).toBe(false)
  })
  it('distinguishes LTO archives from native ones', () => {
    const ar = (member: number[]): Uint8Array => new Uint8Array([...Buffer.from('!<arch>\nx.o/ 0 0 0 644 4 `\n'), ...member])
    expect(looksLikeLtoArchive(ar([0x42, 0x43, 0xc0, 0xde]))).toBe(true)
    expect(looksLikeLtoArchive(ar([0x7f, 0x45, 0x4c, 0x46]))).toBe(false)
  })
  it('expands ~', () => {
    expect(expandHome('~/.dsh/kanalyzer', '/home/u')).toBe('/home/u/.dsh/kanalyzer')
  })
})

describe('bundled skills and selftest', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  it('every skill parses and is named after its directory', () => {
    for (const dir of readdirSync(`${root}skills`)) {
      const s = parseSkillFile(readFileSync(`${root}skills/${dir}/SKILL.md`, 'utf8'))
      expect(s?.name).toBe(dir)
      expect(s?.content.length).toBeGreaterThan(200)
    }
  })
  it('expect.json line numbers point at an instruction line and a comment line', () => {
    const expect_ = JSON.parse(readFileSync(`${root}selftest/expect.json`, 'utf8')) as { target: string; commentLine: string }
    const src = readFileSync(`${root}selftest/sample.c`, 'utf8')
    const lines = heuristicInstructionLines(src)
    expect(lines).toContain(Number(expect_.target.split(':')[1]))
    expect(lines).not.toContain(Number(expect_.commentLine.split(':')[1]))
    expect(src.split('\n')[Number(expect_.target.split(':')[1]) - 1]).toContain('int y = x * 2;')
  })
})

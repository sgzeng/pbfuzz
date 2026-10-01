/**
 * `probeRepo` (tools.ts): the deterministic repo scan behind `pbfuzz_probe` — build system,
 * existing harnesses, built binaries, seed corpora, oracle markers, each with `file:line` or path
 * evidence. Exercised against real temp directories, no LLM/mock involved (there is nothing to
 * mock: the whole point is that this is a plain filesystem walk).
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeRepo } from '../src/tools.ts'

function repo(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-probe-')))
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('probeRepo', () => {
  it("finds a project's own stderr reach/trigger markers, with the text the oracle has to match", () => {
    // The readelf target: plain `std::cerr` markers, no MAGMA/pbfuzz macro. The probe used to
    // report none, and in a clean workspace the model then chose to insert canaries into a target
    // that already reports both signals.
    const root = repo()
    write(root, 'readelf.cpp', [
      'void check() {',
      '    std::cerr << "bug location reached" << std::endl;',
      '    if (bad) {',
      '        std::cerr << "bug location triggered" << std::endl;',
      '        std::cerr << "Error: Cannot read ELF header" << std::endl;',
      '    }',
      '    printf("not reached on stdout\\n");',
      '}',
    ].join('\n'))
    write(root, 'tool.py', 'import sys\nprint("x reached", file=sys.stderr)\n')
    expect(probeRepo(root).oracleMarkers).toEqual([
      { kind: 'stderr_marker', evidence: 'readelf.cpp:2 "bug location reached"' },
      { kind: 'stderr_marker', evidence: 'readelf.cpp:4 "bug location triggered"' },
      { kind: 'stderr_marker', evidence: 'tool.py:2 "x reached"' },
    ])
  })

  it('detects a build system at the repo root', () => {
    const root = repo()
    write(root, 'CMakeLists.txt', 'project(x)\n')
    const result = probeRepo(root)
    expect(result.buildSystems).toContainEqual({ kind: 'cmake', evidence: 'CMakeLists.txt' })
  })

  it('finds an LLVMFuzzerTestOneInput harness with file:line evidence', () => {
    const root = repo()
    write(root, 'fuzz/target.cc', '#include <cstdint>\nint LLVMFuzzerTestOneInput(const uint8_t *d, size_t n) { return 0; }\n')
    const result = probeRepo(root)
    expect(result.harnesses).toContainEqual({ kind: 'LLVMFuzzerTestOneInput', evidence: 'fuzz/target.cc:2' })
    // The `fuzz/` directory itself is also reported as a marker.
    expect(result.harnesses).toContainEqual({ kind: 'fuzz_dir', evidence: 'fuzz' })
  })

  it('finds an atheris harness and a python setuptools build system', () => {
    const root = repo()
    write(root, 'setup.py', 'from setuptools import setup\nsetup(name="x")\n')
    write(root, 'fuzz_target.py', 'import atheris\n\ndef TestOneInput(data):\n    pass\n\natheris.Setup(sys.argv, TestOneInput)\n')
    const result = probeRepo(root)
    expect(result.buildSystems).toContainEqual({ kind: 'python-setuptools', evidence: 'setup.py' })
    expect(result.harnesses).toContainEqual({ kind: 'atheris.Setup', evidence: 'fuzz_target.py:6' })
  })

  it('reports seed corpora with a file count, only for directories that exist', () => {
    const root = repo()
    write(root, 'corpus/seed1', 'a')
    write(root, 'corpus/seed2', 'b')
    const result = probeRepo(root)
    expect(result.seedCorpora).toEqual([{ dir: 'corpus', fileCount: 2 }])
  })

  it('finds oracle markers (MAGMA_LOG-style canaries) with evidence', () => {
    const root = repo()
    write(root, 'src/oracle.c', 'void f() {\n  fprintf(stderr, "MAGMA_LOG: reached %s\\n", "t1");\n}\n')
    const result = probeRepo(root)
    expect(result.oracleMarkers).toContainEqual({ kind: 'MAGMA_LOG', evidence: 'src/oracle.c:2' })
  })

  it('detects a built ELF binary by magic number, and ignores files with an extension', () => {
    const root = repo()
    const elfBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(12)])
    writeFileSync(join(root, 'readelf'), elfBytes)
    writeFileSync(join(root, 'readelf.c'), 'int main(void) { return 0; }\n') // has a dot: not checked
    writeFileSync(join(root, 'notes.txt'), 'not an elf\n')
    const result = probeRepo(root)
    expect(result.binaries).toEqual([{ kind: 'elf', evidence: 'readelf' }])
  })

  it('skips .git, node_modules and other noise directories entirely', () => {
    const root = repo()
    write(root, '.git/config', '[core]\n')
    write(root, 'node_modules/pkg/Makefile', 'all:\n')
    write(root, 'Makefile', 'all:\n')
    const result = probeRepo(root)
    expect(result.buildSystems).toEqual([{ kind: 'make', evidence: 'Makefile' }])
  })

  it('a repo with nothing interesting returns empty arrays, never throws', () => {
    const root = repo()
    const result = probeRepo(root)
    expect(result).toEqual({ repo: root, buildSystems: [], harnesses: [], binaries: [], seedCorpora: [], oracleMarkers: [] })
  })

  it('a nonexistent repo path does not throw', () => {
    expect(() => probeRepo(join(tmpdir(), 'pbfuzz-probe-does-not-exist'))).not.toThrow()
  })
})

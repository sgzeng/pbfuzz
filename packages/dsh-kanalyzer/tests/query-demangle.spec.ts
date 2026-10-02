/**
 * Itanium demangling in `core/query.ts` — a model asks `callers`/`callees`/`critical` by
 * source-level name, but for a C++ target `function_info.txt` holds Itanium-mangled names.
 *
 * `_Z31check_dangerous_elf_combinationRK9ELFHeader` and its surrounding real func-info rows below
 * are a real KAMain capture (`~/.dsh/kanalyzer/cache/123de83f4ca6954d164d8e0b3c0a6b6483bfebb55843731a24e365d3887b5dd1/`
 * on this box), from analysing `examples/readelf-c/readelf.cpp` — the exact case a live session
 * (session-58aed623/…) had to work around by hand-pasting the mangled name before
 * `pbfuzz_callgraph` returned anything for `check_dangerous_elf_combination`. `calleeCaller`'s
 * `11750070784893269751,15822663052811949562` row is the matching real `callee-caller.txt` line
 * (`check_dangerous_elf_combination`'s only caller is `main`).
 */
import { describe, expect, it } from 'vitest'
import { parseFuncInfo, parseGuidEdges } from '../src/core/dumps.ts'
import { blockIndex } from '../src/core/status.ts'
import { demangleItanium, runQuery, type QueryData } from '../src/core/query.ts'

describe('demangleItanium()', () => {
  it('recovers a plain unscoped C++ function name (the real readelf.cpp capture)', () => {
    expect(demangleItanium('_Z31check_dangerous_elf_combinationRK9ELFHeader')).toBe('check_dangerous_elf_combination')
  })

  it('joins a nested (namespaced/class-scoped) name with ::', () => {
    expect(demangleItanium('_ZN3Foo3barEv')).toBe('Foo::bar')
    expect(demangleItanium('_ZN2ns3Foo3barEv')).toBe('ns::Foo::bar')
  })

  it('skips cv-/ref-qualifiers on a nested name', () => {
    expect(demangleItanium('_ZNK3Foo3barEv')).toBe('Foo::bar')
  })

  it('strips a template-argument block, unscoped and per nested component', () => {
    expect(demangleItanium('_Z3fooIiEvi')).toBe('foo')
    expect(demangleItanium('_ZN3FooIiE3barEv')).toBe('Foo::bar')
  })

  it('never throws, and bails to undefined, on the documented gaps', () => {
    // Substitution-compressed std:: names — both real rows from the same readelf.cpp capture.
    expect(demangleItanium('_ZSt3hexRSt8ios_base')).toBeUndefined()
    expect(demangleItanium('_ZNSt8ios_base4setfESt13_Ios_FmtflagsS0_')).toBeUndefined()
    // Constructor/destructor special members.
    expect(demangleItanium('_ZN3FooC1Ev')).toBeUndefined()
    expect(demangleItanium('_ZN3FooD0Ev')).toBeUndefined()
    // Operator overloads.
    expect(demangleItanium('_ZN3FooplERKS_')).toBeUndefined()
    // Malformed / truncated input.
    expect(demangleItanium('')).toBeUndefined()
    expect(demangleItanium('_Z')).toBeUndefined()
    expect(demangleItanium('_ZN3Foo')).toBeUndefined() // unterminated nested-name
    expect(demangleItanium('_Z99tooShort')).toBeUndefined() // length exceeds the string
    // Not mangled at all: a plain C name.
    expect(demangleItanium('not mangled at all')).toBeUndefined()
    expect(demangleItanium('main')).toBeUndefined()
  })
})

describe('runQuery() matches a C++ target by source-level name (real readelf.cpp capture)', () => {
  // func-info rows exactly as KAMain wrote them for examples/readelf-c/readelf.cpp.
  const FUNC_INFO = [
    '11750070784893269751,_Z31check_dangerous_elf_combinationRK9ELFHeader,/mnt/work/pbfuzz/pbfuzz-dsh/examples/readelf-c/readelf.cpp,75,99',
    '15822663052811949562,main,/mnt/work/pbfuzz/pbfuzz-dsh/examples/readelf-c/readelf.cpp,101,148',
  ].join('\n')
  // callee-caller.txt: check_dangerous_elf_combination's only caller is main.
  const CALLEE_CALLER = '11750070784893269751,15822663052811949562\n'
  // bid_loc_mapping.txt row `1029,641239159,11750070784893269751,…/readelf.cpp:93` and the
  // matching critical_BBs.txt row `1029,1030` — one real critical block inside the function.
  const CRITICAL = new Map([[1029, [1030]]])

  const funcInfo = parseFuncInfo(FUNC_INFO)
  const bidMapping = [{ bid: 1029, bbHash: '641239159', funcGuid: '11750070784893269751', file: '/mnt/work/pbfuzz/pbfuzz-dsh/examples/readelf-c/readelf.cpp', line: 93 }]
  const data: QueryData = {
    funcInfo,
    callerCallee: new Map(),
    calleeCaller: parseGuidEdges(CALLEE_CALLER),
    bidMapping,
    critical: CRITICAL,
    blocks: blockIndex(bidMapping, funcInfo),
  }

  it('resolves callers() by the plain source name, not just the mangled one', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: 'check_dangerous_elf_combination' }, data).results).toEqual(['main'])
  })

  it('still resolves callers() by the exact mangled name — the old path stays byte-identical', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: '_Z31check_dangerous_elf_combinationRK9ELFHeader' }, data).results).toEqual(['main'])
  })

  it('tolerates a trailing parameter list, as a model might paste one', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: 'check_dangerous_elf_combination(const ELFHeader&)' }, data).results).toEqual(['main'])
  })

  it('resolves critical() by the plain source name too', () => {
    expect(runQuery({ op: 'critical', bitcode: 'b', fn: 'check_dangerous_elf_combination' }, data).results)
      .toEqual(['/mnt/work/pbfuzz/pbfuzz-dsh/examples/readelf-c/readelf.cpp:93'])
  })

  it('does not match an unrelated source name (no accidental over-matching)', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: 'not_a_real_function' }, data).results).toEqual([])
  })
})

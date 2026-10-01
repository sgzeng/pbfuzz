/**
 * Pure helpers for locating an installed KAMain and the LLVM it was built against.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/install
 */

/** LLVM majors KAMain builds against, in detection preference order (14 is verified; ≥17 removed APIs it uses). */
export const SUPPORTED_LLVM_MAJORS = [14, 15, 16, 13, 12, 11, 10] as const

/** @returns candidate LLVM prefixes: the configured one first, then the Debian/Ubuntu layout. */
export function candidateLlvmPrefixes(configured: string): string[] {
  const out = configured.trim().length > 0 ? [configured.trim().replace(/\/$/, '')] : []
  for (const m of SUPPORTED_LLVM_MAJORS) out.push(`/usr/lib/llvm-${String(m)}`)
  return [...new Set(out)]
}

/**
 * The LLVM prefix a KAMain build was configured with, from `build/CMakeCache.txt`
 * (`LLVM_DIR:PATH=/usr/lib/llvm-14/lib/cmake/llvm`, or Debian/Ubuntu's `/usr/lib/llvm-14/cmake`).
 * This is the truth about the linked LLVM; a settings value may have changed since the build.
 * @param cmakeCache - file contents.
 * @returns the prefix, or undefined.
 */
export function llvmPrefixFromCMakeCache(cmakeCache: string): string | undefined {
  const m = /^LLVM_DIR:[A-Z]+=(.+?)(?:\/lib(?:64)?\/cmake\/llvm|\/cmake)\/?\s*$/m.exec(cmakeCache)
  return m?.[1]
}

/** @returns the major of an `llvm-config --version` string such as `14.0.6`, or undefined. */
export function llvmMajor(version: string): number | undefined {
  const m = /^(\d+)\./.exec(version.trim())
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** @returns whether a major is one KAMain supports. */
export function isSupportedMajor(major: number | undefined): boolean {
  return major !== undefined && major >= 10 && major <= 16
}

/**
 * Whether a static archive contains LLVM bitcode members (an LTO archive).
 * Bitcode members start with the wrapper magic `BC\xC0\xDE`; native members are ELF.
 * @param head - the first bytes of the archive (a few MB suffice for typical archives).
 * @returns true when at least one bitcode member is visible and no ELF member is.
 */
export function looksLikeLtoArchive(head: Uint8Array): boolean {
  let bitcode = false
  let elf = false
  for (let i = 0; i + 4 <= head.length; i++) {
    if (head[i] === 0x42 && head[i + 1] === 0x43 && head[i + 2] === 0xc0 && head[i + 3] === 0xde) bitcode = true
    if (head[i] === 0x7f && head[i + 1] === 0x45 && head[i + 2] === 0x4c && head[i + 3] === 0x46) elf = true
  }
  return bitcode && !elf
}

/** Expand a leading `~` against a home directory. */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

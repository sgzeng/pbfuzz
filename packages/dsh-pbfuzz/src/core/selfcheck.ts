/**
 * The environment self-check: is the Python engine sidecar reachable and healthy?
 *
 * This is the whole of pbfuzz's self-checking now. It has ZERO campaign dependency — no target
 * build, no oracle run, no tracer probe, no static-analysis selftest — so the settings card's
 * Self-check button (`/pbfuzz selfcheck`) can run it with no campaign at all, and `env-selfcheck.ts`
 * can cache it under `settings.status.envSelfcheck` with a TTL.
 *
 * A campaign-scoped self-check used to run alongside it, re-verifying the oracle, the tracer, the
 * corpus and the analysis provider against the target before the campaign could leave INIT. It was
 * removed: it duplicated the settings card's button, cost ~18s serially on every campaign start
 * (dominated by an uncached kanalyzer `doctor()` that rebuilds and re-analyses its own sample), and
 * every check it performed happens anyway at the moment it actually matters — `pbfuzz_campaign
 * draft` builds the target and runs it on a trivial input, `pbfuzz_fuzz`'s own generator/preflight
 * validation exercises the oracle and the breakpoints for real, and the analysis provider prepares
 * itself lazily on its first query.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/selfcheck
 */

import type { Remedy, SelfcheckItem } from './contracts.ts'
import { MANUAL, RETRY } from './remedies.ts'

/** The contracts version this plugin speaks; the engine must report the same. */
export const CONTRACTS_VERSION = '1'

/** Engine-side check result, as the `selfcheck.engine` RPC method returns it. */
export interface EngineCheckResult {
  ok: boolean
  status?: 'pass' | 'warn' | 'fail'
  evidence: string[]
  reason?: string
  remedies?: Remedy[]
}

/** The two real-invocation ports the environment check drives. */
export interface SelfcheckPorts {
  /** `ping` → `{engineVersion, contractsVersion, python}`. */
  ping(): Promise<{ engineVersion: string; contractsVersion: string; python: string }>
  /** `selfcheck.engine {contractsVersion}` — interpreter, contract schemas, generator-sandbox round trip. */
  engine(contractsVersion: string): Promise<EngineCheckResult>
}

/**
 * Run the environment self-check: whether the engine sidecar is reachable and its own real
 * self-test passes (interpreter version, readable contracts, a generator-sandbox round trip).
 * @param ports - the two engine ports.
 * @param now - clock, injected for tests.
 * @returns the `engine` self-check item.
 */
export async function runEnvSelfcheck(ports: Pick<SelfcheckPorts, 'ping' | 'engine'>, now: () => number): Promise<SelfcheckItem> {
  const start = now()
  let result: Omit<SelfcheckItem, 'name' | 'duration_ms'>
  try {
    const ping = await ports.ping()
    const evidence = [`ping → engine ${ping.engineVersion}, contracts ${ping.contractsVersion}, ${ping.python}`]
    if (ping.contractsVersion !== CONTRACTS_VERSION) {
      result = {
        status: 'fail', evidence,
        reason: `engine speaks contracts v${ping.contractsVersion}, plugin speaks v${CONTRACTS_VERSION}; refusing a silent schema skew`,
        remedies: [{ id: 'reinstall_engine', label: 'Reinstall the engine from this repo (pip install -e engine)', effect: 'run_command' }, MANUAL],
      }
    } else {
      // The engine's own check: interpreter version, readable contracts, a real sandbox round trip.
      const check = await ports.engine(CONTRACTS_VERSION)
      const status = check.status ?? (check.ok ? 'pass' : 'fail')
      result = {
        status,
        evidence: [...evidence, ...check.evidence],
        ...check.reason !== undefined ? { reason: check.reason } : {},
        ...status === 'fail' ? { remedies: check.remedies !== undefined && check.remedies.length > 0 ? check.remedies : [RETRY, MANUAL] } : {},
      }
    }
  } catch (error) {
    const e = error as { message?: string; diagnosis?: string; remedies?: Remedy[] }
    result = {
      status: 'fail',
      evidence: [`invocation threw: ${e.message ?? String(error)}`],
      reason: e.diagnosis ?? e.message ?? String(error),
      remedies: e.remedies !== undefined && e.remedies.length > 0 ? e.remedies : [RETRY, MANUAL],
    }
  }
  return { name: 'engine', ...result, duration_ms: Math.max(0, Math.round(now() - start)) }
}

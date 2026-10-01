/**
 * The auxiliary-analysis provider registry (`contracts/analysis-provider.ts`).
 *
 * pbfuzz ships NO static analyzer. This registry is the indirection that decouples it from
 * C/C++: the kanalyzer adapter registers here from inside `ctx.inject(['kanalyzer'], …)`, so it
 * disappears with the plugin, and adding CodeQL or Joern later for Python/Java means writing
 * another adapter and nothing else.
 *
 * Registration returns a disposer rather than mutating a global, because the registering fiber —
 * not this module — owns the lifetime.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/registry
 */

import type { AnalysisProvider, AnalysisProviderRegistry, ProviderCapabilities } from './contracts.ts'

/**
 * Process-local provider registry. Registration order decides the active provider: the first
 * registered provider stays active while it is registered, so a second backend loading later
 * cannot silently take over a running campaign.
 */
export class ProviderRegistry implements AnalysisProviderRegistry {
  private readonly providers: AnalysisProvider[] = []
  private readonly listeners = new Set<() => void>()

  /**
   * Register one provider for the lifetime of the caller's fiber.
   * @param provider - the analysis backend.
   * @returns a disposer that unregisters it and notifies watchers.
   */
  register(provider: AnalysisProvider): { dispose(): void } {
    this.providers.push(provider)
    this.notify()
    let disposed = false
    return {
      dispose: (): void => {
        if (disposed) return
        disposed = true
        const index = this.providers.indexOf(provider)
        if (index >= 0) this.providers.splice(index, 1)
        this.notify()
      },
    }
  }

  /** The active provider, or undefined when no backend is installed. */
  active(): AnalysisProvider | undefined {
    return this.providers[0]
  }

  /** Capabilities of every registered provider, in registration order. */
  list(): ProviderCapabilities[] {
    return this.providers.map(provider => provider.describe())
  }

  /**
   * Observe registration changes. Tool visibility depends on whether a provider is present, so
   * the host half must re-derive its `restrict()` set when kanalyzer loads or unloads.
   * @param listener - invoked after every registration change.
   * @returns a disposer removing the listener.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify watchers, containing a throwing listener so one bad watcher cannot break teardown. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A visibility recomputation that throws must not prevent the provider from unloading.
      }
    }
  }
}

/**
 * Whether a provider can serve a campaign's language. A C-only backend registered while the
 * target is Python must not be treated as available — that is the mistake that made the old
 * PBFuzz C-specific in the first place.
 * @param capabilities - the provider's declared capabilities.
 * @param language - the campaign's `target.language`, when known.
 * @returns whether the provider applies.
 */
export function providerAppliesTo(capabilities: ProviderCapabilities, language: string | undefined): boolean {
  if (language === undefined) return true
  return (capabilities.languages as readonly string[]).includes(language)
}

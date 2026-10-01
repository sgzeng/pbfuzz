/**
 * The dashboard's read side: the `pbfuzz` session projection, decoded.
 *
 * The live value arrives through the session standard kit's `useProjection`
 * (seeded by the history tail page, updated by session/projection frames), so
 * this plugin owns no store, no subscription and no settings namespace.
 */

import { decodeDashboard, type PbfuzzDashboardView } from './dashboard-contract.ts'

/**
 * Decode a raw projection value into the view the popover renders.
 * @param value - `useProjection('pbfuzz')`: undefined before the host serves the key,
 *   null before any pbfuzz tool reported, else the view.
 * @returns the view, or undefined when there is no campaign to show.
 */
export function selectDashboardView(value: unknown): PbfuzzDashboardView | undefined {
  const view = decodeDashboard(value)
  return view !== undefined && view.campaignId !== '' ? view : undefined
}

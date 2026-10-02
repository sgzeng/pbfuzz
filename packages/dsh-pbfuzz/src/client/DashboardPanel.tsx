/**
 * The pbfuzz dashboard: a session-header utility with a popover. Live state comes
 * from `useProjection('pbfuzz')`, so it is per-session and follows replay.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutlineRegular, StateDot, Tag, useDismissOnOutsidePointer, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the session-header utilities slot and the Session standard kit (useProjection).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { selectDashboardView } from './dashboard.ts'
import { PBFUZZ_PROJECTION_KEY, type PbfuzzDashboardView, type PierPhase } from './dashboard-contract.ts'
import type { PbfuzzT } from './locales.ts'

/** Props the renderer binds for the dashboard: the session standard kit plus the locale seat. */
export type PbfuzzDashboardProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'pbfuzz'>

const PHASE_DOT: Record<PierPhase, StateDotState> = {
  '': 'idle', INIT: 'ongoing', PLAN: 'ongoing', IMPLEMENT: 'ongoing', EXECUTE: 'ongoing', REFLECT: 'ongoing',
  SUCCESS: 'done', STOPPED: 'warning',
}

const CHECK: Record<string, { dot: StateDotState; tone: TagTone }> = {
  pass: { dot: 'done', tone: 'success' },
  warn: { dot: 'warning', tone: 'warning' },
  fail: { dot: 'error', tone: 'danger' },
  disabled: { dot: 'idle', tone: 'quiet' },
  skipped: { dot: 'idle', tone: 'quiet' },
}

/** Round shown to the user: the one in progress (completed + 1), capped at the budget. */
function displayRound(view: PbfuzzDashboardView): number {
  const inProgress = view.phase === 'SUCCESS' || view.phase === 'STOPPED' ? view.pierRound : view.pierRound + 1
  return view.maxPierRounds > 0 ? Math.min(inProgress, view.maxPierRounds) : inProgress
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="pbfuzz-dash-section">
      <h4 className="pbfuzz-dash-h">{props.title}</h4>
      {props.children}
    </section>
  )
}

function Body({ view, t }: { view: PbfuzzDashboardView; t: PbfuzzT }) {
  const h = view.hypothesis
  const m = view.metrics
  return (
    <>
      <div className="pbfuzz-dash-status">
        <Tag tone={view.phase === 'SUCCESS' ? 'success' : view.phase === 'STOPPED' ? 'warning' : 'info'}>{view.phase}</Tag>
        <span>{t('dash.round', { round: displayRound(view), max: view.maxPierRounds })}</span>
        <code className="pbfuzz-mono">{view.campaignId}</code>
      </div>
      {view.status !== '' ? <p className="pbfuzz-dash-line">{view.status}</p> : null}
      {view.nextAction !== '' ? <p className="pbfuzz-muted">{t('dash.next', { action: view.nextAction })}</p> : null}
      {view.phase === 'STOPPED' && view.stopReason !== '' ? <p className="pbfuzz-notice">{t('dash.stopReason', { reason: view.stopReason })}</p> : null}

      {view.poc !== null
        ? (
          <Section title={t('dash.poc')}>
            <dl className="pbfuzz-kv">
              {view.poc.input_path !== undefined ? <><dt>{t('dash.pocInput')}</dt><dd><code className="pbfuzz-mono">{view.poc.input_path}</code></dd></> : null}
              {view.poc.run_cmd !== undefined ? <><dt>{t('dash.pocRun')}</dt><dd><code className="pbfuzz-mono">{view.poc.run_cmd}</code></dd></> : null}
            </dl>
            {view.poc.reproduced_times !== undefined ? <Tag tone="success">{t('dash.pocReproduced', { count: view.poc.reproduced_times })}</Tag> : null}
          </Section>
        )
        : null}

      <Section title={t('dash.targets')}>
        {view.targets.length === 0
          ? <p className="pbfuzz-muted">{t('dash.noTargets')}</p>
          : (
            <ul className="pbfuzz-list">
              {view.targets.map(target => (
                <li key={`${target.file}:${target.line}`}>
                  <code className="pbfuzz-mono">{target.file}:{target.line}</code>
                  {target.function !== undefined ? <span className="pbfuzz-muted"> {target.function}()</span> : null}
                </li>
              ))}
            </ul>
          )}
      </Section>

      {h !== null
        ? (
          <Section title={t('dash.hypothesis')}>
            <dl className="pbfuzz-kv">
              <dt>{t('dash.bugPredicates')}</dt><dd>{h.bugPredicates}</dd>
              <dt>{t('dash.preconditions')}</dt>
              <dd>
                {h.preconditions.verified} {t('dash.pre.verified')} · {h.preconditions.violated} {t('dash.pre.violated')} · {h.preconditions.unknown} {t('dash.pre.unknown')} · {h.preconditions.impossible} {t('dash.pre.impossible')}
              </dd>
              <dt>{t('dash.rootCauses')}</dt><dd>{h.rootCauses}</dd>
              <dt>{t('dash.triggerPlans')}</dt>
              <dd>
                {h.triggerPlans.pending} {t('dash.plan.pending')} · {h.triggerPlans.inProgress} {t('dash.plan.inProgress')} · {h.triggerPlans.completed} {t('dash.plan.completed')} · {h.triggerPlans.failed} {t('dash.plan.failed')}
              </dd>
              {h.currentPlan !== undefined
                ? <><dt>{t('dash.currentPlan')}</dt><dd><code className="pbfuzz-mono">{h.currentPlan.id}</code> ({h.currentPlan.complexity}/10, {h.currentPlan.status}) {h.currentPlan.description}</dd></>
                : null}
            </dl>
          </Section>
        )
        : null}

      <Section title={t('dash.metrics')}>
        {m === null
          ? <p className="pbfuzz-muted">{t('dash.noMetrics')}</p>
          : (
            <>
              <div className="pbfuzz-metrics">
                <div><b>{m.total_iterations}</b><span>{t('dash.m.iterations')}</span></div>
                <div><b>{m.total_reached_count}</b><span>{t('dash.m.reached')}</span></div>
                <div><b>{m.last_reached_count ?? 0}</b><span>{t('dash.m.lastReached')}</span></div>
                <div><b>{m.triggered_count}</b><span>{t('dash.m.triggered')}</span></div>
                <div><b>{m.timeout_count ?? 0}</b><span>{t('dash.m.timeouts')}</span></div>
                <div><b>{m.error_count ?? 0}</b><span>{t('dash.m.errors')}</span></div>
              </div>
              {m.last_session !== undefined
                ? (
                  <p className="pbfuzz-muted">
                    {t('dash.m.lastSession', {
                      iterations: m.last_session.iterations ?? 0,
                      reached: m.last_session.reached ?? 0,
                      elapsed: Math.round(m.last_session.elapsed_sec ?? 0),
                      stoppedBy: m.last_session.stopped_by ?? '-',
                    })}
                  </p>
                )
                : null}
            </>
          )}
      </Section>

      <Section title={t('dash.denials')}>
        {view.denials.length === 0
          ? <p className="pbfuzz-muted">{t('dash.noDenials')}</p>
          : (
            <ul className="pbfuzz-list">
              {view.denials.map((denial, index) => (
                <li key={`${denial.at}-${index}`}>
                  <Tag tone="danger">{denial.hook}</Tag>
                  {denial.tool !== undefined ? <code className="pbfuzz-mono"> {denial.tool}</code> : null}
                  <span> {denial.reason}</span>
                </li>
              ))}
            </ul>
          )}
      </Section>
      {view.updatedAt !== '' ? <p className="pbfuzz-muted pbfuzz-dash-foot">{t('dash.updated', { at: view.updatedAt })}</p> : null}
    </>
  )
}

/**
 * Render the header trigger and, when open, the popover. Renders nothing in a
 * session with no pbfuzz campaign.
 * @param props - session standard kit (useProjection) and locale seat.
 * @returns the header utility.
 */
export function PbfuzzDashboardPanel(props: PbfuzzDashboardProps) {
  const t = props.t as unknown as PbfuzzT
  // The raw projection value is a stable reference between frames; decode once per value.
  const raw: unknown = props.useProjection(PBFUZZ_PROJECTION_KEY)
  const view = useMemo(() => selectDashboardView(raw), [raw])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ right: number; top: number }>()

  // The header clips overflow, so the popover is fixed-positioned below the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect !== undefined) setAnchor({ right: Math.max(12, window.innerWidth - rect.right), top: rect.bottom + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])
  useDismissOnOutsidePointer(rootRef, open, setOpen)

  if (view === undefined) return null
  const summary = `${view.phase} ${displayRound(view)}/${view.maxPierRounds}`
  return (
    <div ref={rootRef} className="pbfuzz-dash-root">
      <button
        type="button"
        className="pbfuzz-dash-trigger"
        aria-expanded={open}
        aria-label={`${t('dash.trigger')} ${summary}`}
        title={`${t('dash.trigger')} ${summary}`}
        onClick={() => { setOpen(!open) }}
      >
        <StateDot state={PHASE_DOT[view.phase]} />
        <span>{t('dash.trigger')}</span>
        <span className="pbfuzz-muted">{summary}</span>
      </button>
      {open
        ? (
          <div
            className="pbfuzz-dash-popover"
            role="dialog"
            aria-label={t('dash.title')}
            style={anchor !== undefined ? { right: anchor.right, top: anchor.top } : undefined}
          >
            <div className="pbfuzz-dash-header">
              <strong>{t('dash.title')}</strong>
              <button type="button" className="pbfuzz-icon-btn" aria-label={t('dash.close')} onClick={() => { setOpen(false) }}>
                <IconCloseOutlineRegular size={16} />
              </button>
            </div>
            <div className="pbfuzz-dash-scroll">
              <Body view={view} t={t} />
            </div>
          </div>
        )
        : null}
    </div>
  )
}

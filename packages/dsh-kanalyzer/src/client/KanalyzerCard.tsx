/**
 * The kanalyzer settings card. It renders the `kanalyzer` namespace from
 * `contracts/kanalyzer-settings.schema.json` and owns its own chrome: a bundle
 * outside the DSH repo cannot value-import the Plugins section's card shell.
 *
 * DSH ships no select, textarea or path picker, so enums are a `Menu` anchored on
 * a `Button`, and string lists are rows of `Input`s with add/remove buttons.
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, Menu, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ActionState, FieldState, KanalyzerCardFace, KanalyzerCardState } from './controller.ts'
import { DEFAULT_FIELDS, DUMP_FIELDS, INSTALL_FIELDS, STANDALONE_FIELDS, type DraftValue, type FieldSpec } from './fields.ts'
import type { KanalyzerLocaleKey } from './locales.ts'

/** Props the renderer binds for this card. */
export type KanalyzerCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.kanalyzer'>
  & InjectFace<KanalyzerCardFace>

type T = (key: KanalyzerLocaleKey) => string

interface ControlProps {
  t: T
  field: FieldSpec
  state: FieldState
  disabled: boolean
  onEdit: (value: DraftValue) => void
  onReset: () => void
}

function key(k: string): KanalyzerLocaleKey {
  return k as KanalyzerLocaleKey
}

/** Label row with the override badge and reset. */
function FieldHead({ t, field, state, disabled, onReset, children }: ControlProps & { children?: ReactNode }) {
  return (
    <div className="kz-field-row">
      <label className="kz-label" htmlFor={`kz-${field.id}`}>{t(key(field.id))}</label>
      {state.overridden
        ? (
          <>
            <Tag tone="neutral">{t('overridden')}</Tag>
            <button type="button" className="kz-reset" disabled={disabled} onClick={onReset}>{t('reset')}</button>
          </>
        )
        : null}
      {children}
    </div>
  )
}

function Hint({ t, field, state }: { t: T; field: FieldSpec; state: FieldState }) {
  if (state.invalid) return <p className="kz-hint" data-invalid="true">{t('invalid')}</p>
  const hintKey = `${field.id}.hint`
  const text = t(key(hintKey))
  // The locale service echoes an unknown key; dump toggles have no hint.
  return text === hintKey ? null : <p className="kz-hint">{text}</p>
}

function TextControl(props: ControlProps) {
  const { field, state, disabled, onEdit, t } = props
  const placeholderKey = `${field.id}.placeholder`
  const placeholder = t(key(placeholderKey))
  return (
    <div className="kz-field">
      <FieldHead {...props} />
      <Input
        id={`kz-${field.id}`}
        className={state.invalid ? 'kz-input-invalid' : undefined}
        value={typeof state.value === 'string' ? state.value : ''}
        inputMode={field.kind === 'integer' ? 'numeric' : undefined}
        placeholder={placeholder === placeholderKey ? '' : placeholder}
        aria-invalid={state.invalid || undefined}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => { onEdit(event.target.value) }}
      />
      <Hint t={t} field={field} state={state} />
    </div>
  )
}

function BooleanControl(props: ControlProps) {
  const { field, state, disabled, onEdit, t } = props
  return (
    <div className="kz-field">
      <FieldHead {...props}>
        <Switch
          checked={state.value === true}
          label={t(key(field.id))}
          disabled={disabled}
          onChange={(next) => { onEdit(next) }}
        />
      </FieldHead>
      <Hint t={t} field={field} state={state} />
    </div>
  )
}

function EnumControl(props: ControlProps) {
  const { field, state, disabled, onEdit, t } = props
  const [open, setOpen] = useState(false)
  const current = typeof state.value === 'string' ? state.value : ''
  return (
    <div className="kz-field">
      <FieldHead {...props}>
        <Menu
          open={open}
          portal
          align="end"
          selectedId={current}
          items={(field.options ?? []).map(option => ({ id: option, label: option }))}
          onSelect={(id) => {
            setOpen(false)
            onEdit(id)
          }}
          onClose={() => { setOpen(false) }}
          anchor={(
            <Button
              id={`kz-${field.id}`}
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
            >
              {current === '' ? t('choose') : current}
            </Button>
          )}
        />
      </FieldHead>
      <Hint t={t} field={field} state={state} />
    </div>
  )
}

function ListControl(props: ControlProps) {
  const { field, state, disabled, onEdit, t } = props
  const items = Array.isArray(state.value) ? state.value : []
  const [draft, setDraft] = useState('')
  const add = () => {
    if (draft.trim() === '') return
    onEdit([...items, draft.trim()])
    setDraft('')
  }
  return (
    <div className="kz-field">
      <FieldHead {...props} />
      <div className="kz-list">
        {items.length === 0 ? <span className="kz-empty">{t('listEmpty')}</span> : null}
        {items.map((item, index) => (
          <div className="kz-list-row" key={index}>
            <Input
              value={item}
              disabled={disabled}
              spellCheck={false}
              aria-label={`${t(key(field.id))} ${String(index + 1)}`}
              onChange={(event) => {
                const next = [...items]
                next[index] = event.target.value
                onEdit(next)
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => { onEdit(items.filter((_, i) => i !== index)) }}
            >
              {t('listRemove')}
            </Button>
          </div>
        ))}
        <div className="kz-list-row">
          <Input
            id={`kz-${field.id}`}
            value={draft}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') add() }}
          />
          <Button size="sm" variant="outline" disabled={disabled || draft.trim() === ''} onClick={add}>
            {t('listAdd')}
          </Button>
        </div>
      </div>
      <Hint t={t} field={field} state={state} />
    </div>
  )
}

function Control(props: ControlProps) {
  switch (props.field.kind) {
    case 'boolean': return <BooleanControl {...props} />
    case 'enum': return <EnumControl {...props} />
    case 'list': return <ListControl {...props} />
    case 'text':
    case 'integer': return <TextControl {...props} />
  }
}

function Group({ title, hint, manual, children }: {
  title: string
  hint: string
  manual?: boolean
  children: ReactNode
}) {
  return (
    <section className="kz-group" data-manual={manual === true ? 'true' : undefined}>
      <h3 className="kz-group-title">{title}</h3>
      <p className="kz-group-hint">{hint}</p>
      {children}
    </section>
  )
}

/** One button's honest progress line. */
function ActionResult({ t, state, onOpen }: { t: T; state: ActionState; onOpen: (id: string) => void }) {
  if (state.phase === 'idle') return null
  const detail = state.phase !== 'pending' ? state.detail : undefined
  return (
    <p className="kz-result" data-phase={state.phase} role="status" aria-live="polite">
      <Tag tone={state.phase === 'pending' ? 'info' : state.phase === 'success' ? 'success' : 'danger'}>
        {t(state.messageKey)}
      </Tag>
      {detail !== undefined && detail !== '' ? <span className="kz-detail">{detail}</span> : null}
      {state.sessionId !== undefined
        ? (
          <Button size="sm" variant="ghost" onClick={() => { onOpen(state.sessionId as string) }}>
            {t('openSession')}
          </Button>
        )
        : null}
    </p>
  )
}

function StatusGroup({ t, state, onInstallDeps }: { t: T; state: KanalyzerCardState; onInstallDeps: () => void }) {
  const s = state.status
  const none = t('statusNone')
  const doctor = s.lastDoctor === 'pass' ? t('doctorPass') : s.lastDoctor === 'fail' ? t('doctorFail') : t('doctorNever')
  const wllvm = s.lastWllvm === 'pass' ? t('wllvmPass') : s.lastWllvm === 'fail' ? t('wllvmFail') : t('wllvmNever')
  const canInstallWllvm = s.lastWllvm === 'fail' || s.lastWllvm === ''
  return (
    <Group title={t('groupStatus')} hint={t('groupStatusHint')}>
      {!s.installed ? <p className="kz-note" data-tone="warn" role="status">{t('binaryMissing')}</p> : null}
      <dl className="kz-status">
        <dt>{t('statusInstalled')}</dt>
        <dd>{s.installed ? t('statusYes') : t('statusNo')}</dd>
        <dt>{t('statusBinary')}</dt>
        <dd>{s.binaryPath || none}</dd>
        <dt>{t('statusCommit')}</dt>
        <dd>{s.commit || none}</dd>
        <dt>{t('statusLlvm')}</dt>
        <dd>{s.llvmVersion || none}</dd>
        <dt>{t('statusDoctor')}</dt>
        <dd>
          {doctor}
          {s.lastDoctorAt ? ` · ${s.lastDoctorAt}` : ''}
          {s.lastDoctorMessage ? ` · ${s.lastDoctorMessage}` : ''}
        </dd>
        <dt>{t('statusWllvm')}</dt>
        <dd>
          {wllvm}
          {s.lastWllvmAt ? ` · ${s.lastWllvmAt}` : ''}
          {s.lastWllvmMessage ? ` · ${s.lastWllvmMessage}` : ''}
          {canInstallWllvm
            ? (
              <Button
                size="sm"
                variant="outline"
                title={t('installWllvmHint')}
                disabled={state.installDeps.phase === 'pending'}
                onClick={onInstallDeps}
              >
                {t('installWllvm')}
              </Button>
            )
            : null}
        </dd>
      </dl>
    </Group>
  )
}

/**
 * Render the kanalyzer card.
 * @param props - locale copy, the card snapshot hook and the card actions.
 * @returns the card, or nothing while the namespace is not served.
 */
export function KanalyzerCard(props: KanalyzerCardProps) {
  const t = props.t as T
  const state = props.useKanalyzerCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const control = (field: FieldSpec) => (
    <Control
      key={field.id}
      t={t}
      field={field}
      state={state.fields[field.id] as FieldState}
      disabled={disabled}
      onEdit={(value) => { props.edit(field.id, value) }}
      onReset={() => { props.resetField(field.id) }}
    />
  )
  const nonDump = DEFAULT_FIELDS.filter(field => !DUMP_FIELDS.includes(field))
  const busy = state.build.phase === 'pending' || state.doctor.phase === 'pending' || state.installDeps.phase === 'pending'
  return (
    <li className="kz-card" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="kz-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="kz-headtext">
          <span className="kz-name">{t('title')}</span>
          <span className="kz-desc">{t('description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral">{t('unsaved')}</Tag> : null}
        <Tag tone={state.status.installed ? 'success' : 'warning'}>
          {state.status.installed ? t('tagInstalled') : t('tagNotBuilt')}
        </Tag>
      </button>
      {open
        ? (
          <div className="kz-body">
            <p className="kz-note">{t('pbfuzzNote')}</p>
            {!state.writable ? <p className="kz-note" role="status">{t('readOnly')}</p> : null}

            <StatusGroup t={t} state={state} onInstallDeps={props.installDeps} />

            <div className="kz-actions">
              <div className="kz-action">
                <Button
                  variant="primary"
                  size="sm"
                  title={t('buildHint')}
                  disabled={state.build.phase === 'pending' || state.dirty}
                  onClick={props.build}
                >
                  {state.status.installed ? t('rebuild') : t('build')}
                </Button>
              </div>
              <div className="kz-action">
                <Button
                  variant="outline"
                  size="sm"
                  title={t('selfTestHint')}
                  disabled={state.doctor.phase === 'pending'}
                  onClick={props.doctor}
                >
                  {t('selfTest')}
                </Button>
              </div>
              <Button variant="ghost" size="sm" disabled={state.refreshing} onClick={props.refresh}>
                {state.refreshing ? t('refreshing') : t('refresh')}
              </Button>
            </div>
            <p className="kz-hint">{t('buildHint')}</p>
            <ActionResult t={t} state={state.build} onOpen={props.openSession} />
            {state.buildCwdFallback && state.build.phase !== 'idle' ? <p className="kz-hint">{t('cwdFallback')}</p> : null}
            <ActionResult t={t} state={state.doctor} onOpen={props.openSession} />
            <ActionResult t={t} state={state.installDeps} onOpen={props.openSession} />
            {state.refreshFailed && !busy ? <p className="kz-hint" data-invalid="true">{t('refreshFailed')}</p> : null}

            <Group title={t('groupInstall')} hint={t('groupInstallHint')}>
              {INSTALL_FIELDS.map(control)}
            </Group>
            <Group title={t('groupDefaults')} hint={t('groupDefaultsHint')}>
              {nonDump.map(control)}
            </Group>
            <Group title={t('groupDumps')} hint={t('groupDumpsHint')}>
              {DUMP_FIELDS.map(control)}
            </Group>
            <Group title={t('groupStandalone')} hint={t('groupStandaloneHint')} manual>
              {STANDALONE_FIELDS.map(control)}
            </Group>

            <div className="kz-footer">
              {state.saveFailed ? <p className="kz-failed" role="status">{t('saveFailed')}</p> : null}
              <Button variant="ghost" size="sm" disabled={!state.dirty || state.saving} onClick={props.discard}>
                {t('discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!state.dirty || state.invalid || state.saving || !state.writable}
                onClick={props.save}
              >
                {state.saving ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

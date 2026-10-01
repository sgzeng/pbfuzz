/** The pbfuzz settings card (slot `settings.plugin.item`, key `pbfuzz`). */

import { useState } from 'react'
import { Button, IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the keyed slot's declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { EnumField, MultiField, TextField, ToggleField, type BaseFieldProps, type FieldOption } from './fields.tsx'
import { en, type PbfuzzKey, type PbfuzzT } from './locales.ts'
import { FIELDS, GROUPS, type FieldSpec } from './settings-model.ts'
import type { PbfuzzCardFace, PbfuzzCardState } from './settings-card.ts'

/** Props the renderer binds for the card. */
export type PbfuzzSettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'pbfuzz'> & InjectFace<PbfuzzCardFace>

function renderField(spec: FieldSpec, state: PbfuzzCardState, props: PbfuzzSettingsCardProps, t: PbfuzzT) {
  const field = state.fields[spec.id]
  if (field === undefined) return null
  const hintKey = `h.${spec.id}`
  const base: BaseFieldProps = {
    id: `pbfuzz-${spec.id.replace('.', '-')}`,
    label: t(`f.${spec.id}` as PbfuzzKey),
    // Only fields with a dictionary hint show one.
    hint: hintKey in en ? t(hintKey as PbfuzzKey) : undefined,
    state: field,
    disabled: !state.writable || state.saving,
    overriddenLabel: t('card.overridden'),
    resetLabel: t('card.reset'),
    restartLabel: spec.restart === true ? t('card.restart') : undefined,
    onReset: () => { props.resetField(spec.id) },
  }
  const options = (): FieldOption[] => (spec.options ?? []).map(value => ({ value, label: t(`opt.${value}` as PbfuzzKey) }))
  switch (spec.kind) {
    case 'toggle':
      return <ToggleField key={spec.id} {...base} onChange={(next) => { props.editValue(spec.id, next) }} />
    case 'integer':
    case 'number':
      return (
        <TextField
          key={spec.id}
          {...base}
          numeric
          error={t(spec.kind === 'integer' ? 'card.invalidInteger' : 'card.invalidNumber')}
          onEdit={(text) => { props.editText(spec.id, text) }}
        />
      )
    case 'text':
      return <TextField key={spec.id} {...base} onEdit={(text) => { props.editText(spec.id, text) }} />
    case 'multi':
      return <MultiField key={spec.id} {...base} options={options()} onChange={(value) => { props.editValue(spec.id, value) }} />
    case 'enum': {
      let opts = options()
      let notice = null
      if (spec.id === 'tools.staticAnalysis') {
        // kanalyzer is selectable only when the plugin is actually present.
        const missing = state.kanalyzer !== 'installed'
        opts = opts.map(option => option.value === 'kanalyzer' && missing
          ? { ...option, disabled: true, note: t('kanalyzer.unavailable') }
          : option)
        if (missing) {
          notice = (
            <p className="pbfuzz-notice" role="note" data-kanalyzer={state.kanalyzer}>
              {t(state.kanalyzer === 'unknown' ? 'kanalyzer.checking' : 'kanalyzer.missing')}
              {field.value === 'kanalyzer' && state.kanalyzer === 'missing'
                ? <><br /><strong>{t('kanalyzer.selectedMissing')}</strong></>
                : null}
            </p>
          )
        }
      }
      return <EnumField key={spec.id} {...base} notice={notice} options={opts} onChange={(value) => { props.editValue(spec.id, value) }} />
    }
  }
}

/**
 * Render the card. Renders nothing while the `pbfuzz` namespace is not served,
 * so a deployment without the host half shows no trace of it.
 * @param props - locale seat, card snapshot hook and form actions.
 * @returns the card.
 */
export function PbfuzzSettingsCard(props: PbfuzzSettingsCardProps) {
  const t = props.t as unknown as PbfuzzT
  const state = props.usePbfuzzCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (state.status === 'unavailable') return null
  const title = t('card.title')
  return (
    <li className="pbfuzz-card" data-open={open}>
      <button
        type="button"
        className="pbfuzz-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'card.collapse' : 'card.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="pbfuzz-card-head-text">
          <span className="pbfuzz-card-name">{title}</span>
          <span className="pbfuzz-card-desc">{t('card.description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral">{t('card.unsaved')}</Tag> : null}
        <IconChevronDownOutline14 />
      </button>
      {open
        ? (
          <div className="pbfuzz-card-body">
            {state.status === 'loading' ? <p className="pbfuzz-muted" role="status">{t('card.loading')}</p> : null}
            {state.status === 'ready' && !state.writable ? <p className="pbfuzz-muted" role="status">{t('card.readOnly')}</p> : null}
            {state.status === 'ready'
              ? GROUPS.map(group => (
                <fieldset key={group} className="pbfuzz-group" data-group={group}>
                  <legend className="pbfuzz-group-title">{t(`group.${group}` as PbfuzzKey)}</legend>
                  {group === 'execution'
                    // The generator/extractor sandbox (memLimitMB/cpuLimitSec below) bounds
                    // resources only; it is not real isolation. See engine/README.md.
                    ? <p className="pbfuzz-notice" role="note">{t('sandbox.warning')}</p>
                    : null}
                  {FIELDS.filter(spec => spec.group === group).map(spec => renderField(spec, state, props, t))}
                </fieldset>
              ))
              : null}
            <div className="pbfuzz-card-footer">
              {state.failed ? <p className="pbfuzz-field-error" role="status">{t('card.saveFailed')}</p> : null}
              <Button variant="ghost" size="sm" disabled={!state.dirty || state.saving} onClick={props.discard}>
                {t('card.discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!state.dirty || state.invalid || state.saving || !state.writable}
                onClick={props.save}
              >
                {t(state.saving ? 'card.saving' : 'card.save')}
              </Button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

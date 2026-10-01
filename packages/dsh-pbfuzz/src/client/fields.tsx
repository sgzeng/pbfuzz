/**
 * Field controls for the pbfuzz card, composed from ui-primitives. There is no
 * select, multi-select or textarea primitive, so `EnumField` is Button + Menu
 * and `MultiField` is one Switch per option. Nothing here writes: controls
 * report what the user chose; the card's Save is the single write point.
 */

import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Input, Menu, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldState } from './card-form.ts'

/** Props shared by every control. */
export interface BaseFieldProps {
  /** Stable DOM id. */
  id: string
  /** Visible label. */
  label: string
  /** Optional one-line hint. */
  hint?: string | undefined
  /** Control state. */
  state: FieldState
  /** Disable input. */
  disabled: boolean
  /** Localized "Overridden" badge text. */
  overriddenLabel: string
  /** Localized "Reset" text. */
  resetLabel: string
  /** Localized "Restart" badge text when the field applies on restart. */
  restartLabel?: string | undefined
  /** Stage a reset. */
  onReset: () => void
  /** Extra content under the control (e.g. install hint). */
  notice?: ReactNode
}

function FieldFrame(props: BaseFieldProps & { control: ReactNode; error?: string | undefined }) {
  return (
    <div className="pbfuzz-field" data-field={props.id}>
      <div className="pbfuzz-field-head">
        <label className="pbfuzz-field-label" htmlFor={props.id}>{props.label}</label>
        <span className="pbfuzz-field-badges">
          {props.restartLabel !== undefined ? <Tag tone="info">{props.restartLabel}</Tag> : null}
          {props.state.overridden
            ? (
              <>
                <Tag tone="neutral">{props.overriddenLabel}</Tag>
                <button type="button" className="pbfuzz-link" disabled={props.disabled} onClick={props.onReset}>
                  {props.resetLabel}
                </button>
              </>
            )
            : null}
        </span>
      </div>
      <div className="pbfuzz-field-control">{props.control}</div>
      {props.state.invalid && props.error !== undefined
        ? <p className="pbfuzz-field-error" role="alert">{props.error}</p>
        : props.hint !== undefined ? <p className="pbfuzz-field-hint">{props.hint}</p> : null}
      {props.notice}
    </div>
  )
}

/**
 * Boolean switch.
 * @param props - base props plus the change callback.
 * @returns the field.
 */
export function ToggleField(props: BaseFieldProps & { onChange: (next: boolean) => void }) {
  return (
    <FieldFrame
      {...props}
      control={(
        <Switch
          checked={props.state.value === true}
          onChange={props.onChange}
          label={props.label}
          disabled={props.disabled}
        />
      )}
    />
  )
}

/**
 * Text or numeric input (staged text).
 * @param props - base props plus numeric hinting and error copy.
 * @returns the field.
 */
export function TextField(props: BaseFieldProps & {
  numeric?: boolean
  error?: string
  onEdit: (text: string) => void
}) {
  return (
    <FieldFrame
      {...props}
      control={(
        <Input
          id={props.id}
          type="text"
          spellCheck={false}
          className={props.state.invalid ? 'pbfuzz-input pbfuzz-input-invalid' : 'pbfuzz-input'}
          {...props.numeric === true ? { inputMode: 'decimal' as const } : {}}
          {...props.state.invalid ? { 'aria-invalid': true } : {}}
          value={props.state.text}
          disabled={props.disabled}
          onChange={(event) => { props.onEdit(event.target.value) }}
        />
      )}
    />
  )
}

/** One selectable option of an enum/multi field. */
export interface FieldOption {
  /** Stored value. */
  value: string
  /** Localized label. */
  label: string
  /** Greyed out and unselectable. */
  disabled?: boolean
  /** Short suffix shown on a disabled option (e.g. "Not installed"). */
  note?: string | undefined
}

/**
 * One-of choice built from Button + Menu (no select primitive exists).
 * @param props - base props plus options.
 * @returns the field.
 */
export function EnumField(props: BaseFieldProps & { options: readonly FieldOption[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const current = props.options.find(option => option.value === props.state.value)
  return (
    <FieldFrame
      {...props}
      control={(
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          selectedId={typeof props.state.value === 'string' ? props.state.value : undefined}
          onSelect={(value) => {
            setOpen(false)
            if (props.options.some(option => option.value === value && option.disabled !== true)) props.onChange(value)
          }}
          portal
          items={props.options.map(option => ({
            id: option.value,
            label: option.note !== undefined ? `${option.label} — ${option.note}` : option.label,
            ...option.disabled === true ? { disabled: true } : {},
          }))}
          anchor={(
            <Button
              id={props.id}
              variant="outline"
              size="sm"
              disabled={props.disabled}
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
            >
              {current?.label ?? String(props.state.value ?? '')}
              <IconChevronDownOutline14 />
            </Button>
          )}
        />
      )}
    />
  )
}

/**
 * Subset choice: one Switch per option.
 * @param props - base props plus options.
 * @returns the field.
 */
export function MultiField(props: BaseFieldProps & { options: readonly FieldOption[]; onChange: (value: string[]) => void }) {
  const chosen = Array.isArray(props.state.value) ? (props.state.value as string[]) : []
  return (
    <FieldFrame
      {...props}
      control={(
        <span className="pbfuzz-multi" id={props.id}>
          {props.options.map(option => (
            <span key={option.value} className="pbfuzz-multi-item">
              <Switch
                checked={chosen.includes(option.value)}
                label={`${props.label}: ${option.label}`}
                disabled={props.disabled}
                onChange={(next) => {
                  // Keep schema order so the stored array is stable.
                  const set = new Set(chosen)
                  if (next) set.add(option.value)
                  else set.delete(option.value)
                  props.onChange(props.options.map(o => o.value).filter(v => set.has(v)))
                }}
              />
              <span>{option.label}</span>
            </span>
          ))}
        </span>
      )}
    />
  )
}

/**
 * The card's stylesheet, injected as one tagged `<style>`. It is a string rather than a
 * CSS module so that `lib/client.js` stays a single self-contained file, and it is styled
 * only through the host's `--dsw-alias-*` tokens so it follows the active theme.
 */

const STYLE_ID = '@pbfuzz/dsh-kanalyzer/card'

const CSS = `
.kz-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3)}
.kz-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.kz-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.kz-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.kz-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.kz-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.kz-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.kz-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:16px}
.kz-note{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.kz-note[data-tone="warn"]{color:var(--dsw-alias-label-error)}
.kz-group{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px}
.kz-group[data-manual="true"]{border-style:dashed}
.kz-group-title{margin:0 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}
.kz-group-hint{margin:0 0 6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.kz-field{display:flex;flex-direction:column;gap:6px;padding:10px 0}
.kz-field+.kz-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.kz-field-row{display:flex;align-items:center;gap:8px}
.kz-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.kz-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.kz-hint[data-invalid="true"]{color:var(--dsw-alias-label-error)}
.kz-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.kz-reset:disabled{cursor:default}
.kz-input-invalid input{box-shadow:0 0 0 1px var(--dsw-alias-label-error)}
.kz-list{display:flex;flex-direction:column;gap:6px}
.kz-list-row{display:flex;align-items:center;gap:6px}
.kz-list-row>span{flex:1}
.kz-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.kz-status{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0;font-size:12px}
.kz-status dt{color:var(--dsw-alias-label-tertiary)}
.kz-status dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-all;font-family:var(--dsw-alias-font-mono,ui-monospace,monospace)}
.kz-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.kz-action{display:flex;flex-direction:column;gap:4px}
.kz-result{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.kz-result[data-phase="failure"]{color:var(--dsw-alias-label-error)}
.kz-detail{white-space:pre-wrap;font-family:var(--dsw-alias-font-mono,ui-monospace,monospace)}
.kz-footer{display:flex;justify-content:flex-end;gap:8px;align-items:center}
.kz-failed{margin:0 auto 0 0;font-size:12px;color:var(--dsw-alias-label-error)}
`

/**
 * Install the card stylesheet once.
 * @returns a disposer that removes it.
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@pbfuzz/dsh-kanalyzer'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

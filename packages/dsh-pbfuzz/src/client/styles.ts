/**
 * The card's and dashboard's stylesheet. Injected as one tagged `<style>` for
 * exactly the plugin's lifetime; the `data-plugin` attribute is what the DSH
 * client module system uses to inventory a factory's styles. Plain CSS text
 * rather than CSS Modules: the out-of-tree esbuild bundle has no lightningcss
 * step, so class names are `pbfuzz-` prefixed instead of hashed. Colors come
 * only from `--dsw-*` tokens, with neutral fallbacks.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin id stamped on the style tag; equals the package name. */
export const PLUGIN_ID = '@pbfuzz/dsh-pbfuzz'

const CSS = `
.pbfuzz-card{list-style:none;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.25));border-radius:12px;margin:0 0 12px}
.pbfuzz-card-header{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:12px 16px;cursor:pointer}
.pbfuzz-card-head-text{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px}
.pbfuzz-card-name{font-weight:600;color:var(--dsw-alias-text-primary,inherit)}
.pbfuzz-card-desc,.pbfuzz-muted,.pbfuzz-field-hint{color:var(--dsw-alias-text-tertiary,rgba(127,127,127,.9));font-size:12px}
.pbfuzz-card[data-open=true] svg{transform:rotate(180deg)}
.pbfuzz-card-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}
.pbfuzz-group{border:0;border-top:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.2));margin:0;padding:12px 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px 16px}
.pbfuzz-group-title{font-weight:600;font-size:13px;padding:0 4px 0 0}
.pbfuzz-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.pbfuzz-field-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.pbfuzz-field-label{font-size:13px}
.pbfuzz-field-badges{display:inline-flex;align-items:center;gap:4px}
.pbfuzz-field-hint,.pbfuzz-field-error{margin:0}
.pbfuzz-field-error{color:var(--dsw-alias-text-error,#d33);font-size:12px}
.pbfuzz-input-invalid{outline:1px solid var(--dsw-alias-text-error,#d33);border-radius:8px}
.pbfuzz-link{all:unset;cursor:pointer;font-size:12px;text-decoration:underline;color:var(--dsw-alias-text-secondary,inherit)}
.pbfuzz-link:disabled{cursor:default;opacity:.5}
.pbfuzz-multi{display:flex;flex-wrap:wrap;gap:8px 16px}
.pbfuzz-multi-item{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.pbfuzz-notice{margin:4px 0 0;padding:6px 8px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-warning,rgba(230,160,0,.12));color:var(--dsw-alias-text-primary,inherit)}
.pbfuzz-card-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.pbfuzz-card-footer .pbfuzz-field-error{margin-right:auto}
.pbfuzz-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;word-break:break-all}
.pbfuzz-dash-root{position:relative}
.pbfuzz-dash-trigger{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap}
.pbfuzz-dash-trigger:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.pbfuzz-dash-popover{position:fixed;z-index:1000;width:380px;max-width:calc(100vw - 24px);max-height:70vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.25));background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-primary,#fff));color:var(--dsw-alias-text-primary,inherit);box-shadow:0 8px 28px rgba(0,0,0,.18)}
.pbfuzz-dash-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.2))}
.pbfuzz-icon-btn{all:unset;cursor:pointer;display:inline-flex}
.pbfuzz-dash-scroll{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.pbfuzz-dash-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pbfuzz-dash-line{margin:0;font-size:13px}
.pbfuzz-dash-section{display:flex;flex-direction:column;gap:4px}
.pbfuzz-dash-h{margin:4px 0 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-text-secondary,inherit)}
.pbfuzz-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.pbfuzz-check{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pbfuzz-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:13px}
.pbfuzz-kv dt{color:var(--dsw-alias-text-tertiary,inherit)}
.pbfuzz-kv dd{margin:0;min-width:0}
.pbfuzz-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.pbfuzz-metrics div{display:flex;flex-direction:column;padding:6px;border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08))}
.pbfuzz-metrics b{font-size:15px}
.pbfuzz-metrics span{font-size:11px;color:var(--dsw-alias-text-tertiary,inherit)}
.pbfuzz-dash-foot{margin:4px 0 0}
`

/**
 * Mount the stylesheet for the owning plugin's lifetime.
 * @param ctx - owning plugin context.
 */
export function installPbfuzzStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/pbfuzz.css`
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'pbfuzz: stylesheet')
}

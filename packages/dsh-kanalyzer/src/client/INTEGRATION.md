# Client integration reference (kanalyzer card)

This package's client half (`src/client/**`, `scripts/build-client.mjs`) integrates with the host
half (everything else in `src/`). The one-time integration work this file used to track as a
W8→W4 handoff punch list (`package.json` scripts and `dsh.client.inject`, `tsconfig.json`
excluding `src/client`, `vitest.config.ts` picking up `src/client/controller.test.ts`, and the
host-side settings/status/command contract the card relies on) is done and verified live — see
[`docs/verification.md`](../../../../docs/verification.md) (Stage C2 and B1–B4) for the evidence.
What's left below is ongoing reference: why the bundle is built the way it is.

## Bundle format

`build-client.mjs` uses esbuild `format:'cjs'` + `bundle:true`, wrapped in the loader's factory
closure. The banner, intro and footer are the same as DSH's own `tsdown.client.ts`, and the same
shape as `dsh-pbfuzz/scripts/bundle-client.mjs`:

```
window.__ModuleLoader__.load({ id: "@pbfuzz/dsh-kanalyzer", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
… esbuild CJS body: require("react") etc. …
return module.exports; } });
```

The file is still an immediately-registered, classic-safe script. The only top-level statement is
the `load(...)` call. Platform modules (DSH `PLATFORM_MODULES`) stay external, and each one becomes
a plain `require("…")` that resolves through the factory's `require` parameter. There is never a
global `require`. Why not `format:'iife'`: esbuild's IIFE turns externals into a `__require` shim
that throws "Dynamic require … not supported" whenever no `require` is lexically in scope. It
happened to work inside this closure, but CJS makes the contract explicit, and the self-check now
rejects the shim outright. Any other `@deepseek-ai` value import fails the build (purity gate).

The self-check does four things: parses the file as a classic `vm.Script`, runs it with only a
fake `window.__ModuleLoader__` (expecting exactly one `load` with `id === pkg.name`), materializes
the factory against a stub module table (every `require` must be a platform module, and `apply`
and `inject` must be exported), and scans for stray literal `require`s.

```bash
cd packages/dsh-kanalyzer && node scripts/build-client.mjs          # build + self-checks
```

# contracts/ — the shared source of truth

Everything here is shared by the TypeScript plugins and the Python engine. A contract change
regenerates every consumer via `pnpm codegen` — run it and commit the diff together with your
change; do not hand-edit a `generated/` file.

## Files

| File | Consumed by | What it fixes |
|---|---|---|
| `common.schema.json` | everything | `Location`, `ParameterSpec`, `Breakpoint`, `Provenance` |
| `campaign.schema.json` | dsh-pbfuzz (draft/confirm, guard), engine (via dsh-pbfuzz) | `pbfuzz.campaign.yaml` — every piece of **target-project** information |
| `state/state.schema.json` | dsh-pbfuzz | `.pbfuzz/<id>/state/state.json` — the PIER FSM cursor, written only by pbfuzz's own tools |
| `state/blocks.schema.json` | dsh-pbfuzz | the tool-written analysis blocks (bug predicates, preconditions, root causes, trigger plans, fuzz plan) |
| `state/metrics.schema.json` | engine (writer), dsh-pbfuzz (reader) | engine-written only; no tool or agent ever writes this |
| `selfcheck.schema.json` | dsh-pbfuzz (writer, gate, card) | the per-campaign self-check report |
| `pbfuzz-settings.schema.json` | dsh-pbfuzz (host `Config`, card) | pbfuzz's **own** configuration, including the cached environment self-check |
| `kanalyzer-settings.schema.json` | dsh-kanalyzer (host `Config`, card) | kanalyzer's configuration + read-only status fields |
| `kanalyzer-api.ts` | dsh-kanalyzer (implements), dsh-pbfuzz (consumes) | the `ctx.kanalyzer` service interface. **Knows nothing about pbfuzz.** |
| `analysis-provider.ts` | dsh-pbfuzz (registry + kanalyzer adapter) | pbfuzz's internal auxiliary-analysis provider interface |
| `engine-rpc.schema.json` | dsh-pbfuzz (client), engine (server) | the TS ↔ Python sidecar JSON-RPC surface |
| `policy.json` | dsh-pbfuzz only | the phase→tool table `core/phases.ts` (visibility) and `core/guard-policy.ts` (enforcement) both read, so the two can't drift |

## Codegen

`pnpm codegen` regenerates, and `pnpm codegen:check` fails CI when the generated files drift:

- `packages/dsh-pbfuzz/src/generated/contracts.ts` — TS types from every `*.schema.json`
- `packages/dsh-kanalyzer/src/generated/contracts.ts` — kanalyzer settings types
- `packages/dsh-pbfuzz/src/generated/policy.ts` — `policy.json` as a TS `as const` literal
- `engine/pbfuzz_engine/generated/contracts.py` — NOT pydantic models. It is a schema-file
  loader (`load_schema()` + `SCHEMA_FILES`) the engine uses to read a contract schema by name at
  runtime; `campaign.py` validates campaigns with a hand-written validator instead.

Generated files are committed so a git install needs no codegen step.

## Two rules that shape these schemas

1. **Target-project information lives in the campaign; pbfuzz's own behaviour lives in settings.**
   Nothing appears in both. If a field describes *the program under test*, it belongs in
   `campaign.schema.json`; if it describes *how pbfuzz behaves*, it belongs in
   `pbfuzz-settings.schema.json`.
2. **Every campaign field the agent inferred carries provenance.** `provenance` records whether a
   value came from the user or was inferred, and the evidence for it, so the confirmation panel can
   show the user exactly what pbfuzz decided on its own.

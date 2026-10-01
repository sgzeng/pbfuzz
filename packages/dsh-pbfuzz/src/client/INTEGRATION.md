# Client integration reference (pbfuzz Web UI)

This package's client half (`src/client/**`, `scripts/bundle-client.mjs`) integrates with the host
half (`src/host.ts`, `src/projection.ts`, everything else in `src/`). The one-time integration
work this file used to track as a W6→W1 handoff punch list (package.json exports, the
`pnpm-workspace.yaml` `allowBuilds` setting, the settings-card/dashboard host obligations) is done
and verified live — see [`docs/verification.md`](../../../../docs/verification.md) (Stage C2/C5 and
V1–V4) for the evidence. What's left below is ongoing reference: the dashboard's data contract and
how to build/verify the client bundle.

## The dashboard's data contract

The dashboard lives in the session-scoped slot `conversation.session.header.utilities` (reads
`useProjection('pbfuzz')`, not a settings namespace — a settings namespace would rewrite
`~/.dsh/settings.yaml` about once a second, is host-global rather than per-session, and cannot be
reconstructed on replay). It renders nothing in a session with no pbfuzz campaign.

The host side (`src/projection.ts`) is a pure fold over events DSH already commits — no new
session event type. It folds three kinds of event:
- `tool/result` from a pbfuzz tool call — the host embeds a fresh `PbfuzzDashboardView`
  (`src/core/dashboard.ts`) in `presentationMeta`; the fold keeps the latest one.
- `tool/call` + `tool/result` for a plain `write` of a campaign `state/` document — PIER's own
  FSM-hop procedure advances phase this way, not through a pbfuzz tool call, so this write reaches
  the log as DSH's generic `write` tool. The fold stages the document on the call and merges it in
  only once the paired result shows the write landed (a guard-refused or interrupted write changes
  nothing).
- `hook/result` with `point: PreToolUse`, `decision: deny|block` and a pbfuzz guard header in
  `stderrSummary` → a denial entry (the guard CLI stamps the tool name into the header).

Shape (TS source of truth: `src/client/dashboard-contract.ts`, `PbfuzzDashboardView`):

| field | source |
|---|---|
| `campaignId`, `phase`, `status`, `nextAction`, `pierRound`, `stopReason` | `.pbfuzz/<id>/state/state.json` (`campaign_id`, `phase`, `status`, `next_action`, `pier_round`, `stop_reason`) |
| `maxPierRounds` | resolved `pbfuzz.budget.maxPierRounds` |
| `targets: {file,line,function?}[]` | campaign target location(s) |
| `hypothesis` | counts from `state/bug_predicates.json`, `preconditions.json` (by status), `root_causes.json`, `trigger_plans.json` (pending/inProgress/completed/failed) and `currentPlan` = the `in_progress` plan `{id,description,complexity,status}`; `null` before PLAN |
| `metrics` | `state/metrics.json` **verbatim** (snake_case) or `null` |
| `selfcheck` | `selfcheck.json` **verbatim** or `null` |
| `denials: {at,hook,tool?,reason}[]` | last 10 guard denies, newest first, folded from `hook/result` |
| `poc` | `state.json#poc` verbatim or `null` |
| `updatedAt` | ISO time the host built the latest snapshot |

The view refreshes on every pbfuzz tool result, every landed `state`/`metrics` document write, and
every guard deny. The decoder is tolerant: a missing or malformed part renders as empty.

## Build and verify

```bash
cd packages/dsh-pbfuzz && node scripts/bundle-client.mjs          # build + self-checks
cd packages/dsh-pbfuzz && node scripts/bundle-client.mjs --check  # verify an existing lib/client.js
```
The self-checks cover four things: the output compiles as a classic script with no `import`/`export`
lines; evaluating it without a global `require` calls `window.__ModuleLoader__.load` exactly once
with id `@pbfuzz/dsh-pbfuzz`; the factory requires only platform modules and exports
`apply`/`inject`; and the card fields match the schema leaves exactly (31/31, current as of the
last `pnpm run test:all`).

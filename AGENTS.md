# AGENTS.md

This is the **MyHermit mobile** fork of opencode-mobile: a Hermes-only client.
The upstream docs in `docs/` still describe the OpenCode-era architecture where
noted; the authoritative delta is `docs/hermes.md`. When the two disagree about
Hermes behavior, `docs/hermes.md` wins.

## Layering (unchanged from upstream)

The app stays provider-centric:

- `providers/use-opencode-provider-composition.ts` owns domain state and orchestration.
- `app/` owns routing and thin screen wiring.
- `components/` owns presentation and local UI state.
- `providers/services/` owns provider-facing API aggregation.
- `lib/hermes/` owns the Hermes protocol (auth, HTTP, SSE, runs, mapping).
- `lib/opencode/` now holds two things only: the backend-agnostic domain
  models (`types.ts`, `message-types.ts`, `format/`, `prompt-inbox.ts`) and the
  OpenCode SDK adapters kept for reference — do not add new OpenCode code.
- `tests/fake-hermes/` and `tests/vitest/hermes-*.test.ts` define the Hermes
  behavioral contract.

Do not move domain behavior into screens or presentational components.

## Hermes architecture (see docs/hermes.md for the full protocol)

- **One server kind.** `ServerContract` is `'hermes'` in practice; `'v1'`/`'v2'`
  remain in the type system for the upstream adapters but the connect flow only
  accepts Hermes dashboards (detected via the public `/api/auth/providers`).
- **Auth.** Headless RFC 8252 PKCE against the dashboard
  (`authorize → password-login → /auth/native/token`), bearer + single-flight
  refresh on 401, tokens in SecureStore keyed by the connection scope. The
  password is stored with the connection profile (this fork's model) so a dead
  refresh can re-sign-in silently.
- **Gateway access is plugin-proxied.** All sessions/messages/runs go through
  `/api/plugins/hermes-ios/gw/...`; clarify, live tool args, active-run lookup,
  and skill expansion are plugin routes; credential requests are a separate
  plugin. Missing plugin routes are connection errors with setup hints.
- **Runs, not events.** There is no global event stream. `use-hermes-runs`
  attaches to `/v1/runs/{id}/events` per run (resume via `Last-Event-ID`,
  backoff 1→16s), polls `/runs/active` for the current session (15s, 3s while
  busy-elsewhere), polls `/clarify` (2s while a run is live), and fetches full
  tool args 300ms after tool events. Run events map onto the existing domain
  state: statuses → `sessionStatuses`, approvals → `pendingPermissions`,
  clarify → `pendingQuestions`, streamed turn → synthetic
  `hermesLiveRecords` merged after the server transcript page.
- **OpenCode-only surfaces are capability-gated off for Hermes**
  (`ServerCapabilities`: no files/VCS/worktrees/PTY/MCP/extensions/auto-approve/
  prompt-delivery/context-mentions/shell). Their contexts receive inert stubs in
  the composition; the tab layout is Chat / Credentials / Settings.

## Change Mapping (Hermes)

- **Chat:** visuals/composer: `components/chat/`; transcript shaping stays in
  `lib/opencode/format/` (records are mapped by `lib/hermes/mapping.ts`);
  prompt lifecycle, queueing, abort: `providers/use-hermes-prompts.ts` +
  `providers/use-hermes-runs.ts`.
- **Connection:** sign-in, profiles, token rotation:
  `providers/use-connection-connect-actions.ts`, `lib/hermes/auth.ts`,
  `lib/hermes/tokens.ts`, `lib/hermes/client.ts` (pooled per identity).
- **Credentials:** `providers/use-hermes-credentials.ts`,
  `components/credentials/`, `app/(tabs)/credentials.tsx`.
- **Approvals/clarify:** `providers/use-hermes-runs.ts` (state + wire) and the
  existing question-flow/permission-card components.
- **Protocol:** update `lib/hermes/wire.ts`, `lib/hermes/api.ts`,
  `lib/hermes/run.ts`, and the matching fake server in `tests/fake-hermes/`
  together.
- **Slash commands:** built-ins live in `use-opencode-provider-composition.ts`
  (`HERMES_BUILT_IN_COMMANDS` + `hermesCommandActions`); skills come from
  `GET /api/plugins/hermes-ios/commands` and expand through
  `commands/expand`.

## Validation

Baseline (must pass before push):

```bash
npm run lint
npm run typecheck           # tsc --noEmit
npx vitest run              # 100+ suites incl. Hermes protocol + integration
```

Notes:

- The upstream Playwright e2e suite (`tests/e2e/`) still drives OpenCode fake
  servers and is expected to fail until its flows are rebuilt against
  `tests/fake-hermes/`. Treat Hermes integration tests as the gate for now;
  rebuilding the e2e flows is tracked in docs/hermes.md.
- Architecture ratchets still apply: 500-line file cap, provider wrapper ≤60
  lines, ≤127 context members, no `fetch` in `app/`/`components/`.

## Definition Of Done

- code is in the correct layer (Hermes protocol → `lib/hermes/`, orchestration →
  providers, presentation → components)
- behavior is preserved or intentionally updated
- `lib/hermes/` contract changes update both unit suites and the fake server
- docs updated when behavior/architecture changes (`docs/hermes.md` is the
  source of truth for Hermes behavior)
- lint, typecheck, and vitest pass
- the final summary states what changed, what was verified, and remaining risk

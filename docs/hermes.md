# Hermes adaptation

This fork of opencode-mobile is being adapted into **MyHermit mobile**: a
Hermes-only client that speaks the same protocol as the native MyHermit apps
(rosienhg/myhermit: `Packages/HermesCore` is the reference client, `plugin/`
the reference server plugin). Upstream opencode-mobile supplied the UX shell.

## What is implemented

### Protocol layer — `lib/hermes/`

| Module | Role |
|---|---|
| `wire.ts` | Hermes wire types (snake_case) exactly as served by the dashboard, the `hermes-ios` plugin proxy, and `hermes-cred-requests`. |
| `pkce.ts` | RFC 7636 PKCE (32-byte verifier, base64url-unpadded, S256). |
| `auth.ts` | The headless sign-in flow: `GET /api/auth/providers` → `GET /auth/native/authorize` (capture `hermes_session_pkce`) → `POST /auth/password-login` → code+state from the `next` URL → `POST /auth/native/token`. Also refresh. |
| `errors.ts` | Hermes error bodies (`detail` string / `detail[].msg` / `error.message`). |
| `http.ts` | Authorized client: bearer auth, single-flight refresh on 401, retry-once, sign-out on a rejected refresh; SSE via `expo/fetch` streaming. |
| `tokens.ts` | `StoredAuth` persistence in SecureStore, keyed by connection scope (web: process-local E2E shim). |
| `api.ts` | Every endpoint the app uses: sessions/messages through `/api/plugins/hermes-ios/gw`, runs start/stop/approval/events, model options, health, plugin status, runs/active, live tool calls, clarify list/answer, skill commands + expand, credential requests list/fulfill/cancel. |
| `sse.ts` | Minimal SSE reader (`data:` frames, multi-line join; `id:` ignored — resume keys on the JSON `seq`). |
| `run.ts` | The client-side run state machine (port of HermesCore `ActiveRun.apply`): streamed text, reasoning, tool steps, approvals, terminal-event detection (`run.*` except `run.started`/`run.steered`), live-tool-arg application. |
| `mapping.ts` | Wire → domain: `SessionSummary` → `Session`, `ChatMessage` → transcript records (user/assistant/reasoning/tool parts, role=tool completion matching), model options, clarify → question-flow requests (answers back to `{qid: answer|null}`), approvals → permission cards, credential requests → views. |
| `client.ts` | `HermesClient` facade, pooled per connection identity so every consumer shares one auth/refresh state. |

Covered by `tests/vitest/hermes-protocol.test.ts` (pure logic) and
`tests/vitest/hermes-integration.test.ts` (full flow against the fake server).

### Provider integration

- `buildClient(settings, 'hermes')` returns a Hermes-backed
  `ScopedOpencodeClient`; the session/server/interactions adapters gained
  Hermes branches, so transcript windowing, session CRUD, favorites, catalog,
  and settlement reads all run unchanged over Hermes endpoints.
- `use-connection-connect-actions.ts` performs the PKCE sign-in, verifies the
  plugin via `GET /api/plugins/hermes-ios/status` (404 ⇒ "install the plugin"),
  and reuses stored tokens silently.
- `use-hermes-runs.ts` owns run streams, statuses, approvals, clarify polling,
  live transcript records, and busy-elsewhere tracking.
- `use-hermes-prompts.ts` owns run admission (with skill expansion) and the
  client-side queue while a run is live.
- Built-in slash commands (`/new /stop /retry /title /branch /delete /help`)
  are handled client-side; unknown `/x` fails like MyHermit ("unknown command").

### UI

- Tabs: Chat / Credentials / Settings.
- `Credentials` tab lists pending credential requests (fields with secret
  entry, env/file destination labels), fulfills/cancels them, and shows
  history with saved destinations. Values never persist in the app.
- Approvals reuse the upstream permission card; clarify reuses the upstream
  question-flow wizard.
- Branded MyHermit: scheme `myhermit`, bundle id `uk.co.nickhg.myhermit`,
  Android package `uk.co.nickhg.myhermit`.

## Not yet implemented (tracked)

- **Server setup UI** (install/update the `hermes-ios` plugin from the app —
  `ServerSetup` port). Until then the plugin must be installed manually
  (`plugin/install.sh`).
- **Push notifications.** APNs device registration requires an APNs key/cert
  for this app's bundle id; Expo push or FCM needs a server-side story. The
  local "task finished" notification monitor still works (it polls
  settlement reads).
- **Skills browse/marketplace, cron jobs UI** — endpoints exist in `api.ts`
  shape only where noted; no screens yet.
- **Widget + share-in are OpenCode-era** — they run but their notifications
  surface may need Hermes tuning.
- **Playwright e2e** — upstream specs still target the OpenCode fake servers;
  rebuild the core flows (connect/chat/clarify/credentials) against
  `tests/fake-hermes/`.
- **Locale translations** — new strings ship as English everywhere; parity is
  enforced, translations welcome.

## The fake server

`tests/fake-hermes/server.mjs` implements the dashboard (PKCE + tokens),
the gateway proxy (sessions/messages/runs/SSE), the `hermes-ios` plugin
routes (status, runs/active, tools, clarify, commands), and the
`hermes-cred-requests` plugin, plus a `/__control` surface for tests
(reset, scenario, seed sessions/clarify/cred-requests, busy-elsewhere).
Reference for shapes: `myhermit/android/tools/mock_hermes.py` and
`HermesCore/Sources/HermesCore`.

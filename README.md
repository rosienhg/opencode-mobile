# MyHermit (mobile)

<p align="center">
  <strong>Your Hermes Agent, in your pocket.</strong>
</p>

<p align="center">
  Start chats, watch runs stream in, answer clarify questions, approve actions, and
  fill in credential requests — from Android and iOS.
</p>

---

MyHermit mobile is a React Native (Expo) client for a self-hosted
[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) server. It began as a
fork of [opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile)
(whose excellent chat UX this app keeps) and was adapted to speak the Hermes
protocol the same way the native MyHermit apps do.

## How it works

```text
Your phone
    │
    │  HTTPS (LAN, VPN, or tunnel)
    ▼
Hermes dashboard  (default http://hermes.local, port 80)
    │
    ├─ Sign-in: headless PKCE (/auth/native/*), bearer + refresh tokens
    ├─ hermes-ios plugin: /api/plugins/hermes-ios/gw/... proxies the Hermes
    │  API server for sessions, messages, and runs — the API key never
    │  leaves the server
    └─ hermes-cred-requests plugin: credential requests the agent files,
          fulfilled from the Credentials tab
```

The Hermes **gateway itself is never called directly**; everything flows through
the dashboard and the `hermes-ios` plugin, exactly like the native MyHermit apps.

## What you can do

- **Chat with Hermes** — sessions list, streamed runs (reasoning, tool calls,
  replies) with `Last-Event-ID` resume, stop, message queueing while a run is
  active.
- **Approve actions** — run approvals surface as permission cards.
- **Answer clarify questions** — Hermes parks a `clarify` tool call; the app
  polls the plugin and renders the questions (choices, multi-select, free text,
  skip).
- **Fill credential requests** — the agent requests API keys or files; you
  review the request and enter the values; they are written server-side into
  env/file destinations and never stored in the app.
- **Slash commands** — `/new`, `/stop`, `/retry`, `/title`, `/branch`, `/delete`,
  `/help`, plus server skills (expanded through the plugin).

## Server requirements

1. A Hermes Agent server with the dashboard enabled and `dashboard.basic_auth`
   configured (username/password).
2. The `hermes-ios` plugin installed and enabled (see MyHermit's
   `plugin/install.sh` / `plugin/SETUP.md`), which also requires
   `API_SERVER_ENABLED` + `API_SERVER_KEY` in `~/.hermes/.env`.
3. The `hermes-cred-requests` plugin for the Credentials tab.

The app checks all of this after sign-in and reports exactly what is missing.

## Development

```bash
npm install
npm run typecheck
npm run lint
npx vitest run                         # unit + protocol + integration suites
npm run test:fake-server:self          # OpenCode fake self-test (upstream)
npm run test:e2e:web                   # Playwright e2e (upstream flows)
```

The Hermes protocol layer lives in `lib/hermes/`; its contract is pinned by
`tests/vitest/hermes-protocol.test.ts` and end-to-end by
`tests/vitest/hermes-integration.test.ts` against `tests/fake-hermes/server.mjs`
(a controllable fake Hermes dashboard + plugins).

Architecture and the adaptation state are documented in
[docs/hermes.md](docs/hermes.md) and [AGENTS.md](AGENTS.md).

## License

Apache License 2.0 — inherited from the upstream
[opencode-mobile](https://github.com/alvarolorentedev/opencode-mobile) fork.

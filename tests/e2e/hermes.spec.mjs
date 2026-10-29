import { spawn } from 'node:child_process';
import net from 'node:net';

import { expect, test } from './helpers/fixtures.mjs';
import { goToTab, sendPrompt } from './helpers/flows.mjs';

// The Hermes end-to-end flow drives the real web build against the fake
// Hermes dashboard + plugins: PKCE sign-in, a streamed run, a clarify
// question, and a credential request fulfilled from the Credentials tab.
let hermes;

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startFakeHermes(request) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['tests/fake-hermes/server.mjs'], { env: { ...process.env, FAKE_HERMES_PORT: String(port) }, stdio: 'inherit' });
  await expect.poll(async () => { try { return (await request.get(`${origin}/api/auth/providers`)).status(); } catch { return 0; } }).toBe(200);
  return { server, origin };
}

test.beforeEach(async ({ request }) => {
  hermes = await startFakeHermes(request);
});

test.afterEach(async () => {
  hermes?.server?.kill();
});

async function signIn(page) {
  await page.addInitScript((url) => {
    globalThis.__OPENCODE_E2E_SERVER_URL__ = url;
  }, hermes.origin);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('onboarding-welcome-start').click();
  await page.getByTestId('onboarding-permissions-skip').click();
  await page.getByTestId('connection-method-manual').click();
  await page.getByTestId('connection-profile-url-input').fill(hermes.origin);
  await page.getByTestId('connection-profile-continue').click();
  await expect(page.getByTestId('connection-profile-detection')).toContainText('Hermes dashboard detected');
  await page.getByTestId('connection-profile-username-input').fill('demo');
  await page.getByTestId('connection-profile-password-input').fill('demo');
  await page.getByTestId('connection-profile-save-confirm').click();
  await expect(page.getByTestId('onboarding-general')).toBeVisible();
  await page.getByTestId('onboarding-general-skip').click();
  await page.getByTestId('onboarding-voice-skip').click();
  await page.getByTestId('onboarding-ready-start').click();
  await expect(page.getByTestId('chat-prompt-input')).toBeVisible();
}

test('hermes sign-in, streamed chat, clarify, and credentials', async ({ page, request }) => {
  await signIn(page);

  // A streamed run: the pending user row appears immediately, the assistant
  // turn streams in, and the transcript reload carries the persisted exchange.
  await sendPrompt(page, 'Hello Hermes');
  await expect(page.getByText('Hello from Hermes. (happy-path)').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid^="transcript-message-"]')).toHaveCount(2);

  // Clarify: seed a question through the fake's control plane; the app polls
  // the plugin and shows the question flow.
  const session = (await (await request.get(`${hermes.origin}/__control/state`)).json()).sessions[0];
  await request.post(`${hermes.origin}/__control/clarify`, {
    data: { session_id: session.id, questions: [{ qid: 'q0', question: 'Which colour?', choices: ['Red', 'Blue'], multi_select: false }] },
  });
  await expect(page.getByText('Which colour?')).toBeVisible({ timeout: 20_000 });
  await page.getByText('Blue', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect.poll(async () => (await (await request.get(`${hermes.origin}/__control/state`)).json()).clarify[0].status, { timeout: 15_000 }).toBe('submitted');
  const stateAfterAnswer = await (await request.get(`${hermes.origin}/__control/state`)).json();
  expect(stateAfterAnswer.clarify[0].answers).toEqual({ q0: 'Blue' });

  // Credentials: seed a pending request, open the tab, fulfill it.
  await request.post(`${hermes.origin}/__control/cred-request`, { data: {} });
  await goToTab(page, 'Credentials');
  await expect(page.getByTestId('credentials-screen')).toBeVisible();
  const credState = await (await request.get(`${hermes.origin}/__control/state`)).json();
  const requestId = credState.credRequests[0].id;
  await page.getByTestId(`credential-field-client_secret`).fill('super-secret');
  await page.getByTestId(`credential-fulfill-${requestId}`).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  const credStateAfter = await (await request.get(`${hermes.origin}/__control/state`)).json();
  expect(credStateAfter.credRequests[0].status).toBe('filled');
  expect(JSON.stringify(credStateAfter)).not.toContain('super-secret');
});

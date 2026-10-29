import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'node:crypto';

vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>)(...args) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    getItemAsync: async (key: string) => store.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { store.set(key, value); },
    deleteItemAsync: async (key: string) => { store.delete(key); },
  };
});
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'BASE64' },
  getRandomValues: (array: Uint8Array) => {
    const bytes = nodeCrypto.randomBytes(array.length);
    array.set(bytes);
    return array;
  },
  digestStringAsync: async (_algorithm: string, value: string) => nodeCrypto.createHash('sha256').update(value).digest('base64'),
}));

import { createFakeHermes } from '../fake-hermes/server.mjs';
import { discoverPasswordProvider, signInWithPassword } from '@/lib/hermes/auth';
import { getHermesClient, resetHermesClients } from '@/lib/hermes/client';
import { applyRunEvent, createActiveRun, decodeRunEvent } from '@/lib/hermes/run';
import { readSseStream } from '@/lib/hermes/sse';
import { toCredentialRequestView, toMessageRecords, splitCredentialRequests } from '@/lib/hermes/mapping';

let server: Awaited<ReturnType<typeof createFakeHermes>> & { start: () => Promise<string> };

beforeEach(async () => {
  resetHermesClients();
  server = createFakeHermes();
  await server.start();
});

afterEach(() => {
  server.close();
});

describe('hermes end-to-end against the fake server', () => {
  it('discovers the password provider and rejects a wrong password', async () => {
    const provider = await discoverPasswordProvider(server.url);
    expect(provider).toBe('basic');
    await expect(signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'nope' }))
      .rejects.toMatchObject({ message: 'Wrong username or password.' });
  });

  it('signs in with PKCE, lists and creates sessions, and runs a streamed chat turn', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    expect(auth.accessToken).toBeTruthy();
    expect(auth.refreshToken).toBeTruthy();

    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);

    expect(await client.api.listSessions()).toEqual([]);
    const session = await client.api.createSession();
    expect(session.id).toBeTruthy();

    const runId = await client.api.startRun({ input: 'Hello Hermes', session_id: session.id });
    expect(runId).toMatch(/^run_/);

    // Read the SSE stream the way the runs coordinator does.
    const response = await client.api.runEvents(runId);
    expect(response.ok).toBe(true);
    const run = createActiveRun(runId);
    for await (const message of readSseStream(response.body as ReadableStream<Uint8Array>)) {
      const event = decodeRunEvent(message.data);
      if (event) applyRunEvent(run, event);
      if (run.terminal) break;
    }
    expect(run.terminal?.event).toBe('run.completed');
    expect(run.terminal?.output).toBe('Hello from Hermes. (happy-path)');
    expect(run.tools.map((tool) => tool.status)).toEqual(['done']);

    // The user message is persisted at run start; the assistant turn lands
    // just before the terminal event.
    const messages = await client.api.listMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const records = toMessageRecords(messages, session.id);
    expect(records[0].info.role).toBe('user');
    const assistant = records.find((record) => record.info.role === 'assistant')!;
    expect(assistant.parts.some((part) => part.type === 'tool')).toBe(true);
  });

  it('refreshes an expired bearer transparently', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);
    // Expire the access token server-side by clearing the known token set.
    server.state.tokens.delete(auth.accessToken);
    const sessions = await client.api.listSessions();
    expect(sessions).toEqual([]);
    expect(client.getAuth()?.accessToken).not.toBe(auth.accessToken);
  });

  it('signs out when the refresh token is rejected', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);
    server.state.tokens.delete(auth.accessToken);
    server.state.refreshTokens.delete(auth.refreshToken);
    await expect(client.api.listSessions()).rejects.toMatchObject({ status: 401 });
    expect(client.getAuth()).toBeUndefined();
  });

  it('round-trips clarify questions and credential requests', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);

    const session = await client.api.createSession();
    // No clarify questions yet.
    expect(await client.api.getClarifications(session.id)).toEqual([]);

    // Seed one through the control plane.
    const seedResponse = await fetch(`${server.url}/__control/clarify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.id, run_id: 'run_x', questions: [{ qid: 'q0', question: 'Which colour?', choices: ['Red', 'Blue'], multi_select: false }] }),
    });
    const { entry } = (await seedResponse.json()) as { entry: { id: string } };

    const pending = await client.api.getClarifications(session.id);
    expect(pending.map((candidate) => candidate.id)).toEqual([entry.id]);
    await client.api.answerClarification(entry.id, { q0: 'Blue' });
    expect(await client.api.getClarifications(session.id)).toEqual([]);

    // Credential requests: seed, list, fulfill, cancel.
    await fetch(`${server.url}/__control/cred-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const requests = (await client.api.listCredentialRequests()).map(toCredentialRequestView);
    expect(requests).toHaveLength(1);
    const { pending: pendingCreds } = splitCredentialRequests(requests);
    expect(pendingCreds[0].pending).toBe(true);
    expect(pendingCreds[0].fields[0]).toMatchObject({ name: 'client_secret', kind: 'env', target: 'ACME_API_SECRET' });

    const fulfill = await client.api.fulfillCredentialRequest(pendingCreds[0].id, { client_secret: 'super-secret' });
    expect(fulfill.saved?.[0]).toMatchObject({ dest: 'env:ACME_API_SECRET' });
    const after = (await client.api.listCredentialRequests()).map(toCredentialRequestView);
    expect(after[0].status).toBe('filled');

    await fetch(`${server.url}/__control/cred-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const second = (await client.api.listCredentialRequests()).map(toCredentialRequestView).find((request) => request.pending)!;
    await client.api.cancelCredentialRequest(second.id);
    expect((await client.api.listCredentialRequests()).map(toCredentialRequestView).find((request) => request.id === second.id)?.status).toBe('cancelled');
  });

  it('expands skill slash commands through the plugin', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);

    const commands = await client.api.listSkillCommands();
    expect(commands.map((command) => command.name)).toContain('homelab-updates');
    const expanded = await client.api.expandSkillCommand('/homelab-updates quick check');
    expect(expanded.skill).toBe('homelab-updates');
    expect(expanded.input).toContain('homelab-updates');
    await expect(client.api.expandSkillCommand('/nope')).rejects.toMatchObject({ status: 404 });
  });

  it('stops a running turn through the plugin proxy', async () => {
    const auth = await signInWithPassword({ serverUrl: server.url, username: 'demo', password: 'demo' });
    const client = getHermesClient({ serverUrl: server.url, username: 'demo' });
    client.applyStoredAuth(auth);
    const session = await client.api.createSession();
    server.state.scenario = 'approval';
    const runId = await client.api.startRun({ input: 'do a risky thing', session_id: session.id });

    // The approval request arrives on the stream.
    const response = await client.api.runEvents(runId);
    const run = createActiveRun(runId);
    for await (const message of readSseStream(response.body as ReadableStream<Uint8Array>)) {
      const event = decodeRunEvent(message.data);
      if (event) applyRunEvent(run, event);
      if (run.approval) break;
    }
    expect(run.approval).toMatchObject({ requestId: 'req-1', command: 'bash' });

    await client.api.answerApproval(runId, 'once');
    await client.api.stopRun(runId);
    // The stop cancels pending clarifications server-side and ends the run.
    const state = server.state.runs.get(runId);
    expect(state?.stopped).toBe(true);
  });
});

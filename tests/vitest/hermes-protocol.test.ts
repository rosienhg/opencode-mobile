import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import nodeCrypto from 'node:crypto';

vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>)(...args) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-crypto', () => {
  const node = nodeCrypto;
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { BASE64: 'BASE64' },
    getRandomValues: (array: Uint8Array) => {
      for (let index = 0; index < array.length; index += 1) array[index] = index;
      return array;
    },
    digestStringAsync: async (_algorithm: string, value: string) => node.createHash('sha256').update(value).digest('base64'),
  };
});

import { createPkcePair } from '@/lib/hermes/pkce';
import { HermesError, parseHermesErrorBody } from '@/lib/hermes/errors';
import { applyLiveToolCalls, applyRunEvent, activeRunFailureMessage, createActiveRun, decodeRunEvent } from '@/lib/hermes/run';
import { readSseStream } from '@/lib/hermes/sse';
import {
  approvalToPendingPermission,
  clarifyAnswerToWire,
  clarifyToPendingQuestion,
  splitCredentialRequests,
  toMessageRecords,
  toModelOptions,
  toSessionView,
} from '@/lib/hermes/mapping';
import { HermesHttpClient } from '@/lib/hermes/http';
import type { RunEvent } from '@/lib/hermes/wire';

describe('hermes pkce', () => {
  it('builds an S256 challenge from a padded-free base64url verifier', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toHaveLength(43);
    expect(verifier).not.toMatch(/[+/=]/);
    const expected = nodeCrypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

describe('hermes errors', () => {
  it('prefers detail, then error.message, then the generic status text', () => {
    expect(parseHermesErrorBody({ detail: 'not proxied' }, 404).message).toBe('not proxied');
    expect(parseHermesErrorBody({ error: { message: 'provider down' } }, 500).message).toBe('provider down');
    expect(parseHermesErrorBody({ detail: [{ msg: 'field required' }] }, 400).message).toBe('field required');
    expect(parseHermesErrorBody({}, 502).message).toBe('Request failed (502).');
    expect(parseHermesErrorBody({}, 502)).toBeInstanceOf(HermesError);
  });
});

describe('run state machine', () => {
  it('streams deltas, tool steps, and terminal completion like ChatTimeline', () => {
    const run = createActiveRun('run_1');
    const events: RunEvent[] = [
      { event: 'run.started', seq: 0 },
      { event: 'reasoning.available', seq: 1, text: 'thinking' },
      { event: 'reasoning.available', seq: 2, text: 'thinking' },
      { event: 'tool.started', seq: 3, tool: 'terminal', preview: 'ls -la' },
      { event: 'tool.completed', seq: 4, tool: 'terminal', preview: 'a.txt', duration: 0.3 },
      { event: 'message.delta', seq: 5, delta: 'Hello ' },
      { event: 'message.delta', seq: 6, delta: 'world' },
      { event: 'run.completed', seq: 7, output: 'Hello world!' },
    ];
    for (const event of events) applyRunEvent(run, decodeRunEvent(JSON.stringify(event))!);
    expect(run.lastSeq).toBe(7);
    expect(run.reasoning).toEqual(['thinking']);
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({ tool: 'terminal', status: 'done', preview: 'a.txt', duration: 0.3 });
    expect(run.streamedText).toBe('Hello world');
    expect(run.terminal).toEqual({ event: 'run.completed', output: 'Hello world!', error: undefined });
  });

  it('tracks approvals and clears them on terminal events', () => {
    const run = createActiveRun('run_2');
    applyRunEvent(run, { event: 'approval.request', seq: 1, request_id: 'req_1', command: 'shell', description: 'ls', choices: ['once', 'session', 'deny'] });
    expect(run.approval).toMatchObject({ requestId: 'req_1', command: 'shell', choices: ['once', 'session', 'deny'] });
    applyRunEvent(run, { event: 'run.cancelled', seq: 2 });
    expect(run.approval).toBeUndefined();
    expect(run.terminal?.event).toBe('run.cancelled');
    expect(activeRunFailureMessage(run, (key) => key)).toBe('Stopped.');
  });

  it('treats every unknown run.* event as terminal and carries the error text', () => {
    const run = createActiveRun();
    applyRunEvent(run, { event: 'run.failed', seq: 3, error: 'provider down' });
    expect(run.terminal).toEqual({ event: 'run.failed', output: undefined, error: 'provider down' });
    expect(activeRunFailureMessage(run, (key) => key)).toBe('provider down');
  });

  it('matches live tool args by tool name in order', () => {
    const run = createActiveRun();
    applyRunEvent(run, { event: 'tool.started', seq: 1, tool: 'terminal', preview: 'one' });
    applyRunEvent(run, { event: 'tool.started', seq: 2, tool: 'terminal', preview: 'two' });
    applyRunEvent(run, { event: 'tool.completed', seq: 3, tool: 'terminal' });
    applyLiveToolCalls(run, [
      { tool: 'terminal', args: '{"command": "first"}' },
      { tool: 'terminal', args: '{"command": "second"}' },
    ]);
    expect(run.tools[0].fullArgs).toBe('{"command": "first"}');
    expect(run.tools[1].fullArgs).toBe('{"command": "second"}');
  });
});

describe('sse reader', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  }

  it('yields one message per data frame and ignores comments and ids', async () => {
    const frames = [
      ': keepalive\n\n',
      'id: 0\ndata: {"event":"run.started","seq":0}\n\n',
      'id: 1\ndata: {"event":"message.delta",\ndata: "split"}\n\n',
    ];
    const messages: string[] = [];
    for await (const message of readSseStream(streamOf(frames))) messages.push(message.data);
    expect(messages).toEqual([
      '{"event":"run.started","seq":0}',
      '{"event":"message.delta",\n"split"}',
    ]);
  });
});

describe('hermes mapping', () => {
  it('maps session summaries onto the app Session view', () => {
    const session = toSessionView({ id: 's1', title: '', preview: 'Hello the', started_at: 100, last_active: 200, model: 'anthropic/claude-sonnet-5', estimated_cost_usd: 0.5 });
    expect(session.title).toBe('Hello the');
    expect(session.time).toEqual({ created: 100_000, updated: 200_000 });
    expect(session.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    expect(session.cost).toBe(0.5);
  });

  it('assembles transcript records with tool results attached to their calls', () => {
    const records = toMessageRecords([
      { id: 1, role: 'user', content: 'list files', timestamp: 10 },
      {
        id: 2, role: 'assistant', content: 'Running ls', reasoning: 'need a listing', timestamp: 20,
        tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }],
      },
      { id: 3, role: 'tool', tool_name: 'terminal', tool_call_id: 'c1', content: 'a.txt', timestamp: 30 },
      { id: 4, role: 'assistant', content: 'done', timestamp: 40 },
      { id: 5, role: 'assistant', display_kind: 'hidden', content: 'internal', timestamp: 45 },
    ], 's1');
    expect(records).toHaveLength(4);
    const assistant = records[1];
    expect(assistant.parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool']);
    const tool = assistant.parts[2];
    expect(tool).toMatchObject({ type: 'tool', tool: 'terminal', state: { status: 'completed', output: 'a.txt' } });
    expect((tool as { state: { input: Record<string, unknown> } }).state.input).toEqual({ command: 'ls' });
  });

  it('builds model options only from authenticated providers', () => {
    const options = toModelOptions({
      model: 'mock/model',
      provider: 'mock',
      providers: [
        { slug: 'mock', name: 'Mock', authenticated: true, models: ['mock/model', 'mock/big'] },
        { slug: 'ghost', name: 'Ghost', authenticated: false, models: ['ghost/x'] },
        { slug: 'empty', name: 'Empty', authenticated: true, models: [] },
      ],
    });
    expect(options.map((option) => option.id)).toEqual(['mock|mock/model', 'mock|mock/big']);
    expect(options[0]).toMatchObject({ providerID: 'mock', providerLabel: 'Mock', modelID: 'mock/model' });
  });

  it('maps clarify entries into question-flow requests and back', () => {
    const request = clarifyToPendingQuestion({
      id: 'cq-1',
      session_id: 's1',
      questions: [
        { qid: 'q0', question: 'Which colour?', choices: ['Red', 'Blue'], multi_select: false },
        { qid: 'q1', question: 'Which tags?', choices: ['a', 'b'], multi_select: true },
      ],
    }, 's1');
    expect(request.questions[0]).toMatchObject({ question: 'Which colour?', multiple: false, custom: true, key: 'q0' });
    expect(request.questions[1].multiple).toBe(true);

    const wire = clarifyAnswerToWire(
      { id: 'cq-1', questions: [{ qid: 'q0', choices: ['Red', 'Blue'] }, { qid: 'q1', choices: ['a', 'b'], multi_select: true }] },
      [['Blue'], ['a', 'b']],
    );
    expect(wire).toEqual({ q0: 'Blue', q1: ['a', 'b'] });
    expect(clarifyAnswerToWire({ id: 'cq-1', questions: [{ qid: 'q0' }] }, [undefined])).toEqual({ q0: null });
  });

  it('maps run approvals onto permission requests', () => {
    const permission = approvalToPendingPermission({ request_id: 'req_9', command: 'bash', description: 'run tests', choices: ['once', 'session', 'deny'] }, 's1');
    expect(permission).toMatchObject({ id: 'req_9', sessionID: 's1', permission: 'bash', always: ['session'] });
    expect(permission?.metadata).toEqual({ description: 'run tests', choices: ['once', 'session', 'deny'] });
    expect(approvalToPendingPermission({ command: 'x' }, 's1')).toBeUndefined();
  });

  it('splits credential requests into pending and history', () => {
    const { pending, history } = splitCredentialRequests([
      { id: 'a', title: 'old', status: 'filled', pending: false, fields: [], saved: [], createdAt: 1 },
      { id: 'b', title: 'live', status: 'pending', pending: true, fields: [], saved: [], createdAt: 5 },
      { id: 'c', title: 'expired', status: 'pending', pending: false, fields: [], saved: [], createdAt: 3 },
    ]);
    expect(pending.map((request) => request.id)).toEqual(['b']);
    expect(history.map((request) => request.id)).toEqual(['c', 'a']);
  });
});

describe('hermes http client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes once on a 401 and retries the original request', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer stale') return new Response(JSON.stringify({ detail: 'expired' }), { status: 401 });
      if (auth === 'Bearer fresh') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if ((init?.url ?? '') === '') return new Response('bad', { status: 500 });
      return new Response('unexpected', { status: 500 });
    });
    // The refresh call itself: /auth/native/refresh has no Authorization header.
    const calls: { url: string; auth?: string; body?: string }[] = [];
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), auth: headers.Authorization, body: typeof init?.body === 'string' ? init.body : undefined });
      if (String(input).endsWith('/auth/native/refresh')) {
        return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', provider: 'basic' }), { status: 200 });
      }
      if (headers.Authorization === 'Bearer stale') return new Response(JSON.stringify({ detail: 'expired' }), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    let auth = { accessToken: 'stale', refreshToken: 'r1', provider: 'basic' };
    const client = new HermesHttpClient({
      baseUrl: 'http://hermes.local',
      getAuth: () => auth,
      onTokenRefreshed: (next) => { auth = next; },
      onSignedOut: () => { throw new Error('should not sign out'); },
    });
    const reply = await client.json<{ ok: boolean }>('/api/plugins/hermes-ios/gw/v1/health');
    expect(reply).toEqual({ ok: true });
    expect(auth.accessToken).toBe('fresh');
    expect(calls.some((call) => call.url.endsWith('/auth/native/refresh'))).toBe(true);
  });

  it('signs out when the refresh is rejected', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).endsWith('/auth/native/refresh')) return new Response(JSON.stringify({ detail: 'bad refresh token' }), { status: 401 });
      return new Response(JSON.stringify({ detail: 'expired' }), { status: 401 });
    });
    let signedOut = false;
    const client = new HermesHttpClient({
      baseUrl: 'http://hermes.local',
      getAuth: () => ({ accessToken: 'stale', refreshToken: 'r1', provider: 'basic' }),
      onTokenRefreshed: () => undefined,
      onSignedOut: () => { signedOut = true; },
    });
    await expect(client.json('/api/plugins/hermes-ios/gw/v1/health')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toBe(true);
  });
});

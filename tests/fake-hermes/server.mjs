// A fake Hermes Agent dashboard + hermes-ios plugin + hermes-cred-requests
// plugin, modeling the wire contract the MyHermit apps speak. Shapes follow
// myhermit's android/tools/mock_hermes.py and HermesCore. Built for the
// vitest/e2e harnesses: one server instance per worker, controlled through
// /__control.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';

const PKCE_COOKIE = 'hermes_session_pkce';


export function createFakeHermes(options = {}) {
  const state = {
    // auth
    users: options.users ?? [{ username: 'demo', password: 'demo' }],
    flows: new Map(), // pkce cookie value -> { challenge, state, redirect }
    codes: new Map(), // code -> challenge
    tokens: new Set(),
    refreshTokens: new Map(),
    // data
    sessions: [],
    messages: new Map(), // sessionId -> [chatMessage]
    nextMessageId: 1,
    runs: new Map(), // runId -> { sessionId, input, script, events, cursor, approvals, stopped, output }
    watches: new Map(), // runId -> sessionId
    clarify: new Map(), // clarifyId -> entry
    credRequests: [],
    skillCommands: options.skillCommands ?? [{ name: 'homelab-updates', description: 'Check the homelab for updates.' }],
    modelOptions: options.modelOptions ?? {
      model: 'nous/deepseek-v4.1-flash',
      provider: 'nous',
      providers: [
        { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['nous/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5'] },
      ],
    },
    pluginVersion: options.pluginVersion ?? '1.1.1',
    gatewayVersion: options.gatewayVersion ?? '0.21.5',
    scenario: options.scenario ?? 'happy-path',
    busyElsewhere: null,
  };

  const GW = '/api/plugins/hermes-ios/gw';

  function sessionSummary(session) {
    return session;
  }

  function addSession(fields = {}) {
    const session = {
      id: fields.id ?? `s-${state.sessions.length + 1}`,
      source: 'api_server',
      title: fields.title ?? '',
      started_at: fields.started_at ?? Date.now() / 1000,
      last_active: fields.last_active ?? Date.now() / 1000,
      message_count: fields.message_count ?? 0,
      preview: fields.preview ?? '',
      model: fields.model ?? 'nous/deepseek-v4.1-flash',
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
      ...fields,
    };
    state.sessions.unshift(session);
    state.messages.set(session.id, state.messages.get(session.id) ?? []);
    return session;
  }

  function addMessage(sessionId, message) {
    const list = state.messages.get(sessionId) ?? [];
    const record = { id: state.nextMessageId++, timestamp: Date.now() / 1000, ...message };
    list.push(record);
    state.messages.set(sessionId, list);
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (session) {
      session.message_count = list.length;
      session.last_active = record.timestamp;
      if (!session.title && record.role === 'user') session.preview = String(record.content ?? '').slice(0, 60);
    }
    return record;
  }

  // A scripted run emits canned events over its SSE stream, mimicking the
  // gateway's behavior: user message persisted at start, assistant message
  // persisted just before the terminal event.
  function buildScript(input, scenario) {
    const base = [
      { delay: 50, event: { event: 'run.started' } },
      { delay: 60, event: { event: 'reasoning.available', text: `${scenario} reasoning` } },
      { delay: 60, event: { event: 'tool.started', tool: 'terminal', preview: 'ls -la' } },
      { delay: 80, event: { event: 'tool.completed', tool: 'terminal', preview: 'a.txt\nb.txt', duration: 0.2 } },
      { delay: 60, event: { event: 'message.delta', delta: 'Hello ' } },
      { delay: 40, event: { event: 'message.delta', delta: 'from Hermes.' } },
    ];
    if (scenario === 'approval') {
      base.push({ delay: 60, event: { event: 'approval.request', request_id: 'req-1', command: 'bash', description: 'reboot the box', choices: ['once', 'session', 'deny'] } });
      // The stream stalls here until the approval is answered (control action).
    }
    base.push({ delay: 60, persist: { user: input, assistant: `Hello from Hermes. (${scenario})` }, event: { event: 'run.completed', output: `Hello from Hermes. (${scenario})` } });
    return base;
  }

  function startRun(sessionId, input, model) {
    const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const run = {
      runId,
      sessionId,
      input,
      model,
      script: buildScript(input, state.scenario),
      cursor: 0,
      startedAt: Date.now(),
      timers: [],
      output: null,
      stopped: false,
    };
    state.runs.set(runId, run);
    state.watches.set(runId, sessionId);
    addMessage(sessionId, { role: 'user', content: input });
    scheduleRun(run);
    return run;
  }

  function scheduleRun(run) {
    const advance = () => {
      if (run.stopped) return;
      const step = run.script[run.cursor];
      if (!step) return;
      if (step.waitApproval) {
        // Park until the approval is answered through the control/plugin API.
        run.timers.push(setTimeout(advance, 100));
        return;
      }
      run.cursor += 1;
      if (step.persist) {
        // The user message was already persisted when the run started; the
        // gateway writes the assistant turn (with its tool calls) just before
        // the terminal event.
        addMessage(run.sessionId, {
          role: 'assistant',
          content: step.persist.assistant,
          reasoning: 'The fake thought about it.',
          tool_calls: [{ id: 'call-1', function: { name: 'terminal', arguments: '{"command": "ls -la"}' } }],
        });
      }
      run.emitted?.(step.event);
      if (step.event?.event === 'run.completed') run.output = step.event.output;
      run.timers.push(setTimeout(advance, step.delay));
    };
    run.timers.push(setTimeout(advance, 10));
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1`);
    handler(request, response, url).catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ detail: String(error) }));
    });
  });

  function cors(request, response) {
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Last-Event-ID,Accept,Cookie');
    }
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  function authorized(request) {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return state.tokens.has(token);
  }

  function json(response, body, status = 200) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  }

  async function handler(request, response, url) {
    cors(request, response);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const path = url.pathname;
    const method = request.method ?? 'GET';

    // ---- Test control plane ----
    if (path.startsWith('/__control/')) {
      await control(method, path, url, request, response);
      return;
    }

    // ---- Auth (public) ----
    if (path === '/api/auth/providers' && method === 'GET') {
      json(response, { providers: [{ name: 'basic', supports_password: true }] });
      return;
    }
    if (path === '/auth/native/authorize' && method === 'GET') {
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const flowState = url.searchParams.get('state') ?? '';
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const cookie = randomUUID();
      state.flows.set(cookie, { challenge, state: flowState, redirect });
      response.setHeader('Set-Cookie', `${PKCE_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=None; Secure`);
      response.statusCode = 302;
      response.setHeader('Location', '/login');
      response.end();
      return;
    }
    if (path === '/auth/password-login' && method === 'POST') {
      const cookies = String(request.headers.cookie ?? '');
      const match = cookies.match(new RegExp(`${PKCE_COOKIE}=([^;]+)`));
      const flow = match ? state.flows.get(match[1]) : undefined;
      if (!flow) return json(response, { detail: 'missing PKCE cookie' }, 400);
      const body = await readBody(request);
      const user = state.users.find((entry) => entry.username === body.username && entry.password === body.password);
      if (!user) return json(response, { detail: 'bad credentials' }, 401);
      const code = randomUUID();
      state.codes.set(code, flow.challenge);
      json(response, { next: `${flow.redirect}?code=${code}&state=${flow.state}` });
      return;
    }
    if (path === '/auth/native/token' && method === 'POST') {
      const body = await readBody(request);
      const challenge = state.codes.get(body.code);
      const expected = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url');
      if (!challenge || challenge !== expected) return json(response, { detail: 'PKCE verification failed' }, 400);
      state.codes.delete(body.code);
      const token = randomUUID();
      state.tokens.add(token);
      const refresh = `r-${randomUUID()}`;
      state.refreshTokens.set(refresh, token);
      json(response, { access_token: token, refresh_token: refresh, expires_at: Date.now() / 1000 + 3600, provider: 'basic' });
      return;
    }
    if (path === '/auth/native/refresh' && method === 'POST') {
      const body = await readBody(request);
      const current = state.refreshTokens.get(body.refresh_token);
      if (!current) return json(response, { detail: 'bad refresh token' }, 401);
      state.refreshTokens.delete(body.refresh_token);
      const token = randomUUID();
      state.tokens.add(token);
      const refresh = `r-${randomUUID()}`;
      state.refreshTokens.set(refresh, token);
      json(response, { access_token: token, refresh_token: refresh });
      return;
    }

    // Everything below requires the dashboard bearer.
    if (!authorized(request)) return json(response, { detail: 'unauthorized' }, 401);

    // ---- Plugin status ----
    if (path === '/api/plugins/hermes-ios/status' && method === 'GET') {
      json(response, {
        version: state.pluginVersion,
        gateway: { reachable: true, version: state.gatewayVersion, key_configured: true, error: null },
        apns: { configured: false, missing: ['apns-cert.pem'], mode: 'token' },
        devices: [],
        watching_runs: state.watches.size,
      });
      return;
    }

    // ---- Gateway proxy ----
    if (path.startsWith(`${GW}/`)) {
      const upstream = path.slice(GW.length + 1);
      await gateway(method, upstream, url, request, response);
      return;
    }

    // ---- hermes-ios plugin routes ----
    if (path === '/api/plugins/hermes-ios/runs/active' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id') ?? '';
      let runId = null;
      for (const [candidate, owner] of state.watches) {
        if (owner === sessionId && state.runs.get(candidate) && !state.runs.get(candidate).output && !state.runs.get(candidate).stopped) runId = candidate;
      }
      json(response, { run_id: runId, busy_elsewhere: state.busyElsewhere });
      return;
    }
    const toolsMatch = path.match(/^\/api\/plugins\/hermes-ios\/runs\/([^/]+)\/tools$/);
    if (toolsMatch && method === 'GET') {
      json(response, { calls: [{ tool: 'terminal', args: '{"command": "ls -la"}', call_id: 'call-1', at: Date.now() / 1000 }] });
      return;
    }
    if (path === '/api/plugins/hermes-ios/clarify' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id');
      const pending = [...state.clarify.values()].filter((entry) => entry.status === 'pending' && (!sessionId || entry.session_id === sessionId));
      json(response, { pending });
      return;
    }
    if (path === '/api/plugins/hermes-ios/clarify/answer' && method === 'POST') {
      const body = await readBody(request);
      const entry = state.clarify.get(body.id);
      if (!entry || entry.status !== 'pending') return json(response, { detail: 'that question is no longer waiting for an answer' }, 409);
      entry.status = 'submitted';
      entry.answers = body.answers;
      entry.onAnswered?.();
      json(response, { ok: true });
      return;
    }
    if (path === '/api/plugins/hermes-ios/commands' && method === 'GET') {
      json(response, { skills: state.skillCommands });
      return;
    }
    const expandMatch = path === '/api/plugins/hermes-ios/commands/expand' && method === 'POST';
    if (expandMatch) {
      const body = await readBody(request);
      const text = String(body.text ?? '');
      const name = text.slice(1).split(/\s/)[0]?.toLowerCase();
      const skill = state.skillCommands.find((entry) => entry.name === name);
      if (!text.startsWith('/')) return json(response, { detail: 'not a slash command' }, 400);
      if (!skill) return json(response, { detail: `unknown command: ${text}` }, 404);
      const instruction = text.slice(1 + name.length).trim();
      json(response, {
        input: `[IMPORTANT: The user has invoked the "${skill.name}" skill. The user has provided the following instruction alongside the skill invocation: ${instruction || '(none)'}\n\n[Runtime note: skill expansion from the fake server]`,
        skill: skill.name,
      });
      return;
    }

    // ---- hermes-cred-requests plugin ----
    if (path === '/api/plugins/hermes-cred-requests/requests' && method === 'GET') {
      const now = Date.now();
      for (const request_ of state.credRequests) {
        request_.expired = request_.expires_at ? Date.parse(request_.expires_at) < now : false;
      }
      json(response, {
        url_base: 'http://hermes.local',
        tab_path: '/cred-requests',
        pending_count: state.credRequests.filter((entry) => entry.status === 'pending' && !entry.expired).length,
        requests: state.credRequests,
      });
      return;
    }
    if (path === '/api/plugins/hermes-cred-requests/fulfill' && method === 'POST') {
      const body = await readBody(request);
      const entry = state.credRequests.find((candidate) => candidate.id === body.id);
      if (!entry) return json(response, { detail: 'no such request' }, 404);
      if (entry.status !== 'pending') return json(response, { detail: `request is already ${entry.status}` }, 409);
      if (entry.expired) return json(response, { detail: 'request expired' }, 409);
      const values = body.values ?? {};
      const missing = entry.fields.filter((field) => !String(values[field.name] ?? '').trim());
      if (missing.length) return json(response, { detail: `still missing: ${missing.map((field) => field.label).join(', ')}` }, 400);
      const unknown = Object.keys(values).filter((key) => !entry.fields.some((field) => field.name === key));
      if (unknown.length) return json(response, { detail: `unknown field(s): ${unknown.join(', ')}` }, 400);
      entry.status = 'filled';
      entry.filled_at = new Date().toISOString();
      entry.saved = entry.fields.map((field) => ({ field: field.name, dest: `${field.dest.kind}:${field.dest.target}`, at: new Date().toISOString() }));
      json(response, { ok: true, saved: entry.saved });
      return;
    }
    if (path === '/api/plugins/hermes-cred-requests/cancel' && method === 'POST') {
      const body = await readBody(request);
      const entry = state.credRequests.find((candidate) => candidate.id === body.id);
      if (!entry) return json(response, { detail: 'no such request' }, 404);
      entry.status = 'cancelled';
      entry.cancelled_at = new Date().toISOString();
      json(response, { ok: true, id: entry.id, status: 'cancelled' });
      return;
    }

    json(response, { detail: `fake: no ${path}` }, 404);
  }

  async function gateway(method, upstream, url, request, response) {
    const sessionsMatch = upstream.match(/^api\/sessions$/);
    const sessionMatch = upstream.match(/^api\/sessions\/([^/]+)$/);
    const messagesMatch = upstream.match(/^api\/sessions\/([^/]+)\/messages$/);
    const forkMatch = upstream.match(/^api\/sessions\/([^/]+)\/fork$/);
    const runsMatch = upstream === 'v1/runs';
    const eventsMatch = upstream.match(/^v1\/runs\/([^/]+)\/events$/);
    const approvalMatch = upstream.match(/^v1\/runs\/([^/]+)\/approval$/);
    const stopMatch = upstream.match(/^v1\/runs\/([^/]+)\/stop$/);

    if (sessionsMatch && method === 'GET') {
      json(response, { data: state.sessions.map(sessionSummary) });
      return;
    }
    if (sessionsMatch && method === 'POST') {
      const session = addSession();
      json(response, { session: sessionSummary(session) });
      return;
    }
    if (sessionMatch && method === 'GET') {
      const session = state.sessions.find((entry) => entry.id === sessionMatch[1]);
      if (!session) return json(response, { detail: 'no such session' }, 404);
      json(response, { session: sessionSummary(session) });
      return;
    }
    if (sessionMatch && method === 'PATCH') {
      const session = state.sessions.find((entry) => entry.id === sessionMatch[1]);
      if (!session) return json(response, { detail: 'no such session' }, 404);
      const body = await readBody(request);
      session.title = String(body.title ?? session.title);
      json(response, { session: sessionSummary(session) });
      return;
    }
    if (sessionMatch && method === 'DELETE') {
      state.sessions = state.sessions.filter((entry) => entry.id !== sessionMatch[1]);
      state.messages.delete(sessionMatch[1]);
      response.statusCode = 200;
      response.end();
      return;
    }
    if (messagesMatch && method === 'GET') {
      const list = state.messages.get(messagesMatch[1]);
      if (!list) return json(response, { detail: 'no such session' }, 404);
      json(response, { data: list });
      return;
    }
    if (forkMatch && method === 'POST') {
      const source = state.sessions.find((entry) => entry.id === forkMatch[1]);
      if (!source) return json(response, { detail: 'no such session' }, 404);
      const copy = addSession({ title: `${source.title} (branch)` });
      state.messages.set(copy.id, (state.messages.get(source.id) ?? []).map((message) => ({ ...message, id: state.nextMessageId++ })));
      copy.message_count = state.messages.get(copy.id).length;
      json(response, { session: sessionSummary(copy) });
      return;
    }
    if (runsMatch && method === 'POST') {
      const body = await readBody(request);
      const session = state.sessions.find((entry) => entry.id === body.session_id);
      if (!session) return json(response, { detail: 'no such session' }, 404);
      if (body.model && !session.model) session.model = body.model;
      const run = startRun(body.session_id, String(body.input ?? ''), body.model);
      json(response, { run_id: run.runId });
      return;
    }
    if (stopMatch && method === 'POST') {
      const run = state.runs.get(stopMatch[1]);
      if (run) {
        run.stopped = true;
        for (const timer of run.timers) clearTimeout(timer);
        addMessage(run.sessionId, { role: 'assistant', content: run.state?.streamedText ?? '' });
        run.emitted?.({ event: 'run.cancelled' });
        for (const [id, entry] of state.clarify) {
          if (entry.run_id === run.runId && entry.status === 'pending') {
            entry.status = 'cancelled';
            entry.onAnswered?.();
          }
        }
      }
      json(response, { ok: true });
      return;
    }
    if (approvalMatch && method === 'POST') {
      const run = state.runs.get(approvalMatch[1]);
      if (!run) return json(response, { detail: 'no such run' }, 404);
      const body = await readBody(request);
      run.approvalAnswer = body.choice;
      run.emitted?.({ event: 'run.steered' });
      json(response, { ok: true });
      return;
    }
    if (eventsMatch && method === 'GET') {
      const run = state.runs.get(eventsMatch[1]);
      if (!run) return json(response, { detail: 'run not found' }, 404);
      response.statusCode = 200;
      response.setHeader('content-type', 'text/event-stream');
      response.setHeader('cache-control', 'no-cache');
      response.setHeader('x-accel-buffering', 'no');
      response.flushHeaders?.();
      let lastEventId = Number(request.headers['last-event-id'] ?? -1);
      let seq = -1;
      const queue = [];
      let closed = false;
      const flush = () => {
        while (queue.length && !closed) {
          const event = queue.shift();
          seq += 1;
          response.write(`id: ${seq}\ndata: ${JSON.stringify({ ...event, seq })}\n\n`);
        }
      };
      run.emitted = (event) => {
        queue.push(event);
        flush();
      };
      // Replay from the beginning unless Last-Event-ID resumes mid-stream.
      const script = run.script.flatMap((step) => [step.event]);
      const start = lastEventId >= 0 ? lastEventId + 1 : 0;
      for (let index = start; index < Math.min(script.length, run.cursor); index += 1) {
        queue.push(script[index]);
      }
      flush();
      run.emitted = (event) => {
        seq += 1;
        response.write(`id: ${seq}\ndata: ${JSON.stringify({ ...event, seq })}\n\n`);
      };
      // Emit any script steps not yet flushed while the stream is open.
      const tail = setInterval(() => {
        if (closed) {
          clearInterval(tail);
          return;
        }
        // Events between run.cursor and script length are emitted by the timer
        // loop; nothing to do here.
      }, 200);
      request.on('close', () => {
        closed = true;
        clearInterval(tail);
      });
      return;
    }
    if (upstream === 'v1/health' && method === 'GET') {
      json(response, { version: state.gatewayVersion });
      return;
    }
    if (upstream === 'api/model/options' && method === 'GET') {
      json(response, state.modelOptions);
      return;
    }
    if (upstream === 'api/jobs' && method === 'GET') {
      json(response, { jobs: [] });
      return;
    }
    json(response, { detail: 'not proxied' }, 404);
  }

  async function control(method, path, url, request, response) {
    if (method !== 'POST' && method !== 'GET') return json(response, { detail: 'unsupported' }, 405);
    if (path === '/__control/reset') {
      state.sessions = [];
      state.messages.clear();
      state.runs.clear();
      state.watches.clear();
      state.clarify.clear();
      state.credRequests = [];
      state.busyElsewhere = null;
      state.scenario = 'happy-path';
      json(response, { ok: true });
      return;
    }
    if (path === '/__control/scenario' && method === 'POST') {
      const body = await readBody(request);
      state.scenario = String(body.scenario ?? 'happy-path');
      json(response, { ok: true, scenario: state.scenario });
      return;
    }
    if (path === '/__control/state' && method === 'GET') {
      json(response, {
        sessions: state.sessions,
        messages: Object.fromEntries(state.messages),
        runs: Object.fromEntries([...state.runs.entries()].map(([id, run]) => [id, { sessionId: run.sessionId, output: run.output, cursor: run.cursor, stopped: run.stopped, approvalAnswer: run.approvalAnswer }])),
        clarify: [...state.clarify.values()],
        credRequests: state.credRequests,
        busyElsewhere: state.busyElsewhere,
        scenario: state.scenario,
      });
      return;
    }
    if (path === '/__control/sessions' && method === 'POST') {
      const body = await readBody(request);
      const session = addSession(body);
      for (const message of body.messages ?? []) addMessage(session.id, message);
      json(response, { session });
      return;
    }
    if (path === '/__control/clarify' && method === 'POST') {
      const body = await readBody(request);
      const id = `cq-${randomUUID().slice(0, 12)}`;
      const entry = {
        id,
        run_id: body.run_id ?? null,
        session_id: body.session_id,
        created: Date.now() / 1000,
        status: 'pending',
        questions: body.questions ?? [{ qid: 'q0', question: 'Which colour?', choices: ['Red', 'Blue'], multi_select: false }],
        answers: null,
      };
      state.clarify.set(id, entry);
      json(response, { entry });
      return;
    }
    if (path === '/__control/cred-request' && method === 'POST') {
      const body = await readBody(request);
      const id = `cr-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 4)}`;
      const entry = {
        id,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        title: body.title ?? 'Acme API credentials',
        why: body.why ?? 'so I can call the Acme API on your behalf',
        requester: 'agent',
        status: 'pending',
        filled_at: null,
        cancelled_at: null,
        note: '',
        fields: body.fields ?? [{ name: 'client_secret', label: 'Client secret', hint: 'From the Acme console', secret: true, dest: { kind: 'env', target: 'ACME_API_SECRET' } }],
        saved: [],
        expired: false,
      };
      state.credRequests.unshift(entry);
      json(response, { entry });
      return;
    }
    if (path === '/__control/busy-elsewhere' && method === 'POST') {
      const body = await readBody(request);
      state.busyElsewhere = body.text ?? null;
      if (body.text) {
        // Simulate an external turn by appending messages directly.
        const sessionId = body.session_id;
        if (sessionId) {
          addMessage(sessionId, { role: 'user', content: body.text });
          addMessage(sessionId, { role: 'assistant', content: body.reply ?? 'Working on it from the dashboard.' });
        }
      }
      json(response, { ok: true });
      return;
    }
    json(response, { detail: `fake: no ${path}` }, 404);
  }

  const listen = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });

  return {
    get url() { return `http://127.0.0.1:${this.port}`; },
    port: undefined,
    async start() {
      this.port = await listen;
      return this.url;
    },
    close() {
      for (const run of state.runs.values()) for (const timer of run.timers) clearTimeout(timer);
      server.close();
    },
    state,
  };
}

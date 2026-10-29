import type { HermesHttpClient } from '@/lib/hermes/http';
import type {
  ActiveRunReply,
  ChatMessage,
  ClarifyEntry,
  CredentialRequest,
  CredentialRequestsReply,
  LiveToolCall,
  ModelOptions,
  PluginStatus,
  SessionSummary,
  SkillCommand,
  StartRunReply,
  StartRunRequest,
} from '@/lib/hermes/wire';

// The hermes-ios plugin proxies an allowlist of Hermes gateway routes at
// /api/plugins/hermes-ios/gw/... and injects the API key server-side; the app
// never talks to the gateway directly.
export const HERMES_PLUGIN_PATH = '/api/plugins/hermes-ios';
export const HERMES_GATEWAY_PROXY_PATH = `${HERMES_PLUGIN_PATH}/gw`;
export const CRED_REQUESTS_PATH = '/api/plugins/hermes-cred-requests';

export const gw = (path: string) => `${HERMES_GATEWAY_PROXY_PATH}${path}`;

function jsonInit(method: string, body?: unknown): RequestInit {
  return { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}

export type HermesSessionsPage = { data?: SessionSummary[] };
export type HermesMessagesPage = { data?: ChatMessage[] };
export type HermesSessionReply = { session?: SessionSummary };

export type HermesApi = {
  // Sessions (through the gateway proxy).
  listSessions(limit?: number): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSummary>;
  getSession(sessionId: string): Promise<SessionSummary>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  forkSession(sessionId: string): Promise<SessionSummary>;
  listMessages(sessionId: string, options?: { inlineImages?: boolean }): Promise<ChatMessage[]>;

  // Runs.
  startRun(request: StartRunRequest): Promise<string>;
  stopRun(runId: string): Promise<void>;
  answerApproval(runId: string, choice: string): Promise<void>;
  runEvents(runId: string, options?: { lastEventId?: number; signal?: AbortSignal }): Promise<Response>;

  // Models / health.
  getModelOptions(): Promise<ModelOptions>;
  getHealth(): Promise<{ version?: string }>;

  // hermes-ios plugin.
  getPluginStatus(): Promise<PluginStatus>;
  getActiveRun(sessionId: string): Promise<ActiveRunReply>;
  getLiveToolCalls(runId: string): Promise<LiveToolCall[]>;
  getClarifications(sessionId?: string): Promise<ClarifyEntry[]>;
  answerClarification(id: string, answers: Record<string, string | string[] | null>): Promise<void>;
  listSkillCommands(): Promise<SkillCommand[]>;
  expandSkillCommand(text: string): Promise<{ input: string; skill: string }>;

  // hermes-cred-requests plugin.
  listCredentialRequests(): Promise<CredentialRequest[]>;
  fulfillCredentialRequest(id: string, values: Record<string, string>): Promise<{ saved?: { field?: string; dest?: string }[] }>;
  cancelCredentialRequest(id: string): Promise<void>;
};

export function createHermesApi(client: HermesHttpClient): HermesApi {
  const listSessions = async (limit = 100) => {
    const page = await client.json<HermesSessionsPage>(`${gw('/api/sessions')}?limit=${limit}`);
    return Array.isArray(page.data) ? page.data : [];
  };
  return {
    listSessions,
    createSession: async () => {
      const reply = await client.json<HermesSessionReply>(gw('/api/sessions'), jsonInit('POST', {}));
      if (!reply.session) throw missingFieldError('session');
      return reply.session;
    },
    getSession: async (sessionId) => {
      const reply = await client.json<HermesSessionReply>(gw(`/api/sessions/${encodeURIComponent(sessionId)}`));
      if (!reply.session) throw missingFieldError('session');
      return reply.session;
    },
    renameSession: (sessionId, title) => client.send(gw(`/api/sessions/${encodeURIComponent(sessionId)}`), jsonInit('PATCH', { title })),
    deleteSession: (sessionId) => client.send(gw(`/api/sessions/${encodeURIComponent(sessionId)}`), { method: 'DELETE' }),
    forkSession: async (sessionId) => {
      const reply = await client.json<HermesSessionReply>(gw(`/api/sessions/${encodeURIComponent(sessionId)}/fork`), jsonInit('POST', {}));
      if (!reply.session) throw missingFieldError('session');
      return reply.session;
    },
    listMessages: async (sessionId, options) => {
      const inlineImages = options?.inlineImages === true;
      const page = await client.json<HermesMessagesPage>(`${gw(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)}?inline_images=${inlineImages}`);
      return Array.isArray(page.data) ? page.data : [];
    },

    startRun: async (request) => {
      const reply = await client.json<StartRunReply>(gw('/v1/runs'), jsonInit('POST', request));
      if (!reply.run_id) throw missingFieldError('run_id');
      return reply.run_id;
    },
    stopRun: (runId) => client.send(gw(`/v1/runs/${encodeURIComponent(runId)}/stop`), jsonInit('POST', {})),
    answerApproval: (runId, choice) => client.send(gw(`/v1/runs/${encodeURIComponent(runId)}/approval`), jsonInit('POST', { choice })),
    runEvents: (runId, options) => client.stream(gw(`/v1/runs/${encodeURIComponent(runId)}/events`), {
      headers: options?.lastEventId !== undefined ? { 'Last-Event-ID': String(options.lastEventId) } : undefined,
      signal: options?.signal,
    }),

    getModelOptions: () => client.json<ModelOptions>(gw('/api/model/options')),
    getHealth: () => client.json<{ version?: string }>(gw('/v1/health')),

    getPluginStatus: () => client.json<PluginStatus>(`${HERMES_PLUGIN_PATH}/status`),
    getActiveRun: (sessionId) => client.json<ActiveRunReply>(`${HERMES_PLUGIN_PATH}/runs/active?session_id=${encodeURIComponent(sessionId)}`),
    getLiveToolCalls: (runId) => client.json<{ calls?: LiveToolCall[] }>(`${HERMES_PLUGIN_PATH}/runs/${encodeURIComponent(runId)}/tools`).then((reply) => reply.calls ?? []),
    getClarifications: async (sessionId) => {
      const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const reply = await client.json<{ pending?: ClarifyEntry[] }>(`${HERMES_PLUGIN_PATH}/clarify${query}`);
      return reply.pending ?? [];
    },
    answerClarification: (id, answers) => client.send(`${HERMES_PLUGIN_PATH}/clarify/answer`, jsonInit('POST', { id, answers })),
    listSkillCommands: async () => {
      const reply = await client.json<{ skills?: SkillCommand[] }>(`${HERMES_PLUGIN_PATH}/commands`);
      return reply.skills ?? [];
    },
    expandSkillCommand: async (text) => {
      const reply = await client.json<{ input?: string; skill?: string }>(`${HERMES_PLUGIN_PATH}/commands/expand`, jsonInit('POST', { text }));
      if (!reply.input) throw missingFieldError('input');
      return { input: reply.input, skill: reply.skill ?? '' };
    },

    listCredentialRequests: async () => {
      const reply = await client.json<CredentialRequestsReply>(`${CRED_REQUESTS_PATH}/requests`);
      return reply.requests ?? [];
    },
    fulfillCredentialRequest: (id, values) => client.json<{ saved?: { field?: string; dest?: string }[] }>(`${CRED_REQUESTS_PATH}/fulfill`, jsonInit('POST', { id, values })),
    cancelCredentialRequest: (id) => client.send(`${CRED_REQUESTS_PATH}/cancel`, jsonInit('POST', { id })),
  };
}

function missingFieldError(field: string): Error {
  return new Error(`The server sent a reply the app did not understand (missing ${field}).`);
}

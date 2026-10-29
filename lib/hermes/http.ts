import { fetch as expoFetch } from 'expo/fetch';

import { HermesError, parseHermesErrorBody } from '@/lib/hermes/errors';
import { refreshAccessToken } from '@/lib/hermes/auth';
import type { TokenReply } from '@/lib/hermes/wire';

export type HermesAuthState = {
  accessToken: string;
  refreshToken: string;
  provider: string;
  expiresAt?: number;
};

export type HermesHttpClientOptions = {
  baseUrl: string;
  getAuth: () => HermesAuthState | undefined;
  /** Persist a refreshed token set. */
  onTokenRefreshed: (auth: HermesAuthState) => void;
  /** The session is unrecoverable (refresh rejected): sign out. */
  onSignedOut: () => void;
};

async function readError(response: Response): Promise<HermesError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  return parseHermesErrorBody(body, response.status);
}

// Authorized dashboard HTTP client. Every request carries the dashboard bearer;
// a 401 triggers one single-flight refresh and a retry, and a second 401 (or a
// rejected refresh) signs the app out — the same contract as HermesConnection.
export class HermesHttpClient {
  readonly baseUrl: string;
  private readonly options: HermesHttpClientOptions;
  private refreshTask: Promise<void> | undefined;

  constructor(options: HermesHttpClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl;
  }

  private async ensureFresh(): Promise<void> {
    const auth = this.options.getAuth();
    if (!auth) throw new HermesError('Your session expired. Sign in again.', 401);
    if (!this.refreshTask) {
      this.refreshTask = (async () => {
        const current = this.options.getAuth();
        if (!current) throw new HermesError('Your session expired. Sign in again.', 401);
        try {
          const reply = await refreshAccessToken(this.baseUrl, current.refreshToken, current.provider);
          const next: HermesAuthState = {
            accessToken: reply.access_token,
            refreshToken: reply.refresh_token,
            provider: reply.provider ?? current.provider,
            expiresAt: reply.expires_at ?? current.expiresAt,
          };
          this.options.onTokenRefreshed(next);
        } catch (error) {
          this.options.onSignedOut();
          throw error instanceof HermesError ? new HermesError('Your session expired. Sign in again.', 401) : new HermesError('Your session expired. Sign in again.', 401);
        }
      })().finally(() => {
        this.refreshTask = undefined;
      });
    }
    return this.refreshTask;
  }

  private async raw(path: string, init: RequestInit | undefined, auth: HermesAuthState | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined ?? {}),
    };
    if (auth) headers.Authorization = `Bearer ${auth.accessToken}`;
    if (init?.body != null && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    return fetch(`${this.baseUrl}${path}`, { ...init, headers, credentials: 'include' });
  }

  // Non-streaming request. Returns the Response for callers that need status
  // code semantics (setup flows read 404s).
  async request(path: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.raw(path, init, this.options.getAuth());
      if (response.status !== 401 || attempt === 1) return response;
      await response.body?.cancel().catch(() => undefined);
      try {
        await this.ensureFresh();
      } catch {
        throw new HermesError('Your session expired. Sign in again.', 401);
      }
    }
    throw new HermesError('Request failed.', 500);
  }

  // JSON request that throws on non-2xx with the parsed Hermes error body.
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await readError(response);
    try {
      return await response.json() as T;
    } catch {
      throw new HermesError('The server sent a reply the app did not understand.', response.status);
    }
  }

  // Fire-and-forget JSON body (2xx required, payload ignored).
  async send(path: string, init?: RequestInit): Promise<void> {
    const response = await this.request(path, init);
    if (!response.ok) throw await readError(response);
    await response.body?.cancel().catch(() => undefined);
  }

  // Streaming request for SSE. Never retried here; the caller owns
  // Last-Event-ID resume logic. Uses expo/fetch for streaming body support.
  async stream(path: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await expoFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'text/event-stream', ...(init?.headers as Record<string, string> | undefined ?? {}), Authorization: `Bearer ${this.options.getAuth()?.accessToken ?? ''}` },
        credentials: 'include',
      });
      if (response.status !== 401 || attempt === 1) return response as unknown as Response;
      try {
        await this.ensureFresh();
      } catch {
        throw new HermesError('Your session expired. Sign in again.', 401);
      }
    }
    throw new HermesError('Request failed.', 500);
  }

  // Public refresh entry point for proactive token renewal.
  async refresh(): Promise<TokenReply | undefined> {
    await this.ensureFresh();
    return undefined;
  }
}

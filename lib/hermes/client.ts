import { hermesBaseUrl } from '@/lib/hermes/auth';
import { HermesError } from '@/lib/hermes/errors';
import { HermesHttpClient, type HermesAuthState } from '@/lib/hermes/http';
import { createHermesApi, type HermesApi } from '@/lib/hermes/api';
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, type StoredAuth } from '@/lib/hermes/tokens';
import { getConnectionScope, type ConnectionIdentity } from '@/lib/connection-scope';

export type HermesClient = {
  identity: ConnectionIdentity;
  http: HermesHttpClient;
  api: HermesApi;
  getAuth: () => HermesAuthState | undefined;
  /** Loads persisted tokens for this identity, if any. */
  loadStoredAuth: () => Promise<StoredAuth | undefined>;
  applyStoredAuth: (auth: StoredAuth) => void;
  signOut: () => Promise<void>;
  /** Fires when the token set changes or the session is signed out. */
  onAuthChanged: (listener: () => void) => () => void;
};

type HermesClientInternal = HermesClient & {
  notifyAuthChanged: () => void;
};

// One Hermes client per connection identity, shared by every consumer (provider
// runtime, notification monitor, widgets). A single instance keeps the refresh
// single-flight across all of them; per-runtime state listens via onAuthChanged.
const clients = new Map<string, HermesClientInternal>();

export function getHermesClient(identity: ConnectionIdentity): HermesClient {
  const scope = getConnectionScope(identity);
  const existing = clients.get(scope);
  if (existing) return existing;

  const baseUrl = hermesBaseUrl(identity.serverUrl);
  let auth: HermesAuthState | undefined;
  const listeners = new Set<() => void>();

  const http = new HermesHttpClient({
    baseUrl,
    getAuth: () => auth,
    onTokenRefreshed: (next) => {
      auth = next;
      void saveStoredAuth(toStoredAuth(next, identity, baseUrl), identity).catch(() => undefined);
      notify();
    },
    onSignedOut: () => {
      auth = undefined;
      void clearStoredAuth(identity).catch(() => undefined);
      notify();
    },
  });
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors are their own */ } } };

  const client: HermesClientInternal = {
    identity,
    http,
    api: createHermesApi(http),
    getAuth: () => auth,
    loadStoredAuth: () => loadStoredAuth(identity),
    applyStoredAuth: (stored) => {
      auth = {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        provider: stored.provider,
        expiresAt: stored.expiresAt,
      };
      notify();
    },
    signOut: async () => {
      auth = undefined;
      await clearStoredAuth(identity).catch(() => undefined);
      notify();
    },
    onAuthChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyAuthChanged: notify,
  };
  clients.set(scope, client);
  return client;
}

// Test hook: drop every pooled client so suites start from a clean auth state.
export function resetHermesClients(): void {
  clients.clear();
}

function toStoredAuth(state: HermesAuthState, identity: ConnectionIdentity, baseUrl: string): StoredAuth {
  return {
    server: baseUrl,
    username: identity.username,
    provider: state.provider,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    expiresAt: state.expiresAt,
  };
}

export { HermesError };

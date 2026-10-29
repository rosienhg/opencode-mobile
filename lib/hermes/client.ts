import { hermesBaseUrl } from '@/lib/hermes/auth';
import { HermesError } from '@/lib/hermes/errors';
import { HermesHttpClient, type HermesAuthState } from '@/lib/hermes/http';
import { createHermesApi, type HermesApi } from '@/lib/hermes/api';
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, type StoredAuth } from '@/lib/hermes/tokens';
import type { ConnectionIdentity } from '@/lib/connection-scope';

export type HermesClient = {
  identity: ConnectionIdentity;
  http: HermesHttpClient;
  api: HermesApi;
  getAuth: () => HermesAuthState | undefined;
  /** Loads persisted tokens for this identity, if any. */
  loadStoredAuth: () => Promise<StoredAuth | undefined>;
  applyStoredAuth: (auth: StoredAuth) => void;
  signOut: () => Promise<void>;
};

// One Hermes client per connection identity. Token persistence is keyed by the
// connection scope, so the same server with a different user is a different
// session.
export function buildHermesClient(identity: ConnectionIdentity, hooks: { onSignedOut?: () => void } = {}): HermesClient {
  const baseUrl = hermesBaseUrl(identity.serverUrl);
  let auth: HermesAuthState | undefined;

  const http = new HermesHttpClient({
    baseUrl,
    getAuth: () => auth,
    onTokenRefreshed: (next) => {
      auth = next;
      void saveStoredAuth(toStoredAuth(next, identity, baseUrl), identity).catch(() => undefined);
    },
    onSignedOut: () => {
      auth = undefined;
      void clearStoredAuth(identity).catch(() => undefined);
      hooks.onSignedOut?.();
    },
  });

  return {
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
    },
    signOut: async () => {
      auth = undefined;
      await clearStoredAuth(identity).catch(() => undefined);
    },
  };
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

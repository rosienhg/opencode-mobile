import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getConnectionScope, type ConnectionIdentity } from '@/lib/connection-scope';

// Mirrors StoredAuth in HermesCore: everything needed to keep a signed-in
// session without remembering the password. Persisted in SecureStore under a
// key derived from the connection scope, so two Hermes servers (or two users)
// never share tokens. Web has no SecureStore; E2E builds keep secrets in a
// process-local map that intentionally vanishes on reload.
export type StoredAuth = {
  server: string;
  username: string;
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
};

const webSecrets = new Map<string, string>();

function authStorageKey(identity: ConnectionIdentity): string {
  return `hermes.auth.${getConnectionScope(identity)}`;
}

export async function loadStoredAuth(identity: ConnectionIdentity): Promise<StoredAuth | undefined> {
  const raw = Platform.OS === 'web'
    ? webSecrets.get(authStorageKey(identity))
    : await SecureStore.getItemAsync(authStorageKey(identity));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.accessToken || !parsed.refreshToken) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveStoredAuth(auth: StoredAuth, identity: ConnectionIdentity): Promise<void> {
  const raw = JSON.stringify(auth);
  if (Platform.OS === 'web') {
    if (auth.accessToken) webSecrets.set(authStorageKey(identity), raw); else webSecrets.delete(authStorageKey(identity));
    return;
  }
  await SecureStore.setItemAsync(authStorageKey(identity), raw, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export async function clearStoredAuth(identity: ConnectionIdentity): Promise<void> {
  if (Platform.OS === 'web') {
    webSecrets.delete(authStorageKey(identity));
    return;
  }
  await SecureStore.deleteItemAsync(authStorageKey(identity));
}

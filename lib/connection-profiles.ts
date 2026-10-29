import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

import { parseWorkspaces, WORKSPACES_STORAGE_KEY } from '@/providers/workspace-storage';
import { getConnectionPassword } from '@/lib/connection-password';
import {
  getProfileHeaders,
  getConnectionHeaders,
  type ConnectionHeaders,
} from '@/lib/connection-headers';
import { getWebSecret, setWebSecret } from '@/lib/secure-web-store';
import { getConnectionScope, type ConnectionIdentity } from '@/lib/connection-scope';
import { CONNECTION_PROFILES_STORAGE_KEY, SETTINGS_STORAGE_KEY } from '@/lib/storage-keys';
import { normalizeAutoModelPreferences } from '@/lib/auto-model/preferences';
import type { ChatPreferences } from '@/providers/opencode-preferences';
import { isValidServerUrl, stripServerUrlCredentials } from '@/lib/opencode/client/url';

// Saved connection metadata is non-secret and lives in AsyncStorage. Passwords
// are stored per profile in SecureStore and are never part of this model.
type ProfileModelPreferences = Pick<
  ChatPreferences,
  'providerId' | 'modelId' | 'enabledModelIds' | 'providerModelSelections' | 'recentModelIds' | 'autoModel'
>;

export type ConnectionProfile = {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
  // Partial because older writes may not carry every field; unknown fields are
  // ignored and each present field is validated before it is applied.
  modelPreferences?: Partial<ProfileModelPreferences>;
};

// SecureStore keys may only contain alphanumerics, ".", "-" and "_".
function passwordKey(profileId: string) {
  return `opencode-mobile.connection-profile-password.${profileId}`;
}

export function createProfileId() {
  return randomUUID();
}

export function pickModelPreferences(preferences: ChatPreferences): ProfileModelPreferences {
  return {
    providerId: preferences.providerId,
    modelId: preferences.modelId,
    enabledModelIds: [...preferences.enabledModelIds],
    providerModelSelections: { ...preferences.providerModelSelections },
    recentModelIds: [...preferences.recentModelIds],
    autoModel: {
      ...preferences.autoModel,
      tiers: { ...preferences.autoModel.tiers },
    },
  };
}

const ProfileModelPreferencesSchema = z.object({
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  enabledModelIds: z.array(z.string()).nullish().transform((value) => value ?? undefined),
  providerModelSelections: z.record(z.string(), z.string()).nullish().transform((value) => value ?? undefined),
  recentModelIds: z.array(z.string()).nullish().transform((value) => value ?? undefined),
  autoModel: z.unknown().optional().transform((value) => (
    value === undefined ? undefined : normalizeAutoModelPreferences(value)
  )),
});
const ConnectionProfileSchema = z.object({
  id: z.string().refine((value) => value.trim().length > 0),
  name: z.string().refine((value) => value.trim().length > 0),
  serverUrl: z.string().refine((value) => value.trim().length > 0),
  username: z.string(),
  modelPreferences: ProfileModelPreferencesSchema.nullish().transform((value) => value ?? undefined),
});

// Validates the whole persisted DTO, including model preferences. Unknown
// fields are ignored; an entry with any malformed known field is dropped so a
// corrupt value can never hydrate a partial profile.
export function toConnectionProfile(value: unknown): ConnectionProfile | undefined {
  const parsed = ConnectionProfileSchema.safeParse(value);
  if (!parsed.success) return undefined;

  const { id, name, serverUrl, username, modelPreferences } = parsed.data;
  const trimmedUsername = username.trim();

  const parsedPreferences = modelPreferences && Object.keys(modelPreferences).length > 0
    ? modelPreferences as Partial<ProfileModelPreferences>
    : undefined;

  return {
    id: id.trim(),
    name: name.trim(),
    serverUrl: stripServerUrlCredentials(serverUrl),
    username: trimmedUsername,
    ...(parsedPreferences ? { modelPreferences: parsedPreferences } : {}),
  };
}

export function findProfileByConnectionScope(profiles: ConnectionProfile[], connectionScope: string) {
  return profiles.find((profile) => getConnectionScope(profile) === connectionScope);
}

export function findMatchingProfile(profiles: ConnectionProfile[], identity: ConnectionIdentity) {
  return findProfileByConnectionScope(profiles, getConnectionScope(identity));
}

async function writeConnectionProfiles(profiles: ConnectionProfile[]) {
  await AsyncStorage.setItem(CONNECTION_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

let profileMutations: Promise<unknown> = Promise.resolve();
function serializeProfiles<T>(operation: () => Promise<T>) {
  const result = profileMutations.then(operation);
  profileMutations = result.catch(() => undefined);
  return result;
}

export function loadConnectionProfiles(strict = false) {
  return serializeProfiles(() => readConnectionProfiles(strict));
}

// Credential changes and metadata rollback must finish before another writer reads.
export function mutateConnectionProfiles<T>(operation: (profiles: ConnectionProfile[], save: typeof writeConnectionProfiles) => Promise<T>) {
  return serializeProfiles(async () => operation(await readConnectionProfiles(true), writeSanitizedProfiles));
}

async function readConnectionProfiles(strict = false): Promise<ConnectionProfile[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(CONNECTION_PROFILES_STORAGE_KEY);
  } catch (error) {
    if (strict) throw error;
    // A transient read failure leaves the stored value untouched.
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await AsyncStorage.removeItem(CONNECTION_PROFILES_STORAGE_KEY).catch(() => undefined);
    return [];
  }
  if (!Array.isArray(parsed)) {
    await AsyncStorage.removeItem(CONNECTION_PROFILES_STORAGE_KEY).catch(() => undefined);
    return [];
  }

  const profiles = parsed.map(toConnectionProfile).filter((profile): profile is ConnectionProfile => profile !== undefined);
  // Rewrite when the stored value carried unexpected fields or dropped
  // entries, so plain AsyncStorage never keeps anything the model excludes.
  if (JSON.stringify(profiles) !== raw) {
    await writeConnectionProfiles(profiles).catch(() => undefined);
  }
  return profiles;
}

async function writeSanitizedProfiles(profiles: ConnectionProfile[]) {
  const sanitized = profiles
    .map(toConnectionProfile)
    .filter((profile): profile is ConnectionProfile => profile !== undefined);
  await writeConnectionProfiles(sanitized);
}

/**
 * Resolves credentials for a connection that may no longer be the active one.
 *
 * Resolution order:
 * 1. the saved profile whose scope matches (password in SecureStore),
 * 2. the active connection when the record belongs to it, which also covers a
 *    connection that has not been saved as a profile yet.
 *
 * Returns `undefined` when no credential is available. Callers must keep the
 * pending record instead of dropping it or borrowing another connection's
 * password. Gateway headers travel with the same resolution.
 */
export async function resolveConnectionCredentials(identity: ConnectionIdentity): Promise<{ password: string; headers: ConnectionHeaders } | undefined> {
  if (!identity.serverUrl.trim() || !isValidServerUrl(identity.serverUrl)) return undefined;
  const connectionScope = getConnectionScope(identity);
  // Background notifications and widget actions honor explicit disconnects too.
  try {
    const raw = await AsyncStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (raw && !parseWorkspaces(raw).connections.some((entry) => entry.enabled && getConnectionScope(entry.settings) === connectionScope)) return undefined;
  } catch { return undefined; }

  try {
    const profiles = await loadConnectionProfiles();
    const profile = findProfileByConnectionScope(profiles, connectionScope);
    if (profile) {
      const [password, headers] = await Promise.all([getProfilePassword(profile.id), getProfileHeaders(profile.id)]);
      return password ? { password, headers } : undefined;
    }
  } catch {
    // Fall through to the active connection.
  }

  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return undefined;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings.serverUrl !== 'string') return undefined;
    const activeScope = getConnectionScope({
      serverUrl: settings.serverUrl,
      username: typeof settings.username === 'string' ? settings.username : '',
    });
    if (activeScope !== connectionScope) return undefined;
    const [password, headers] = await Promise.all([getConnectionPassword(), getConnectionHeaders()]);
    return { password: password || '', headers };
  } catch {
    return undefined;
  }
}

export async function getProfilePassword(profileId: string) {
  if (Platform.OS === 'web') return getWebSecret(passwordKey(profileId));
  return (await SecureStore.getItemAsync(passwordKey(profileId))) ?? '';
}

export async function saveProfilePassword(profileId: string, password: string, background = false) {
  if (Platform.OS === 'web') { setWebSecret(passwordKey(profileId), password); return; }
  if (password) {
    await SecureStore.setItemAsync(passwordKey(profileId), password, background ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY } : undefined);
    return;
  }
  await SecureStore.deleteItemAsync(passwordKey(profileId));
}

export async function deleteProfilePassword(profileId: string) {
  if (Platform.OS === 'web') { setWebSecret(passwordKey(profileId), ''); return; }
  await SecureStore.deleteItemAsync(passwordKey(profileId));
}

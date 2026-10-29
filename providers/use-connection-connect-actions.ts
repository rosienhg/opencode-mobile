import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  classifyConnectionFailure,
  detectServerContract,
  getConnectionError,
  getNormalizedServerUrl,
  isValidServerUrl,
  buildClient,
  type ConnectionFailureKind,
  type OpencodeConnectionSettings,
  type ServerContract,
} from '@/lib/opencode/client';
import { signInWithPassword } from '@/lib/hermes/auth';
import { HermesError } from '@/lib/hermes/errors';
import type { ChatPreferences, ConnectionState } from '@/providers/opencode-provider-types';
import type { ConnectionConnectInput } from '@/providers/opencode-provider-action-inputs';

// Joining concurrent connects is keyed on the exact credentials and generation
// so a rotation that lands mid-flight starts a new attempt instead of adopting
// stale credentials.
function getConnectRequestKey(settings: OpencodeConnectionSettings, generation: number) {
  return [generation, settings.serverUrl, settings.username, settings.password].join('\u0000');
}

export function useConnectionConnectActions({
  settings,
  setSettings,
  clearProjectState,
  isHydrated: _isHydrated,
  isCurrentCatalogClient: _isCurrentCatalogClient,
  loadProjectCatalog,
  setSessions,
  setSessionStatuses,
  setCurrentConfig,
  setAvailableProviders,
  setProviderAuthMethodsById,
  setAvailableModels,
  setAvailableAgents,
  setConnection,
  setServerContract,
  settingsRef,
  setChatPreferences,
  serverContractRef,
  connectionRef,
  serverGenerationRef,
  catalogGenerationRef,
  scopeGenerationRef,
  initialConnectStartedRef,
}: ConnectionConnectInput) {
  const { t } = useTranslation();
  // Keep connect callbacks stable across renders while still formatting errors
  // with the active language.
  const translateRef = useRef(t);
  useLayoutEffect(() => { translateRef.current = t; });
  const connectInFlightRef = useRef<{ key: string; promise: Promise<ConnectionState> } | undefined>(undefined);

  const clearServerState = useCallback(() => {
    setSessions([]);
    setSessionStatuses({});
    setCurrentConfig(undefined);
    setAvailableProviders([]);
    setProviderAuthMethodsById({});
    setAvailableModels([]);
    setAvailableAgents([]);
  }, [setAvailableAgents, setAvailableModels, setAvailableProviders, setProviderAuthMethodsById, setCurrentConfig, setSessionStatuses, setSessions]);

  const performConnect = useCallback(async (targetSettings: OpencodeConnectionSettings): Promise<ConnectionState> => {
    initialConnectStartedRef.current = true;
    const generation = serverGenerationRef.current;
    const current = () => generation === serverGenerationRef.current;
    if (!isValidServerUrl(targetSettings.serverUrl)) {
      const failed: ConnectionState = {
        status: 'error',
        message: getConnectionError(targetSettings.serverUrl, new Error('Invalid server URL.'), translateRef.current),
        kind: 'unknown',
        checkedAt: Date.now(),
      };
      setConnection(failed);
      return failed;
    }

    setConnection({
      status: 'connecting',
      message: `Connecting to ${getNormalizedServerUrl(targetSettings.serverUrl)}...`,
    });

    const client = buildClient({ ...targetSettings, directory: '' }, 'hermes');
    catalogGenerationRef.current.set(client, serverGenerationRef.current);

    // Hermes dashboards answer /api/auth/providers without auth; a server that
    // answers with an OpenCode contract is a mis-entered address.
    let serverContract: ServerContract = 'hermes';
    let contractError: string | undefined;
    try {
      const detected = await detectServerContract(targetSettings);
      if (detected.contract !== 'hermes') {
        contractError = 'That address is not a Hermes dashboard. Enter the URL of your Hermes Agent server.';
      } else {
        serverContract = 'hermes';
      }
    } catch {
      // Unreachable or unknown: keep going so the sign-in attempt produces the
      // precise transport error instead of a probe-shaped guess.
    }
    if (!current()) return connectionRef.current;

    if (!contractError) {
      // Silent path: tokens from an earlier sign-in may still be valid.
      const stored = await client.hermes!.loadStoredAuth();
      if (stored) {
        client.hermes!.applyStoredAuth(stored);
        try {
          await client.hermes!.api.getPluginStatus();
          if (!current()) return connectionRef.current;
          if (serverContractRef.current !== serverContract) {
            serverContractRef.current = serverContract;
            setServerContract(serverContract);
          }
          const connected: ConnectionState = {
            status: 'connected',
            message: `Connected to ${getNormalizedServerUrl(targetSettings.serverUrl)}`,
            checkedAt: Date.now(),
          };
          setConnection(connected);
          await loadProjectCatalog(true, client);
          return connected;
        } catch (error) {
          if (!current()) return connectionRef.current;
          if (!((error as HermesError)?.status === 401)) {
            // Plugin missing or gateway down: surface it instead of re-signing in.
            throw error;
          }
          // Tokens are dead; fall through to a fresh sign-in below.
        }
      }
    }

    if (contractError) {
      const failed: ConnectionState = {
        status: 'error',
        message: contractError,
        kind: 'server-incompatible',
        checkedAt: Date.now(),
      };
      setConnection(failed);
      return failed;
    }

    if (!targetSettings.username.trim() || !targetSettings.password) {
      const failed: ConnectionState = {
        status: 'error',
        message: 'Sign in to your Hermes dashboard to connect.',
        kind: 'auth',
        checkedAt: Date.now(),
      };
      setConnection(failed);
      return failed;
    }

    try {
      const stored = await signInWithPassword({
        serverUrl: targetSettings.serverUrl,
        username: targetSettings.username,
        password: targetSettings.password,
      });
      if (!current()) return connectionRef.current;
      client.hermes!.applyStoredAuth(stored);
    } catch (error) {
      if (!current()) return connectionRef.current;
      const failed: ConnectionState = {
        status: 'error',
        message: error instanceof HermesError ? error.message : 'Could not sign in to the Hermes dashboard.',
        kind: 'auth',
        checkedAt: Date.now(),
      };
      setConnection(failed);
      return failed;
    }

    try {
      // The plugin proxy is what makes the app work; without it there is
      // nothing to talk to. Its 404 is the canonical "not mounted" signal.
      await client.hermes!.api.getPluginStatus();
      if (!current()) return connectionRef.current;
    } catch (error) {
      if (!current()) return connectionRef.current;
      const status = (error as HermesError).status;
      const failed: ConnectionState = {
        status: 'error',
        message: status === 404
          ? 'The hermes-ios plugin is not installed on this server. Install it with `plugin/install.sh` and restart the dashboard.'
          : error instanceof HermesError ? error.message : 'The hermes-ios plugin is not reachable on this server.',
        kind: status === 404 ? 'server-incompatible' : classifyConnectionFailure(error),
        checkedAt: Date.now(),
      };
      setConnection(failed);
      clearServerState();
      return failed;
    }

    if (serverContractRef.current !== serverContract) {
      serverContractRef.current = serverContract;
      setServerContract(serverContract);
    }

    const connected: ConnectionState = {
      status: 'connected',
      message: `Connected to ${getNormalizedServerUrl(targetSettings.serverUrl)}`,
      checkedAt: Date.now(),
    };
    setConnection(connected);

    try {
      await loadProjectCatalog(true, client);
    } catch {
      if (!current()) return connectionRef.current;
      clearServerState();
    }
    return connected;
  }, [catalogGenerationRef, clearServerState, initialConnectStartedRef, loadProjectCatalog, serverContractRef, serverGenerationRef, setConnection, setServerContract]);

  const runConnect = useCallback((targetSettings: OpencodeConnectionSettings) => {
    const inFlight = connectInFlightRef.current;
    if (inFlight && inFlight.key === getConnectRequestKey(targetSettings, serverGenerationRef.current)) return inFlight.promise;
    const record = { key: '', promise: Promise.resolve(connectionRef.current) };
    record.promise = performConnect(targetSettings).finally(() => {
      if (connectInFlightRef.current === record) connectInFlightRef.current = undefined;
    });
    record.key = getConnectRequestKey(targetSettings, serverGenerationRef.current);
    connectInFlightRef.current = record;
    return record.promise;
  }, [connectionRef, performConnect, serverGenerationRef]);

  const connect = useCallback(() => runConnect(settingsRef.current), [runConnect, settingsRef]);

  // A revoked session cannot heal by retrying with the same tokens: drop the
  // server-derived state and ask for a fresh sign-in.
  const handleStreamAuthFailure = useCallback((_kind: ConnectionFailureKind) => {
    scopeGenerationRef.current += 1;
    serverGenerationRef.current += 1;
    clearProjectState();
    setConnection({
      status: 'error',
      kind: 'auth',
      message: 'Your Hermes session expired. Sign in again.',
      checkedAt: Date.now(),
    });
  }, [clearProjectState, scopeGenerationRef, serverGenerationRef, setConnection]);

  const updateSettings = useCallback((patch: Partial<OpencodeConnectionSettings>) => {
    const connectionChanged = (['serverUrl', 'username', 'password'] as const)
      .some((key) => patch[key] !== undefined && patch[key] !== settingsRef.current[key]);
    if (connectionChanged) {
      scopeGenerationRef.current += 1;
      serverGenerationRef.current += 1;
      setConnection({ status: 'idle', message: 'Connection settings changed. Reconnect to apply them.' });
      clearProjectState();
      setSessions([]);
      setSessionStatuses({});
    }
    setSettings((current) => ({
      ...current,
      ...patch,
    }));
  }, [clearProjectState, scopeGenerationRef, serverGenerationRef, settingsRef, setConnection, setSessionStatuses, setSessions, setSettings]);

  const switchConnection = useCallback(async (
    next: Pick<OpencodeConnectionSettings, 'serverUrl' | 'username' | 'password'>,
    modelPreferences?: Partial<ChatPreferences>,
  ) => {
    const targetSettings: OpencodeConnectionSettings = {
      ...settingsRef.current,
      ...next,
    };
    updateSettings(next);
    settingsRef.current = targetSettings;
    if (modelPreferences) {
      setChatPreferences((current) => ({ ...current, ...modelPreferences }));
    }
    return runConnect(targetSettings);
  }, [runConnect, setChatPreferences, settingsRef, updateSettings]);

  return { connect, updateSettings, switchConnection, handleStreamAuthFailure };
}

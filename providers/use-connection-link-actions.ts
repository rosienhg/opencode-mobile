import { useCallback } from 'react';

import { findProfileByConnectionScope, getProfilePassword, loadConnectionProfiles } from '@/lib/connection-profiles';
import type { SessionDeepLinkTarget } from '@/providers/opencode-provider-types';
import type { ConnectionActionsInput } from '@/providers/opencode-provider-action-inputs';
import type { useConnectionConnectActions } from '@/providers/use-connection-connect-actions';

type ConnectionLinkActionsInput = ConnectionActionsInput
  & Pick<ReturnType<typeof useConnectionConnectActions>, 'connect' | 'switchConnection'>;

// External entry points (notification taps, session links) land here. Hermes
// has no project directories: a target is a connection scope plus a session id.
export function useConnectionLinkActions({
  connect,
  switchConnection,
  connectionRef,
  connectionScopeRef,
  setCurrentSessionId,
  serverGenerationRef,
}: ConnectionLinkActionsInput) {
  const waitForConnectionScope = useCallback(async (scope: string, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (connectionScopeRef.current !== scope && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return connectionScopeRef.current === scope;
  }, [connectionScopeRef]);

  const switchToScope = useCallback(async (scope: string) => {
    if (scope === connectionScopeRef.current) return;
    const profile = findProfileByConnectionScope(await loadConnectionProfiles(), scope);
    if (!profile) throw new Error('The saved connection for this session no longer exists.');
    const password = await getProfilePassword(profile.id);
    await switchConnection({ serverUrl: profile.serverUrl, username: profile.username, password });
    if (!await waitForConnectionScope(scope)) throw new Error('Could not switch to the connection that owns this session.');
  }, [connectionScopeRef, switchConnection, waitForConnectionScope]);

  const openDeepLinkSession = useCallback(
    async (target: SessionDeepLinkTarget, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> => {
      const sessionId = target.sessionId.trim();
      if (!sessionId) {
        return { ok: false, error: 'This session link is missing a session ID.' };
      }
      try {
        if (target.connectionScope) {
          await switchToScope(target.connectionScope);
        }
        const status = () => connectionRef.current.status;
        if (status() !== 'connected') {
          if (status() !== 'connecting') {
            await connect();
          }
          const connectDeadline = Date.now() + 20000;
          while (status() === 'connecting' && Date.now() < connectDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          if (status() !== 'connected') {
            return { ok: false, error: connectionRef.current.message || 'Could not connect to the server.' };
          }
        }
        if (signal?.aborted) return { ok: false, error: 'This session link was cancelled.' };
        const generation = serverGenerationRef.current;
        setCurrentSessionId(sessionId);
        // A session id from a notification may predate the session list read;
        // the next sessions refresh reconciles the title.
        void generation;
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Could not open this session link.' };
      }
    },
    [connect, connectionRef, setCurrentSessionId, serverGenerationRef, switchToScope],
  );

  const openSessionInProject = useCallback(async (_projectPath: string, sessionId: string, targetConnectionScope?: string) => {
    if (targetConnectionScope && targetConnectionScope !== connectionScopeRef.current) {
      await switchToScope(targetConnectionScope);
    }
    const result = await openDeepLinkSession({ sessionId });
    if (!result.ok) {
      throw new Error(result.error || 'Could not open the session.');
    }
  }, [connectionScopeRef, openDeepLinkSession, switchToScope]);

  return { openDeepLinkSession, openSessionInProject };
}

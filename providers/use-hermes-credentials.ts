import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ScopedOpencodeClient } from '@/lib/opencode/client';
import { HermesError } from '@/lib/hermes/errors';
import { splitCredentialRequests, toCredentialRequestView, type CredentialRequestView } from '@/lib/hermes/mapping';

export type HermesCredentialsState = {
  requests: CredentialRequestView[];
  pending: CredentialRequestView[];
  history: CredentialRequestView[];
  // The hermes-cred-requests plugin is not installed on this server.
  pluginMissing: boolean;
  loading: boolean;
  error?: string;
  load: () => Promise<void>;
  fulfill: (id: string, values: Record<string, string>) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

// The Credentials domain: pending credential requests filed by the agent are
// listed on open/pull-to-refresh (matching MyHermit's polling-free cadence)
// and fulfilled with per-field secret entry. Values never persist.
export function useHermesCredentials(client: ScopedOpencodeClient, connected: boolean): HermesCredentialsState {
  const inputRef = useRef({ client, connected });
  useLayoutEffect(() => { inputRef.current = { client, connected }; });

  const [requests, setRequests] = useState<CredentialRequestView[]>([]);
  const [pluginMissing, setPluginMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!inputRef.current.connected || !inputRef.current.client.hermes) return;
    setLoading(true);
    setError(undefined);
    try {
      const views = (await inputRef.current.client.hermes.api.listCredentialRequests()).map(toCredentialRequestView);
      setRequests(views);
      setPluginMissing(false);
    } catch (reason) {
      if ((reason as HermesError).status === 404) {
        setPluginMissing(true);
        setRequests([]);
      } else {
        setError(reason instanceof Error ? reason.message : 'Could not load credential requests.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fulfill = useCallback(async (id: string, values: Record<string, string>) => {
    const hermes = inputRef.current.client.hermes;
    if (!hermes) throw new Error('Not connected.');
    try {
      await hermes.api.fulfillCredentialRequest(id, values);
      // The saved destinations come back from the server; values are dropped.
      await load();
    } catch (reason) {
      throw reason instanceof HermesError ? reason : new Error(reason instanceof Error ? reason.message : 'Could not save the credentials.');
    }
  }, [load]);

  const cancel = useCallback(async (id: string) => {
    const hermes = inputRef.current.client.hermes;
    if (!hermes) throw new Error('Not connected.');
    await hermes.api.cancelCredentialRequest(id);
    await load();
  }, [load]);

  const split = useMemo(() => splitCredentialRequests(requests), [requests]);

  return {
    requests,
    pending: split.pending,
    history: split.history,
    pluginMissing,
    loading,
    error,
    load,
    fulfill,
    cancel,
  };
}

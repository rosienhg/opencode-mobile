import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ScopedOpencodeClient } from '@/lib/opencode/client';
import type { SessionMessageRecord } from '@/lib/opencode/format';
import type { TranscriptRefreshMode } from '@/providers/opencode-provider-types';
import type { PendingPrompt } from '@/lib/opencode/prompt-inbox';
import type { ChatPreferences } from '@/providers/opencode-preferences';
import type { ModelOption } from '@/providers/opencode-model-selection';
import { pendingNotificationKey } from '@/lib/notification-pending';
import type { HermesRuns } from '@/providers/use-hermes-runs';

export type HermesPromptsInput = {
  client: ScopedOpencodeClient;
  isCurrentClient: (candidate: object) => boolean;
  connected: boolean;
  online: boolean;
  connectionScope: string;
  chatPreferences: ChatPreferences;
  availableModels: ModelOption[];
  skillCommandNames: string[];
  runs: HermesRuns;
  busyNotificationsRef: { current: Set<string> };
  promptSubmissionRef: { current: { active: boolean; sessionId?: string } };
  refreshMessages: (sessionId: string, silent?: boolean, options?: { mode?: TranscriptRefreshMode }) => Promise<SessionMessageRecord[]>;
};

// Hermes prompt admission: POST /v1/runs and stream the result. While a run is
// live on a session, plain text queues client-side (the gateway runs one turn
// at a time) — the same behavior as MyHermit's MessageQueue.
export function useHermesPrompts(input: HermesPromptsInput) {
  const {
    client,
    isCurrentClient,
    connectionScope,
    chatPreferences,
    availableModels,
    skillCommandNames,
    runs,
    busyNotificationsRef,
    promptSubmissionRef,
    refreshMessages,
  } = input;

  const inputRef = useRef(input);
  useLayoutEffect(() => { inputRef.current = input; });

  const [sendingState, setSendingState] = useState<{ sessionId?: string; active: boolean }>({ active: false });
  const [promptError, setPromptError] = useState<{ message: string; occurredAt: number; sessionId?: string }>();

  const startRun = useCallback(async (sessionId: string, text: string): Promise<void> => {
    const hermes = client.hermes!;
    const modelId = chatPreferences.modelId?.trim();
    let model: string | undefined;
    let provider: string | undefined;
    if (modelId) {
      const selected = availableModels.find((option) => option.id === modelId);
      if (selected) {
        model = selected.modelID;
        provider = selected.providerID;
      }
    }
    // Skill commands must be expanded server-side before they become a run;
    // only known skill names go through the expand round-trip.
    let runInput = text;
    const draft = text.trim();
    if (draft.startsWith('/')) {
      const name = draft.slice(1).split(/\s/)[0]?.toLowerCase().replace(/_/g, '-') ?? '';
      if (name && skillCommandNames.includes(name)) {
        const expanded = await hermes.api.expandSkillCommand(draft);
        runInput = expanded.input;
      }
    }
    const runId = await hermes.api.startRun({
      input: runInput,
      session_id: sessionId,
      ...(model && provider ? { model, provider } : {}),
    });
    runs.registerRun(sessionId, runId, text.trim());
  }, [availableModels, chatPreferences.modelId, client, runs, skillCommandNames]);

  const sendPrompt = useCallback(async (
    sessionId: string,
    prompt: string,
    attachments?: { uri: string; mime?: string; filename?: string }[],
  ): Promise<boolean> => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return false;
    if (!isCurrentClient(client) || promptSubmissionRef.current.active) return false;
    if (attachments && attachments.length > 0) {
      setPromptError({ message: 'Hermes runs do not support attachments yet.', occurredAt: Date.now(), sessionId });
      return false;
    }
    if (!inputRef.current.connected || !inputRef.current.online) {
      // Offline: queue like the OpenCode inbox does, flushed when the
      // connection returns.
      runs.enqueuePrompt(sessionId, trimmedPrompt);
      return true;
    }

    const submission = { active: true, sessionId, requestedAt: Date.now(), owner: connectionScope };
    promptSubmissionRef.current = submission;
    setSendingState({ active: true, sessionId });
    setPromptError(undefined);
    busyNotificationsRef.current.delete(pendingNotificationKey(connectionScope, sessionId));

    try {
      if (runs.hasActiveRun(sessionId)) {
        runs.enqueuePrompt(sessionId, trimmedPrompt);
        promptSubmissionRef.current = { active: false };
        setSendingState({ active: false, sessionId: undefined });
        return true;
      }
      await startRun(sessionId, trimmedPrompt);
      promptSubmissionRef.current = { active: false };
      return true;
    } catch (error) {
      promptSubmissionRef.current = { active: false };
      setSendingState({ active: false, sessionId: undefined });
      setPromptError({
        message: error instanceof Error ? error.message : 'Hermes could not start that run.',
        occurredAt: Date.now(),
        sessionId,
      });
      return false;
    }
  }, [busyNotificationsRef, client, connectionScope, isCurrentClient, promptSubmissionRef, runs, startRun]);

  // After each terminal run event the first queued message goes out.
  const sendNextQueued = useCallback(async (sessionId: string) => {
    const first = runs.getQueue(sessionId)[0];
    if (!first) return;
    runs.removeQueued(sessionId, first.id);
    await sendPrompt(sessionId, first.text).catch(() => undefined);
  }, [runs, sendPrompt]);

  const cancelPrompt = useCallback(async (sessionId: string, promptId: string) => {
    runs.removeQueued(sessionId, promptId);
  }, [runs]);

  const abortSession = useCallback(async (sessionId: string) => {
    await runs.stopRun(sessionId).catch(() => undefined);
  }, [runs]);

  const pendingPromptsBySession = useMemo((): Record<string, PendingPrompt[]> => {
    const result: Record<string, PendingPrompt[]> = {};
    for (const [sessionId, queue] of Object.entries(runs.promptQueueBySession)) {
      result[sessionId] = queue.map((entry) => ({
        id: entry.id,
        sessionId,
        createdAt: entry.createdAt,
        text: entry.text,
        delivery: 'queue' as const,
        state: 'queued' as const,
        attachments: [],
      }));
    }
    return result;
  }, [runs.promptQueueBySession]);

  const clearPromptError = useCallback(() => setPromptError(undefined), []);

  return {
    sendPrompt,
    abortSession,
    sendNextQueued,
    cancelPrompt,
    pendingPromptsBySession,
    sendingState,
    setSendingState,
    promptError,
    setPromptError,
    clearPromptError,
  };
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ScopedOpencodeClient } from '@/lib/opencode/client';
import type { SessionMessageRecord } from '@/lib/opencode/format';
import type { SessionStatus } from '@/lib/opencode/types';
import type { PendingPermissionRequest, PendingQuestionRequest } from '@/lib/opencode/client/types';
import { HermesError } from '@/lib/hermes/errors';
import {
  activeRunFailureMessage,
  applyLiveToolCalls,
  applyRunEvent,
  cloneRunState,
  createActiveRun,
  type ActiveRun,
} from '@/lib/hermes/run';
import { readSseStream } from '@/lib/hermes/sse';
import {
  approvalToPendingPermission,
  clarifyAnswerToWire,
  clarifyToPendingQuestion,
  hermesSessionStatus,
} from '@/lib/hermes/mapping';
import { isTerminalRunEvent, type ClarifyEntry, type LiveToolCall, type RunEvent } from '@/lib/hermes/wire';
import { buildHermesLiveRecords } from '@/providers/hermes-live-records';

export type HermesPromptQueueEntry = { id: string; sessionId: string; text: string; createdAt: number };

// Immutable view of one in-flight run, published as React state so the render
// path never touches the mutable loop objects below.
export type HermesRunView = {
  runId: string;
  sessionId: string;
  prompt: string;
  startedAt: number;
  state: ActiveRun;
};

type ManagedRun = HermesRunView & {
  controller: AbortController;
};

const SSE_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 16000];
const CLARIFY_POLL_MS = 2000;
const ACTIVE_RUN_POLL_MS = 15_000;
const BUSY_ELSEWHERE_POLL_MS = 3000;

export type HermesRunsInput = {
  client: ScopedOpencodeClient;
  isCurrentClient: (candidate: object) => boolean;
  connected: boolean;
  online: boolean;
  currentSessionId?: string;
  refreshMessages: (sessionId: string, silent?: boolean) => Promise<SessionMessageRecord[]>;
  refreshSessions: () => Promise<unknown>;
  setSessionStatuses: (updater: (current: Record<string, SessionStatus>) => Record<string, SessionStatus>) => void;
  setPendingPermissionsBySession: (updater: (current: Record<string, PendingPermissionRequest[]>) => Record<string, PendingPermissionRequest[]>) => void;
  setPendingQuestionsBySession: (updater: (current: Record<string, PendingQuestionRequest[]>) => Record<string, PendingQuestionRequest[]>) => void;
  onAuthFailure?: () => void;
  onRunEnded?: (sessionId: string) => void;
};

export type HermesRuns = ReturnType<typeof useHermesRuns>;

// Owns every Hermes run the app knows about: the SSE attach loop with
// Last-Event-ID resume, approvals, live tool args, clarify polling, and the
// per-session busy status. Prompt queueing and sending live in
// use-hermes-prompts; this hook is the shared substrate both use.
export function useHermesRuns(input: HermesRunsInput) {
  const {
    client,
    isCurrentClient,
    connected,
    online,
    currentSessionId,
    refreshMessages,
    setSessionStatuses,
    setPendingPermissionsBySession,
    setPendingQuestionsBySession,
  } = input;

  // The input object is rebuilt every render; callbacks below must stay
  // referentially stable so effect loops never restart on unrelated renders.
  const inputRef = useRef(input);
  useLayoutEffect(() => { inputRef.current = input; });

  const [runs, setRuns] = useState<Record<string, HermesRunView>>({});
  const [runsRevision, setRunsRevision] = useState(0);
  const [liveRunCount, setLiveRunCount] = useState(0);
  const [promptQueueBySession, setPromptQueueBySession] = useState<Record<string, HermesPromptQueueEntry[]>>({});
  const [attachedStreams, setAttachedStreams] = useState(0);
  const clarifyEntriesRef = useRef(new Map<string, ClarifyEntry>());
  const queueCounterRef = useRef(0);
  // Mutable loop bookkeeping, only touched from effects and callbacks.
  const controllersRef = useRef(new Map<string, AbortController>());

  const eventStreamStatus: 'idle' | 'connecting' | 'connected' | 'error' = connected
    ? (attachedStreams > 0 ? 'connected' : 'idle')
    : 'idle';

  const publishRun = useCallback((managed: ManagedRun) => {
    setRuns((current) => ({ ...current, [managed.sessionId]: { runId: managed.runId, sessionId: managed.sessionId, prompt: managed.prompt, startedAt: managed.startedAt, state: managed.state } }));
  }, []);

  const publishState = useCallback((sessionId: string, state: ActiveRun) => {
    setRuns((current) => {
      const existing = current[sessionId];
      if (!existing) return current;
      return { ...current, [sessionId]: { ...existing, state } };
    });
  }, []);

  const setStatus = useCallback((sessionId: string, busy: boolean) => {
    setSessionStatuses((current) => {
      const next = hermesSessionStatus(busy);
      if (JSON.stringify(current[sessionId]) === JSON.stringify(next)) return current;
      return { ...current, [sessionId]: next };
    });
  }, [setSessionStatuses]);

  // ---- Live transcript projection -----------------------------------------
  // The Hermes gateway persists the user message when the run starts and the
  // assistant turn when it finishes; while the run is live the transcript must
  // render the streamed state instead.

  const liveRecordsBySession = useMemo(() => {
    const result: Record<string, SessionMessageRecord[]> = {};
    for (const run of Object.values(runs)) {
      result[run.sessionId] = buildHermesLiveRecords(run);
    }
    return result;
  }, [runs]);

  // Texts of prompts whose user record may not be on the server yet.
  const pendingUserTexts = useMemo(() => {
    const texts: Record<string, string[]> = {};
    for (const run of Object.values(runs)) {
      if (!run.prompt) continue;
      (texts[run.sessionId] ??= []).push(run.prompt);
    }
    return texts;
  }, [runs]);

  // ---- Attach loop ---------------------------------------------------------

  const endRun = useCallback(async (managed: ManagedRun) => {
    const sessionId = managed.sessionId;
    managed.controller.abort();
    controllersRef.current.delete(sessionId);
    setRuns((current) => {
      if (!current[sessionId] || current[sessionId].runId !== managed.runId) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setRunsRevision((current) => current + 1);
    setStatus(sessionId, false);
    await inputRef.current.refreshMessages(sessionId, true).catch(() => undefined);
    await inputRef.current.refreshSessions().catch(() => undefined);
    inputRef.current.onRunEnded?.(sessionId);
    // Hermes upgrades untitled sessions with a quick title in the background;
    // re-read once after the typical upgrade window.
    setTimeout(() => {
      void inputRef.current.refreshSessions().catch(() => undefined);
    }, 10_000);
  }, [setStatus]);

  const refreshLiveToolCalls = useCallback(async (sessionId: string, runId: string, state: ActiveRun) => {
    if (!inputRef.current.isCurrentClient(client)) return;
    try {
      const calls: LiveToolCall[] = await client.hermes!.api.getLiveToolCalls(runId);
      const nextState = cloneRunState(state);
      applyLiveToolCalls(nextState, calls);
      publishState(sessionId, nextState);
    } catch {
      // Full args are cosmetic; the preview stays until the next event.
    }
  }, [client, publishState]);

  const attachRun = useCallback((managed: ManagedRun, options?: { fromStart?: boolean }) => {
    const hermes = client.hermes!;
    let state = managed.state;
    void (async () => {
      let backoffIndex = 0;
      setAttachedStreams((current) => current + 1);
      try {
        while (!managed.controller.signal.aborted) {
          try {
            const response = await hermes.api.runEvents(managed.runId, {
              lastEventId: options?.fromStart ? undefined : state.lastSeq,
              signal: managed.controller.signal,
            });
            if (response.status === 404) {
              // The run no longer exists (finished elsewhere or a gateway
              // restart): drop it and rebuild the transcript from the server.
              await endRun(managed);
              return;
            }
            if (response.status === 401) {
              inputRef.current.onAuthFailure?.();
              return;
            }
            if (!response.ok || !response.body) {
              throw new HermesError(`Run stream failed (${response.status}).`, response.status);
            }
            backoffIndex = 0;
            let sawTerminal = false;
            let toolArgsTimer: ReturnType<typeof setTimeout> | undefined;
            const scheduleToolArgsFetch = () => {
              clearTimeout(toolArgsTimer);
              toolArgsTimer = setTimeout(() => { void refreshLiveToolCalls(managed.sessionId, managed.runId, state); }, 300);
            };
            try {
              for await (const message of readSseStream(response.body as ReadableStream<Uint8Array>, managed.controller.signal)) {
                const event = decodeSafely(message.data);
                if (!event) continue;
                state = cloneRunState(state);
                applyRunEvent(state, event);
                if (event.event === 'tool.started' || event.event === 'tool.completed') scheduleToolArgsFetch();
                if (event.event === 'approval.request') {
                  const permission = approvalToPendingPermission(event as unknown as Record<string, unknown>, managed.sessionId);
                  if (permission) {
                    const permissionId = permission.id;
                    setPendingPermissionsBySession((current) => {
                      const existing = current[managed.sessionId] ?? [];
                      if (existing.some((entry) => entry.id === permissionId)) return current;
                      return { ...current, [managed.sessionId]: [...existing, permission] };
                    });
                  }
                }
                publishState(managed.sessionId, state);
                if (isTerminalRunEvent(event.event)) {
                  sawTerminal = true;
                  break;
                }
              }
            } finally {
              clearTimeout(toolArgsTimer);
            }
            if (managed.controller.signal.aborted) return;
            if (sawTerminal) {
              activeRunFailureMessage(state, (key) => key);
              await endRun(managed);
              return;
            }
            // Stream closed without a terminal event: resume with Last-Event-ID.
          } catch (error) {
            if (managed.controller.signal.aborted) return;
            if ((error as HermesError)?.status === 404) {
              await endRun(managed);
              return;
            }
            if ((error as HermesError)?.status === 401) {
              inputRef.current.onAuthFailure?.();
              return;
            }
          }
          const delay = SSE_BACKOFF_MS[Math.min(backoffIndex, SSE_BACKOFF_MS.length - 1)];
          backoffIndex += 1;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            managed.controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          options = undefined; // resume from the last applied sequence, never from zero
        }
      } catch {
        // The loop never throws past its own error handling.
      } finally {
        setAttachedStreams((current) => Math.max(0, current - 1));
      }
    })();
  }, [client, endRun, publishState, refreshLiveToolCalls, setPendingPermissionsBySession]);

  const registerRun = useCallback((sessionId: string, runId: string, prompt: string, options?: { fromStart?: boolean }) => {
    const previous = controllersRef.current.get(sessionId);
    if (previous) previous.abort();
    const managed: ManagedRun = {
      runId,
      sessionId,
      prompt,
      startedAt: Date.now(),
      state: createActiveRun(runId),
      controller: new AbortController(),
    };
    controllersRef.current.set(sessionId, managed.controller);
    publishRun(managed);
    setStatus(sessionId, true);
    setRunsRevision((current) => current + 1);
    attachRun(managed, options);
    return runId;
  }, [attachRun, publishRun, setStatus]);

  // Callbacks may read the latest published snapshot; the mirror is refreshed
  // in a layout effect.
  const runsMirrorRef = useRef(runs);
  useLayoutEffect(() => { runsMirrorRef.current = runs; });
  const runsRef_get = useCallback((sessionId: string): HermesRunView | undefined => runsMirrorRef.current[sessionId], []);
  const queueMirrorRef = useRef(promptQueueBySession);
  useLayoutEffect(() => { queueMirrorRef.current = promptQueueBySession; });
  const getQueue = useCallback((sessionId: string): HermesPromptQueueEntry[] => queueMirrorRef.current[sessionId] ?? [], []);

  const stopRun = useCallback(async (sessionId: string) => {
    const run = runsRef_get(sessionId);
    if (!run) return;
    publishState(sessionId, { ...run.state, statusText: 'stopping' });
    try {
      await client.hermes!.api.stopRun(run.runId);
    } catch (error) {
      // A 404 means the run already ended; the stream will confirm shortly.
      if ((error as HermesError).status !== 404) throw error;
    }
  }, [client, publishState, runsRef_get]);

  const answerApproval = useCallback(async (sessionId: string, requestId: string, choice: 'once' | 'always' | 'reject') => {
    const run = runsRef_get(sessionId);
    if (!run) throw new Error('This approval is no longer available.');
    let wireChoice: string = choice;
    if (choice === 'always' && run.state.approval) {
      // Hermes distinguishes "this session" from "always"; the card's
      // always-button sends whichever long-lived scope the run offers.
      const choices = run.state.approval.choices;
      if (!choices.includes('always') && choices.includes('session')) wireChoice = 'session';
    }
    if (choice === 'reject') wireChoice = 'deny';
    try {
      await client.hermes!.api.answerApproval(run.runId, wireChoice);
    } finally {
      setPendingPermissionsBySession((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter((entry) => entry.id !== requestId),
      }));
    }
  }, [client, runsRef_get, setPendingPermissionsBySession]);

  // ---- Clarify -------------------------------------------------------------

  const syncClarifications = useCallback(async (sessionId?: string) => {
    if (!inputRef.current.isCurrentClient(client) || !inputRef.current.connected) return;
    try {
      const entries = await client.hermes!.api.getClarifications(sessionId);
      clarifyEntriesRef.current.clear();
      const bySession: Record<string, PendingQuestionRequest[]> = {};
      for (const entry of entries) {
        if (entry.status && entry.status !== 'pending') continue;
        const sid = entry.session_id ?? sessionId ?? '';
        if (!sid) continue;
        clarifyEntriesRef.current.set(entry.id, entry);
        (bySession[sid] ??= []).push(clarifyToPendingQuestion(entry, sid));
      }
      setPendingQuestionsBySession((current) => {
        const next = { ...current };
        for (const sid of Object.keys(bySession)) next[sid] = bySession[sid];
        if (sessionId && !bySession[sessionId]) delete next[sessionId];
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        return next;
      });
    } catch {
      // The plugin may be mid-restart; the next poll retries.
    }
  }, [client, setPendingQuestionsBySession]);

  const answerClarify = useCallback(async (requestId: string, answers: (string[] | undefined)[]) => {
    const entry = clarifyEntriesRef.current.get(requestId);
    if (!entry) throw new Error('This question is no longer available.');
    try {
      await client.hermes!.api.answerClarification(requestId, clarifyAnswerToWire(entry, answers));
    } finally {
      setPendingQuestionsBySession((current) => {
        const next: Record<string, PendingQuestionRequest[]> = {};
        for (const [sid, list] of Object.entries(current)) {
          const filtered = list.filter((question) => question.id !== requestId);
          if (filtered.length) next[sid] = filtered;
        }
        return next;
      });
      clarifyEntriesRef.current.delete(requestId);
    }
  }, [client, setPendingQuestionsBySession]);

  const skipClarify = useCallback(async (requestId: string) => {
    const entry = clarifyEntriesRef.current.get(requestId);
    if (!entry) return;
    const answers = (entry.questions ?? []).map(() => undefined);
    await answerClarify(requestId, answers).catch(() => undefined);
  }, [answerClarify, clarifyEntriesRef]);

  // ---- Polling loops -------------------------------------------------------

  // Clarify: every 2s while a run is live anywhere, else for the current
  // session at the slower active-run cadence (answers can also arrive while the
  // app sits on another chat).
  useEffect(() => {
    if (!connected || !online) return;
    const pollTarget = liveRunCount > 0 ? undefined : currentSessionId;
    if (liveRunCount === 0 && !currentSessionId) return;
    const tick = () => { void syncClarifications(pollTarget); };
    tick();
    const timer = setInterval(tick, pollTarget ? ACTIVE_RUN_POLL_MS : CLARIFY_POLL_MS);
    return () => clearInterval(timer);
  }, [connected, currentSessionId, liveRunCount, online, runsRevision, syncClarifications]);

  // Active-run discovery for the current session: catches runs started
  // elsewhere (dashboard, CLI, messaging) and busy-elsewhere turns.
  useEffect(() => {
    if (!connected || !online || !currentSessionId || !isCurrentClient(client)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busyElsewhere = false;
    const hermes = client.hermes!;
    const poll = async () => {
      if (cancelled) return;
      try {
        const active = await hermes.api.getActiveRun(currentSessionId);
        if (cancelled) return;
        busyElsewhere = Boolean(active.busy_elsewhere) && !controllersRef.current.has(currentSessionId);
        if (active.run_id && !controllersRef.current.has(currentSessionId)) {
          registerRun(currentSessionId, active.run_id, '', { fromStart: true });
        } else if (busyElsewhere) {
          setStatus(currentSessionId, true);
          // A turn started outside the app has no event stream; reload the
          // transcript on the fast cadence until it clears.
          await inputRef.current.refreshMessages(currentSessionId, true).catch(() => undefined);
        } else if (!active.run_id && !controllersRef.current.has(currentSessionId)) {
          setStatus(currentSessionId, false);
        }
      } catch {
        // Transient poll failures are fine; the next tick retries.
      }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, busyElsewhere ? BUSY_ELSEWHERE_POLL_MS : ACTIVE_RUN_POLL_MS);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // registerRun/refreshMessages/setStatus are stable; run activity is read
    // through controllersRef so streaming events do not restart this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, connected, currentSessionId, isCurrentClient, online, refreshMessages, setStatus]);

  // Losing the connection kills every attach loop; a reconnect re-registers.
  useEffect(() => {
    if (connected) return;
    for (const controller of controllersRef.current.values()) {
      controller.abort();
    }
    controllersRef.current.clear();
  }, [connected]);

  const enqueuePrompt = useCallback((sessionId: string, text: string): HermesPromptQueueEntry => {
    queueCounterRef.current += 1;
    const entry: HermesPromptQueueEntry = { id: `queue-${queueCounterRef.current}`, sessionId, text, createdAt: Date.now() };
    setPromptQueueBySession((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), entry] }));
    return entry;
  }, []);

  const removeQueued = useCallback((sessionId: string, id: string) => {
    setPromptQueueBySession((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((entry) => entry.id !== id) }));
  }, []);

  const reset = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    setPromptQueueBySession({});
    setRuns({});
    setRunsRevision((current) => current + 1);
    setLiveRunCount(0);
  }, []);

  return useMemo(() => ({
    registerRun,
    stopRun,
    answerApproval,
    getRunHandle: runsRef_get,
    getQueue,
    hasActiveRun: (sessionId: string) => Boolean(runsMirrorRef.current[sessionId]),
    liveRecordsBySession,
    pendingUserTexts,
    promptQueueBySession,
    enqueuePrompt,
    removeQueued,
    answerClarify,
    skipClarify,
    syncClarifications,
    reset,
    eventStreamStatus,
  }), [registerRun, stopRun, answerApproval, runsRef_get, getQueue, liveRecordsBySession, pendingUserTexts, promptQueueBySession, enqueuePrompt, removeQueued, answerClarify, skipClarify, syncClarifications, reset, eventStreamStatus]);
}

function decodeSafely(data: string): RunEvent | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as RunEvent;
    if (!parsed || typeof parsed.event !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

import { emptySharedInput } from '@/providers/use-share-state';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { buildClient } from '@/lib/opencode/client';
import { buildOpencodeProjects, resolveActiveProject } from '@/providers/opencode-provider-utils';
import {
  CURRENT_ONBOARDING_VERSION,
  isOnboardingComplete,
} from '@/providers/onboarding-state';
import { useConversationState } from '@/providers/use-conversation-state';
import { MAX_ACTIVE_SESSIONS, useActiveSessions } from '@/providers/use-active-sessions';
import { getActiveSessions } from '@/providers/active-sessions';
import { useTranscriptState } from '@/providers/use-transcript-state';
import { useTranscriptReadErrors } from '@/providers/use-transcript-read-errors';
import { useHermesRuns } from '@/providers/use-hermes-runs';
import { useHermesCredentials } from '@/providers/use-hermes-credentials';
import { useHermesPrompts } from '@/providers/use-hermes-prompts';
import { useWorkspaceRuntimeState } from '@/providers/use-workspace-runtime-state';
import { useOpencodeProviderEffects } from '@/providers/use-opencode-provider-effects';
import { useProjectActions } from '@/providers/use-project-actions';
import { useCapabilitiesActions } from '@/providers/use-capabilities-actions';
import { useSessionActions } from '@/providers/use-session-actions';
import { useConnectionActions } from '@/providers/use-connection-actions';
import { useConnectionRetry } from '@/providers/use-connection-retry';
import { useOpencodeProviderValues } from '@/providers/opencode-provider-values';
import { useOpencodeProviderReset } from '@/providers/use-opencode-provider-reset';

import {
  HERMES_BUILT_IN_COMMANDS,
  extensionsStub,
  mcpStub,
  permissionRulesStub,
  servicesStub,
  terminalStub,
  worktreeStub,
} from '@/providers/hermes-composition-stubs';
import type { WorkspaceCatalog, WorkspaceRuntimeInput } from '@/providers/workspace-types';

const EMPTY_CATALOG: WorkspaceCatalog = { sessions: [], statuses: {}, refresh: async () => undefined, removeSession: () => {} };
const NOOP_REFRESH = async () => undefined;
const noop = () => undefined;

export function useOpencodeProviderComposition(input: WorkspaceRuntimeInput) {
  const state = useWorkspaceRuntimeState(input);
  // Connectivity is owned by WorkspaceProvider. NetInfo.configure() is global
  // and tears down existing listeners, so a per-runtime hook would freeze every
  // workspace except the one that mounted last.
  const network = input.network;
  const { connection: inputConnection, isConnectionOwner, onCatalog } = input;
  const isHydrated = input.isHydrated && input.connection.enabled;
  const {
    setConnection,
    initialConnectStartedRef,
    setOnboardingVersion,
    setOnboardingActive,
    bootstrapPromiseRef,
    bootstrapTokenRef,
    sessionRefreshTimeoutsRef,
    sessionRefreshOptionsRef,
    clientGenerationRef,
    catalogGenerationRef,
    scopeGenerationRef,
    serverGenerationRef,
  } = state;

  const refreshProjectCatalogRef = useRef<(silent?: boolean) => Promise<void>>(async () => undefined);
  const refreshChatCapabilitiesRef = useRef<() => Promise<void>>(async () => undefined);

  const onboardingCompleted = isOnboardingComplete(state.onboardingVersion);

  const completeOnboarding = useCallback(async () => {
    setOnboardingVersion(CURRENT_ONBOARDING_VERSION);
    setOnboardingActive(false);
  }, [setOnboardingActive, setOnboardingVersion]);

  const startOnboardingReview = useCallback(() => {
    setOnboardingActive(true);
  }, [setOnboardingActive]);

  const stopOnboardingReview = useCallback(() => {
    setOnboardingActive(false);
  }, [setOnboardingActive]);

  // Hermes has no projects: the catalog resolves to one synthetic workspace.
  const projects = useMemo(
    () => buildOpencodeProjects(state.projectPathsByConnection[state.connectionScope] ?? [], state.serverProjects),
    [state.connectionScope, state.projectPathsByConnection, state.serverProjects],
  );

  const client = useMemo(
    () => buildClient({ ...state.settings, directory: '' }, 'hermes'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect needs fresh clients so old in-flight requests stay invalid.
    [state.settings, input.connection.enabled],
  );
  const catalogClient = useMemo(() => buildClient({ ...state.settings, directory: '' }, 'hermes'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect invalidates the previous catalog client too.
    [state.settings, input.connection.enabled]);
  // Tag each client instance with the generation current when it is first seen.
  // A layout effect keeps this off the render path while still running before
  // any callback that could consume `isCurrentClient`. Generation bumps that
  // reuse the client object (catalog-driven project switches) must re-tag the
  // current instances, or every later isCurrentClient check fails.
  useLayoutEffect(() => {
    clientGenerationRef.current.set(client, scopeGenerationRef.current);
    catalogGenerationRef.current.set(catalogClient, serverGenerationRef.current);
  });
  const isCurrentClient = useCallback(
    (candidate: object) => input.connection.enabled && clientGenerationRef.current.get(candidate) === scopeGenerationRef.current,
    [clientGenerationRef, scopeGenerationRef, input.connection.enabled],
  );
  const isCurrentCatalogClient = useCallback(
    (candidate: object) => input.connection.enabled && catalogGenerationRef.current.get(candidate) === serverGenerationRef.current,
    [catalogGenerationRef, serverGenerationRef, input.connection.enabled],
  );

  const transcript = useTranscriptState({ ...state, client, isCurrentClient });
  const transcriptRead = useTranscriptReadErrors({
    client,
    isCurrentClient,
    refreshMessages: transcript.refreshMessages,
  });
  const retryTranscript = useCallback(async () => {
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    await transcriptRead.readMessages(sessionId, false).catch(() => undefined);
  }, [transcriptRead.readMessages, state.currentSessionId]);

  // The catalog owner is the only runtime that seeds the shared snapshot. Other
  // retained projects consume it so reconnecting N projects does not issue N
  // identical session list reads.
  const ownedActiveSessions = useActiveSessions({
    catalogClient,
    isCurrentCatalogClient,
    connectionScope: state.connectionScope,
    connected: isConnectionOwner && state.connection.status === 'connected',
    currentSessionId: state.currentSessionId,
    hideSubagentChats: state.chatPreferences.hideSubagentChats === true,
    visible: isConnectionOwner && state.activeSessionsVisible,
  });
  const ownedCatalog = useMemo<WorkspaceCatalog>(() => ({
    sessions: ownedActiveSessions.catalogSessions,
    statuses: ownedActiveSessions.catalogStatuses,
    refresh: ownedActiveSessions.refreshActiveSessions,
    removeSession: ownedActiveSessions.removeSession,
  }), [ownedActiveSessions.catalogSessions, ownedActiveSessions.catalogStatuses, ownedActiveSessions.refreshActiveSessions, ownedActiveSessions.removeSession]);
  useLayoutEffect(() => {
    if (isConnectionOwner) onCatalog(inputConnection.id, ownedCatalog);
  }, [inputConnection.id, isConnectionOwner, onCatalog, ownedCatalog]);
  const catalog = isConnectionOwner ? ownedCatalog : input.catalog ?? EMPTY_CATALOG;
  const activeSessions = useMemo(() => getActiveSessions({
    sessions: catalog.sessions,
    statuses: catalog.statuses,
    currentSessionId: state.currentSessionId,
    hideSubagentChats: state.chatPreferences.hideSubagentChats === true,
    maxTotal: MAX_ACTIVE_SESSIONS,
  }), [catalog.sessions, catalog.statuses, state.currentSessionId, state.chatPreferences.hideSubagentChats]);

  const { reset: resetTranscript } = transcript;
  const clearProjectState = useOpencodeProviderReset({
    state,
    resetMcpState: noop,
    resetPermissionRules: noop,
    resetTerminal: noop,
    resetTranscript,
    resetWorktrees: noop,
  });

  const softResetProjectState = useCallback(() => {
    // Same-server token rotation: keep server-derived data but drop in-flight
    // bookkeeping bound to the old client so a new bootstrap can start.
    bootstrapPromiseRef.current = null;
    bootstrapTokenRef.current = undefined;
    Object.values(sessionRefreshTimeoutsRef.current).forEach((timeout) => clearTimeout(timeout));
    sessionRefreshTimeoutsRef.current = {};
    sessionRefreshOptionsRef.current = {};
  }, [bootstrapPromiseRef, bootstrapTokenRef, sessionRefreshOptionsRef, sessionRefreshTimeoutsRef]);

  const project = useProjectActions({ ...state, client, catalogClient, isCurrentClient, isCurrentCatalogClient, clearProjectState, isHydrated, refreshMessages: transcriptRead.readMessages });

  const capabilities = useCapabilitiesActions({ ...state, client, isCurrentClient });

  const sessionActions = useSessionActions({
    ...state,
    ...project,
    ...permissionRulesStub,
    client,
    catalogClient,
    isCurrentClient,
    isCurrentCatalogClient,
    refreshMessages: transcriptRead.readMessages,
    refreshActiveSessions: catalog.refresh,
    refreshChatCapabilities: capabilities.refreshChatCapabilities,
    beginHydration: transcript.beginHydration,
  });
  const ensureActiveSessionRef = useRef(sessionActions.ensureActiveSession);

  // Hermes runs: the SSE attach loop, approvals, clarify, and live records.
  const sendNextQueuedRef = useRef<(sessionId: string) => Promise<void>>(async () => undefined);
  const runs = useHermesRuns({
    client,
    isCurrentClient,
    connected: state.connection.status === 'connected',
    online: network.online,
    currentSessionId: state.currentSessionId,
    refreshMessages: transcriptRead.readMessages,
    refreshSessions: project.refreshSessions,
    setSessionStatuses: state.setSessionStatuses,
    setPendingPermissionsBySession: state.setPendingPermissionsBySession,
    setPendingQuestionsBySession: state.setPendingQuestionsBySession,
    onAuthFailure: () => connectionActionsRef.current?.handleStreamAuthFailure('auth'),
    onRunEnded: (sessionId) => { void sendNextQueuedRef.current(sessionId); },
  });

  const skillCommandNames = useMemo(
    () => state.commands.map((command) => command.name.toLowerCase()),
    [state.commands],
  );
  const credentials = useHermesCredentials(client, state.connection.status === 'connected');

  const prompts = useHermesPrompts({
    client,
    isCurrentClient,
    connected: state.connection.status === 'connected',
    online: network.online,
    connectionScope: state.connectionScope,
    chatPreferences: state.chatPreferences,
    availableModels: state.availableModels,
    skillCommandNames: skillCommandNames,
    runs,
    busyNotificationsRef: state.busyNotificationsRef,
    promptSubmissionRef: state.promptSubmissionRef,
    refreshMessages: transcriptRead.readMessages,
  });
  useLayoutEffect(() => {
    sendNextQueuedRef.current = prompts.sendNextQueued;
    ensureActiveSessionRef.current = sessionActions.ensureActiveSession;
  });

  const connectionActions = useConnectionActions({
    ...state,
    ...project,
    ...sessionActions,
    ...prompts,
    isCurrentCatalogClient,
    ensureActiveSessionRef,
    clearProjectState,
    softResetProjectState,
    isHydrated,
    refreshActiveSessions: catalog.refresh,
  }, input);
  const connectionActionsRef = useRef<typeof connectionActions | null>(null);
  useLayoutEffect(() => { connectionActionsRef.current = connectionActions; });
  const reconnect = useConnectionRetry({
    active: input.visible,
    status: state.connection.status,
    kind: 'kind' in state.connection ? state.connection.kind : undefined,
    online: network.online,
    connect: connectionActions.connect,
  });

  const { conversation, clearConversationFeedback, toggleConversationMode } = useConversationState({
    connection: state.connection,
    chatPreferences: state.chatPreferences,
    currentSessionId: state.currentSessionId,
    setCurrentSessionId: state.setCurrentSessionId,
    sessionStatuses: state.sessionStatuses,
    messagesBySession: state.messagesBySession,
    pendingPermissionsBySession: state.pendingPermissionsBySession,
    pendingQuestionsBySession: state.pendingQuestionsBySession,
    sendingState: prompts.sendingState,
    ensureActiveSession: sessionActions.ensureActiveSession,
    sendPrompt: prompts.sendPrompt,
  });
  const { phase: conversationPhase, sessionId: conversationSessionId } = conversation;

  const streamConnectedRef = useRef(false);
  useLayoutEffect(() => {
    streamConnectedRef.current = runs.eventStreamStatus === 'connected';
  });

  useOpencodeProviderEffects({
    active: input.visible,
    ...state,
    client,
    catalogClient,
    isCurrentClient,
    isHydrated,
    onboardingCompleted,
    connect: connectionActions.connect,
    // The catalog owner is the only runtime that seeds the shared snapshot.
    refreshActiveSessions: isConnectionOwner ? catalog.refresh : NOOP_REFRESH,
    refreshWorktrees: NOOP_REFRESH,
    ensureActiveSessionRef,
    setPromptError: prompts.setPromptError,
    conversationSessionId,
    pruneTranscript: transcript.prune,
  });

  // Hermes built-ins run client-side; skill commands expand and send.
  const hermesCommandActions = useMemo(() => ({
    executeCommand: async (sessionId: string, command: string, args: string) => {
      switch (command.toLowerCase().replace(/_/g, '-')) {
        case 'stop':
          await runs.stopRun(sessionId);
          return;
        case 'new': {
          const session = await sessionActions.createSession();
          await sessionActions.openSession(session.id);
          return;
        }
        case 'title': {
          const title = args.trim();
          if (title) await sessionActions.renameSession(sessionId, title);
          return;
        }
        case 'branch': {
          const forked = await sessionActions.forkSession(sessionId);
          await sessionActions.openSession(forked.id);
          return;
        }
        case 'delete':
          await sessionActions.deleteSession(sessionId);
          return;
        case 'retry': {
          const records = state.messagesBySession[sessionId] ?? [];
          const lastUser = [...records].reverse().find((record) => record.info.role === 'user');
          const text = lastUser?.parts.find((part) => part.type === 'text')?.text ?? '';
          if (text) await prompts.sendPrompt(sessionId, text);
          return;
        }
        case 'help':
          return;
        default:
          await prompts.sendPrompt(sessionId, `/${command}${args ? ` ${args}` : ''}`);
      }
    },
    executeShell: async () => {
      throw new Error('Hermes has no shell surface.');
    },
  }), [prompts, runs, sessionActions, state.messagesBySession]);

  const activeProject = useMemo(
    () => resolveActiveProject(projects, state.activeProjectPath, worktreeStub.worktrees) ?? (state.activeProjectPath
      ? { path: state.activeProjectPath, label: state.activeProjectPath.split('/').filter(Boolean).pop() || state.activeProjectPath } : undefined),
    [projects, state.activeProjectPath],
  );

  // Hermes answer paths override the OpenCode interaction actions: approvals
  // ride the run stream, clarify answers go to the plugin.
  const hermesInteractions = useMemo(() => ({
    replyToPermission: async (requestId: string, reply: 'once' | 'always' | 'reject') => {
      const sessionId = Object.entries(state.pendingPermissionsBySession)
        .find(([, list]) => list.some((entry) => entry.id === requestId))?.[0];
      if (!sessionId) throw new Error('This approval is no longer available.');
      await runs.answerApproval(sessionId, requestId, reply);
    },
    replyToQuestion: async (requestId: string, answers: (string[] | undefined)[]) => {
      await runs.answerClarify(requestId, answers);
    },
    rejectQuestion: async (requestId: string) => {
      await runs.skipClarify(requestId);
    },
  }), [runs, state.pendingPermissionsBySession]);

  const values = useOpencodeProviderValues({
    ...state,
    ...transcript,
    transcriptReadError: state.currentSessionId ? transcriptRead.errors[state.currentSessionId] : undefined,
    retryTranscript,
    ...permissionRulesStub,
    mcpAuthPrompt: undefined,
    dismissMcpAuth: noop,
    ...terminalStub,
    ...worktreeStub,
    ...mcpStub,
    ...extensionsStub,
    ...project,
    ...sessionActions,
    ...hermesCommandActions,
    ...hermesInteractions,
    ...capabilities,
    ...prompts,
    ...connectionActions,
    commands: [...state.commands, ...HERMES_BUILT_IN_COMMANDS],
    activeSessions,
    refreshActiveSessions: catalog.refresh,
    conversation,
    clearConversationFeedback,
    toggleConversationMode,
    isHydrated: input.isHydrated,
    onboardingCompleted,
    onboardingActive: state.onboardingActive,
    completeOnboarding,
    startOnboardingReview,
    stopOnboardingReview,
    projects,
    activeProject: activeProject,
    eventStreamStatus: runs.eventStreamStatus,
    network,
    reconnect,
    sharedInput: emptySharedInput,
    servicesValue: servicesStub,
    hermesLiveRecords: runs.liveRecordsBySession,
    credentialsState: credentials,
  });

  const suspend = useCallback(() => {
    scopeGenerationRef.current++; serverGenerationRef.current++; initialConnectStartedRef.current = false;
    for (const timeout of Object.values(sessionRefreshTimeoutsRef.current)) clearTimeout(timeout);
    sessionRefreshTimeoutsRef.current = {}; sessionRefreshOptionsRef.current = {};
    runs.reset();
    setConnection({ status: 'idle', message: 'Disconnected' });
  }, [scopeGenerationRef, serverGenerationRef, setConnection, sessionRefreshTimeoutsRef, sessionRefreshOptionsRef, initialConnectStartedRef, runs]);
  const busy = prompts.sendingState.active || conversationPhase !== 'off' || state.isBootstrappingChat ||
    state.connection.status === 'connecting' ||
    Object.values(state.sessionStatuses).some((status) => status.type !== 'idle') ||
    Object.values(state.pendingPermissionsBySession).some((items) => items.length > 0) ||
    Object.values(state.pendingQuestionsBySession).some((items) => items.length > 0) ||
    Object.values(runs.promptQueueBySession).some((items) => items.length > 0);
  return useMemo(() => ({ enabled: input.connection.enabled, values, busy, suspend, catalogClient, catalogSessions: catalog.sessions, catalogStatuses: catalog.statuses,
    pendingPermissions: state.pendingPermissionsBySession, pendingQuestions: state.pendingQuestionsBySession,
    native: { settings: state.settings, catalogClient, contract: 'hermes' as const, isCurrentCatalogClient,
      connectionScope: state.connectionScope, currentSessionId: state.currentSessionId, sessions: state.sessions,
      activeSessions, todoRecordsBySession: transcript.todoRecordsBySession,
      todosBySession: state.todosBySession, streamConnectedRef },
  }), [input.connection.enabled, values, busy, suspend, catalogClient, catalog.sessions, catalog.statuses, state.pendingPermissionsBySession,
    state.pendingQuestionsBySession, state.settings, isCurrentCatalogClient, state.connectionScope,
    state.currentSessionId, state.sessions, activeSessions, transcript.todoRecordsBySession, state.todosBySession, runs.liveRecordsBySession]);
}

// The transcript retry bridge is defined after the hooks it forwards to.

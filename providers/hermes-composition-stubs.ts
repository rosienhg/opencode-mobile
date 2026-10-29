import type { Command } from '@/lib/opencode/types';

// Inert values for the OpenCode-only domains. Hermes connections have no
// terminal, MCP, extensions, projects/files, worktrees, service management, or
// server-persisted permission rules; the contexts stay part of the app's
// contract (components reference them), while ServerCapabilities and the tab
// layout keep their screens out of reach.
const noop = () => undefined;
const asyncNoop = async () => undefined;

export const terminalStub = {
  terminals: [],
  activeTerminalId: undefined,
  terminalRuntime: { scope: 0, instances: [], registerRenderer: () => noop, resize: noop },
  terminalConnection: 'idle' as const,
  refreshTerminals: asyncNoop,
  createTerminal: async () => { throw new Error('Hermes has no terminal surface.'); },
  openTerminal: asyncNoop,
  sendTerminalInput: noop,
  closeTerminal: asyncNoop,
};

export const worktreeStub = {
  worktrees: { entries: [], loading: false },
  refreshWorktrees: asyncNoop,
  createWorktree: asyncNoop,
  removeWorktree: asyncNoop,
  resetWorktrees: noop,
};

export const mcpStub = {
  mcpStatuses: {},
  refreshMcpServers: asyncNoop,
  addMcpServer: asyncNoop,
  connectMcpServer: asyncNoop,
  disconnectMcpServer: asyncNoop,
  mcpOAuth: { methods: async () => [], start: async () => { throw new Error('Hermes has no MCP surface.'); }, complete: asyncNoop, wait: asyncNoop, cancel: asyncNoop },
  resetMcpState: noop,
};

export const extensionsStub = {
  extensions: {
    snapshot: undefined,
    isRefreshing: false,
    refresh: asyncNoop,
    addMcp: asyncNoop,
    updateMcp: asyncNoop,
    removeMcp: asyncNoop,
    addPlugin: asyncNoop,
    removePlugin: asyncNoop,
    saveCommand: asyncNoop,
    removeCommand: asyncNoop,
    createSkill: asyncNoop,
    updateSkill: asyncNoop,
    removeSkill: asyncNoop,
    restoreBackup: asyncNoop,
  },
};

export const permissionRulesStub = {
  savedPermissions: [],
  refreshSavedPermissions: asyncNoop,
  removeSavedPermission: asyncNoop,
  resetPermissionRules: noop,
};

export const servicesStub = {
  services: [] as never[],
  available: false as const,
  machines: [] as never[],
  isRefreshing: false,
  isSaving: false,
  refresh: asyncNoop,
  save: async () => { throw new Error('Hermes has no service management surface.'); },
  remove: asyncNoop,
  selectMachine: noop,
  activateTarget: async () => false,
};

// Client-side built-ins, matching MyHermit's slash commands. Anything else
// starting with "/" is a skill and expands through the plugin.
export const HERMES_BUILT_IN_COMMANDS: Command[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'stop', description: 'Stop the running turn' },
  { name: 'retry', description: 'Resend your last message' },
  { name: 'title', description: 'Rename this chat: /title <name>' },
  { name: 'branch', description: 'Branch this chat (fork)' },
  { name: 'delete', description: 'Delete this chat' },
  { name: 'help', description: 'Show the commands you can type' },
];

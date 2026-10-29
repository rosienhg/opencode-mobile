// Hermes Agent wire types (snake_case, as served by the dashboard, the
// hermes-ios plugin proxy, and the hermes-cred-requests plugin).
//
// Shapes mirror Packages/HermesCore/Sources/HermesCore in rosienhg/myhermit and
// the reference mock server (myhermit/android/tools/mock_hermes.py).

// ---- Auth ----

export type AuthProvider = { name: string; supports_password?: boolean; supportsPassword?: boolean };

export type TokenReply = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  provider?: string;
};

// ---- Sessions ----

export type SessionSummary = {
  id: string;
  source?: string;
  title?: string;
  started_at?: number;
  last_active?: number;
  message_count?: number;
  preview?: string;
  hidden?: boolean;
  archived?: boolean;
  is_internal_child?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;
  model?: string;
};

export type ToolCallWire = {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
};

export type ChatMessage = {
  id: number;
  role: string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallWire[];
  timestamp?: number;
  display_kind?: string;
  reasoning?: string;
};

// ---- Runs ----

export type StartRunRequest = {
  input: string;
  session_id: string;
  model?: string;
  provider?: string;
  model_options?: Record<string, unknown>;
};

export type StartRunReply = { run_id: string };

export type RunEvent =
  | { event: 'run.started'; seq?: number }
  | { event: 'reasoning.available'; seq?: number; text?: string }
  | { event: 'message.delta'; seq?: number; delta?: string }
  | { event: 'message.interim'; seq?: number; text?: string }
  | { event: 'tool.started'; seq?: number; tool?: string; preview?: string }
  | { event: 'tool.completed'; seq?: number; tool?: string; preview?: string; duration?: number; error?: boolean }
  | { event: 'subagent.start'; seq?: number }
  | { event: 'approval.request'; seq?: number; request_id?: string; command?: string; description?: string; choices?: string[] }
  | { event: 'run.steered'; seq?: number }
  | { event: string; seq?: number; [key: string]: unknown };

export type LiveToolCall = { tool?: string; args?: string; call_id?: string; at?: number };

// ---- Plugin (hermes-ios) ----

export type PluginStatus = {
  version?: string;
  gateway?: { reachable?: boolean; version?: string; key_configured?: boolean; error?: string | null };
  apns?: { configured?: boolean; missing?: string[]; mode?: string };
  devices?: { name?: string; environment?: string; bundle_id?: string; registered_at?: string; token_suffix?: string }[];
  watching_runs?: number;
};

export type ActiveRunReply = { run_id?: string | null; busy_elsewhere?: string | null };

export type ClarifyQuestion = { qid?: string; question?: string; choices?: string[]; multi_select?: boolean };

export type ClarifyEntry = {
  id: string;
  run_id?: string;
  session_id?: string;
  created?: number;
  status?: string;
  questions?: ClarifyQuestion[];
  answers?: Record<string, string | string[] | null> | null;
};

// ---- Models ----

export type ModelOptions = {
  model?: string;
  provider?: string;
  providers?: { slug?: string; name?: string; authenticated?: boolean; models?: string[] }[];
};

// ---- Skills / commands ----

export type SkillCommand = { name?: string; description?: string };

// ---- Credential requests (hermes-cred-requests plugin) ----

export type CredFieldDestination = { kind: 'env' | 'file'; target: string };

export type CredField = {
  name?: string;
  label?: string;
  hint?: string;
  secret?: boolean;
  dest?: CredFieldDestination;
};

export type CredentialRequest = {
  id: string;
  created_at?: string;
  expires_at?: string;
  title?: string;
  why?: string;
  requester?: string;
  status?: 'pending' | 'filled' | 'cancelled';
  filled_at?: string | null;
  cancelled_at?: string | null;
  note?: string;
  fields?: CredField[];
  saved?: { field?: string; dest?: string; at?: string }[];
  expired?: boolean;
};

export type CredentialRequestsReply = {
  url_base?: string;
  tab_path?: string;
  pending_count?: number;
  requests?: CredentialRequest[];
};

export function isTerminalRunEvent(event: string): boolean {
  return event.startsWith('run.') && event !== 'run.started' && event !== 'run.steered';
}

import type { Part, Message } from '@/lib/opencode/message-types';
import type { SessionMessageRecord } from '@/lib/opencode/format/types';
import type { Command, Session, SessionStatus } from '@/lib/opencode/types';
import type { ModelOption } from '@/providers/opencode-model-selection';
import type { PendingPermissionRequest, PendingQuestionRequest } from '@/lib/opencode/client/types';
import type {
  ChatMessage,
  ClarifyEntry,
  CredentialRequest,
  ModelOptions,
  SessionSummary,
  SkillCommand,
  ToolCallWire,
} from '@/lib/hermes/wire';
// Hermes timestamps are epoch seconds; the app's domain model uses millis.
function toMillis(seconds: number | undefined): number {
  return typeof seconds === 'number' && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

export function hermesDisplayTitle(summary: SessionSummary): string {
  if (summary.title && summary.title.trim()) return summary.title;
  if (summary.preview && summary.preview.trim()) return summary.preview;
  return 'New chat';
}

export function toSessionView(summary: SessionSummary): Session {
  return {
    id: summary.id,
    title: hermesDisplayTitle(summary),
    time: {
      created: toMillis(summary.started_at),
      updated: toMillis(summary.last_active ?? summary.started_at),
    },
    model: parseHermesModelRef(summary.model),
    cost: summary.estimated_cost_usd,
    metadata: {
      hermes: {
        source: summary.source,
        preview: summary.preview,
        messageCount: summary.message_count,
        inputTokens: summary.input_tokens,
        outputTokens: summary.output_tokens,
        estimatedCostUsd: summary.estimated_cost_usd,
        actualCostUsd: summary.actual_cost_usd,
        rawModel: summary.model,
      },
    },
  } as unknown as Session;
}

export function parseHermesModelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model || !model.includes('/')) return undefined;
  const [providerID, ...rest] = model.split('/');
  return { providerID, modelID: rest.join('/') };
}

// A Hermes session is "busy" while a run is active on it; everything else is
// idle. Retry states do not exist on the Hermes gateway.
export function hermesSessionStatus(busy: boolean): SessionStatus {
  return busy ? { type: 'busy' } : { type: 'idle' };
}

export function isListedSession(summary: SessionSummary): boolean {
  return summary.hidden !== true && summary.archived !== true && summary.is_internal_child !== true;
}

function normalizeToolArguments(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value: parsed };
    } catch {
      return { raw };
    }
  }
  return raw;
}

function toToolCallId(call: ToolCallWire, index: number): string {
  return call.id ?? call.function?.name ? `${call.id ?? `call-${index}`}` : `call-${index}`;
}

// Maps one persisted Hermes exchange into the app's message-record shape:
// user → text part, assistant → reasoning + text + tool parts, and role=tool
// follow-ups complete the matching tool part with their output.
export function toMessageRecords(messages: ChatMessage[], sessionId: string): SessionMessageRecord[] {
  const records: SessionMessageRecord[] = [];
  const openToolParts = new Map<string, { recordIndex: number; part: Extract<Part, { type: 'tool' }> }>();

  const pushRecord = (info: Message, parts: Part[]) => {
    records.push({ info, parts });
    return records.length - 1;
  };

  for (const message of messages) {
    if (message.display_kind === 'hidden') continue;
    const role = message.role === 'user' ? 'user' : 'assistant';
    const created = toMillis(message.timestamp);
    const base = {
      id: String(message.id),
      sessionID: sessionId,
      time: { created },
    };
    if (role === 'user') {
      const parts: Part[] = [];
      if (message.content) parts.push({ id: `${base.id}-text`, sessionID: sessionId, messageID: base.id, type: 'text', text: message.content });
      pushRecord({ ...base, role: 'user' } as Message, parts);
      continue;
    }
    const parts: Part[] = [];
    if (message.reasoning) {
      parts.push({ id: `${base.id}-reasoning`, sessionID: sessionId, messageID: base.id, type: 'reasoning', text: message.reasoning });
    }
    if (message.content) {
      parts.push({ id: `${base.id}-text`, sessionID: sessionId, messageID: base.id, type: 'text', text: message.content });
    }
    (message.tool_calls ?? []).forEach((call, index) => {
      const callId = toToolCallId(call, index);
      const toolName = call.function?.name ?? 'tool';
      const part: Extract<Part, { type: 'tool' }> = {
        id: `${base.id}-tool-${index}`,
        sessionID: sessionId,
        messageID: base.id,
        type: 'tool',
        callID: callId,
        tool: toolName,
        state: {
          status: 'completed',
          input: normalizeToolArguments(call.function?.arguments),
          output: '',
        },
      };
      parts.push(part);
      if (callId) openToolParts.set(callId, { recordIndex: records.length, part });
    });
    pushRecord({ ...base, role: 'assistant', providerID: '', modelID: '' } as Message, parts);
    // Tool result follow-ups attach to the assistant record just pushed.
    if (message.role === 'tool' && message.tool_call_id) {
      const open = openToolParts.get(message.tool_call_id);
      if (open) {
        if (open.part.state.status === 'completed') open.part.state.output = message.content ?? '';
        openToolParts.delete(message.tool_call_id);
      }
    }
  }

  // role=tool messages arrive after their assistant record; replay pass fixes
  // ordering of the map above by walking once more.
  for (const message of messages) {
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const open = openToolParts.get(message.tool_call_id);
    if (open && open.part.state.status === 'completed') open.part.state.output = message.content ?? '';
  }

  return records;
}

export function toModelOptions(reply: ModelOptions): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of reply.providers ?? []) {
    if (provider.authenticated !== true) continue;
    const models = provider.models ?? [];
    if (models.length === 0) continue;
    for (const model of models) {
      options.push({
        id: `${provider.slug ?? ''}|${model}`,
        label: model.includes('/') ? model.split('/').slice(1).join('/') : model,
        providerID: provider.slug ?? '',
        providerLabel: provider.name ?? provider.slug ?? '',
        modelID: model,
        variants: [],
        supportsReasoning: true,
        supportsAttachments: false,
        inputModalities: ['text'],
        supportsToolCalls: true,
      });
    }
  }
  return options;
}

export function hermesDefaultModel(reply: ModelOptions): { provider: string; model: string } | undefined {
  if (!reply.model || !reply.provider) return undefined;
  return { provider: reply.provider, model: reply.model };
}

export function skillCommandToCommand(skill: SkillCommand): Command {
  return { name: (skill.name ?? '').replace(/^\/+/, ''), description: skill.description };
}

// ---- Clarify → question flow ----

export function clarifyToPendingQuestion(entry: ClarifyEntry, sessionId: string): PendingQuestionRequest {
  return {
    id: entry.id,
    sessionID: entry.session_id ?? sessionId,
    title: 'Hermes has a question',
    questions: (entry.questions ?? []).map((question, index) => ({
      header: `Question ${index + 1}`,
      question: question.question ?? '',
      options: (question.choices ?? []).map((choice) => ({ label: choice, value: choice })),
      multiple: question.multi_select === true,
      custom: true,
      key: question.qid ?? `q${index}`,
    })),
  };
}

// Question-flow answers (one entry per question, option labels/values or free
// text) map back onto Hermes' {qid: answer} shape. Skipped questions become
// null, single choices collapse to a string, multi-selects stay an array.
export function clarifyAnswerToWire(
  entry: ClarifyEntry,
  answers: (string[] | undefined)[],
): Record<string, string | string[] | null> {
  const wire: Record<string, string | string[] | null> = {};
  const questions = entry.questions ?? [];
  questions.forEach((question, index) => {
    const qid = question.qid ?? `q${index}`;
    const answer = answers[index];
    if (!answer || answer.length === 0) {
      wire[qid] = null;
      return;
    }
    if (question.multi_select === true) {
      wire[qid] = answer;
      return;
    }
    wire[qid] = answer[0];
  });
  return wire;
}

// ---- Run approvals → permission cards ----

export type HermesApprovalRequest = {
  request_id?: string;
  command?: string;
  description?: string;
  choices?: string[];
};

export function approvalToPendingPermission(
  approval: HermesApprovalRequest,
  sessionId: string,
): PendingPermissionRequest | undefined {
  if (!approval.request_id) return undefined;
  const choices = approval.choices ?? ['once', 'deny'];
  return {
    id: approval.request_id,
    sessionID: sessionId,
    permission: approval.command ?? 'approval',
    patterns: [],
    always: choices.filter((choice) => choice === 'always' || choice === 'session'),
    metadata: { description: approval.description ?? '', choices },
  };
}

// ---- Credential requests ----

export type CredentialRequestView = {
  id: string;
  title: string;
  why?: string;
  requester?: string;
  status: 'pending' | 'filled' | 'cancelled';
  createdAt?: number;
  expiresAt?: number;
  pending: boolean;
  fields: {
    name: string;
    label: string;
    hint?: string;
    secret: boolean;
    destination: string;
    kind: 'env' | 'file';
    target: string;
  }[];
  saved: { field?: string; dest?: string; at?: string }[];
};

function destinationDescription(kind: 'env' | 'file', target: string): string {
  return kind === 'env' ? `env ${target}` : `file ${target}`;
}

export function toCredentialRequestView(request: CredentialRequest): CredentialRequestView {
  const status = request.status === 'filled' ? 'filled' : request.status === 'cancelled' ? 'cancelled' : 'pending';
  const expired = request.expired === true;
  return {
    id: request.id,
    title: request.title?.trim() || request.id,
    why: request.why || undefined,
    requester: request.requester || undefined,
    status,
    createdAt: request.created_at ? Date.parse(request.created_at) : undefined,
    expiresAt: request.expires_at ? Date.parse(request.expires_at) : undefined,
    pending: status === 'pending' && !expired,
    fields: (request.fields ?? []).map((field, index) => ({
      name: field.name ?? `field-${index}`,
      label: field.label?.trim() || field.name || `Field ${index + 1}`,
      hint: field.hint || undefined,
      secret: field.secret !== false,
      kind: field.dest?.kind === 'file' ? 'file' : 'env',
      target: field.dest?.target ?? '',
      destination: destinationDescription(field.dest?.kind === 'file' ? 'file' : 'env', field.dest?.target ?? ''),
    })),
    saved: request.saved ?? [],
  };
}

export function splitCredentialRequests(requests: CredentialRequestView[]): { pending: CredentialRequestView[]; history: CredentialRequestView[] } {
  const pending = requests.filter((request) => request.pending).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  const history = requests.filter((request) => !request.pending).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  return { pending, history };
}

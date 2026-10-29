import { isTerminalRunEvent, type RunEvent } from '@/lib/hermes/wire';

// The client-side run state machine, mirroring ChatTimeline's ActiveRun in
// HermesCore. A run starts as "Sending…", streams deltas/tool steps/reasoning,
// may park on an approval request, and ends on any terminal run.* event.

export type RunApprovalRequest = {
  requestId: string;
  command: string;
  description?: string;
  choices: string[];
};

export type RunToolStep = {
  id: string;
  tool: string;
  status: 'running' | 'done' | 'failed';
  preview?: string;
  fullArgs?: string;
  duration?: number;
};

export type ActiveRun = {
  runId: string;
  statusText: string;
  streamedText: string;
  reasoning: string[];
  interim: string[];
  tools: RunToolStep[];
  approval: RunApprovalRequest | undefined;
  lastSeq: number | undefined;
  terminal: { event: string; output?: string; error?: string } | undefined;
};

export function createActiveRun(runId = ''): ActiveRun {
  return { runId, statusText: 'sending', streamedText: '', reasoning: [], interim: [], tools: [], approval: undefined, lastSeq: undefined, terminal: undefined };
}

// Copy-on-write snapshot for React state publication: applyRunEvent mutates in
// place, so the streaming loop clones before each event.
export function cloneRunState(run: ActiveRun): ActiveRun {
  return {
    ...run,
    reasoning: [...run.reasoning],
    interim: [...run.interim],
    tools: run.tools.map((tool) => ({ ...tool })),
    approval: run.approval ? { ...run.approval } : undefined,
    terminal: run.terminal ? { ...run.terminal } : undefined,
  };
}

export function decodeRunEvent(data: string): RunEvent | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as RunEvent;
    if (!parsed || typeof parsed.event !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

let toolStepCounter = 0;

// Applies one event, mutating `run` in place (the caller owns copy-on-write
// around React state updates).
export function applyRunEvent(run: ActiveRun, event: RunEvent): void {
  if (typeof event.seq === 'number' && (run.lastSeq === undefined || event.seq > run.lastSeq)) {
    run.lastSeq = event.seq;
  }
  switch (event.event) {
    case 'run.started':
      break;
    case 'reasoning.available': {
      const text = typeof event.text === 'string' ? event.text : '';
      if (text && run.reasoning[run.reasoning.length - 1] !== text) run.reasoning.push(text);
      break;
    }
    case 'message.delta': {
      if (typeof event.delta === 'string' && event.delta) {
        run.streamedText += event.delta;
        run.statusText = 'streaming';
      }
      break;
    }
    case 'message.interim': {
      const text = typeof event.text === 'string' ? event.text : '';
      if (text && !run.streamedText.includes(text) && !run.interim.includes(text)) run.interim.push(text);
      break;
    }
    case 'tool.started': {
      flushStreamedText(run);
      toolStepCounter += 1;
      run.tools.push({
        id: `tool-${toolStepCounter}`,
        tool: typeof event.tool === 'string' ? event.tool : 'tool',
        status: 'running',
        preview: typeof event.preview === 'string' ? event.preview : undefined,
      });
      run.statusText = 'running';
      break;
    }
    case 'tool.completed': {
      const name = typeof event.tool === 'string' ? event.tool : undefined;
      const step = [...run.tools].reverse().find((entry) => entry.tool === name && entry.status === 'running');
      if (step) {
        step.status = event.error === true ? 'failed' : 'done';
        step.preview = typeof event.preview === 'string' ? event.preview : step.preview;
        step.duration = typeof event.duration === 'number' ? event.duration : step.duration;
      }
      break;
    }
    case 'subagent.start':
      run.statusText = 'delegating';
      break;
    case 'approval.request': {
      if (typeof event.request_id === 'string') {
        run.approval = {
          requestId: event.request_id,
          command: typeof event.command === 'string' ? event.command : 'approval',
          description: typeof event.description === 'string' ? event.description : undefined,
          choices: Array.isArray(event.choices) && event.choices.length ? event.choices : ['once', 'deny'],
        };
      }
      break;
    }
    case 'run.steered':
      break;
    default:
      if (isTerminalRunEvent(event.event)) {
        flushStreamedText(run);
        const output = typeof (event as unknown as { output?: unknown }).output === 'string' ? (event as unknown as { output: string }).output : undefined;
        const error = typeof (event as unknown as { error?: unknown }).error === 'string' ? (event as unknown as { error: string }).error : undefined;
        run.terminal = { event: event.event, output, error };
        run.approval = undefined;
      }
      break;
  }
}

// The streamed text stays visible next to tool steps once tools start; it is
// not re-rendered as a growing bubble after the first flush.
function flushStreamedText(run: ActiveRun): void {
  // Intentional no-op: streamed text is rendered above the tool list as-is.
}

export function activeRunFinalReply(run: ActiveRun): string {
  if (!run.terminal) return '';
  if (run.terminal.event === 'run.completed') return run.terminal.output ?? run.streamedText;
  if (run.terminal.event === 'run.cancelled') return '';
  return run.terminal.error ?? '';
}

export function activeRunFailureMessage(run: ActiveRun, locale: (key: string) => string): string {
  if (!run.terminal) return '';
  if (run.terminal.event === 'run.cancelled') return locale('Stopped.');
  if (run.terminal.event === 'run.completed') return '';
  return run.terminal.error || locale('The run ended without an answer.');
}

// Replaces preview text with the full recorded args for matching tool steps,
// matched in order by tool name (same rule as ChatTimeline.applyLiveToolCalls).
export function applyLiveToolCalls(run: ActiveRun, calls: { tool?: string; args?: string }[]): void {
  const remaining = [...calls];
  for (const step of run.tools) {
    const index = remaining.findIndex((call) => (call.tool ?? '') === step.tool);
    if (index === -1) continue;
    const [call] = remaining.splice(index, 1);
    if (call.args) step.fullArgs = call.args;
  }
}

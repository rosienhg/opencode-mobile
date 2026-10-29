import type { SessionMessageRecord } from '@/lib/opencode/format';
import type { HermesRunView } from '@/providers/use-hermes-runs';

// Builds the synthetic transcript records that render a live Hermes run: the
// pending user message plus the streamed assistant turn (reasoning, text,
// tool steps). The gateway persists both messages around the terminal event,
// so until then this projection is the only thing the transcript can show.
export function buildHermesLiveRecords(run: HermesRunView): SessionMessageRecord[] {
  const active = run.state;
  const pendingId = `pending-${run.runId}`;
  const records: SessionMessageRecord[] = [];
  records.push({
    info: {
      id: pendingId,
      sessionID: run.sessionId,
      role: 'user',
      time: { created: run.startedAt },
    } as SessionMessageRecord['info'],
    parts: [{
      id: `${pendingId}-text`,
      sessionID: run.sessionId,
      messageID: pendingId,
      type: 'text',
      text: run.prompt,
    }],
  });
  if (active.streamedText || active.reasoning.length > 0 || active.tools.length > 0 || active.interim.length > 0) {
    const liveId = `live-${run.runId}`;
    const parts: SessionMessageRecord['parts'] = [];
    active.reasoning.forEach((text, index) => {
      parts.push({
        id: `${liveId}-reasoning-${index}`,
        sessionID: run.sessionId,
        messageID: liveId,
        type: 'reasoning',
        text,
      });
    });
    if (active.streamedText) {
      parts.push({
        id: `${liveId}-text`,
        sessionID: run.sessionId,
        messageID: liveId,
        type: 'text',
        text: active.streamedText,
      });
    }
    active.tools.forEach((tool, index) => {
      let toolInput: Record<string, unknown> = {};
      if (tool.fullArgs) {
        try {
          const parsed = JSON.parse(tool.fullArgs);
          if (parsed && typeof parsed === 'object') toolInput = parsed as Record<string, unknown>;
        } catch {
          toolInput = { raw: tool.fullArgs };
        }
      }
      parts.push({
        id: `${liveId}-tool-${index}`,
        sessionID: run.sessionId,
        messageID: liveId,
        type: 'tool',
        callID: `${liveId}-${index}`,
        tool: tool.tool,
        state: tool.status === 'failed'
          ? { status: 'error', input: toolInput, error: tool.preview ?? 'failed' }
          : {
              status: 'completed',
              input: toolInput,
              output: tool.preview ?? '',
              time: tool.duration !== undefined ? { start: run.startedAt, end: run.startedAt + tool.duration * 1000 } : undefined,
            },
      });
    });
    const text = [active.interim.join('\n\n'), active.streamedText].filter(Boolean).join('\n\n');
    if (text) {
      records.push({
        info: {
          id: liveId,
          sessionID: run.sessionId,
          role: 'assistant',
          providerID: '',
          modelID: '',
          time: { created: run.startedAt },
        } as SessionMessageRecord['info'],
        parts,
      });
    }
  }
  return records;
}

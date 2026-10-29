// Minimal SSE reader over an expo/fetch streaming body. Hermes run events use
// `id:`/`data:` frames with a single JSON payload per event; the client keys
// resume on the JSON `seq`, so `id:` lines are intentionally ignored.

export type SseMessage = { data: string };

export async function* readSseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = parseFrameData(frame);
        if (data !== undefined) yield { data };
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // Reader already released by cancel.
    }
  }
}

function parseFrameData(frame: string): string | undefined {
  const lines = frame.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment/keepalive
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    // `event:`/`id:`/other fields are ignored on purpose.
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join('\n');
}

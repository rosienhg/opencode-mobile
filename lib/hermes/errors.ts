// Error parsing follows HermesConnection.check in HermesCore: `detail` (string)
// wins, then `error.message`, then a generic status message. FastAPI validation
// errors expose an array of {msg} objects under `detail`.

export class HermesError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
  }
}

export function parseHermesErrorBody(body: unknown, status: number): HermesError {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === 'string' && record.detail) return new HermesError(record.detail, status);
    if (Array.isArray(record.detail)) {
      const first = record.detail.find((entry) => entry && typeof entry === 'object' && typeof (entry as { msg?: unknown }).msg === 'string');
      const message = first ? (first as { msg: string }).msg : undefined;
      if (message) return new HermesError(message, status);
    }
    const error = record.error;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return new HermesError((error as { message: string }).message, status);
    }
  }
  return new HermesError(`Request failed (${status}).`, status);
}

export function toHermesError(error: unknown, fallbackStatus?: number): HermesError {
  if (error instanceof HermesError) return error;
  if (error instanceof Error) return new HermesError(error.message, fallbackStatus);
  return new HermesError(String(error), fallbackStatus);
}

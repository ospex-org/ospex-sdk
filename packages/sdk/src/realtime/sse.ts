/**
 * Shared Server-Sent Events primitives used by every Ospex SSE transport:
 * the protocol streams (`realtime/stream.ts`) and the odds stream
 * (`realtime/oddsStream.ts`). Pure, transport-agnostic, no module-level state —
 * the incremental wire parser plus the reconnect timing helpers both transports
 * layer their own state machine on top of.
 */

/** No event or heartbeat for this long ⇒ treat the stream as dead and reconnect.
 *  The server heartbeats ~20s; 60s tolerates a couple of missed beats. */
export const IDLE_TIMEOUT_MS = 60_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

export interface SseFrame {
  kind: 'event' | 'comment';
  event?: string;
  data?: string;
  id?: string;
}

/** Full-jitter exponential backoff. */
export function backoffDelay(attempt: number): number {
  const ceil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceil);
}

/** Sleep that resolves early if `signal` aborts (e.g. unsubscribe). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Incremental Server-Sent Events parser over a fetch byte stream. Yields one
 * frame per dispatched event (blank-line terminated) and one per `:` comment
 * (heartbeats — so the idle watchdog sees them). Handles chunk boundaries,
 * CRLF, multi-line `data:`, and a single optional space after each field colon.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventType = '';
  let data = '';
  let id: string | undefined;
  let sawField = false;
  const reset = (): void => {
    eventType = '';
    data = '';
    id = undefined;
    sawField = false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          if (sawField) {
            const frame: SseFrame = { kind: 'event', event: eventType || 'message', data };
            if (id !== undefined) frame.id = id;
            yield frame;
          }
          reset();
          continue;
        }
        if (line.startsWith(':')) {
          yield { kind: 'comment' };
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
          case 'event':
            eventType = value;
            sawField = true;
            break;
          case 'data':
            data = data === '' ? value : `${data}\n${value}`;
            sawField = true;
            break;
          case 'id':
            id = value;
            sawField = true;
            break;
          default:
            // 'retry' (we own backoff) and unknown fields: ignore.
            break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a pending read may already have errored on abort */
    }
  }
}

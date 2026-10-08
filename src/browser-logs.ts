type BrowserLog = {
  timestamp: string;
  participantId: string | null;
  event: string;
  details: Record<string, unknown>;
};

let pageId: string | null = null;
let sequence = 0;
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
const encoder = new TextEncoder();

export function startBrowserLogs() {
  if (!import.meta.env.DEV || pageId) return;
  pageId = crypto.randomUUID();
  const record = (event: string, details: Record<string, unknown>) => recordBrowserLog({
    timestamp: new Date().toISOString(), participantId: null, event, details,
  });
  window.addEventListener('error', (event) => record('browser.error', {
    message: event.message, stack: event.error instanceof Error ? event.error.stack : undefined,
    filename: event.filename, line: event.lineno, column: event.colno,
  }));
  window.addEventListener('unhandledrejection', (event) => record('browser.unhandled_rejection', {
    message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    stack: event.reason instanceof Error ? event.reason.stack : undefined,
  }));
  window.addEventListener('pagehide', () => {
    record('browser.page_hidden', {});
    flushBrowserLogs(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBrowserLogs(true);
  });
  record('browser.page_opened', { origin: window.location.origin, path: window.location.pathname });
}

export function recordBrowserLog(entry: BrowserLog) {
  if (!pageId) return;
  try {
    const record = { sequence: ++sequence, ...entry };
    let line = redact(JSON.stringify(record));
    if (encoder.encode(line).length > 16_000) {
      line = redact(JSON.stringify({ ...record, details: { truncated: true, preview: line.slice(0, 2_000) } }));
    }
    pending.push(line);
    if (pending.length > 1_000) pending.shift();
    scheduleFlush();
  } catch { /* Logging must not interrupt a voice session. */ }
}

function scheduleFlush() {
  timer ??= setTimeout(() => flushBrowserLogs(), 500);
}

function flushBrowserLogs(unloading = false) {
  clearTimeout(timer);
  timer = undefined;
  if (!pageId || !pending.length || (sending && !unloading)) return;
  const batch: string[] = [];
  let bytes = 0;
  while (pending.length && batch.length < 100 && bytes + encoder.encode(pending[0]).length < 48_000) {
    const line = pending.shift()!;
    batch.push(line);
    bytes += encoder.encode(line).length + 1;
  }
  const body = `{"pageId":"${pageId}","entries":[${batch.join(',')}]}`;
  if (unloading && navigator.sendBeacon('/api/browser-logs', new Blob([body], { type: 'application/json' }))) {
    if (pending.length) scheduleFlush();
    return;
  }
  if (sending) {
    pending.unshift(...batch);
    return;
  }
  sending = true;
  void fetch('/api/browser-logs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    keepalive: true, signal: AbortSignal.timeout(5_000),
  }).then((response) => {
    if (!response.ok) throw new Error('Browser log collection failed.');
  }).catch(() => {
    pending = [...batch, ...pending].slice(-1_000);
  }).finally(() => {
    sending = false;
    if (pending.length) scheduleFlush();
  });
}

function redact(value: string) {
  return value.replace(/\b(?:sk|ek)-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

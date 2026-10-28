// Structured logs, one JSON object per line, written to stdout or stderr so systemd
// journal captures them. Every field passes through redact() before it is written.

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose values are never written, whatever their content.
const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|credential|api[-_]?key|refresh[-_]?token|session[-_]?id|redirect[-_]?url|auth[-_]?url|body|raw_?html|html|description_text|snippet)/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g;
const URL_WITH_CODE = /https?:\/\/\S*[?&](code|token|state|access_token|refresh_token)=\S*/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const GOOGLE_TOKEN = /\bya29\.[A-Za-z0-9._-]+/g;

export function redactString(value: string): string {
  return value
    .replace(URL_WITH_CODE, '[redacted-url]')
    .replace(BEARER, '$1 [redacted]')
    .replace(GOOGLE_TOKEN, '[redacted-token]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]');
}

export function redact(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(minLevel: Level = 'info', bindings: Record<string, unknown> = {}, sink: (line: string, level: Level) => void = defaultSink): Logger {
  const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(redact({ ...bindings, ...fields }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record), level);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (more) => createLogger(minLevel, { ...bindings, ...more }, sink),
  };
}

function defaultSink(line: string, level: Level): void {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

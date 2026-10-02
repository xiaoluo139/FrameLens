/**
 * 轻量日志器：控制台输出 + 内存环形缓冲（供 UI 实时查看）。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BUFFER = 500;

const buffer = [];
const listeners = new Set();

let threshold = LEVELS.info;

export function setLogLevel(level) {
  if (LEVELS[level]) threshold = LEVELS[level];
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentLogs() {
  return buffer.slice();
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: Date.now(),
    level,
    scope,
    message: String(message),
    extra: extra === undefined ? null : safeExtra(extra),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* UI 监听器异常不能拖垮主流程 */
    }
  }
  const tag = `[${scope}]`;
  const line = `${new Date(entry.ts).toISOString()} ${level.toUpperCase()} ${tag} ${entry.message}`;
  if (level === 'error') console.error(line, entry.extra ?? '');
  else if (level === 'warn') console.warn(line, entry.extra ?? '');
  else console.log(line, entry.extra ?? '');
}

function safeExtra(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

export function createLogger(scope) {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('app');

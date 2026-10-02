/**
 * HTTP 传输层。
 * - 默认使用全局 fetch（Node 18+ / Electron 均可用）
 * - 主进程可注入 Electron 的 net.fetch，以支持系统代理与证书
 * - 统一超时、UA、重定向、重试与大小上限
 */

import { createLogger } from './logger.js';

const log = createLogger('http');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let transport = (input, init) => globalThis.fetch(input, init);
let options = { timeoutMs: 20000, proxy: '', userAgent: 'desktop' };

export function setTransport(fn) {
  transport = fn;
}

export function configure(next = {}) {
  options = { ...options, ...next };
}

export function currentOptions() {
  return { ...options };
}

export function userAgent(kind) {
  if (kind === 'mobile') return UA_MOBILE;
  if (kind === 'android') return `${UA_MOBILE} MicroMessenger/8.0.49`;
  return UA_DESKTOP;
}

export class HttpError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * 单次请求（不自动重试）。
 * @returns {Promise<Response>}
 */
export async function request(url, init = {}) {
  const { timeoutMs = options.timeoutMs, signal, headers = {}, ...rest } = init;
  const guard = withTimeout(signal, timeoutMs);
  const finalHeaders = {
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'user-agent')) {
    finalHeaders['user-agent'] = userAgent(options.userAgent);
  }
  try {
    return await transport(url, {
      redirect: 'follow',
      ...rest,
      headers: finalHeaders,
      signal: guard.signal,
    });
  } catch (error) {
    if (guard.signal.aborted) throw new HttpError('请求超时', { url });
    throw error;
  } finally {
    guard.dispose();
  }
}

/**
 * 带重试的请求。默认对网络错误与 5xx 重试。
 */
export async function requestWithRetry(url, init = {}, { retries = 2, backoffMs = 600 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await request(url, init);
      if (res.status >= 500 && attempt < retries) {
        lastError = new HttpError(`服务端错误 ${res.status}`, { status: res.status, url });
      } else {
        return res;
      }
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || init.signal?.aborted) throw error;
    }
    const wait = backoffMs * (attempt + 1);
    log.debug(`第 ${attempt + 1} 次重试 ${url}`, lastError?.message);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastError;
}

export async function getText(url, init = {}, retryOpts) {
  const res = await requestWithRetry(url, init, retryOpts);
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
  return res.text();
}

export async function getJson(url, init = {}, retryOpts) {
  const text = await getText(url, init, retryOpts);
  return parseJsonLoose(text);
}

/** 有些接口返回 `callback({...})` 或带 BOM 的 JSON，做一次宽松解析 */
export function parseJsonLoose(text) {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/^[\w.$]+\s*\(([\s\S]*)\)\s*;?$/);
    if (match) return JSON.parse(match[1]);
    throw new HttpError('响应不是合法 JSON');
  }
}

export function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * 取「实际请求的地址」。
 *
 * CapacitorHttp 会把 fetch 的 URL 改写成
 *   https://localhost/_capacitor_http_interceptor_?u=<原始地址>
 * 于是 response.url 变成这个拦截器地址，据此做域名判断会全部判错
 * （手机端曾因此把抖音识别成「通用网页」）。这里把它还原回原始地址。
 */
export function effectiveUrl(res, fallback = '') {
  const raw = typeof res === 'string' ? res : (res?.url ?? '');
  if (!raw) return fallback;
  const match = raw.match(/\/_capacitor_http_interceptor_\?(?:[^#]*&)?u=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return fallback;
    }
  }
  return raw;
}

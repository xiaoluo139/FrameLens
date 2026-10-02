/**
 * 各平台解析器共用的小工具。
 */

import { sliceBalancedObject } from '../html.js';

/** 从 HTML 里取出 `window.XXX = {...}` 形式的 JSON */
export function readAssignedObject(html, varNames) {
  const names = Array.isArray(varNames) ? varNames : [varNames];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s*=\\s*\\{`, 'm');
    const match = html.match(re);
    if (!match) continue;
    const start = match.index + match[0].length - 1;
    const balanced = sliceBalancedObject(html.slice(start));
    if (!balanced) continue;
    try {
      return JSON.parse(balanced);
    } catch {
      continue;
    }
  }
  return null;
}

/** 安全取值：safeGet(obj, 'a.b.0.c') */
export function safeGet(object, path, fallback = undefined) {
  const value = String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
  return value === undefined ? fallback : value;
}

export function firstArrayValue(value) {
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v) ?? '';
  return typeof value === 'string' ? value : '';
}

/** 修掉 JSON 字符串里被转义的斜杠 */
export function unescapeUrl(value) {
  return String(value ?? '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

/**
 * 完整还原 JSON 字符串里的转义。
 * 只处理 \u002F 和 \/ 是不够的——真实页面里还会出现 \u0026(&)、\u003D(=)、
 * \u003F(?) 等，漏掉就会产出带字面量 `\u0026` 的假地址（实测 YouTube 页面就会这样）。
 * 同时把尚未还原的残留转义视为非法，交给调用方丢弃。
 */
export function decodeJsonUrl(value) {
  const text = String(value ?? '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/');
  return text;
}

/** URL 是否可信：还原后仍含反斜杠转义、空白、或无法解析的都判为无效 */
export function isUsableUrl(value) {
  const text = String(value ?? '').trim();
  if (text.length < 10) return false;
  if (/\\u[0-9a-fA-F]{4}|\\\//.test(text)) return false;
  if (/\s/.test(text)) return false;
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const url = new URL(text);
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** 这些地址需要二次签名/鉴权才能真正下载，列出来只会误导用户 */
const UNUSABLE_PATTERNS = [/initplayback/i, /signatureCipher/i, /\/videoplayback\?[^]*\bn=[A-Za-z0-9_-]{2,}/];

export function isDirectlyDownloadable(url) {
  return !UNUSABLE_PATTERNS.some((re) => re.test(String(url)));
}

export function withReferer(url, referer) {
  return referer ? { referer } : {};
}

export function parseCsvNumbers(value) {
  return String(value ?? '')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
}

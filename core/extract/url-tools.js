/**
 * 输入解析：从分享文本里提取 URL、补全协议、判断直链媒体。
 */

const URL_RE = /https?:\/\/[^\s"'<>()（）【】\u4e00-\u9fa5]+/gi;
const BARE_DOMAIN_RE =
  /\b((?:[a-z0-9-]+\.)+(?:com|cn|net|tv|me|be|io|org|xyz|top|cc|vip|info)(?:\/[^\s"'<>()（）【】\u4e00-\u9fa5]*)?)/gi;

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|flv|ts|m3u8|mpd|avi|wmv)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg)(\?|#|$)/i;

/** 从任意文本中提取所有 URL（保持出现顺序，自动去重） */
export function extractUrls(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  const push = (raw) => {
    const cleaned = trimTrailing(raw);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    found.push(cleaned);
  };

  for (const match of String(text).matchAll(URL_RE)) push(match[0]);
  if (found.length === 0) {
    for (const match of String(text).matchAll(BARE_DOMAIN_RE)) push(`https://${match[1]}`);
  }
  return found;
}

/** 去掉中文标点、右括号等常见尾随字符 */
function trimTrailing(url) {
  let out = url;
  while (out.length > 0 && /[.,;:!?、，。；：！？"'）)】》\]]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function mediaKind(url) {
  if (VIDEO_EXT.test(url)) return 'video';
  if (IMAGE_EXT.test(url)) return 'image';
  if (AUDIO_EXT.test(url)) return 'audio';
  return 'page';
}

export function isDirectMedia(url) {
  return mediaKind(url) !== 'page';
}

/** 根据 URL 猜一个安全的文件名 */
export function guessFileName(url, fallback = 'media') {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '');
    if (last && last.length < 120) return last;
  } catch {
    /* ignore */
  }
  return `${fallback}-${Date.now()}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Windows / macOS / Linux 通用安全文件名 */
export function sanitizeFileName(name, replacement = '_') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, replacement)
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'untitled';
}

/** 解析 "1080P" / "720p60" / 4000 这类清晰度文本 -> 数值（用于排序） */
export function qualityScore(label) {
  if (typeof label === 'number') return label;
  const text = String(label ?? '');
  const byName = { '8k': 8000, '4k': 4000, '2k': 2000, '1080': 1080, '720': 720, '480': 480, '360': 360, '240': 240 };
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(byName)) {
    if (lower.includes(key)) return value;
  }
  const digits = text.match(/\d{3,4}/);
  return digits ? Number(digits[0]) : 0;
}

export function dedupeVariants(variants) {
  const seen = new Set();
  const out = [];
  for (const v of variants) {
    if (!v?.url) continue;
    const key = `${v.url}|${v.quality}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

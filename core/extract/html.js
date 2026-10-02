/**
 * 网页元数据抽取：OG / Twitter Card / JSON-LD / <video> / 内嵌 JSON。
 * 这是「通用平台」能力的地基——绝大多数网页都能拿到标题、封面与视频地址。
 */

import { resolveUrl } from '../http.js';

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, entity) => {
    if (entity in ENTITIES) return ENTITIES[entity];
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    return raw;
  });
}

function pickAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/** 收集所有 <meta>，同时支持 name/property/itemprop 三种键 */
function collectMeta(html) {
  const meta = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (pickAttr(tag, 'property') || pickAttr(tag, 'name') || pickAttr(tag, 'itemprop')).toLowerCase();
    const content = pickAttr(tag, 'content');
    if (!key || !content) continue;
    if (!(key in meta)) meta[key] = content;
  }
  return meta;
}

function collectLinks(html) {
  const links = {};
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = pickAttr(tag, 'rel').toLowerCase();
    const href = pickAttr(tag, 'href');
    if (!rel || !href) continue;
    if (!(rel in links)) links[rel] = href;
  }
  return links;
}

/** 抽取页面里所有 JSON-LD 块 */
export function collectJsonLd(html) {
  const blocks = [];
  for (const match of html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = match[1].trim().replace(/^\uFEFF/, '');
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      /* 页面 JSON-LD 常常带尾逗号，忽略即可 */
    }
  }
  return blocks;
}

/** 解析形如 <script id="x">window.X = {...}</script> 的赋值型 JSON */
export function extractAssignedJson(html, variablePattern) {
  const re = new RegExp(`${variablePattern}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?\\s*(?:</script>|$)`, 'i');
  const match = html.match(re);
  if (!match) return null;
  const text = match[1];
  try {
    return JSON.parse(text);
  } catch {
    // 退化处理：做括号配对切出第一个完整 JSON 对象
    const balanced = sliceBalancedObject(text);
    if (!balanced) return null;
    try {
      return JSON.parse(balanced);
    } catch {
      return null;
    }
  }
}

export function sliceBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function walkJsonLd(node, visit) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkJsonLd(item, visit));
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) walkJsonLd(value, visit);
}

function isoDurationToSeconds(value) {
  const match = String(value ?? '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

/**
 * 从 HTML 中抽取媒体与元信息。
 * @param {string} html
 * @param {string} baseUrl 用于把相对地址转成绝对地址
 */
export function extractHtmlMeta(html, baseUrl = '') {
  const meta = collectMeta(html);
  const links = collectLinks(html);
  const jsonLd = collectJsonLd(html);

  const result = {
    title:
      meta['og:title'] ||
      meta['twitter:title'] ||
      decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()),
    description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
    cover: meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || links['image_src'] || '',
    siteName: meta['og:site_name'] || '',
    author: meta.author || meta['article:author'] || '',
    durationSec: 0,
    videoUrls: [],
    audioUrls: [],
    imageUrls: [],
    poster: '',
  };

  const push = (list, value) => {
    if (!value) return;
    const abs = resolveUrl(baseUrl, value);
    if (!list.includes(abs)) list.push(abs);
  };

  for (const [key, value] of Object.entries(meta)) {
    if (/^og:video(:url|:secure_url)?$/.test(key) || /^twitter:player:stream$/.test(key)) push(result.videoUrls, value);
    if (/^og:audio(:url)?$/.test(key)) push(result.audioUrls, value);
    if (/^og:image(:url|:secure_url)?$/.test(key)) push(result.imageUrls, value);
  }

  // <video src> / <video><source></video> / data-src 惰性加载
  for (const match of html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
    const tag = match[0];
    push(result.videoUrls, pickAttr(tag, 'src') || pickAttr(tag, 'data-src'));
    const poster = pickAttr(tag, 'poster');
    if (poster && !result.poster) result.poster = resolveUrl(baseUrl, poster);
    for (const source of match[1].matchAll(/<source\b[^>]*>/gi)) {
      push(result.videoUrls, pickAttr(source[0], 'src') || pickAttr(source[0], 'data-src'));
    }
  }
  for (const match of html.matchAll(/<(?:source|embed)\b[^>]*>/gi)) {
    const tag = match[0];
    const type = pickAttr(tag, 'type');
    const src = pickAttr(tag, 'src') || pickAttr(tag, 'data-src');
    if (!src) continue;
    if (/audio/i.test(type)) push(result.audioUrls, src);
    else if (/video/i.test(type)) push(result.videoUrls, src);
    // <embed> 常是播放器/插件地址，没有明确 type 时只认媒体扩展名
    else if (!type && /\.(mp4|m4v|mov|mkv|webm|flv|ts|m3u8|mpd)(\?|#|$)/i.test(src)) push(result.videoUrls, src);
  }
  for (const match of html.matchAll(/<meta\b[^>]*(?:itemprop|property)\s*=\s*["'](?:contentUrl|video_url)["'][^>]*>/gi)) {
    push(result.videoUrls, pickAttr(match[0], 'content'));
  }

  // JSON-LD
  walkJsonLd(jsonLd, (node) => {
    const type = String(node['@type'] ?? '').toLowerCase();
    if (type === 'videoobject') {
      result.title ||= node.name ?? '';
      result.description ||= typeof node.description === 'string' ? node.description : '';
      result.cover ||= node.thumbnailUrl ?? '';
      if (!result.durationSec) result.durationSec = isoDurationToSeconds(node.duration);
      const content = node.contentUrl ?? node.embedUrl ?? node.url;
      if (typeof content === 'string') push(result.videoUrls, content);
      if (Array.isArray(node.contentUrl)) node.contentUrl.forEach((c) => push(result.videoUrls, c));
      const uploader = node.creator ?? node.author;
      if (!result.author && uploader) {
        result.author = typeof uploader === 'string' ? uploader : (uploader.name ?? '');
      }
    }
    if (type === 'imageobject' && typeof node.contentUrl === 'string') push(result.imageUrls, node.contentUrl);
  });

  result.title = decodeEntities(result.title ?? '').replace(/\s+/g, ' ').trim();
  result.description = decodeEntities(result.description ?? '').replace(/\s+/g, ' ').trim();
  if (result.cover) result.cover = resolveUrl(baseUrl, result.cover);
  if (result.poster) result.poster = resolveUrl(baseUrl, result.poster);

  return result;
}

/** 在文本里找第一个符合特征的绝对 URL（常用于内嵌 json 的兜底抓取） */
export function findFirstUrl(text, pattern) {
  const re = new RegExp(pattern, 'i');
  const match = String(text).match(re);
  return match?.[1] ?? match?.[0] ?? '';
}

/**
 * 通用提取器：适用于任何公开网页 / 直链媒体。
 * 覆盖 OG 标签、JSON-LD、<video> 标签、HLS 多码率清单、内嵌 JSON 里的播放地址。
 */

import { extractHtmlMeta, decodeEntities, sliceBalancedObject } from '../html.js';
import { isMasterPlaylist, isPlaylist, parseMasterPlaylist, sortVariants, labelFor } from '../hls.js';
import { createAsset, guessFormat } from '../model.js';
import { mediaKind, normalizeUrl, guessFileName } from '../url-tools.js';
import { resolveUrl, userAgent } from '../../http.js';
import { decodeJsonUrl, isUsableUrl, isDirectlyDownloadable } from './util.js';

/** 通用解析最多列出的清晰度数量：避免把页面上几百个近似地址全倒给用户 */
const MAX_GENERIC_VARIANTS = 24;

/**
 * 内嵌 JSON 里的「播放地址」字段，分强弱两档：
 *   STRONG：专指播放地址，即使没有扩展名也大概率是媒体
 *   WEAK  ：`src` / `url` 太泛（页面里图片、频道页、脚本地址都叫 url），
 *           只有明确是媒体文件、或落在已知媒体 CDN 上才采信
 */
const STRONG_KEYS = [
  'playAddr',
  'play_addr',
  'playUrl',
  'play_url',
  'videoUrl',
  'video_url',
  'downloadAddr',
  'download_addr',
  'masterUrl',
  'master_url',
];
const WEAK_KEYS = ['src', 'url'];

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|flv|ts|m3u8|mpd|avi|wmv|mp3|m4a|aac)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|bmp|avif|svg)(\?|#|$)/i;
/** 播放器页面而非媒体文件：YouTube 的 og:video 就是这种 embed 地址 */
const PLAYER_PAGE = /\/(embed|player|iframe|watch)(\/|\?|$)/i;
/** 已知媒体 CDN：这些域名下的无扩展名地址通常是真实媒体流 */
const MEDIA_CDN = /(bilivideo|douyinvod|douyinpic|tiktokcdn|tiktokv|kwimgs|gifshow|ixigua|zjcdn|akamaized|cloudfront|myqcloud|aliyuncs|googlevideo|mcdn|xhscdn|cdinstagram|sinaimg|hdslb|byteimg)/i;

/** 是否是「像视频」的地址：排除图片，接受媒体扩展名或已知媒体 CDN */
export function looksLikeVideoUrl(raw) {
  const text = String(raw ?? '');
  if (IMAGE_EXT.test(text)) return false;
  if (MEDIA_EXT.test(text)) return true;
  if (PLAYER_PAGE.test(text)) return false;
  try {
    return MEDIA_CDN.test(new URL(text).hostname);
  } catch {
    return false;
  }
}

/**
 * 来自 og:video / 强字段的地址即使没有扩展名也相对可信，
 * 但图片和播放器页面这两类「明显不是媒体文件」的要排除。
 */
function isObviouslyNotMedia(raw) {
  const text = String(raw ?? '');
  if (IMAGE_EXT.test(text)) return true;
  if (!MEDIA_EXT.test(text) && PLAYER_PAGE.test(text)) return true;
  return false;
}

export const id = 'generic';
export const platforms = ['*'];

export async function extract(ctx) {
  const { url, platform, http, logger, signal } = ctx;

  if (mediaKind(url) !== 'page') {
    return createAsset({
      platform,
      webpageUrl: url,
      mediaType: mediaKind(url),
      title: decodeURIComponent(guessFileName(url, '直链媒体')),
      variants: [{ url, label: '原始文件', quality: 0 }],
    });
  }

  let html;
  try {
    html = await http.getText(url, { headers: platformHeaders(platform), signal });
  } catch (error) {
    const hint = /404/.test(error.message) ? '（链接可能已失效，请重新复制分享文本）' : '';
    throw new Error(`目标页面无法访问：${error.message}${hint}`);
  }
  const meta = extractHtmlMeta(html, url);

  const candidates = [];
  const seen = new Set();
  const addCandidate = (raw, source, trusted = false) => {
    if (!raw || typeof raw !== 'string') return;
    const value = decodeJsonUrl(raw.startsWith('//') ? `https:${raw}` : raw);
    if (!isUsableUrl(value)) return;
    if (!isDirectlyDownloadable(value)) return;
    // 可信来源只排除「明显不是媒体」的地址；泛化字段则必须"像视频"才采信
    if (trusted ? isObviouslyNotMedia(value) : !looksLikeVideoUrl(value)) return;
    const abs = normalizeUrl(resolveUrl(url, value));
    if (!/^https?:/i.test(abs) || seen.has(abs)) return;
    // 同一路径只保留一个：YouTube 之类页面会带几百个仅查询参数不同的近似地址
    const key = (() => {
      try {
        const u = new URL(abs);
        return `${u.host}${u.pathname}`;
      } catch {
        return abs;
      }
    })();
    if (seen.has(key)) return;
    seen.add(abs);
    seen.add(key);
    candidates.push({ url: abs, source });
  };

  meta.videoUrls.forEach((u) => addCandidate(u, 'og/meta', true));
  collectEmbeddedCandidates(html, addCandidate);

  const variants = [];
  const warnings = [];

  for (const candidate of candidates) {
    if (/\.m3u8(\?|$)/i.test(candidate.url)) {
      try {
        const playlist = await http.getText(candidate.url, { headers: platformHeaders(platform), signal });
        if (isMasterPlaylist(playlist)) {
          for (const v of sortVariants(parseMasterPlaylist(playlist, candidate.url))) {
            variants.push({ url: v.url, label: v.label, quality: v.quality, bandwidth: v.bandwidth, format: 'mp4' });
          }
          continue;
        }
        if (isPlaylist(playlist)) {
          variants.push({ url: candidate.url, label: 'HLS 直播/点播流', quality: 0, isManifest: true, note: '需支持 m3u8 的下载器' });
          continue;
        }
      } catch (error) {
        logger.warn(`HLS 清单读取失败：${candidate.url}`, error);
        warnings.push('HLS 清单读取失败，已保留原始地址');
      }
      variants.push({ url: candidate.url, label: 'HLS 多码率', quality: 0, isManifest: true });
      continue;
    }
    if (/\.mpd(\?|$)/i.test(candidate.url)) {
      variants.push({ url: candidate.url, label: 'DASH 清单', quality: 0, format: 'mpd', isManifest: true, note: 'DASH 需合并音视频轨' });
      continue;
    }
    variants.push({
      url: candidate.url,
      label: labelFromUrl(candidate.url),
      quality: qualityFromUrl(candidate.url),
      format: guessFormat(candidate.url) || 'mp4',
    });
  }

  if (variants.length === 0) {
    warnings.push('页面里没有找到可直接下载的媒体地址，该站点可能需要登录、或需要用专用工具（如 yt-dlp）解密');
  }

  /**
   * 兜底：服务端抓不到东西时，用本机浏览器渲染一次。
   * 既能救回被 JS 动态渲染的视频，也能把图文帖的配图抓出来。
   */
  const images = [...(meta.imageUrls ?? [])];
  if (variants.length === 0 && ctx.renderMedia) {
    try {
      const rendered = await ctx.renderMedia(url, { timeoutMs: 25000 });
      for (const [index, item] of (rendered.mediaUrls ?? []).entries()) {
        variants.push({ url: item, label: `直链 ${index + 1}`, quality: 0, format: guessFormat(item) || 'mp4' });
      }
      for (const item of rendered.images ?? []) if (!images.includes(item)) images.push(item);
      if (variants.length > 0 || images.length > 0) {
        warnings.length = 0;
        warnings.push('内容由本机浏览器渲染后捕获，直链有时效性，请尽快下载。');
      }
    } catch (error) {
      logger.warn('通用解析的浏览器渲染兜底失败', error);
    }
  }
  if (candidates.length > MAX_GENERIC_VARIANTS) {
    warnings.push(`页面里共有 ${candidates.length} 个候选地址，已只展示前 ${MAX_GENERIC_VARIANTS} 条`);
  }

  return createAsset({
    platform,
    webpageUrl: url,
    mediaType: meta.videoUrls.length > 0 || variants.length > 0 ? 'video' : 'page',
    title: meta.title,
    author: meta.author,
    description: meta.description,
    cover: meta.cover || meta.poster,
    durationSec: meta.durationSec,
    variants: variants.slice(0, MAX_GENERIC_VARIANTS),
    images: images.slice(0, 24),
    mediaType: variants.length > 0 ? 'video' : images.length > 0 ? 'image' : 'page',
    warnings,
    extra: { siteName: meta.siteName },
  });
}

export function platformHeaders(platform) {
  const headers = {};
  if (platform?.referer) headers.referer = platform.referer;
  if (platform?.ua) headers['user-agent'] = userAgent(platform.ua);
  return headers;
}

/** 从 HTML 里挖出内嵌 JSON 中的媒体地址 */
function collectEmbeddedCandidates(html, add) {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const body = match[1];
    if (body.length < 40 || body.length > 2_000_000) continue;
    if (!/https?:\\?\/\\?\//.test(body) && !/playAddr|play_url|videoUrl/.test(body)) continue;

    for (const key of STRONG_KEYS) {
      const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{8,2000})"`, 'g');
      for (const m of body.matchAll(re)) add(m[1], 'embedded-strong', true);
    }
    for (const key of WEAK_KEYS) {
      const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{8,2000})"`, 'g');
      for (const m of body.matchAll(re)) add(m[1], 'embedded-weak', false);
    }
  }

  // 形如 window.__DATA__ = {...}
  const assigned = html.match(/(?:window\.)?[A-Za-z_$][\w$]*\s*=\s*\{\s*"/g);
  if (assigned && html.length < 3_000_000) {
    for (const m of html.matchAll(/(?:window\.)?[A-Za-z_$][\w$]*\s*=\s*\{/g)) {
      const balanced = sliceBalancedObject(html.slice(m.index + m[0].length - 1));
      if (!balanced || balanced.length > 500_000) continue;
      for (const key of STRONG_KEYS) {
        const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{8,2000})"`, 'g');
        for (const mm of balanced.matchAll(re)) add(mm[1], 'inline-strong', true);
      }
      for (const key of WEAK_KEYS) {
        const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{8,2000})"`, 'g');
        for (const mm of balanced.matchAll(re)) add(mm[1], 'inline-weak', false);
      }
    }
  }
}

function qualityFromUrl(url) {
  const match = url.match(/(\d{3,4})[pP](?:\b|_|\/|\.)/);
  if (match) return Number(match[1]);
  if (/4k/i.test(url)) return 2160;
  if (/2k/i.test(url)) return 1440;
  return 0;
}

function labelFromUrl(url) {
  const quality = qualityFromUrl(url);
  return quality ? labelFor(quality) : '默认清晰度';
}

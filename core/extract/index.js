/**
 * 解析流水线：分享文本 -> URL -> 平台识别 -> 专用/通用解析器 -> 归一化媒体对象。
 */

import { createLogger } from '../logger.js';
import * as http from '../http.js';
import { extractUrls, isDirectMedia, normalizeUrl } from './url-tools.js';
import { GENERIC_PLATFORM, findPlatformByHost, getPlatform, isShortUrl } from './platforms.js';
import { createAsset } from './model.js';

import * as generic from './extractors/generic.js';
import * as bilibili from './extractors/bilibili.js';
import * as douyin from './extractors/douyin.js';
import * as kuaishou from './extractors/kuaishou.js';
import * as xiaohongshu from './extractors/xiaohongshu.js';
import * as youtube from './extractors/youtube.js';
import * as weibo from './extractors/weibo.js';

const EXTRACTORS = [bilibili, douyin, kuaishou, xiaohongshu, youtube, weibo];
const log = createLogger('extract');

const BY_PLATFORM = new Map();
for (const extractor of EXTRACTORS) {
  for (const platformId of extractor.platforms) BY_PLATFORM.set(platformId, extractor);
}

export function listPlatforms() {
  return [...new Set([...BY_PLATFORM.keys(), 'generic'])];
}

export function detectPlatform(url) {
  try {
    const { hostname } = new URL(url);
    return findPlatformByHost(hostname) ?? GENERIC_PLATFORM;
  } catch {
    return GENERIC_PLATFORM;
  }
}

/**
 * 分析一段分享文本，返回解析结果列表。
 * @param {string} input
 * @param {{signal?: AbortSignal, onProgress?: (event: object) => void, maxItems?: number}} options
 */
export async function analyze(input, options = {}) {
  const { signal, onProgress = () => {}, maxItems = 8, renderMedia, resolveUrl } = options;
  const urls = extractUrls(input);
  if (urls.length === 0) {
    const error = new Error('没有识别到链接，请粘贴视频分享文本或 URL');
    error.code = 'NO_URL';
    throw error;
  }

  const targets = urls.slice(0, maxItems);
  const assets = [];
  const failures = [];

  for (const [index, rawUrl] of targets.entries()) {
    if (signal?.aborted) break;
    onProgress({ stage: 'start', index, total: targets.length, url: rawUrl });
    try {
      const asset = await analyzeOne(rawUrl, { signal, onProgress, index, total: targets.length, renderMedia, resolveUrl });
      assets.push(asset);
      onProgress({ stage: 'done', index, total: targets.length, assetId: asset.id, title: asset.title });
    } catch (error) {
      log.warn(`解析失败：${rawUrl}`, error);
      failures.push({ url: rawUrl, message: error?.message ?? String(error) });
      onProgress({ stage: 'error', index, total: targets.length, url: rawUrl, message: error?.message });
    }
  }

  return {
    ok: assets.length > 0,
    count: assets.length,
    total: targets.length,
    assets,
    failures,
    analyzedAt: Date.now(),
  };
}

/** 解析单个链接 */
export async function analyzeOne(rawUrl, options = {}) {
  const { signal, onProgress = () => {}, index = 0, total = 1, renderMedia, resolveUrl } = options;

  onProgress({ stage: 'resolve', index, total, url: rawUrl });

  /**
   * 短链域名本身就能确定平台（v.douyin.com -> 抖音），所以平台识别直接用原始链接，
   * 不必等展开；展开后的地址仍会交给解析器（部分平台需要它取 ID）。
   */
  const shortPlatform = isShortUrl(rawUrl) ? detectPlatform(rawUrl) : null;
  const url = shortPlatform ? normalizeUrl(rawUrl) : await resolveFinalUrl(rawUrl, signal, resolveUrl);
  const platform = shortPlatform ?? detectPlatform(url);

  if (isDirectMedia(url)) {
    return createAsset({
      platform,
      webpageUrl: url,
      mediaType: 'video',
      title: decodeURIComponent(url.split('/').at(-1) ?? ''),
      variants: [{ url, label: '原始文件', quality: 0 }],
    });
  }

  const extractor = BY_PLATFORM.get(platform.id);
  const headers = {};
  if (platform.referer) headers.referer = platform.referer;
  headers['user-agent'] = http.userAgent(platform.ua ?? 'desktop');

  const ctx = {
    url,
    rawUrl,
    platform,
    signal,
    logger: log.child(platform.id),
    /**
     * 用主进程里的隐藏浏览器渲染页面并捕获媒体地址。
     * 核心逻辑层不依赖 Electron：这个能力由调用方注入，
     * 在纯 Node 环境下为 undefined，解析器会自动跳过这条路径。
     */
    renderMedia,
    /** 展开短链的能力：手机端由隐藏 WebView 提供，因为 Capacitor 的 HTTP 拦截器会吞掉重定向地址 */
    resolveUrl,
    http: {
      request: http.request,
      effectiveUrl: http.effectiveUrl,
      getText: (target, init) => http.getText(target, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }),
      getJson: (target, init) => http.getJson(target, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }),
    },
  };

  if (extractor) {
    onProgress({ stage: 'extract', index, total, url, platform: platform.name });
    try {
      const asset = await extractor.extract(ctx);
      if (asset.variants.length > 0 || asset.images.length > 0) return asset;
      log.warn(`${platform.name} 专用解析器没有拿到媒体，回退通用解析`);
      const fallback = await generic.extract(ctx);
      return mergeAssets(asset, fallback, `${platform.name} 专用解析未取到直链，已改用通用解析`);
    } catch (error) {
      log.warn(`${platform.name} 专用解析器失败，回退通用解析`, error);
      const fallback = await generic.extract(ctx);
      fallback.warnings.push(`${platform.name} 专用解析失败：${error?.message ?? error}`);
      return fallback;
    }
  }

  onProgress({ stage: 'extract', index, total, url, platform: platform.name });
  return generic.extract(ctx);
}

/** 短链（v.douyin.com / b23.tv / t.cn ...）跟随跳转拿到真实地址 */
export async function resolveFinalUrl(url, signal, resolveUrlFn) {
  if (!isShortUrl(url)) return normalizeUrl(url);
  // 优先用调用方注入的解析器
  if (resolveUrlFn) {
    try {
      const resolved = await resolveUrlFn(url);
      if (resolved) return normalizeUrl(resolved);
    } catch (error) {
      log.warn(`注入的短链解析器失败：${url}`, error);
    }
  }
  try {
    const res = await http.request(url, { method: 'GET', headers: { 'user-agent': http.userAgent('mobile') }, signal });
    // 注意要「调用」effectiveUrl：写成 `http.effectiveUrl ?? ...` 会把函数本身当值用
    return normalizeUrl(http.effectiveUrl ? http.effectiveUrl(res, url) : (res.url ?? url));
  } catch (error) {
    log.warn(`短链展开失败：${url}`, error);
    return normalizeUrl(url);
  }
}

/**
 * 专用解析器拿到了元信息却没拿到直链时，用通用解析器补直链，
 * 同时保留专用解析器更准确的标题/作者/时长/封面，避免白白丢信息。
 */
function mergeAssets(primary, fallback, note) {
  return {
    ...fallback,
    id: primary.id || fallback.id,
    platformId: primary.platformId || fallback.platformId,
    platformName: primary.platformName || fallback.platformName,
    platformColor: primary.platformColor || fallback.platformColor,
    title: primary.title && primary.title !== '未命名视频' ? primary.title : fallback.title,
    author: primary.author || fallback.author,
    description: primary.description || fallback.description,
    cover: primary.cover || fallback.cover,
    durationSec: primary.durationSec || fallback.durationSec,
    mediaType: primary.mediaType || fallback.mediaType,
    extra: { ...fallback.extra, ...primary.extra },
    warnings: [...new Set([...(primary.warnings ?? []), ...(fallback.warnings ?? []), note])],
  };
}

export { createAsset, getPlatform, mergeAssets };

/**
 * HLS（m3u8）主播放列表解析：把多码率清单展开成可下载的清晰度列表。
 */

import { resolveUrl } from '../http.js';

const QUALITY_ORDER = ['2160', '1440', '1080', '720', '480', '360', '240'];

/**
 * 解析 master playlist。
 * @returns {Array<{url:string, bandwidth:number, resolution:string, quality:number, codecs:string, label:string}>}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const variants = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/i.test(line)) {
      continue;
    }
    if (line.startsWith('#')) continue;

    if (pending) {
      const resolution = pending.RESOLUTION ?? '';
      const height = Number(resolution.split('x')[1] ?? 0) || 0;
      const quality = height || Math.round(Number(pending.BANDWIDTH ?? 0) / 15000);
      variants.push({
        url: resolveUrl(baseUrl, line),
        bandwidth: Number(pending.BANDWIDTH ?? 0),
        resolution,
        quality,
        codecs: pending.CODECS ?? '',
        label: labelFor(quality, resolution),
      });
      pending = null;
    }
  }
  return variants;
}

/** 解析 `KEY=VALUE,KEY="VALUE"` 形式的属性列表 */
export function parseAttributes(input) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of input.matchAll(re)) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

export function isMediaPlaylist(text) {
  return /#EXTINF/i.test(text);
}

export function isPlaylist(text) {
  // 有些服务器返回的清单不带 #EXTM3U 头，只认 #EXTINF 也能用
  return /#EXTM3U|#EXTINF/.test(String(text).trim());
}

export function labelFor(quality, resolution = '') {
  if (!quality && /^\d+x(\d+)$/.test(resolution)) {
    return `${Number(resolution.split('x')[1])}P 自适应`;
  }
  if (quality >= 2160) return '4K 超清';
  if (quality >= 1440) return '2K 超清';
  if (quality >= 1080) return '1080P 全高清';
  if (quality >= 720) return '720P 高清';
  if (quality >= 480) return '480P 标清';
  if (quality >= 360) return '360P 流畅';
  return resolution ? `${resolution} 自适应` : '自适应';
}

export function sortVariants(variants) {
  return [...variants].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

export { QUALITY_ORDER };

/**
 * 快手：短链跳转后读取页面内嵌的 Apollo State。
 * 快手前端结构变动频繁，这里做多路径兜底，失败时自动回退到通用抓取。
 */

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';
import { readAssignedObject, unescapeUrl } from './util.js';

export const id = 'kuaishou';
export const platforms = ['kuaishou'];

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export async function extract(ctx) {
  const { url, http, logger, signal } = ctx;
  const platform = getPlatform('kuaishou');
  const headers = { 'user-agent': MOBILE_UA, referer: 'https://www.kuaishou.com/' };

  const res = await http.request(url, { headers, signal });
  const finalUrl = http.effectiveUrl ? http.effectiveUrl(res, url) : (res.url || url);
  const html = await res.text();

  const apollo = readAssignedObject(html, ['window.__APOLLO_STATE__', '__APOLLO_STATE__']);
  const warnings = [];
  const variants = [];
  let title = '';
  let author = '';
  let cover = '';
  let durationSec = 0;
  const photoId = parsePhotoId(finalUrl) || parsePhotoId(url);

  const photos = collectPhotoNodes(apollo);
  const photo = photos.find((p) => String(p.id ?? p.photoId ?? '') === photoId) ?? photos[0];

  if (photo) {
    title = photo.caption ?? photo.title ?? '';
    author = photo.userName ?? photo.user?.name ?? '';
    cover = photo.coverUrl ?? photo.coverUrls?.[0]?.url ?? '';
    durationSec = Math.round(Number(photo.duration ?? 0) / 1000);
    for (const [key, entry] of Object.entries(photo)) {
      if (!/url$/i.test(key) || typeof entry !== 'string') continue;
      if (!/^https?:/.test(entry) || !/\.(mp4|m3u8)/i.test(entry)) continue;
      variants.push({
        url: unescapeUrl(entry),
        label: key.toLowerCase().includes('hd') ? '高清' : '默认清晰度',
        quality: key.toLowerCase().includes('hd') ? 1080 : 720,
        format: entry.includes('.m3u8') ? 'm3u8' : 'mp4',
      });
    }
  }

  if (variants.length === 0) warnings.push('未能从快手页面提取直链，已保留作品页地址');

  logger.debug(`快手命中节点 ${photos.length} 个`, { photoId });

  return createAsset({
    platform,
    webpageUrl: finalUrl,
    title: title || (photoId ? `快手作品 ${photoId}` : '快手作品'),
    author,
    cover: unescapeUrl(cover),
    durationSec,
    variants,
    warnings,
    extra: { photoId },
  });
}

export function parsePhotoId(url) {
  return (
    String(url).match(/\/short-video\/([\w-]{6,32})/)?.[1] ??
    String(url).match(/\/fw\/photo\/([\w-]{6,32})/)?.[1] ??
    String(url).match(/photoId=([\w-]{6,32})/)?.[1] ??
    ''
  );
}

function collectPhotoNodes(apollo) {
  const found = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, depth + 1));
      return;
    }
    if (node.__typename === 'Photo' || node.photoUrl || node.photoId) found.push(node);
    Object.values(node).forEach((child) => walk(child, depth + 1));
  };
  walk(apollo, 0);
  return found;
}

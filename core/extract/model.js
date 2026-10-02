/**
 * 归一化媒体模型：所有解析器都产出一致的结构，UI 只认这一份 schema。
 */

import { dedupeVariants, qualityScore } from './url-tools.js';
import { labelFor } from './hls.js';

export function createVariant(input) {
  const quality = input.quality ?? qualityScore(input.label ?? '');
  const format = (input.format ?? guessFormat(input.url) ?? 'mp4').toLowerCase();
  return {
    id: input.id ?? `${quality || 'auto'}-${format}-${shortHash(input.url)}`,
    label: input.label || labelFor(quality),
    quality,
    format,
    url: input.url,
    headers: input.headers ?? {},
    bandwidth: input.bandwidth ?? 0,
    sizeBytes: input.sizeBytes ?? 0,
    isManifest: /\.m3u8|\.mpd(\?|$)/i.test(input.url ?? ''),
    note: input.note ?? '',
  };
}

export function guessFormat(url) {
  const match = String(url).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
  return match ? match[1] : '';
}

export function shortHash(input) {
  let hash = 0;
  const text = String(input ?? '');
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

export function createAsset(input) {
  const platform = input.platform ?? { id: 'generic', name: '通用网页', color: '#7C8CF8' };
  // 关键：把平台请求头（尤其是 Referer）挂到每个变体上。
  // B 站等 CDN 在没有 Referer 时直接 403，用户会看到「下载失败」却不知道为什么。
  const defaultHeaders = platform.referer ? { referer: platform.referer } : {};
  const variants = dedupeVariants(
    (input.variants ?? []).map((variant) =>
      createVariant({ headers: { ...defaultHeaders, ...(variant.headers ?? {}) }, ...variant }),
    ),
  ).sort((a, b) => b.quality - a.quality || b.bandwidth - a.bandwidth);

  /**
   * 封面统一当作「第一张可下载的图片」。
   * 之前只在抖音解析器里做了这件事，导致 B 站等平台只有视频没有图片，
   * 用户看到的界面就少了「图片与封面」这一块和对应的下载按钮。
   * 放在公共层后，所有平台（含通用解析）都自动具备「图片 + 视频」双解析。
   */
  const cover = input.cover ?? '';
  const images = [];
  for (const url of [cover, ...(input.images ?? [])]) {
    if (url && !images.includes(url)) images.push(url);
  }

  return {
    id: input.id ?? `${platform.id}-${shortHash(input.webpageUrl ?? input.title ?? Date.now())}`,
    platformId: platform.id,
    platformName: platform.name,
    platformColor: platform.color ?? '#7C8CF8',
    mediaType: input.mediaType ?? 'video',
    title: (input.title ?? '').trim() || '未命名视频',
    author: input.author ?? '',
    description: input.description ?? '',
    cover,
    durationSec: Number(input.durationSec ?? 0) || 0,
    webpageUrl: input.webpageUrl ?? '',
    variants,
    images,
    extra: input.extra ?? {},
    warnings: input.warnings ?? [],
    resolvedAt: Date.now(),
  };
}

/** 给 UI 用的展示摘要 */
export function summarizeAsset(asset) {
  return {
    id: asset.id,
    title: asset.title,
    platformName: asset.platformName,
    platformColor: asset.platformColor,
    author: asset.author,
    cover: asset.cover,
    durationSec: asset.durationSec,
    variantCount: asset.variants.length,
    best: asset.variants[0]?.label ?? '',
    warnings: asset.warnings,
  };
}

/**
 * 微博：移动版页面结构简单、反爬较弱，优先抓取 微博正文 页里的视频标签。
 */

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';
import { extractHtmlMeta } from '../html.js';
import { readAssignedObject } from './util.js';

export const id = 'weibo';
export const platforms = ['weibo'];

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export async function extract(ctx) {
  const { url, http, logger, signal } = ctx;
  const platform = getPlatform('weibo');
  const headers = { 'user-agent': MOBILE_UA, referer: 'https://m.weibo.cn/' };

  const res = await http.request(url, { headers, signal });
  const finalUrl = http.effectiveUrl ? http.effectiveUrl(res, url) : (res.url || url);
  const html = await res.text();
  const meta = extractHtmlMeta(html, finalUrl);
  const warnings = [];
  const variants = [];

  const state = readAssignedObject(html, ['$render_data', 'window.$render_data', '__INITIAL_STATE__']);
  const component = state?.stage?.components?.find?.((c) => c?.action_type === 'video') ?? null;
  const mediaUrl = component?.action_data?.media_info?.stream_url_hd
    ?? component?.action_data?.media_info?.stream_url
    ?? component?.action_data?.media_info?.mp4_720p_mp4
    ?? '';

  if (mediaUrl) {
    variants.push({ url: mediaUrl, label: '高清', quality: 1080, format: 'mp4' });
    const sd = component?.action_data?.media_info?.mp4_sd_url;
    if (sd) variants.push({ url: sd, label: '标清', quality: 480, format: 'mp4' });
  } else if (meta.videoUrls.length > 0) {
    meta.videoUrls.forEach((u) => variants.push({ url: u, label: '默认清晰度', quality: 720 }));
  } else {
    warnings.push('微博正文页未找到视频，可能需要在 App 内打开或该内容不是视频');
    logger.debug('微博未命中视频组件');
  }

  return createAsset({
    platform,
    webpageUrl: finalUrl,
    title: meta.title || '微博视频',
    author: meta.author,
    description: meta.description,
    cover: meta.cover,
    variants,
    warnings,
    extra: {},
  });
}

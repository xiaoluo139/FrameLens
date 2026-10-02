/**
 * 小红书：笔记页为 SPA，从 __INITIAL_STATE__ 中取出图片组与视频流。
 */

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';
import { readAssignedObject, unescapeUrl } from './util.js';

export const id = 'xiaohongshu';
export const platforms = ['xiaohongshu'];

export async function extract(ctx) {
  const { url, http, logger, signal } = ctx;
  const platform = getPlatform('xiaohongshu');
  const headers = { referer: 'https://www.xiaohongshu.com/' };

  const noteId = parseNoteId(url);
  if (!noteId) throw new Error('无法识别小红书笔记 ID');

  let html = '';
  try {
    html = await http.getText(url, { headers, signal });
  } catch (error) {
    logger.warn('小红书页面抓取失败', error);
  }

  const state = readAssignedObject(html, ['window.__INITIAL_STATE__', '__INITIAL_STATE__']);
  const note = findNote(state, noteId);
  if (!note) {
    return createAsset({
      platform,
      webpageUrl: url,
      title: `小红书笔记 ${noteId}`,
      variants: [],
      warnings: ['未能读取笔记详情（小红书有较强的反爬限制），可尝试在 App 内直接分享文件'],
    });
  }

  const images = (note.imageList ?? [])
    .map((img) => img?.urlDefault ?? img?.urlPre ?? img?.url ?? '')
    .filter(Boolean)
    .map(unescapeUrl);

  const variants = [];
  const streams = note.video?.media?.stream ?? {};
  for (const [codec, list] of Object.entries(streams)) {
    for (const item of list ?? []) {
      const target = item?.masterUrl ?? item?.backupUrls?.[0];
      if (!target) continue;
      const height = Number(item.height) || 0;
      variants.push({
        url: unescapeUrl(target),
        label: height ? `${height}P ${codec.toUpperCase()}` : `${codec.toUpperCase()} 流`,
        quality: height,
        bandwidth: Number(item.videoBitrate ?? 0),
        format: 'mp4',
      });
    }
  }

  return createAsset({
    platform,
    webpageUrl: url,
    mediaType: variants.length > 0 ? 'video' : 'image',
    title: note.title || note.desc?.slice(0, 60) || `小红书笔记 ${noteId}`,
    author: note.user?.nickname ?? note.user?.nickName ?? '',
    description: note.desc ?? '',
    cover: unescapeUrl(note.imageList?.[0]?.urlDefault ?? ''),
    images,
    variants,
    warnings: variants.length === 0 && images.length > 0 ? ['该笔记为图文笔记，已提取全部原图'] : [],
    extra: { noteId },
  });
}

export function parseNoteId(url) {
  return String(url).match(/\/(?:explore|discovery\/item)\/([0-9a-fA-F]{16,32})/)?.[1] ?? '';
}

function findNote(state, noteId) {
  if (!state) return null;
  const map = state.note?.noteDetailMap ?? state.noteDetailMap ?? {};
  if (map[noteId]?.note) return map[noteId].note;
  for (const value of Object.values(map)) {
    if (value?.note) return value.note;
  }
  return null;
}

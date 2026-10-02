/**
 * YouTube / TikTok 之类的「自适应流」站点。
 * YouTube 直接地址通常带 signatureCipher（需要解密），这里：
 *   - 能拿到明文 url 的格式直接列出
 *   - 拿不到的给出明确提示，并保留 oEmbed 元信息（标题/作者/封面）
 */

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';
import { readAssignedObject, unescapeUrl } from './util.js';

export const id = 'youtube';
export const platforms = ['youtube'];

/** googlevideo 的 itag -> 清晰度标签（只覆盖常见的视频/音频轨） */
const ITAG_LABEL = {
  18: { label: '360P 合并流', quality: 360 },
  22: { label: '720P 合并流', quality: 720 },
  137: { label: '1080P 视频轨', quality: 1080, videoOnly: true },
  136: { label: '720P 视频轨', quality: 720, videoOnly: true },
  135: { label: '480P 视频轨', quality: 480, videoOnly: true },
  134: { label: '360P 视频轨', quality: 360, videoOnly: true },
  133: { label: '240P 视频轨', quality: 240, videoOnly: true },
  160: { label: '144P 视频轨', quality: 144, videoOnly: true },
  299: { label: '1080P60 视频轨', quality: 1080, videoOnly: true },
  298: { label: '720P60 视频轨', quality: 720, videoOnly: true },
  140: { label: '128K 音频', quality: 0, audioOnly: true },
  139: { label: '48K 音频', quality: 0, audioOnly: true },
  251: { label: '160K 音频', quality: 0, audioOnly: true },
};

export async function extract(ctx) {
  const { url, http, logger, signal } = ctx;
  const platform = getPlatform('youtube');
  const headers = { referer: 'https://www.youtube.com/' };

  const videoId = parseVideoId(url);
  if (!videoId) throw new Error('无法识别 YouTube 视频 ID');

  const warnings = [];
  const variants = [];
  let player = null;
  let meta = { title: '', author: '', cover: '', durationSec: 0, description: '' };

  try {
    const html = await http.getText(`https://www.youtube.com/watch?v=${videoId}&hl=zh-CN`, { headers, signal });
    player = readAssignedObject(html, ['ytInitialPlayerResponse'])
      ?? extractJsonAfter(html, '"ytInitialPlayerResponse":');

    if (player?.videoDetails) {
      meta = {
        title: player.videoDetails.title ?? '',
        author: player.videoDetails.author ?? '',
        cover: player.videoDetails.thumbnail?.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        durationSec: Number(player.videoDetails.lengthSeconds ?? 0),
        description: (player.videoDetails.shortDescription ?? '').slice(0, 500),
      };
    }

    const all = [
      ...(player?.streamingData?.formats ?? []),
      ...(player?.streamingData?.adaptiveFormats ?? []),
    ];
    let unsigned = 0;
    for (const format of all) {
      if (!format.url) continue;
      // 只有 googlevideo 的 videoplayback 才是真正可直接下载的地址；
      // initplayback / n 参数形式的地址需要二次解密，列出来只会让用户下到 403
      if (!/^https:\/\/[\w.-]*googlevideo\.com\/videoplayback/i.test(format.url)) {
        unsigned++;
        continue;
      }
      variants.push({
        url: unescapeUrl(format.url),
        label: formatLabel(format),
        quality: Number(format.height) || Number(String(format.qualityLabel ?? '').replace(/\D/g, '')) || 0,
        bandwidth: Number(format.bitrate ?? 0),
        format: String(format.mimeType ?? '').includes('webm') ? 'webm' : 'mp4',
        note: String(format.mimeType ?? '').includes('audio') ? '仅音频' : String(format.mimeType ?? '').includes('video') && !format.audioQuality ? '仅视频轨' : '',
      });
    }
    if (variants.length === 0 && unsigned > 0) {
      warnings.push('YouTube 页面里的直链带签名保护，正在尝试用本机浏览器渲染获取可用地址…');
    }
  } catch (error) {
    logger.warn('YouTube 页面解析失败', error);
    warnings.push('YouTube 页面解析失败（可能被风控）');
  }

  /**
   * 兜底：用本机浏览器渲染播放页，捕获播放器自己发出的 googlevideo 请求。
   * 这些地址带着浏览器签名过的参数，是可直接下载的。
   */
  if (variants.length === 0 && ctx.renderMedia) {
    try {
      const rendered = await ctx.renderMedia(`https://www.youtube.com/watch?v=${videoId}`, { timeoutMs: 35000, settleMs: 3000 });
      const captured = (rendered.mediaUrls ?? []).filter((u) => /googlevideo\.com\/videoplayback/i.test(u));
      const seen = new Set();
      for (const url of captured) {
        const itag = Number(new URL(url).searchParams.get('itag') ?? 0);
        if (!itag || seen.has(itag)) continue;
        seen.add(itag);
        const info = ITAG_LABEL[itag];
        if (!info) continue;
        variants.push({
          url,
          label: info.label,
          quality: info.quality,
          format: info.audioOnly ? 'm4a' : 'mp4',
          note: info.audioOnly ? '仅音频' : info.videoOnly ? '仅视频轨' : '',
        });
      }
      warnings.length = 0;
      warnings.push(
        variants.length > 0
          ? '直链由本机浏览器渲染捕获，带时效性，请尽快下载。'
          : 'YouTube 直链需要签名解密，本机浏览器也没能捕获到地址，建议改用 yt-dlp。标题、封面、时长已正常获取。',
      );
    } catch (error) {
      logger.warn('YouTube 浏览器渲染失败', error);
      warnings.push('YouTube 直链需要签名解密，建议改用 yt-dlp。标题、封面、时长已正常获取。');
    }
  }

  if (!meta.title) {
    try {
      const oembed = await http.getJson(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { headers, signal },
      );
      meta.title = oembed.title ?? meta.title;
      meta.author = oembed.author_name ?? meta.author;
      meta.cover = oembed.thumbnail_url ?? meta.cover;
    } catch {
      /* oEmbed 只是兜底 */
    }
  }

  return createAsset({
    platform,
    webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: meta.title || `YouTube ${videoId}`,
    author: meta.author,
    description: meta.description,
    cover: meta.cover,
    durationSec: meta.durationSec,
    variants,
    warnings,
    extra: { videoId },
  });
}

function formatLabel(format) {
  const kind = String(format.mimeType ?? '');
  if (kind.includes('audio')) return `${Math.round(Number(format.bitrate ?? 0) / 1000)}K 音频`;
  const label = format.qualityLabel ?? `${format.height ?? ''}P`;
  const fps = Number(format.fps) > 30 ? `${format.fps}fps` : '';
  return [label, fps, kind.includes('webm') ? 'WebM' : ''].filter(Boolean).join(' ');
}

export function parseVideoId(url) {
  const text = String(url);
  return (
    text.match(/[?&]v=([\w-]{8,15})/)?.[1] ??
    text.match(/youtu\.be\/([\w-]{8,15})/)?.[1] ??
    text.match(/\/(?:shorts|embed|live)\/([\w-]{8,15})/)?.[1] ??
    ''
  );
}

function extractJsonAfter(html, marker) {
  const index = html.indexOf(marker);
  if (index < 0) return null;
  const start = html.indexOf('{', index);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

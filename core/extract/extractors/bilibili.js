/**
 * 哔哩哔哩：走官方公开接口，稳定拿到标题/封面/时长/多清晰度直链。
 * 说明：DASH 模式下视频与音频分离，这里给出视频轨（含音频的 durl 也会一并列出）。
 */

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';

export const id = 'bilibili';
export const platforms = ['bilibili'];

const QN_LABEL = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P60 高帧率',
  112: '1080P+ 高码率',
  80: '1080P 高清',
  74: '720P60 高帧率',
  64: '720P 高清',
  32: '480P 清晰',
  16: '360P 流畅',
  6: '240P 极速',
};

export async function extract(ctx) {
  const { url, http, logger, signal } = ctx;
  const platform = getPlatform('bilibili');
  const headers = { referer: 'https://www.bilibili.com/' };

  const ids = parseIds(url);
  if (!ids.bvid && !ids.aid) throw new Error('无法从链接中识别视频 ID');

  const query = ids.bvid ? `bvid=${ids.bvid}` : `aid=${ids.aid}`;
  const view = await http.getJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers, signal });
  if (view?.code !== 0 || !view.data) throw new Error(`B 站接口返回异常：${view?.message ?? 'unknown'}`);

  const data = view.data;
  const page = data.pages?.[ids.page - 1] ?? data.pages?.[0] ?? {};
  const cid = page.cid ?? data.cid;

  const warnings = [];
  const variants = [];
  const audioTracks = [];

  try {
    const play = await http.getJson(
      `https://api.bilibili.com/x/player/playurl?${query}&cid=${cid}&qn=127&fnval=4048&fourk=1`,
      { headers, signal },
    );
    const dash = play?.data?.dash;
    const seen = new Set();
    // 同一清晰度会有多个编码（AV1/HEVC/AVC），优先保留兼容性最好的 AVC(codecid 7)
    const tracks = [...(dash?.video ?? [])].sort((a, b) => codecRank(a.codecid) - codecRank(b.codecid));
    for (const track of tracks) {
      if (!track?.baseUrl || seen.has(track.id)) continue;
      seen.add(track.id);
      variants.push({
        url: track.baseUrl,
        label: QN_LABEL[track.id] ?? `${track.height}P`,
        quality: track.height || track.id,
        bandwidth: track.bandwidth ?? 0,
        format: 'm4s',
        note: 'DASH 视频轨（含音轨单独下载）',
      });
    }
    for (const track of [...(dash?.audio ?? []), ...(dash?.flac?.audio ? [dash.flac.audio] : [])]) {
      if (!track?.baseUrl) continue;
      audioTracks.push({
        url: track.baseUrl,
        quality: track.bandwidth ?? 0,
        label: track.id === 30280 ? '192K 音频' : track.id === 30232 ? '132K 音频' : '音频轨',
        format: 'm4s',
      });
    }
    if (dash?.video?.length) {
      warnings.push('B 站为 DASH 流，视频与音频分离；如需带声音的成品文件，建议同时勾选音频轨。');
    }
    // 平台对未登录用户限流时要把原因讲清楚，否则用户只会觉得「怎么只有 480P」
    const accepted = play?.data?.accept_quality ?? [];
    const bestAccepted = Math.max(0, ...accepted.map((q) => QN_HEIGHT[q] ?? 0));
    const bestGot = Math.max(0, ...variants.map((v) => v.quality ?? 0));
    if (bestAccepted >= 720 && bestGot > 0 && bestAccepted > bestGot) {
      warnings.push(`B 站对未登录用户只下发到 ${bestGot}P，该视频实际提供到 ${bestAccepted}P；在设置里填入登录 Cookie 后可获取更高清晰度。`);
    }
    if (play?.data?.durl?.length) {
      play.data.durl.forEach((seg, index) => {
        variants.push({
          url: seg.url || seg.backup_url?.[0],
          label: play.data.durl.length > 1 ? `合并流 片段 ${index + 1}` : '合并流（含音频）',
          quality: play.data.quality ?? 80,
          sizeBytes: seg.size ?? 0,
          format: 'mp4',
        });
      });
    }
  } catch (error) {
    logger.warn('B 站播放地址获取失败', error);
    warnings.push('未能获取播放直链（可能需要登录或该视频受限）');
  }

  return createAsset({
    platform,
    webpageUrl: `https://www.bilibili.com/video/${ids.bvid ?? `av${ids.aid}`}${ids.page > 1 ? `?p=${ids.page}` : ''}`,
    title: ids.page > 1 && page.part ? `${data.title} - P${ids.page} ${page.part}` : data.title,
    author: data.owner?.name ?? '',
    description: (data.desc ?? '').slice(0, 500),
    cover: data.pic ?? '',
    durationSec: page.duration ?? data.duration ?? 0,
    variants,
    warnings,
    extra: {
      bvid: ids.bvid,
      aid: ids.aid,
      cid,
      view: data.stat?.view ?? 0,
      danmaku: data.stat?.danmaku ?? 0,
      audioTracks,
      pageCount: data.pages?.length ?? 1,
    },
  });
}

/** qn 代码 -> 高度，用于判断「平台其实有更高清晰度但没给我」 */
const QN_HEIGHT = { 6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320 };

/** 编码优先级：AVC 兼容性最好 */
function codecRank(codecid) {
  if (codecid === 7) return 0;
  if (codecid === 12) return 1;
  if (codecid === 13) return 2;
  return 3;
}

export function parseIds(url) {
  const text = String(url);
  const bvid = text.match(/BV[0-9A-Za-z]{8,12}/)?.[0] ?? '';
  const aid = Number(text.match(/\/av(\d+)/i)?.[1] ?? 0);
  const page = Number(text.match(/[?&]p=(\d+)/)?.[1] ?? 1) || 1;
  return { bvid, aid, page };
}

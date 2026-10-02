// 抖音解析器：两级策略
//
//   1) 服务端分享页 —— 快（几百毫秒），但现在通常只拿得到标题/封面
//   2) 浏览器渲染 —— 用主进程里的隐藏窗口打开作品页，
//      监听页面自己发出的媒体请求，拿到带完整签名的直链
//
// 抖音已经不把视频数据放在服务端 HTML 里，老的公开接口也全部返回空 body，
// 所以第 2 条路才是真正能用的那条；第 1 条用来快速补标题、封面、作者。

import { createAsset } from '../model.js';
import { getPlatform } from '../platforms.js';
import { readAssignedObject, safeGet, firstArrayValue, unescapeUrl } from './util.js';

export const id = 'douyin';
export const platforms = ['douyin'];

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export async function extract(ctx) {
  const { url, logger, signal } = ctx;
  const platform = getPlatform('douyin');

  /**
   * 提速策略：短链直接丢给浏览器渲染。
   * 之前是「先用一个窗口展开短链 -> 再开一个窗口渲染作品页」，
   * 等于跑两遍完整页面加载；现在只跑一遍，浏览器自己会完成跳转。
   */
  const looksLikeShort = /v\.douyin\.com|iesdouyin\.com\/share|m\.douyin\.com/i.test(url);
  let awemeId = parseAwemeId(url);
  let meta = null;

  /**
   * 短链只做一次普通请求就能拿到作品 ID（请求会跟随跳转，页面里也带 itemId），
   * 大约 0.5 秒。之前两种做法都试过：
   *   - 用浏览器展开短链：要一次完整页面加载，慢
   *   - 直接渲染短链页面：短链自带一段跳转链，反而最慢（实测 29.6s）
   * 所以这里先快速拿 ID，再只渲染规范的作品页。
   */
  if (looksLikeShort && !awemeId) {
    const resolved = await resolveShortLinkFast(ctx, url);
    awemeId = resolved.awemeId;
    if (resolved.title) meta = { title: normalizeTitle(resolved.title) };
  }

  // 常规流程：展开短链 -> 分享页元信息 -> 渲染作品页
  let finalUrl = url;
  if (!awemeId) {
    finalUrl = await followShareLink(ctx, url);
    awemeId = parseAwemeId(finalUrl) || parseAwemeId(url);
  }
  if (!awemeId) throw new Error('无法从链接中识别抖音作品 ID');

  meta = await trySharePage(ctx, awemeId);
  if (meta?.variants?.length > 0) return buildAsset(platform, awemeId, meta, meta.variants);

  if (ctx.renderMedia) {
    /**
     * 两个入口都试一遍，因为抖音两边偶尔会有其中一个不吐播放地址：
     *   1) 作品页 —— 最稳定（热窗口约 3 秒）
     *   2) 移动分享页 —— 更轻，作为兜底
     */
    const targets = [
      `https://www.douyin.com/video/${awemeId}`,
      `https://www.iesdouyin.com/share/video/${awemeId}/`,
    ];
    for (const target of targets) {
      try {
        const rendered = await ctx.renderMedia(target, { timeoutMs: 15000, settleMs: 700 });
        const asset = buildFromRender(platform, awemeId, rendered, meta);
        if (asset) return asset;
        logger.warn(`渲染 ${target.slice(0, 48)} 未捕获到内容，换入口重试`);
      } catch (error) {
        logger.warn(`渲染 ${target.slice(0, 48)} 失败`, error);
      }
    }
  } else if (signal?.aborted) {
    throw new Error('已取消');
  }

  if (meta) {
    return buildAsset(platform, awemeId, meta, [], [
      '抖音现在要求登录态才能取到播放地址，服务端与浏览器渲染都没能拿到直链。',
      '可尝试：在软件的「模型中心 → 设置」里用浏览器登录一次抖音后再试。',
    ]);
  }
  throw new Error('未能获取抖音视频地址');
}

/** 一次普通请求拿到作品 ID 与标题（比浏览器渲染快一个数量级） */
async function resolveShortLinkFast(ctx, url) {
  try {
    const res = await ctx.http.request(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': MOBILE_UA },
      signal: ctx.signal,
    });
    const html = await res.text();
    const finalUrl = ctx.http.effectiveUrl ? ctx.http.effectiveUrl(res, url) : (res.url || url);
    const awemeId =
      parseAwemeId(finalUrl) ||
      html.match(/"itemId"\s*:\s*"(\d{6,25})"/)?.[1] ||
      html.match(/"aweme_id"\s*:\s*"(\d{6,25})"/)?.[1] ||
      html.match(/\/video\/(\d{6,25})/)?.[1] ||
      '';
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
    ctx.logger.debug(`短链快速解析 -> id=${awemeId}`);
    return { awemeId, title };
  } catch (error) {
    ctx.logger.warn('短链快速解析失败', error);
    return { awemeId: '', title: '' };
  }
}

/**
 * 把一次浏览器渲染的结果整理成「图片 + 视频」双解析结果。
 * 视频作品也会有封面图，所以两类内容都能单独下载。
 */
function buildFromRender(platform, awemeId, rendered, meta = null) {
  const variants = buildVariantsFromUrls(rendered.mediaUrls);
  const captured = rendered.images ?? [];
  /**
   * 视频作品只把封面当图片给出（页面上抓到的其它图多是相关推荐，属于噪音）；
   * 图文作品才把抓到的图全部列出。
   */
  const cover = rendered.cover || meta?.cover || captured[0] || '';
  const images = variants.length > 0 ? (cover ? [cover] : []) : captured;
  if (variants.length === 0 && images.length === 0) return null;

  const warnings = [];
  if (variants.length > 0) {
    warnings.push('直链由本机浏览器渲染捕获，通常几小时内有效，请尽快下载。');
    if (images.length > 0) warnings.push('封面已作为图片列出，可单独下载。');
  }
  if (variants.length === 0 && images.length > 0) warnings.push('这是图文作品，已提取全部图片，可逐张保存或全部保存。');

  return createAsset({
    platform,
    webpageUrl: `https://www.douyin.com/video/${awemeId}`,
    mediaType: variants.length > 0 ? 'video' : 'image',
    title: rendered.pageTitle || meta?.title || `抖音作品 ${awemeId}`,
    author: meta?.author ?? '',
    description: meta?.description ?? '',
    cover,
    durationSec: Math.round(rendered.duration || meta?.durationSec || 0),
    variants,
    images,
    warnings,
    extra: { awemeId, viaBrowser: true },
  });
}

function buildAsset(platform, awemeId, meta, variants, warnings = []) {
  /**
   * 视频作品也把封面当成一张图片给出，这样「图片 + 视频」两类内容都能单独下载；
   * 图文作品则保留全部配图。
   */
  const images = meta.images?.length ? meta.images : meta.cover ? [meta.cover] : [];
  return createAsset({
    platform,
    webpageUrl: `https://www.douyin.com/video/${awemeId}`,
    mediaType: meta.images?.length > 0 && variants.length === 0 ? 'image' : 'video',
    title: meta.title || `抖音作品 ${awemeId}`,
    author: meta.author ?? '',
    description: meta.description ?? '',
    cover: meta.cover ?? '',
    durationSec: meta.durationSec ?? 0,
    variants,
    images,
    warnings: [...(meta.warnings ?? []), ...warnings],
    extra: { awemeId, viaBrowser: Boolean(meta.viaBrowser) },
  });
}

/** 社交短链 -> 真实作品地址 */
export async function followShareLink(ctx, url) {
  // 手机端优先用隐藏 WebView 展开：Capacitor 的 HTTP 拦截器会把 response.url
  // 改写成 localhost 拦截器地址，拿不到重定向后的真实链接
  if (ctx.resolveUrl) {
    try {
      const resolved = await ctx.resolveUrl(url);
      if (resolved && /douyin\.com|iesdouyin\.com/.test(resolved)) return resolved;
    } catch (error) {
      ctx.logger.warn('短链解析器失败，退回直接请求', error);
    }
  }
  try {
    const res = await ctx.http.request(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': MOBILE_UA },
      signal: ctx.signal,
    });
    return ctx.http.effectiveUrl ? ctx.http.effectiveUrl(res, url) : (res.url || url);
  } catch (error) {
    ctx.logger.warn('短链跳转失败，按原链接继续', error);
    return url;
  }
}

/** 服务端分享页：拿标题/封面/作者，运气好还能拿到地址 */
async function trySharePage(ctx, awemeId) {
  const headers = { 'user-agent': MOBILE_UA, referer: 'https://www.douyin.com/' };
  let html = '';
  try {
    html = await ctx.http.getText(`https://www.iesdouyin.com/share/video/${awemeId}/`, { headers, signal: ctx.signal });
  } catch (error) {
    ctx.logger.warn('抖音分享页抓取失败', error);
    return null;
  }

  const router = readAssignedObject(html, ['window._ROUTER_DATA', '_ROUTER_DATA']);
  const item = pickItem(router);

  if (!item) {
    // 页面已不含视频数据，但 <title> 仍然可用
    const title = normalizeTitle(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '');
    return title ? { title, variants: [], images: [], warnings: [], cover: '', author: '', description: '', durationSec: 0 } : null;
  }

  const video = item.video ?? {};
  const variants = [];
  for (const rate of video.bit_rate ?? video.bitrate ?? []) {
    const candidate = firstArrayValue(rate?.play_addr?.url_list);
    if (!candidate) continue;
    variants.push({
      url: unescapeUrl(candidate).replace('playwm', 'play'),
      label: rate?.gear_name ? String(rate.gear_name).toUpperCase() : `${rate?.play_addr?.height ?? 0}P`,
      quality: rate?.play_addr?.height ?? 0,
      bandwidth: rate?.bit_rate ?? 0,
      format: 'mp4',
    });
  }
  const main = firstArrayValue(video.play_addr?.url_list) || firstArrayValue(video.download_addr?.url_list);
  if (main) {
    variants.push({
      url: unescapeUrl(main).replace('playwm', 'play'),
      label: '默认清晰度（无水印）',
      quality: video.play_addr?.height ?? 0,
      format: 'mp4',
    });
  }

  const images = [];
  for (const image of item.images ?? []) {
    const url0 = firstArrayValue(image?.url_list);
    if (url0) images.push(unescapeUrl(url0));
  }

  return {
    title: (item.desc ?? '').trim() || `抖音作品 ${awemeId}`,
    author: item.author?.nickname ?? '',
    description: item.desc ?? '',
    cover: unescapeUrl(video.cover?.url_list?.[0] ?? video.origin_cover?.url_list?.[0] ?? ''),
    durationSec: Math.round((video.duration ?? item.duration ?? 0) / (video.duration > 1000 ? 1000 : 1)),
    variants,
    images,
    warnings: [],
    extra: { awemeId, diggCount: safeGet(item, 'statistics.digg_count', 0) },
  };
}

/** 页面标题常带「- 抖音」后缀，去掉更干净 */
function normalizeTitle(title) {
  return String(title)
    .replace(/\s*[-_|]\s*抖音(极速版|火山版)?\s*$/i, '')
    .trim()
    .slice(0, 140);
}

/**
 * 整理浏览器捕获到的地址。
 * 抖音 CDN 地址本身不带清晰度标记，同一视频会有多个 CDN 节点，
 * 因此按路径去重，并优先选真正指向媒体文件的地址。
 */
export function buildVariantsFromUrls(urls) {
  const seen = new Set();
  const variants = [];
  const sorted = [...(urls ?? [])].sort((a, b) => scoreUrl(b) - scoreUrl(a));

  for (const url of sorted) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (seen.has(parsed.pathname)) continue;
    seen.add(parsed.pathname);

    const isCdn = /douyinvod\.com/i.test(parsed.hostname);
    const quality = guessQuality(url);
    variants.push({
      url,
      label: quality ? `${quality}P` : isCdn ? '原画直链' : '播放地址',
      quality,
      format: 'mp4',
      note: isCdn ? '' : '播放重定向地址',
    });
    if (variants.length >= 6) break;
  }
  return variants;
}

function scoreUrl(url) {
  let score = 0;
  if (/douyinvod\.com/i.test(url)) score += 10;
  if (/ratio=1080|1080p/i.test(url)) score += 5;
  if (/ratio=720|720p/i.test(url)) score += 3;
  if (/watermark=0/i.test(url)) score += 3;
  if (/\/aweme\/v1\/play\//i.test(url)) score += 1;
  return score;
}

function guessQuality(url) {
  const match = String(url).match(/(\d{3,4})[pP](?:&|$|\/)/);
  return match ? Number(match[1]) : 0;
}

export function parseAwemeId(url) {
  const text = String(url);
  const patterns = [/\/video\/(\d{6,25})/, /modal_id=(\d{6,25})/, /\/share\/video\/(\d{6,25})/, /aweme_id=(\d{6,25})/];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1];
  }
  return '';
}

/** 抖音把数据放在 loaderData['video_(id)/page'] 下，路径随版本会变，这里做兼容遍历 */
function pickItem(router) {
  if (!router) return null;
  const loader = router.loaderData ?? router;
  return searchItem(loader, 0);
}

function searchItem(node, depth) {
  if (!node || depth > 6) return null;
  if (typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = searchItem(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (Array.isArray(node.item_list) && node.item_list.length > 0) return node.item_list[0];
  if (node.video?.play_addr) return node;
  for (const value of Object.values(node)) {
    const hit = searchItem(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

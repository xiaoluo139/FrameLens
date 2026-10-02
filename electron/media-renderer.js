// 用隐藏窗口渲染页面并捕获媒体地址。
//
// 为什么需要它：抖音这类站点已经不再把视频数据放在服务端返回的 HTML 里，
// 老的公开接口也全部返回空 body。但它们在真实浏览器里会由自己的 JS 去请求播放地址，
// 而我们的软件本身就是 Chromium——用一个不可见的窗口渲染页面，
// 监听它自己发出的媒体请求，就能拿到带完整签名的可用直链。
//
// 这是「用自己的浏览器引擎解决自己的问题」，不依赖任何外部解析服务。

import { BrowserWindow, session } from 'electron';
import { createLogger } from '../core/logger.js';

const log = createLogger('render');

// 独立分区：抖音会下发风控 Cookie，持久化后成功率明显更高
const PARTITION = 'persist:framelens-web';

/**
 * 复用一个常驻的隐藏窗口。
 * 每次新建窗口要 1 秒上下，而且丢掉已缓存的静态资源与 Cookie；
 * 连续解析多个链接时差别非常明显。
 */
let sharedWindow = null;
let sharedReady = false;
/** 站点预热中的 Promise：解析前先等它，否则会把预热中的加载打断、白白付两次首次加载成本 */
let warmingPromise = null;

const MEDIA_HINTS = [
  /douyinvod\.com/i,
  /\/aweme\/v1\/play\//i,
  /googlevideo\.com\/videoplayback/i,
  /\.mp4(\?|$)/i,
  /\.m3u8(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.m4s(\?|$)/i,
  /bilivideo\.com/i,
  /tiktokcdn/i,
  /xhscdn/i,
];

/**
 * 图文帖的内容图：这些 CDN 上的图片才是作品配图，头像/图标也常在同一批域名下，
 * 所以再用关键词排除掉明显的头像、表情、二维码。
 */
const CONTENT_IMAGE = /(douyinpic\.com|p\d+-sign|xhscdn\.com\/spectrum|sns-img|sinaimg\.cn\/large|tiktokcdn.*image)/i;
const IMAGE_NOISE = /(avatar|headimg|emoji|icon|logo|qrcode|二维码|favicon|profile)/i;

function isMediaUrl(url) {
  if (!/^https?:/i.test(url)) return false;
  if (/\.(jpg|jpeg|png|webp|gif|svg|ico|css|js|woff2?)(\?|$)/i.test(url)) return false;
  return MEDIA_HINTS.some((re) => re.test(url));
}

function isContentImage(url) {
  if (!/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(url)) return false;
  if (IMAGE_NOISE.test(url)) return false;
  return CONTENT_IMAGE.test(url);
}

/**
 * 渲染一个页面并把其中的媒体地址收集出来。
 * @param {string} url
 * @param {{timeoutMs?:number, settleMs?:number, waitForMedia?:boolean}} options
 * @returns {Promise<{pageUrl:string, pageTitle:string, mediaUrls:string[], videoSrcs:string[], duration:number}>}
 */
export async function renderPageForMedia(url, { timeoutMs = 25000, settleMs = 900 } = {}) {
  const ses = session.fromPartition(PARTITION);
  const found = new Map();
  const images = new Map();

  // 预热还没结束时先等一会儿（最多 6 秒），避免把预热中的页面加载掐掉
  if (warmingPromise) {
    await Promise.race([warmingPromise, new Promise((r) => setTimeout(r, 6000))]).catch(() => {});
    warmingPromise = null;
  }

  const listener = (details, callback) => {
    // 字体与统计/埋点请求对解析没有任何帮助，直接拦掉能省下可观的加载时间
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(details.url) || /(analytics|beacon|sentry|logreport|monitor)/i.test(details.url)) {
      callback({ cancel: true });
      return;
    }
    if (isMediaUrl(details.url) && !found.has(details.url)) {
      found.set(details.url, details.url);
      log.debug(`捕获媒体地址 ${details.url.slice(0, 120)}`);
    } else if (isContentImage(details.url) && !images.has(details.url.split('?')[0])) {
      images.set(details.url.split('?')[0], details.url);
    }
    callback({});
  };
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, listener);

  const win = await getSharedWindow();

  let result = { pageUrl: url, pageTitle: '', cover: '', mediaUrls: [], videoSrcs: [], duration: 0, images: [] };
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();

  try {
    win.loadURL(url).catch((error) => log.debug(`loadURL 警告：${error.message}`));

    let firstMediaAt = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const snapshot = await win.webContents
        .executeJavaScript(
          `(() => {
            const v = document.querySelector('video');
            const srcs = [...document.querySelectorAll('video, source')]
              .map((n) => n.src || n.currentSrc || '')
              .filter((s) => s && !s.startsWith('blob:'));
            return {
              title: document.querySelector('h1')?.textContent?.trim() || document.title || '',
              srcs,
              duration: Number.isFinite(v?.duration) ? v.duration : 0,
              poster: v?.poster || '',
              ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
              href: location.href,
            };
          })()`,
        )
        .catch(() => null);

      if (snapshot) {
        result = {
          pageUrl: snapshot.href || url,
          pageTitle: snapshot.title || result.pageTitle,
          cover: snapshot.poster || snapshot.ogImage || result.cover,
          mediaUrls: [...found.keys()],
          videoSrcs: snapshot.srcs ?? [],
          duration: snapshot.duration || 0,
          images: [...images.values()],
        };
        for (const src of snapshot.srcs ?? []) if (!found.has(src)) found.set(src, src);
      }

      // 有些站点（YouTube 等）要等播放真正开始才会请求视频流，
      // 因此过几秒还没收获时主动触发一次播放
      const waited = Date.now() - startedAt;
      if (found.size === 0 && waited > 3000 && waited < timeoutMs - 4000) {
        await win.webContents
          .executeJavaScript(
            `(() => {
              const v = document.querySelector('video');
              if (v) { v.muted = true; v.play?.().catch(() => {}); }
              const play = document.querySelector('.ytp-large-play-button, .vjs-big-play-button');
              if (play) play.click();
              return true;
            })()`,
          )
          .catch(() => null);
      }

      const hasMedia = found.size > 0;
      if (hasMedia && !firstMediaAt) firstMediaAt = Date.now();
      // 拿到第一个地址后再多等一会儿，收集其它清晰度
      if (firstMediaAt && Date.now() - firstMediaAt > settleMs) break;
      if (found.size >= 6) break;
    }
  } finally {
    ses.webRequest.onBeforeRequest(null);
  }

  result.mediaUrls = [...new Set([...result.mediaUrls, ...result.videoSrcs])];
  // 封面也算一张图，放在最前面：视频作品也能「图片 + 视频」一起给出
  const cover = result.cover ? [result.cover] : [];
  result.images = [...new Set([...cover, ...images.values()])].slice(0, 24);
  log.info(`渲染完成 ${url.slice(0, 80)} -> ${result.mediaUrls.length} 个媒体地址，${result.images.length} 张图片，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return result;
}

/** 常驻隐藏窗口：只创建一次，之后复用 */
async function getSharedWindow() {
  if (sharedWindow && !sharedWindow.isDestroyed()) {
    if (!sharedReady) await new Promise((r) => setTimeout(r, 200));
    return sharedWindow;
  }
  sharedWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: PARTITION,
      offscreen: true,
      javascript: true,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  sharedWindow.webContents.setAudioMuted(true);
  /**
   * 隐藏窗口绝不允许弹窗或跳走。
   * 抖音、小红书这类页面会尝试唤起自家 App（snssdk://、intent://）
   * 或 window.open 打开站点——不管住的话用户会看到浏览器突然弹出来。
   */
  sharedWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sharedWindow.webContents.on('will-navigate', (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });
  sharedWindow.on('closed', () => {
    sharedWindow = null;
    sharedReady = false;
  });
  sharedReady = true;
  return sharedWindow;
}

/** 应用退出时清理常驻窗口 */
export function disposeRenderer() {
  if (sharedWindow && !sharedWindow.isDestroyed()) sharedWindow.destroy();
  sharedWindow = null;
  sharedReady = false;
}

/**
 * 启动时把隐藏窗口建好。
 * 新建一个 BrowserWindow 要 1 秒左右，而用户第一次粘贴链接时正是最在意速度的时候。
 */
export function warmUpRenderer() {
  warmingPromise = getSharedWindow()
    .then(async (win) => {
      /**
       * 不只是建窗口，还顺带把站点首页加载一次。
       * 实测首次渲染要 9.6s、暖窗口只要 3.3s，差的就是首次的 DNS/TLS 与 JS 包；
       * 启动时先付掉这部分，用户第一次粘贴链接时就能直接进 4 秒档。
       */
      const target = process.env.FRAMELENS_WARMUP_URL ?? 'https://www.iesdouyin.com/';
      await win.loadURL(target).catch(() => {});
      log.debug(`渲染窗口与站点已预热（${target}）`);
    })
    .catch((error) => log.debug('渲染窗口预热失败', error));
  return warmingPromise;
}

/** 给 UI/日志用：渲染窗口用的分区名 */
export const RENDER_PARTITION = PARTITION;

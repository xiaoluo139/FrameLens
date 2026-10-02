// 试验：用隐藏的 Chromium 窗口渲染抖音页面，看能否拿到可下载的视频地址。
// 抖音的服务端页面已不再包含视频数据（SSR 只有 itemId），
// 但真实浏览器里它的 JS 会自己把播放地址请求出来。

import { app, BrowserWindow, session } from 'electron';

const id = process.argv.find((a) => /^\d{10,}$/.test(a)) ?? '7691643953896022201';
const target = `https://www.douyin.com/video/${id}`;

app.whenReady().then(async () => {
  const media = new Set();

  // 抓住页面自己发出的媒体请求
  const filter = { urls: ['*://*/*'] };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    const url = details.url;
    if (/douyinvod|\.mp4(\?|$)|\.m3u8(\?|$)|byteimg\.com\/.*video/i.test(url)) media.add(url);
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { offscreen: true, javascript: true, sandbox: true, images: false },
  });

  console.log('[probe] 加载:', target);
  win.loadURL(target).catch((e) => console.log('[probe] loadURL 错误:', e.message));

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const state = await win.webContents
      .executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          const srcs = [...document.querySelectorAll('video, source')].map((n) => n.src || n.currentSrc).filter(Boolean);
          const title = document.querySelector('h1')?.textContent?.trim() ?? document.title;
          return { title, srcs, readyState: v?.readyState ?? -1, duration: v?.duration ?? 0, href: location.href };
        })()`,
      )
      .catch((e) => ({ error: e.message }));
    if (i % 5 === 0 || state.srcs?.length) {
      console.log(`[probe ${i}s]`, JSON.stringify({ ...state, srcs: state.srcs?.map((s) => s.slice(0, 90)) }));
    }
    if (media.size > 0 && state.srcs?.length) break;
  }

  console.log('[probe] 网络里抓到的媒体地址:', media.size);
  [...media].slice(0, 8).forEach((u) => console.log('   -', u.slice(0, 140)));

  const cookies = await session.defaultSession.cookies.get({ domain: '.douyin.com' });
  console.log('[probe] 抖音相关 Cookie 数:', cookies.length);
  win.destroy();
  app.exit(0);
});

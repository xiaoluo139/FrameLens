// 测不同页面在隐藏浏览器里的渲染耗时，用来挑最快的入口。
//   electron scripts/probe-render-speed.mjs

import { app } from 'electron';
import { renderPageForMedia, warmUpRenderer } from '../electron/media-renderer.js';

const id = '7691643953896022201';
const targets = [
  ['www 作品页', `https://www.douyin.com/video/${id}`],
  ['m 分享页', `https://m.douyin.com/share/video/${id}`],
  ['iesdouyin 分享页', `https://www.iesdouyin.com/share/video/${id}/`],
];

app.whenReady().then(async () => {
  // 模拟应用启动时的预热
  await warmUpRenderer();
  // 先量「预热后的第一次解析」——这是用户实际会感受到的那个数字
  const firstStart = Date.now();
  const first = await renderPageForMedia(`https://www.iesdouyin.com/share/video/${id}/`, { timeoutMs: 20000, settleMs: 700 });
  console.log(`[预热后第一次解析分享页] ${((Date.now() - firstStart) / 1000).toFixed(1)}s | 直链 ${first.mediaUrls.length} | 图片 ${first.images.length}`);
  for (const [name, url] of targets) {
    const started = Date.now();
    try {
      const result = await renderPageForMedia(url, { timeoutMs: 22000, settleMs: 700 });
      console.log(`[${name}] ${((Date.now() - started) / 1000).toFixed(1)}s | 直链 ${result.mediaUrls.length} | 图片 ${result.images.length} | 封面 ${result.cover ? '有' : '无'} | 标题 ${(result.pageTitle || '').slice(0, 24)}`);
    } catch (error) {
      console.log(`[${name}] 失败 ${error.message}`);
    }
  }
  // 同进程再渲染一次同一页面：用来量化「窗口/缓存复用」到底能省多少
  const again = `https://www.iesdouyin.com/share/video/${id}/`;
  const started2 = Date.now();
  const second = await renderPageForMedia(again, { timeoutMs: 20000, settleMs: 700 });
  console.log(`[同一页面第二次] ${((Date.now() - started2) / 1000).toFixed(1)}s | 直链 ${second.mediaUrls.length}`);
  app.exit(0);
});

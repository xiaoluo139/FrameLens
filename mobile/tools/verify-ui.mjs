// 手机端界面验证：在 Chromium/WebView 同源引擎里跑 mobile/www。
//
// 手机上没有 Node，网页抓取靠 Capacitor 的 CapacitorHttp 把 window.fetch
// 接管为原生请求，从而绕开 WebView 的同源策略。这个脚本用 Electron 复现同样的机制：
// 把页面里的 fetch 换成走主进程的原生请求，然后真的点一次「解析全平台链接」。
//
//   electron tools/verify-ui.mjs [url]

import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const targetUrl = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'https://www.bilibili.com/video/BV1GJ411x7h7';

if (!existsSync(join(WWW, 'app.js'))) {
  console.error('[verify] 先执行 npm run build 生成 www/');
  app.exit(1);
}

// 原生请求桥：等价于 CapacitorHttp 的作用
ipcMain.handle('native-http', async (_event, { url, method = 'GET', headers = {} }) => {
  try {
    const res = await fetch(url, { method, headers, redirect: 'follow' });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
  } catch (error) {
    return { ok: false, status: 0, url, headers: {}, body: `native fetch failed: ${error.message}` };
  }
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420,
    height: 880,
    show: true,
    backgroundColor: '#0b0e14',
    webPreferences: { preload: join(ROOT, 'tools', 'fetch-shim.cjs'), contextIsolation: false, sandbox: false },
  });

  await win.loadURL(pathToFileURL(join(WWW, 'index.html')).toString());
  await new Promise((r) => setTimeout(r, 1200));

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  console.log('[verify] 视口:', await win.webContents.executeJavaScript('`${innerWidth}x${innerHeight}`'));
  console.log('[verify] fetch 是否已接管:', await win.webContents.executeJavaScript('Boolean(window.__nativeFetchInstalled)'));

  await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('input');
    box.value = ${JSON.stringify(targetUrl)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return box.value.length;
  })()`);
  await win.webContents.executeJavaScript(`document.getElementById('go').click(); true`);

  let report = null;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    report = await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.asset').length,
      variants: document.querySelectorAll('.variant').length,
      title: document.querySelector('.asset__title')?.textContent ?? '',
      platform: document.querySelector('.chip--brand')?.textContent ?? '',
      firstUrl: document.querySelector('.variant__url')?.textContent ?? '',
      status: document.getElementById('status')?.textContent ?? '',
    }))()`);
    if (report.cards > 0) break;
  }
  console.log('[verify] 解析结果:', JSON.stringify(report, null, 2));

  mkdirSync(join(ROOT, 'shots'), { recursive: true });
  const image = await win.webContents.capturePage();
  writeFileSync(join(ROOT, 'shots', 'mobile-parse.png'), image.toPNG());
  console.log('[verify] 截图: mobile/shots/mobile-parse.png');

  const ok = report?.cards > 0 && report?.variants > 0 && /^https?:\/\//.test(report.firstUrl ?? '');
  if (errors.length) console.error('[verify] 页面报错:', errors.slice(0, 5));
  console.log(ok ? '[verify] 通过：手机端界面可以正常解析并展示结果' : '[verify] 失败：手机端没有拿到解析结果');
  app.exit(ok ? 0 : 1);
});

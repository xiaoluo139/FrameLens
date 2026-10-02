// 在真实应用环境里验证解析：带上主进程的「浏览器渲染」能力。
//   electron scripts/e2e-app-parse.mjs --user-data-dir=<目录> <分享文本或URL>

import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { analyze } from '../core/extract/index.js';
import { renderPageForMedia } from '../electron/media-renderer.js';
import { request } from '../core/http.js';

// 隐藏的渲染窗口销毁后，如果没有任何窗口存活 Electron 会直接退出，
// 后面的下载校验就跑不到了。这里显式禁用该默认行为。
app.on('window-all-closed', () => {});

const text = process.argv.find((a) => !a.startsWith('--') && /(https?:\/\/|复制|打开)/.test(a)) ?? 'https://www.bilibili.com/video/BV1GJ411x7h7';

app.whenReady().then(async () => {
  const started = Date.now();
  const result = await analyze(text, {
    renderMedia: renderPageForMedia,
    onProgress: (event) => {
      if (event.stage !== 'start') console.log(`  [${event.stage}] ${event.title ?? event.message ?? event.url ?? ''}`);
    },
  });

  console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s，成功 ${result.assets.length} 条，失败 ${result.failures.length} 条`);
  for (const asset of result.assets) {
    console.log(`\n标题  : ${asset.title}`);
    console.log(`平台  : ${asset.platformName}(${asset.platformId})   作者: ${asset.author || '空'}`);
    console.log(`封面  : ${asset.cover ? asset.cover.slice(0, 80) : '无'}`);
    console.log(`时长  : ${asset.durationSec}s   清晰度: ${asset.variants.length}`);
    for (const v of asset.variants.slice(0, 6)) console.log(`   - ${v.label.padEnd(14)} ${v.url.slice(0, 110)}`);
    if (asset.warnings.length) console.log(`警告  : ${asset.warnings.join(' / ')}`);
  }
  for (const f of result.failures) console.log('失败:', f.url, f.message);

  // --download：立刻用第一条地址下载一次，确认它真的能下（直链有签名时效）
  if (process.argv.includes('--download')) {
    const first = result.assets.find((a) => a.variants.length > 0)?.variants[0];
    if (first) {
      console.log(`\n验证下载：${first.label}`);
      try {
        const res = await request(first.url, { headers: first.headers ?? {}, timeoutMs: 90000 });
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync('D:/jx/.dl-probe', { recursive: true });
        writeFileSync('D:/jx/.dl-probe/verified.bin', buf);
        const head = buf.subarray(4, 12).toString('ascii');
        console.log(`  HTTP ${res.status} | ${(buf.length / 1024 / 1024).toFixed(2)} MB | 文件头 ${head}`);
        console.log(head.startsWith('ftyp') ? '  ✅ 下载成功，是合法 MP4' : `  ⚠️ 文件头异常：${head}`);
      } catch (error) {
        console.log('  ❌ 下载失败:', error.message);
      }
    }
  }
  app.exit(result.assets.some((a) => a.variants.length > 0) ? 0 : 1);
});

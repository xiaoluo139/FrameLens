/**
 * 把桌面端的解析引擎打包成移动端可直接运行的单文件脚本。
 *
 * 复用范围：core/extract/**（平台识别、HTML 抽取、HLS 解析、各平台解析器）
 * 说明：core/extract/downloader.js 依赖 node:fs，不参与移动端打包；
 *       移动端用系统下载能力（浏览器/分享）承接下载动作。
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const WWW = join(ROOT, 'www');

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
cpSync(join(ROOT, 'index.html'), join(WWW, 'index.html'));
cpSync(join(ROOT, 'styles.css'), join(WWW, 'styles.css'));

await build({
  entryPoints: [join(ROOT, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  minify: true,
  sourcemap: false,
  outfile: join(WWW, 'app.js'),
  logLevel: 'info',
});

console.log('[mobile] www/ 已生成');

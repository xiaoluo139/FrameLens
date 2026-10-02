/**
 * 清理构建中间产物。
 *   node scripts/clean.mjs            清临时目录与移动端构建产物
 *   node scripts/clean.mjs --release  额外清掉 release/（安装包、APK）
 *
 * 注意：shots/ 是文档用的界面截图，永远不删——之前把它放进来导致
 * README 里的截图被误删过，这里明确排除。
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['.smoke-home', '.smoke-packaged', '.verify-home', '.bundle-stage', 'mobile\\www', 'mobile\\android\\app\\build'];
if (process.argv.includes('--release')) targets.push('release');

for (const target of targets) {
  const full = join(ROOT, target);
  if (!existsSync(full)) continue;
  try {
    rmSync(full, { recursive: true, force: true });
    console.log(`已清理 ${target}`);
  } catch (error) {
    console.warn(`跳过 ${target}：${error.message}`);
  }
}

// 顺便清掉打包目录里 rcedit 的残留
const appDir = join(ROOT, 'release', 'win-unpacked');
if (existsSync(appDir)) {
  for (const entry of readdirSync(appDir)) {
    if (!/^RCX.*\.tmp$/i.test(entry)) continue;
    try {
      rmSync(join(appDir, entry), { force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('完成');

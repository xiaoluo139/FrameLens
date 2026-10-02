/**
 * Windows 安装包构建入口。
 *
 *   node scripts/build-win.mjs            # 精简版（不含模型，首次使用时下载）
 *   node scripts/build-win.mjs --bundled  # 全内置版（把运行时和模型打进安装包）
 *
 * 这个脚本额外做两件事，都是为了在真实 Windows 机器上稳定出包：
 *   1) 把 electron / electron-builder 的下载缓存固定在项目内，避免污染用户目录
 *   2) 自动修复「第三方依赖解压后改名失败」——杀软或索引服务占用时
 *      electron-builder 会把内容解压到随机数字目录却改不回正式名字，
 *      这里检测到就帮忙归位并重试一次
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const EB_CACHE = join(CACHE, 'electron-builder');
const bundled = process.argv.includes('--bundled');
const lite = process.argv.includes('--lite');

process.env.ELECTRON_CACHE = join(CACHE, 'electron');
process.env.ELECTRON_BUILDER_CACHE = EB_CACHE;

for (const dir of [join(CACHE, 'electron'), EB_CACHE]) mkdirSync(dir, { recursive: true });

const run = (args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`electron-builder 退出码 ${code}`))));
    child.on('error', reject);
  });

/**
 * electron-builder 下载的 7z 会解压到 `<包名>/<随机数字>/`，
 * 正常情况下它会把该目录改名为 `<包名>-<版本>`。改名失败时我们手动补上。
 */
function repairExtractedPackages() {
  if (!existsSync(EB_CACHE)) return 0;
  let repaired = 0;
  for (const group of readdirSync(EB_CACHE, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(EB_CACHE, group.name);
    const temps = readdirSync(groupDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{6,}$/.test(e.name));
    if (temps.length === 0) continue;

    // 目标名从同级的正式目录推断；没有正式目录说明这次就是它，取「包名-版本」惯例
    const existing = readdirSync(groupDir).filter((n) => n.startsWith(`${group.name}-`));
    const target = join(groupDir, existing[0] ?? `${group.name}-unversioned`);
    const source = join(groupDir, temps[0].name);
    if (existing.length > 0) {
      // 已经有正式目录，说明这只是重复下载的残渣，清掉
      try {
        rmSync(source, { recursive: true, force: true });
      } catch {
        /* 占用中就先留着 */
      }
      continue;
    }
    try {
      renameSync(source, target);
      console.log(`[build] 已修复解压目录：${group.name}/${temps[0].name} -> ${target.split(/[\\/]/).pop()}`);
      repaired++;
    } catch (error) {
      console.warn(`[build] 修复 ${group.name} 失败：${error.message}`);
    }
  }
  return repaired;
}

/**
 * rcedit（写入 exe 图标/版本信息）会在打包目录里留下 RCX*.tmp 副本，
 * 文件被占用时删不掉就会残留在安装包里，白白多出上百 MB。
 */
function cleanStaleRceditTemp() {
  const appDir = join(ROOT, 'release', 'win-unpacked');
  if (!existsSync(appDir)) return;
  for (const entry of readdirSync(appDir)) {
    if (!/^RCX.*\.tmp$/i.test(entry)) continue;
    try {
      rmSync(join(appDir, entry), { force: true });
      console.log(`[build] 清理残留临时文件 ${entry}`);
    } catch {
      console.warn(`[build] ${entry} 暂时被占用，跳过`);
    }
  }
}

console.log('▶ 生成图标');
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'make-icon.mjs')], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error('生成图标失败'))));
});

if (bundled) {
  console.log('▶ 准备随包资源（运行时 + 模型）');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'fetch-model.mjs'), ...process.argv.slice(3)], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error('准备随包资源失败'))));
  });
}

const args = ['--config', 'electron-builder.config.json', '--win', '--x64'];
console.log(`▶ 打包${bundled ? '（全内置版）' : '（精简版）'}`);
cleanStaleRceditTemp();

/**
 * 精简版：把随包资源临时挪开再打包。
 * electron-builder 的 extraResources 是静态配置，只能在打包前把目录移走。
 */
const bundledDir = join(ROOT, 'resources', 'bundled');
const parkedDir = join(ROOT, 'resources', '.bundled-parked');
let parked = false;
if (lite && existsSync(bundledDir)) {
  rmSync(parkedDir, { recursive: true, force: true });
  renameSync(bundledDir, parkedDir);
  parked = true;
  console.log('[build] 精简版：已临时移开随包资源');
}

try {
  await run(args);
} catch (error) {
  console.warn(`\n[build] 第一次打包失败：${error.message}`);
  const repaired = repairExtractedPackages();
  if (repaired === 0) throw error;
  console.log(`[build] 已修复 ${repaired} 个依赖目录，重试打包…\n`);
  await run(args);
} finally {
  if (parked) {
    renameSync(parkedDir, bundledDir);
    console.log('[build] 随包资源已放回');
  }
}

console.log('\n✅ 完成，产物在 release/ 目录');

/**
 * llama.cpp 本地推理运行时管理。
 *
 * 应用不把 llama.cpp 编译进包里，而是在首次使用时从官方 Release 拉取
 * `llama-server`（OpenAI 兼容的本地服务，支持 --mmproj 多模态），
 * 之后完全离线可用。安装包也可以选择把 runtime 一起打进去。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getText, request } from '../http.js';
import { createLogger } from '../logger.js';
import { extractZip } from '../zip.js';
import { fetchToFile } from './downloader.js';
import { bundledRuntimeDir } from '../paths.js';

const log = createLogger('runtime');

const RELEASES_ATOM = 'https://github.com/ggml-org/llama.cpp/releases.atom';
const EXPANDED_ASSETS = (tag) => `https://github.com/ggml-org/llama.cpp/releases/expanded_assets/${tag}`;

export const RUNTIME_SERVER_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/**
 * 按平台挑选合适的发行包。
 * 注意：官方发布里既有 `llama-...`（含 llama-server）也有 `cudart-llama-...`
 * （只有 CUDA 运行库 DLL），这里必须带 `llama-` 前缀，否则会选错。
 */
export function assetPattern(variant = 'cpu') {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') {
    if (variant === 'cuda') return new RegExp(`^llama-.*bin-win-cuda-[\\d.]+-${arch}\\.zip$`, 'i');
    if (variant === 'vulkan') return new RegExp(`^llama-.*bin-win-vulkan-${arch}\\.zip$`, 'i');
    return new RegExp(`^llama-.*bin-win-cpu-${arch}\\.zip$`, 'i');
  }
  if (process.platform === 'darwin') return new RegExp(`^llama-.*bin-macos-${arch}\\.zip$`, 'i');
  if (variant === 'vulkan') return new RegExp(`^llama-.*bin-ubuntu-vulkan-${arch}\\.zip$`, 'i');
  if (variant === 'cuda') return new RegExp(`^llama-.*bin-ubuntu-cuda[\\d.]*-${arch}\\.zip$`, 'i');
  return new RegExp(`^llama-.*bin-ubuntu-${arch}\\.zip$`, 'i');
}

/** CUDA 版本需要额外下载官方运行库包 */
export function cudartPattern(asset) {
  const match = String(asset).match(/bin-win-cuda-([\d.]+)-x64\.zip$/i);
  if (!match) return null;
  return new RegExp(`^cudart-llama-bin-win-cuda-${match[1].replace(/\./g, '\\.')}-x64\\.zip$`, 'i');
}

export function runtimeRoot(userDataDir) {
  return join(userDataDir, 'runtime');
}

/** 查找已安装的 llama-server */
export function findInstalledServer(userDataDir) {
  // 用户数据目录优先（可升级），安装包随附的运行时兜底
  for (const root of [runtimeRoot(userDataDir), bundledRuntimeDir()].filter(Boolean)) {
    if (!existsSync(root)) continue;
    try {
      const direct = walkForServer(root);
      if (direct) return direct;
      const versions = readdirSync(root).filter((d) => d.startsWith('llama-'));
      for (const version of versions.sort().reverse()) {
        const hit = walkForServer(join(root, version));
        if (hit) return hit;
      }
    } catch (error) {
      log.warn('扫描本地运行时时出错', error);
    }
  }
  return '';
}

function walkForServer(dir, depth = 0) {
  if (depth > 4) return '';
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === RUNTIME_SERVER_NAME) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = walkForServer(join(dir, entry.name), depth + 1);
    if (hit) return hit;
  }
  return '';
}

/** 取最新 release tag（atom 源不需要 API token，也不会被匿名限流） */
export async function fetchLatestTag({ signal } = {}) {
  const tags = await fetchRecentTags({ signal });
  if (tags.length === 0) throw new Error('无法获取 llama.cpp 版本号');
  return tags[0];
}

/**
 * 取最近的若干个 release tag（新的在前）。
 * 需要它是因为：GitHub 上最新那个 release 有时还没挂上二进制资产
 * （实测 b11347 就是空的），这时必须能回退到上一个可用版本。
 */
export async function fetchRecentTags({ signal, limit = 12 } = {}) {
  const xml = await getText(RELEASES_ATOM, { headers: { 'user-agent': 'FrameLens/1.0' }, signal });
  const tags = [...xml.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g)].map((m) => m[1]);
  return tags.slice(0, limit);
}

/** 列出某个版本的发行资产名 */
export async function listAssets(tag, { signal } = {}) {
  const html = await getText(EXPANDED_ASSETS(tag), { headers: { 'user-agent': 'Mozilla/5.0 FrameLens/1.0' }, signal });
  const names = new Set();
  for (const match of html.matchAll(/href="[^"]*\/releases\/download\/[^"]*\/([^"/]+\.zip)"/gi)) {
    names.add(decodeURIComponent(match[1]));
  }
  return [...names];
}

/**
 * 安装运行时。
 * @returns {Promise<{serverPath:string, tag:string, asset:string}>}
 */
export async function installRuntime(userDataDir, { variant = 'cpu', signal, onProgress = () => {}, tag } = {}) {
  const existing = findInstalledServer(userDataDir);
  if (existing) {
    onProgress({ stage: 'done', percent: 100, message: '已安装', serverPath: existing });
    return { serverPath: existing, tag: tag ?? 'installed', asset: '' };
  }

  onProgress({ stage: 'lookup', percent: 0, message: '查询可用版本…' });
  const candidates = tag ? [tag] : await fetchRecentTags({ signal });
  const requested = variantFor(variant);
  let resolvedTag = '';
  let asset = '';
  let assets = [];

  // 最新版本可能还没挂上二进制资产，逐个版本往下找
  for (const candidate of candidates) {
    const list = await listAssets(candidate, { signal });
    const hit = list.find((name) => assetPattern(requested).test(name)) ?? list.find((name) => assetPattern('cpu').test(name));
    if (hit) {
      resolvedTag = candidate;
      asset = hit;
      assets = list;
      break;
    }
    log.debug(`版本 ${candidate} 没有可用资产，继续往前找`);
  }
  if (!asset) {
    throw new Error(`没有找到适配当前系统的运行时包（${process.platform}/${process.arch}，variant=${variant}）`);
  }
  onProgress({ stage: 'lookup', percent: 4, message: `使用版本 ${resolvedTag}` });
  const targetDir = join(runtimeRoot(userDataDir), `llama-${resolvedTag}`);
  mkdirSync(targetDir, { recursive: true });

  const cudart = cudartPattern(asset);
  const packages = [{ asset, label: '推理引擎', weight: cudart ? 0.6 : 1 }];
  const cudartAsset = cudart ? assets.find((name) => cudart.test(name)) : '';
  if (cudartAsset) packages.push({ asset: cudartAsset, label: 'CUDA 运行库', weight: 0.4 });

  let doneWeight = 0;
  const fs = await import('node:fs');
  for (const pack of packages) {
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${resolvedTag}/${pack.asset}`;
    const zipPath = join(targetDir, pack.asset);
    onProgress({ stage: 'download', percent: 5 + doneWeight * 80, message: `下载${pack.label}…` });
    await fetchToFile({
      url,
      destPath: zipPath,
      signal,
      onProgress: (p) => {
        onProgress({
          stage: 'download',
          percent: 5 + (doneWeight + (p.percent / 100) * pack.weight) * 80,
          received: p.received,
          total: p.total,
          speed: p.speed,
          message: `下载${pack.label} ${p.percent.toFixed(1)}%`,
        });
      },
    });
    onProgress({ stage: 'extract', percent: 85 + doneWeight * 10, message: `解压${pack.label}…` });
    extractZip(fs.readFileSync(zipPath), targetDir, { filter: (entry) => !entry.name.endsWith('.pdb') });
    rmSync(zipPath, { force: true });
    doneWeight += pack.weight;
  }

  const serverPath = walkForServer(targetDir);
  if (!serverPath) throw new Error('运行时解压完成，但没有找到 llama-server 可执行文件');
  if (process.platform !== 'win32') {
    try {
      chmodSync(serverPath, 0o755);
    } catch {
      /* 权限设置失败不致命 */
    }
  }
  writeFileSync(join(targetDir, '.framelens-runtime.json'), JSON.stringify({ tag: resolvedTag, asset, installedAt: Date.now() }, null, 2));
  onProgress({ stage: 'done', percent: 100, message: '运行时就绪', serverPath });
  return { serverPath, tag: resolvedTag, asset };
}

/** 运行时是否可用（离线状态下的快速判定） */
export function runtimeStatus(userDataDir) {
  const serverPath = findInstalledServer(userDataDir);
  return { installed: Boolean(serverPath), serverPath };
}

/** 把配置里的加速偏好收敛成实际可用的 variant */
function variantFor(variant) {
  if (process.platform !== 'win32') return variant;
  return ['cpu', 'cuda', 'vulkan'].includes(variant) ? variant : 'cpu';
}

/** 直接请求一个 URL 探测可达性（给「网络诊断」用） */
export async function probe(url, { signal } = {}) {
  const res = await request(url, { method: 'HEAD', redirect: 'follow', signal });
  return { ok: res.ok || res.status === 302, status: res.status };
}

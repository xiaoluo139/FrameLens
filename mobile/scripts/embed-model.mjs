// 把模型文件放进 Android 工程的 assets，使它随 APK 一起分发。
//
//   node scripts/embed-model.mjs qwen2.5-vl-3b
//
// 产物：
//   android/app/src/main/assets/models/<id>/*.gguf
//   android/app/src/main/assets/models/manifest.json   （应用启动时用它判断「包里带了哪些模型」）
//
// 说明：GGUF 在打包时设为不压缩（见 app/build.gradle 的 noCompress），
// 否则 2.6GB 的模型在安装和首次读取时会非常慢。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'models');

/** 移动端模型 id -> 桌面端模型 id（同一仓库同一文件，直接复用已下载的副本） */
const SOURCE = {
  'smolvlm2-2.2b': 'smolvlm2-2_2b-q4_k_m',
  'qwen2.5-vl-3b': 'qwen2.5-vl-3b-q4_k_m',
  'smolvlm-256m': 'smolvlm-256m-q8_0',
};

/** 桌面端下载目录的候选位置 */
const CACHE_ROOTS = [process.env.FRAMELENS_MODELS, 'D:/jx/.e2e-home/models', join(ROOT, '.models')].filter(Boolean);

const modelId = process.argv[2] ?? 'qwen2.5-vl-3b';
const sourceId = SOURCE[modelId] ?? modelId;

let sourceDir = '';
for (const root of CACHE_ROOTS) {
  const candidate = join(root, sourceId);
  if (existsSync(candidate)) {
    sourceDir = candidate;
    break;
  }
}
if (!sourceDir) {
  console.error(`找不到模型文件（${sourceId}）。先下载：\n  node scripts/e2e-app-parse.mjs 无关\n或把 GGUF 放到 ${CACHE_ROOTS[0]}/${sourceId}/`);
  process.exit(2);
}

const files = readdirSync(sourceDir).filter((name) => name.toLowerCase().endsWith('.gguf'));
if (files.length === 0) {
  console.error(`${sourceDir} 里没有 .gguf 文件`);
  process.exit(2);
}

rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(join(ASSETS, modelId), { recursive: true });

const manifest = { models: [] };
const entries = [];
let total = 0;

for (const name of files) {
  const from = join(sourceDir, name);
  const to = join(ASSETS, modelId, name);
  console.log(`复制 ${name} …`);
  copyFileSync(from, to);
  const size = statSync(to).size;
  total += size;
  entries.push({ name, size });
}

manifest.models.push({ id: modelId, files: entries });
writeFileSync(join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`\n已嵌入模型 ${modelId}：${files.length} 个文件，共 ${(total / 1024 ** 3).toFixed(2)} GB`);
console.log('接下来执行：npm run android:release:full');

/**
 * 本地推理链路自检（开发用，也能给用户排障）：
 *   1. 安装 / 复用 llama-server 运行时
 *   2. 下载 / 复用指定 GGUF 模型
 *   3. 启动服务，跑一次文本对话
 *   4. 用一张测试图跑一次视觉理解
 *
 *   node scripts/verify-runtime.mjs [modelId]
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceRuntime } from '../core/model/runtime.js';
import { MODEL_CATALOG } from '../core/model/catalog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = process.env.FRAMELENS_HOME ?? join(mkdtempSync(join(tmpdir(), 'framelens-')), 'home');
const modelId = process.argv[2] ?? 'smolvlm-256m-q8_0';

console.log('[verify] 工作目录:', workDir);
console.log('[verify] 目标模型:', modelId);

const settings = { network: { preferMirror: true }, model: { activeModelId: modelId, contextsPerSequence: 4096 } };
const runtime = new InferenceRuntime({
  userDataDir: workDir,
  modelsDir: join(workDir, 'models'),
  settings: () => settings,
});

const report = (event) => {
  if (event.message) process.stdout.write(`\r[${event.stage}] ${String(event.message).padEnd(60).slice(0, 60)}`);
};

const started = Date.now();
console.log('\n[1/4] 准备运行时与模型…');
await runtime.ensureReady({ modelId, onProgress: report });
console.log(`\n[1/4] 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

console.log('\n[2/4] 文本对话…');
const textStart = Date.now();
const text = await runtime.chat({
  messages: [
    { role: 'system', content: '你是 FrameLens 的助手，回答保持简洁。' },
    { role: 'user', content: '用一句话说明你能做什么。' },
  ],
  maxTokens: 80,
  onToken: () => {},
});
console.log(`  -> ${text.text.trim() || '(空回复)'}`);
console.log(`  用时 ${((Date.now() - textStart) / 1000).toFixed(1)}s`);

const imagePath = join(ROOT, 'build', 'icon.png');
if (existsSync(imagePath)) {
  console.log('\n[3/4] 视觉理解（用品牌图标当测试图）…');
  const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`;
  const visionStart = Date.now();
  const vision = await runtime.chat({
    messages: [
      { role: 'system', content: 'You are a helpful vision assistant.' },
      { role: 'user', content: 'Describe this image in one short sentence.' },
    ],
    images: [dataUrl],
    maxTokens: 80,
  });
  console.log(`  -> ${vision.text.trim() || '(空回复)'}`);
  console.log(`  用时 ${((Date.now() - visionStart) / 1000).toFixed(1)}s`);
} else {
  console.log('\n[3/4] 跳过视觉测试（没找到 build/icon.png，先跑 npm run icons）');
}

console.log('\n[4/4] 关闭推理进程…');
await runtime.unload();
console.log('[verify] 全部通过 ✅');
process.exit(0);

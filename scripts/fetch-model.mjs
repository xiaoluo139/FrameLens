/**
 * 把运行时与模型预先下载到 resources/bundled，供「全内置安装包」使用。
 *
 *   node scripts/fetch-model.mjs                       # 默认拉运行时 + 极速试用模型
 *   node scripts/fetch-model.mjs smolvlm-500m-q8_0     # 指定模型
 *   node scripts/fetch-model.mjs --runtime-only        # 只拉运行时
 *
 * 产物：
 *   resources/bundled/runtime/llama-<tag>/llama-server.exe ...
 *   resources/bundled/models/<modelId>/*.gguf
 *   resources/bundled/bundled.json
 */

import { mkdirSync, writeFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRuntime, runtimeStatus } from '../core/model/llama-runtime.js';
import { MODEL_CATALOG, getModel } from '../core/model/catalog.js';
import { InferenceRuntime } from '../core/model/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'resources', 'bundled');
const STAGE = join(ROOT, '.bundle-stage');

const args = process.argv.slice(2);
const runtimeOnly = args.includes('--runtime-only');
const modelId = args.find((a) => !a.startsWith('--')) ?? 'smolvlm-256m-q8_0';
const model = getModel(modelId);

console.log('目标模型:', model.name, `(${model.repo})`);
mkdirSync(BUNDLE, { recursive: true });
mkdirSync(STAGE, { recursive: true });

/* ---------------------------------------------------------------- 运行时 */
const already = runtimeStatus(STAGE);
if (!already.installed) {
  console.log('\n[1/2] 下载 llama.cpp 运行时…');
  await installRuntime(STAGE, {
    variant: 'cpu',
    onProgress: (event) => process.stdout.write(`\r  ${event.message ?? ''}                    `.slice(0, 78)),
  });
  console.log('');
}

const runtimeTarget = join(BUNDLE, 'runtime');
mkdirSync(runtimeTarget, { recursive: true });
const runtimeSrc = join(STAGE, 'runtime');
if (existsSync(runtimeSrc)) {
  for (const entry of readdirSync(runtimeSrc)) {
    cpSync(join(runtimeSrc, entry), join(runtimeTarget, entry), { recursive: true, force: true });
  }
  console.log('运行时已复制到 resources/bundled/runtime');
}

/* ---------------------------------------------------------------- 模型 */
if (!runtimeOnly) {
  console.log('\n[2/2] 下载模型（体积较大，请耐心等待）…');
  const runtime = new InferenceRuntime({
    userDataDir: STAGE,
    modelsDir: join(STAGE, 'models'),
    settings: () => ({ network: { preferMirror: true }, model: { activeModelId: model.id } }),
  });
  let lastLine = '';
  await runtime.downloadModel(model.id, {
    onProgress: (event) => {
      const line = `${event.message ?? ''}`;
      if (line === lastLine) return;
      lastLine = line;
      process.stdout.write(`\r  ${line}                    `.slice(0, 78));
    },
  });
  console.log('');

  const modelsTarget = join(BUNDLE, 'models');
  mkdirSync(modelsTarget, { recursive: true });
  cpSync(join(STAGE, 'models', model.id), join(modelsTarget, model.id), { recursive: true, force: true });
  console.log('模型已复制到 resources/bundled/models/' + model.id);
}

writeFileSync(
  join(BUNDLE, 'bundled.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      runtime: !runtimeOnly,
      models: runtimeOnly ? [] : [model.id],
      note: '由 scripts/fetch-model.mjs 生成，随安装包一起分发。',
    },
    null,
    2,
  ),
);

console.log('\n完成。接下来执行：npm run build:win');
console.log('提示：模型体积较大，NSIS 安装包会相应变大（压缩后通常比原始小 10%~20%）。');
console.log('可选项：MODEL_CATALOG 里的模型 id 有：');
for (const item of MODEL_CATALOG) console.log(`  - ${item.id}  (${item.name})`);

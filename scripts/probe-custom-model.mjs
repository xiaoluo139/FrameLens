// 验证「导入自定义模型」这条链路：
// 把一个 GGUF 登记成自定义模型 -> 出现在模型列表 -> 能被加载并对话。
//
//   electron scripts/probe-custom-model.mjs --user-data-dir=<目录>

import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InferenceRuntime } from '../core/model/runtime.js';
import { Store } from '../core/store.js';

const dirArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
const HOME = dirArg ? dirArg.split('=')[1] : join(app.getPath('temp'), 'framelens-custom');
const sourceRoot = process.env.FRAMELENS_MODELS ?? 'D:/jx/.e2e-home/models';
const sourceId = 'smolvlm-256m-q8_0';

app.whenReady().then(async () => {
  const sourceDir = join(sourceRoot, sourceId);
  if (!existsSync(sourceDir)) {
    console.error('[probe] 找不到样本模型：', sourceDir);
    app.exit(2);
    return;
  }

  // 1) 模拟「用户导入模型」：把文件拷进 models/custom-xxx/ 并登记
  const id = 'custom-smolvlm-256m';
  const targetDir = join(HOME, 'models', id);
  mkdirSync(targetDir, { recursive: true });
  const files = readdirSync(sourceDir).filter((f) => f.toLowerCase().endsWith('.gguf'));
  for (const file of files) copyFileSync(join(sourceDir, file), join(targetDir, file));
  const mmproj = files.find((f) => /mmproj|^clip/i.test(f)) ?? '';
  const main = files.find((f) => f !== mmproj);

  const store = new Store(join(HOME, 'framelens.config.json'));
  store.set('customModels', [
    {
      id,
      name: '我的本地模型',
      modelFile: main,
      mmprojFile: mmproj,
      bytes: files.reduce((sum, f) => sum + statSync(join(targetDir, f)).size, 0),
      contextSize: 4096,
      description: '从本机导入',
    },
  ]);
  store.set('model.activeModelId', id);

  const runtime = new InferenceRuntime({
    userDataDir: HOME,
    modelsDir: join(HOME, 'models'),
    settings: () => store.all,
  });

  // 2) 自定义模型要出现在列表里，且被识别为「已安装」
  const status = await runtime.status();
  const entry = status.models.find((m) => m.id === id);
  console.log('[probe] 自定义模型是否出现在列表:', Boolean(entry));
  console.log('[probe] 是否识别为已安装:', entry?.installed, '| 体积', ((entry?.installedBytes ?? 0) / 1024 / 1024).toFixed(0), 'MB');
  console.log('[probe] 实际生效的模型:', status.effectiveModelId);

  // 3) 自定义模型要能真的加载并对话
  let reply = '';
  try {
    const result = await runtime.chat({
      messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
      maxTokens: 48,
      onToken: () => {},
      onProgress: (event) => {
        if (event.stage === 'load' || event.stage === 'ready') process.stdout.write(`\r[probe] ${event.message ?? ''}`.padEnd(60));
      },
    });
    reply = result.text.trim();
    console.log(`\n[probe] 对话成功：${reply.slice(0, 100)}`);
  } catch (error) {
    console.error('\n[probe] 对话失败：', error.message);
  }

  await runtime.unload();
  const ok = Boolean(entry?.installed) && reply.length > 0;
  console.log(ok ? '[probe] 通过 ✅ 自定义模型可用' : '[probe] 未通过 ❌');
  app.exit(ok ? 0 : 1);
});

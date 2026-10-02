// 诊断：启动 llama-server 并查看它实际使用的对话模板（/props 接口会返回）。
//   electron scripts/probe-template.mjs --user-data-dir=<目录>

import { app } from 'electron';
import { join } from 'node:path';
import { InferenceRuntime } from '../core/model/runtime.js';
import { getModel, inspectInstalled } from '../core/model/catalog.js';

const dirArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
const HOME = dirArg ? dirArg.split('=')[1] : join(app.getPath('temp'), 'framelens-probe');
const MODEL = process.env.FL_MODEL ?? 'minicpm-v-2_6-q4_k_m';

app.whenReady().then(async () => {
  const runtime = new InferenceRuntime({
    userDataDir: HOME,
    modelsDir: join(HOME, 'models'),
    settings: () => ({ model: { activeModelId: MODEL, contextsPerSequence: 4096 } }),
  });

  const model = getModel(MODEL);
  const local = inspectInstalled([join(HOME, 'models')], model);
  console.log('[probe] 模型文件:', local.modelPath);
  console.log('[probe] 视觉编码器:', local.mmprojPath || '(无)');

  const server = await runtime.ensureReady({ modelId: MODEL, onProgress: () => {} });
  const props = await fetch(`${server.baseUrl}/props`).then((r) => r.json());
  const template = props?.chat_template ?? props?.default_generation_settings?.chat_template ?? '';
  console.log('[probe] 模型路径:', props?.model_path);
  console.log('[probe] 对话模板长度:', String(template).length);
  console.log('[probe] 对话模板内容:\n' + String(template).slice(0, 1200));
  console.log('[probe] 上下文:', props?.default_generation_settings?.n_ctx, ' 参数:', JSON.stringify(props?.default_generation_settings?.params ?? {}).slice(0, 300));

  await runtime.unload();
  app.exit(0);
});

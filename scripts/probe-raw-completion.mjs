// 诊断：绕开 chat 模板与流式解析，直接调 llama-server 原生 /completion，
// 判断「乱码」是模型本身的问题，还是我们请求格式的问题。
//   electron scripts/probe-raw-completion.mjs --user-data-dir=<目录>

import { app } from 'electron';
import { join } from 'node:path';
import { InferenceRuntime } from '../core/model/runtime.js';

const dirArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
const HOME = dirArg ? dirArg.split('=')[1] : join(app.getPath('temp'), 'framelens-probe');
const MODEL = process.env.FL_MODEL ?? 'minicpm-v-2_6-q4_k_m';

app.whenReady().then(async () => {
  const runtime = new InferenceRuntime({
    userDataDir: HOME,
    modelsDir: join(HOME, 'models'),
    settings: () => ({ model: { activeModelId: MODEL, contextsPerSequence: 4096 } }),
  });
  const server = await runtime.ensureReady({ modelId: MODEL, onProgress: () => {} });

  const cases = [
    { name: '原生 completion（手工 im_start 模板）', body: { prompt: '<|im_start|>user\n你好，请用一句话介绍你自己。<|im_end|>\n<|im_start|>assistant\n', n_predict: 48, temperature: 0.3, top_p: 0.9, repeat_penalty: 1.05 } },
    { name: '原生 completion（极简 prompt）', body: { prompt: '你好', n_predict: 24, temperature: 0.3 } },
    { name: '原生 completion（手工加 <s> BOS）', body: { prompt: '<s><|im_start|>user\n你好，请用一句话介绍你自己。<|im_end|>\n<|im_start|>assistant\n', n_predict: 48, temperature: 0.3 } },
    { name: '原生 completion（英文 + /no_think）', body: { prompt: '<|im_start|>user\nSay hello in one short sentence.<|im_end|>\n<|im_start|>assistant\n', n_predict: 32, temperature: 0.3 } },
  ];

  for (const item of cases) {
    const res = await fetch(`${server.baseUrl}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...item.body, stream: false }),
    });
    const json = await res.json().catch(() => ({}));
    console.log(`\n[probe] ${item.name}`);
    console.log('  内容:', JSON.stringify(String(json.content ?? json.error ?? '').slice(0, 220)));
    console.log('  停止原因:', json.stop_type ?? '-', ' tokens:', json.tokens_predicted ?? '-');
  }

  await runtime.unload();
  app.exit(0);
});

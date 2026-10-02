/**
 * 诊断脚本：在 Electron 主进程里直接调用 InferenceRuntime.chat()，
 * 用来区分「推理层在 Electron 下有问题」还是「IPC / 渲染层有问题」。
 *   electron scripts/probe-chat-in-electron.mjs --user-data-dir=<目录>
 */

import { app } from 'electron';
import { join } from 'node:path';
import { InferenceRuntime } from '../core/model/runtime.js';

const dirArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
const HOME = dirArg ? dirArg.split('=')[1] : join(app.getPath('temp'), 'framelens-probe');
const MODEL = process.env.FL_MODEL ?? 'smolvlm-256m-q8_0';

app.whenReady().then(async () => {
  console.log('[probe] home =', HOME, ' model =', MODEL);
  const runtime = new InferenceRuntime({
    userDataDir: HOME,
    modelsDir: join(HOME, 'models'),
    settings: () => ({ network: { preferMirror: true }, model: { activeModelId: MODEL, contextsPerSequence: 4096 } }),
  });

  const started = Date.now();

  // FL_VERIFY=1 时只跑模型自检，用来验证「模型中心 -> 自检」这条链路
  if (process.env.FL_VERIFY === '1') {
    const report = await runtime.verifyModel(MODEL, { onProgress: () => {} });
    console.log('[probe] 自检结果:', JSON.stringify(report));
    await runtime.unload();
    app.exit(report.ok ? 0 : 1);
    return;
  }

  try {
    const result = await runtime.chat({
      messages: [
        { role: 'system', content: '回答保持简洁。' },
        { role: 'user', content: '用一句话说明你能做什么。' },
      ],
      maxTokens: 60,
      onToken: (_delta, full) => process.stdout.write(`\r[token] ${full.slice(-60).replace(/\n/g, ' ')}`),
      onProgress: (event) => console.log(`\n[progress] ${event.stage} ${event.percent?.toFixed?.(0) ?? ''}% ${event.message ?? ''}`),
    });
    console.log(`\n[probe] 成功，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('[probe] 回复：', result.text.trim() || '(空)');
  } catch (error) {
    console.error(`\n[probe] 失败，用时 ${((Date.now() - started) / 1000).toFixed(1)}s：`, error.message);
    if (error.logTail) console.error('[probe] 进程日志尾部：\n' + error.logTail.join('\n'));
  }
  await runtime.unload();
  app.exit(0);
});

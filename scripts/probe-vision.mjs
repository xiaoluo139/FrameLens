// 多帧视觉推理探针：在 Electron 主进程里直接跑，测量「N 帧 + 提示词」的真实耗时。
//   electron scripts/probe-vision.mjs --user-data-dir=<目录> [帧数]

import { app, nativeImage } from 'electron';
import { join } from 'node:path';
import { InferenceRuntime } from '../core/model/runtime.js';

const dirArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
const HOME = dirArg ? dirArg.split('=')[1] : join(app.getPath('temp'), 'framelens-probe');
const MODEL = process.env.FL_MODEL ?? 'qwen2.5-vl-3b-q4_k_m';
const frames = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1);
const iconPath = 'D:/jx/build/icon.png';

app.whenReady().then(async () => {
  const runtime = new InferenceRuntime({
    userDataDir: HOME,
    modelsDir: join(HOME, 'models'),
    settings: () => ({ model: { activeModelId: MODEL, contextsPerSequence: 8192 } }),
  });

  // 用同一张图模拟多帧（尺寸与抽帧默认值 512 一致）
  const resized = nativeImage.createFromPath(iconPath).resize({ width: 512, height: 512 });
  const dataUrl = resized.toDataURL();
  const images = Array.from({ length: frames }, () => dataUrl);
  console.log(`[probe] 模型 ${MODEL}，帧数 ${frames}，单帧约 ${(dataUrl.length / 1024).toFixed(0)} KB`);

  const started = Date.now();
  try {
    const result = await runtime.chat({
      messages: [
        { role: 'system', content: 'You are a video analyst. Answer in Chinese.' },
        { role: 'user', content: '这是视频的关键帧，请用一句话描述画面内容。' },
      ],
      images,
      maxTokens: 128,
      onToken: () => {},
      onProgress: (e) => {
        if (e.stage !== 'load') console.log(`[progress] ${e.stage} ${e.message ?? ''}`);
      },
    });
    console.log(`[probe] 成功，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('[probe] 回复：', result.text.trim().slice(0, 200));
  } catch (error) {
    console.error(`[probe] 失败，用时 ${((Date.now() - started) / 1000).toFixed(1)}s：`, error.message);
  }

  await runtime.unload();
  app.exit(0);
});

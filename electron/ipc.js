/**
 * 主进程 IPC 处理器：渲染进程的每一个动作都在这里落地。
 */

import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, freemem, totalmem } from 'node:os';
import { createLogger, recentLogs } from '../core/logger.js';
import { analyze, listPlatforms } from '../core/extract/index.js';
import { DownloadScheduler } from '../core/extract/downloader.js';
import { sanitizeFileName } from '../core/extract/url-tools.js';
import { MODEL_CATALOG, getModel } from '../core/model/catalog.js';
import { fetchLatestTag, runtimeStatus } from '../core/model/llama-runtime.js';
import { renderPageForMedia } from './media-renderer.js';

const log = createLogger('ipc');

export function registerHandlers(context) {
  const { ipcMain, app, dialog, shell, store, runtime, modelsDir, getMainWindow, broadcast, isDev, isE2E, applyThemeOverlay } = context;

  const controllers = new Map();
  const scheduler = new DownloadScheduler({
    maxParallel: store.get('download.maxParallel', 3),
    intervalMs: store.get('download.downloadInterval', 3) * 1000,
    logger: createLogger('queue'),
  });
  scheduler.on((event) => broadcast('download:event', event));

  store.on((data) => {
    scheduler.maxParallel = Math.max(1, data.download?.maxParallel ?? 3);
    scheduler.intervalMs = Math.max(0, (data.download?.downloadInterval ?? 3) * 1000);
  });

  const downloadsDir = () => store.get('download.outputDir', '') || join(homedir(), 'Downloads', 'FrameLens');

  const handlers = {
    /* ---------------------------------------------------------- 应用 */
    'app:info': async () => ({
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isDev,
      paths: {
        userData: app.getPath('userData'),
        models: modelsDir(),
        downloads: downloadsDir(),
        home: homedir(),
      },
    }),

    'app:openExternal': async ({ url }) => {
      if (!/^https?:/i.test(String(url))) throw new Error('只允许打开 http/https 链接');
      await shell.openExternal(url);
      return true;
    },

    'app:showItemInFolder': async ({ path }) => {
      shell.showItemInFolder(path);
      return true;
    },

    'app:openPath': async ({ path }) => {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
      return true;
    },

    'app:chooseDirectory': async ({ title, defaultPath } = {}) => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: title ?? '选择目录',
        defaultPath: defaultPath || downloadsDir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? '' : result.filePaths[0];
    },

    'app:chooseFiles': async ({ title, filters, multi = true } = {}) => {
      // E2E 模式：无法驱动系统文件选择框，用环境变量指定文件
      if (isE2E && process.env.FL_E2E_FILE) return [process.env.FL_E2E_FILE];
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: title ?? '选择文件',
        properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: filters ?? [
          { name: '媒体文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      return result.canceled ? [] : result.filePaths;
    },

    'app:saveText': async ({ defaultPath, content, filters } = {}) => {
      const result = await dialog.showSaveDialog(getMainWindow(), {
        defaultPath: defaultPath || join(downloadsDir(), 'framelens-result.txt'),
        filters: filters ?? [{ name: '文本文件', extensions: ['txt', 'md', 'json'] }],
      });
      if (result.canceled || !result.filePath) return '';
      writeFileSync(result.filePath, String(content ?? ''), 'utf8');
      return result.filePath;
    },

    'app:readText': async ({ path }) => readFileSync(path, 'utf8'),

    'app:writeBinary': async ({ path, base64 }) => {
      writeFileSync(path, Buffer.from(base64, 'base64'));
      return { path, size: statSync(path).size };
    },

    'app:windowAction': async ({ action }) => {
      const win = getMainWindow();
      if (!win) return false;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
      else if (action === 'close') win.close();
      else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
      return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    },

    /* ---------------------------------------------------------- 设置 */
    'settings:get': async () => store.all,

    'settings:patch': async (partial) => {
      store.patch(partial);
      applyThemeOverlay();
      return store.all;
    },

    'settings:reset': async () => {
      store.reset();
      applyThemeOverlay();
      return store.all;
    },

    'logs:recent': async () => recentLogs(),

    /* ---------------------------------------------------------- 解析 */
    'extract:platforms': async () => listPlatforms(),

    'extract:analyze': async ({ input, jobId }) => {
      const controller = new AbortController();
      if (jobId) controllers.set(jobId, controller);
      try {
        return await analyze(input, {
          signal: controller.signal,
          onProgress: (event) => broadcast('extract:progress', { jobId, ...event }),
          renderMedia: process.env.FRAMELENS_NO_RENDER ? undefined : renderPageForMedia,
        });
      } finally {
        if (jobId) controllers.delete(jobId);
      }
    },

    /* ---------------------------------------------------------- 下载 */
    'download:enqueue': async ({ items }) => {
      const dir = downloadsDir();
      return items.map((item) => {
        const folder = sanitizeFileName(item.title ?? 'media');
        const fileName = sanitizeFileName(item.fileName ?? `video.${item.format ?? 'mp4'}`);
        const preferred = item.destDir ?? join(dir, folder);
        return scheduler.enqueue({
          url: item.url,
          kind: /\.m3u8(\?|$)/i.test(item.url) ? 'hls' : 'file',
          title: item.title ?? fileName,
          platform: item.platform ?? '',
          headers: item.headers ?? {},
          destDir: ensureWritableDir(preferred, join(app.getPath('userData'), 'downloads', folder)),
          fileName,
        });
      });
    },

    'download:cancel': async ({ id }) => scheduler.cancel(id),
    'download:cancelAll': async () => {
      scheduler.cancelAll();
      return true;
    },
    'download:list': async () => scheduler.list(),

    /* ---------------------------------------------------------- 模型 */
    'model:status': async () => runtime.status(),

    'model:activate': async ({ modelId }) => {
      store.set('model.activeModelId', modelId);
      await runtime.unload();
      return runtime.status();
    },

    'model:download': async ({ modelId, mirror, requestId }) => {
      const controller = new AbortController();
      if (requestId) controllers.set(requestId, controller);
      try {
        const result = await runtime.downloadModel(modelId, {
          mirror,
          signal: controller.signal,
          onProgress: (event) => broadcast('model:progress', { requestId, modelId, ...event }),
        });
        return { ok: true, ...result };
      } finally {
        if (requestId) controllers.delete(requestId);
      }
    },

    'model:installRuntime': async ({ variant, requestId }) => {
      const controller = new AbortController();
      if (requestId) controllers.set(requestId, controller);
      try {
        const result = await runtime.installRuntime({
          variant,
          signal: controller.signal,
          onProgress: (event) => broadcast('model:progress', { requestId, ...event }),
        });
        return { ok: true, ...result };
      } finally {
        if (requestId) controllers.delete(requestId);
      }
    },

    'model:resolveFiles': async ({ modelId, mirror }) => {
      const { resolveModelFiles } = await import('../core/model/catalog.js');
      return resolveModelFiles(getModel(modelId), { base: mirror });
    },

    'model:unload': async () => {
      await runtime.unload();
      return runtime.status();
    },

    'model:verify': async ({ modelId }) =>
      runtime.verifyModel(modelId, { onProgress: (event) => broadcast('model:progress', { modelId, ...event }) }),

    /**
     * 导入用户自己的模型（.gguf）。
     * 支持一次选两个文件：主模型 + 视觉编码器（mmproj）。
     * 文件会被复制到应用数据目录下的 models/<id>/，并登记成「自定义模型」。
     */
    'model:import': async () => {
      /**
       * 自动化测试通道：设了 FRAMELENS_IMPORT_FILES 就直接用这些路径，
       * 跳过系统文件选择框（否则端到端测试会卡在原生弹窗上等人点）。
       * 正常使用时不设这个变量，走下面的对话框。
       */
      const injected = (process.env.FRAMELENS_IMPORT_FILES ?? '')
        .split(/[;\r\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      let files = injected;
      if (files.length === 0) {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          title: '选择 GGUF 模型文件（可同时选主模型与 mmproj）',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'GGUF 模型', extensions: ['gguf'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
        files = picked.filePaths;
      }
      if (files.length === 0) return { ok: false, canceled: true };
      const mmprojPath = files.find((f) => /mmproj|^clip/i.test(basename(f)));
      const modelPath = files.find((f) => f !== mmprojPath) ?? files[0];
      if (!modelPath) return { ok: false, error: '没有选择主模型文件' };

      const rawName = basename(modelPath).replace(/\.gguf$/i, '');
      const id = `custom-${rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || Date.now()}`;
      const targetDir = join(modelsDir(), id);
      mkdirSync(targetDir, { recursive: true });

      const copied = [];
      for (const file of [modelPath, mmprojPath].filter(Boolean)) {
        const dest = join(targetDir, basename(file));
        if (file !== dest) {
          // 大文件用流式复制，避免一次性读进内存
          await new Promise((resolvePromise, reject) => {
            const read = createReadStream(file);
            const write = createWriteStream(dest);
            read.on('error', reject);
            write.on('error', reject);
            write.on('close', resolvePromise);
            read.pipe(write);
          });
        }
        copied.push({ name: basename(file), bytes: statSync(dest).size });
      }

      const mainFile = copied.find((c) => !/mmproj|^clip/i.test(c.name)) ?? copied[0];
      const mmprojFile = copied.find((c) => /mmproj|^clip/i.test(c.name));
      const entry = {
        id,
        name: rawName,
        modelFile: mainFile.name,
        mmprojFile: mmprojFile?.name ?? '',
        bytes: copied.reduce((sum, c) => sum + c.bytes, 0),
        contextSize: 8192,
        description: `从本机导入${mmprojFile ? '（含视觉编码器）' : ''}`,
        importedAt: Date.now(),
      };

      const customModels = (store.get('customModels', []) ?? []).filter((m) => m.id !== id);
      customModels.push(entry);
      store.set('customModels', customModels);
      log.info(`已导入自定义模型 ${id}（${copied.map((c) => c.name).join(', ')}）`);
      return { ok: true, model: entry };
    },

    /** 删除自定义模型（只删导入的，内置模型不动） */
    'model:removeCustom': async ({ modelId }) => {
      const customModels = store.get('customModels', []) ?? [];
      const target = customModels.find((m) => m.id === modelId);
      if (!target) return { ok: false, error: '不是自定义模型' };
      await runtime.unload();
      store.set(
        'customModels',
        customModels.filter((m) => m.id !== modelId),
      );
      try {
        rmSync(join(modelsDir(), modelId), { recursive: true, force: true });
      } catch (error) {
        log.warn('删除自定义模型文件失败', error);
      }
      if (store.get('model.activeModelId') === modelId) store.set('model.activeModelId', 'qwen2.5-vl-3b-q4_k_m');
      return { ok: true };
    },

    'model:chat': async ({ requestId, messages, images, options = {} }) => {
      const controller = new AbortController();
      if (requestId) controllers.set(requestId, controller);
      const imageCount = Array.isArray(images) ? images.length : 0;
      const bytes = imageCount > 0 ? Math.round(images.join('').length / 1024) : 0;
      log.info(`收到推理请求 ${requestId ?? '-'}：${messages?.length ?? 0} 条消息 / ${imageCount} 张图片${bytes ? `（约 ${bytes} KB）` : ''}`);
      try {
        const result = await runtime.chat({
          messages,
          images,
          ...options,
          signal: controller.signal,
          onToken: (delta, full) => broadcast('chat:token', { requestId, delta, full }),
          onProgress: (event) => broadcast('model:progress', { requestId, ...event }),
        });
        return { ok: true, ...result };
      } catch (error) {
        if (controller.signal.aborted) return { ok: false, aborted: true, error: '已停止生成' };
        log.error('对话失败', error);
        return { ok: false, error: friendlyInferenceError(error), detail: error?.detail ?? '', logTail: error?.logTail ?? [] };
      } finally {
        if (requestId) controllers.delete(requestId);
      }
    },

    'model:cancel': async ({ requestId }) => {
      const controller = controllers.get(requestId);
      if (controller) {
        controller.abort(new Error('用户取消'));
        controllers.delete(requestId);
        return true;
      }
      return false;
    },

    /* ---------------------------------------------------------- 诊断 */
    'system:diagnose': async () => {
      const checks = [];
      const push = (name, ok, detail, hint = '') => checks.push({ name, ok, detail, hint });

      push('运行环境', true, `Electron ${process.versions.electron} · Node ${process.versions.node} · ${process.platform}/${process.arch}`);

      const runtimeState = runtimeStatus(app.getPath('userData'));
      push('推理运行时', runtimeState.installed, runtimeState.installed ? runtimeState.serverPath : '未安装', '未安装时首次对话会自动下载（约 15MB）');

      const status = await runtime.status();
      const installedModels = status.models.filter((m) => m.installed);
      push(
        '本地模型',
        installedModels.length > 0,
        installedModels.length > 0 ? installedModels.map((m) => m.name).join('、') : '还没有下载任何模型',
        '到「模型中心」下载一个模型即可离线使用',
      );

      try {
        const tag = await fetchLatestTag();
        push('llama.cpp 源', true, `可访问，最新版本 ${tag}`);
      } catch (error) {
        push('llama.cpp 源', false, error.message, '如在国内网络环境，可在设置里开启镜像');
      }

      push('内存', totalmem() / 1024 ** 3 >= 8, `${(totalmem() / 1024 ** 3).toFixed(1)} GB（可用 ${(freemem() / 1024 ** 3).toFixed(1)} GB）`, '低于 8G 建议用 SmolVLM 或 IQ3 量化');
      push('下载目录', true, downloadsDir());

      return { checks, hardware: status.hardware, models: status.models, modelCatalog: MODEL_CATALOG };
    },
  };

  ipcMain.handle('fl:invoke', async (_event, { channel, payload }) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`未知通道：${channel}`);
    try {
      return await handler(payload ?? {});
    } catch (error) {
      log.warn(`通道 ${channel} 执行失败`, error);
      throw new Error(error?.message ?? String(error));
    }
  });

  return { scheduler, handlers };
}

/**
 * 目录可写性检查。
 * 默认下载目录在某些机器上不可写（受管电脑、权限收紧、只读盘），
 * 直接 mkdir 会抛 EPERM 让用户看到一个看不懂的错误。
 * 这里做一次探测，失败就回退到应用数据目录，并且让任务标题里带上说明。
 */
function ensureWritableDir(preferred, fallback) {
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (error) {
    try {
      mkdirSync(fallback, { recursive: true });
      log.warn(`下载目录不可写（${error.code ?? error.message}），已回退到 ${fallback}`);
      return fallback;
    } catch (fallbackError) {
      log.error('回退目录同样不可写', fallbackError);
      return preferred;
    }
  }
}

/**
 * 把推理层的英文报错翻译成用户能照做的中文提示。
 * 直接把 llama-server 的原始 JSON 甩给用户，等于没说。
 */
function friendlyInferenceError(error) {
  const raw = String(error?.message ?? error);
  const detail = String(error?.detail ?? '');
  const text = `${raw} ${detail}`;

  if (/exceeds the available context size/i.test(text)) {
    return '内容超出了模型的上下文长度。图片/关键帧太多时容易出现，请减少关键帧数量或图片数量后重试（也可在设置里调大上下文长度）。';
  }
  if (/failed to load model|error loading model/i.test(text)) {
    return '模型加载失败。文件可能不完整，请到模型中心重新下载。';
  }
  if (/out of memory|failed to allocate/i.test(text)) {
    return '内存不足，模型没能加载。请换更小的模型，或在设置里调小上下文长度。';
  }
  if (/model is not loaded|尚未加载/i.test(text)) {
    return '模型还没加载完成，请稍等几秒后重试。';
  }
  return raw;
}

export { basename, dirname };

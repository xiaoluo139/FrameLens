/**
 * 本地推理运行时门面：
 *   检查 -> 安装 llama-server -> 下载模型 -> 加载 -> 对话 / 看图
 * 全部失败路径都给出可读的中文原因，UI 直接展示。
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { MODEL_CATALOG, MIRRORS, getModel, inspectInstalled, modelDir, resolveModelFiles } from './catalog.js';
import { fetchToFile } from './downloader.js';
import { installRuntime, runtimeStatus } from './llama-runtime.js';
import { LlamaServer } from './server.js';
import { detectGpu, detectHardware, recommendModel } from './hardware.js';
import { bundledModelsDir } from '../paths.js';

const log = createLogger('inference');

export class InferenceRuntime {
  /**
   * @param {{userDataDir:string, modelsDir:string, settings:() => object}} options
   */
  constructor(options) {
    this.userDataDir = options.userDataDir;
    this.modelsDir = options.modelsDir;
    /** 查找顺序：用户目录优先（可自行下载），安装包随附模型兜底 */
    this.modelsDirs = [options.modelsDir, bundledModelsDir()].filter(Boolean);
    this.getSettings = options.settings ?? (() => ({}));
    this.server = null;
    this.loadingModelId = '';
    /** 正在进行的加载：并发请求应该等它，而不是再开一个进程把加载重启一遍 */
    this.startPromise = null;
    this.idleTimer = null;
    /** 正在进行的推理请求数：有请求在跑时绝不能被空闲回收杀掉 */
    this.activeRequests = 0;
    this.hardware = null;
  }

  async hardwareInfo() {
    if (!this.hardware) {
      this.hardware = detectHardware();
      this.hardware.gpu = await detectGpu();
      this.hardware.recommendedModelId = recommendModel(this.hardware, MODEL_CATALOG);
    }
    return this.hardware;
  }

  /**
   * 有效模型清单 = 内置目录 + 用户自己导入的模型。
   * 自定义模型存的是真实文件名，这里翻译成与内置目录一致的结构，
   * 后续「查找 / 判断是否已安装 / 加载」就能完全复用同一套逻辑。
   */
  modelsForLookup() {
    const custom = (this.getSettings()?.customModels ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.mmprojFile ? 'vision' : 'text',
      repo: '本地导入',
      modelPattern: new RegExp(`${escapeRegExp(item.modelFile)}$`, 'i'),
      mmprojPattern: item.mmprojFile ? new RegExp(`${escapeRegExp(item.mmprojFile)}$`, 'i') : undefined,
      approxBytes: item.bytes ?? 0,
      contextSize: item.contextSize ?? 8192,
      minRamGb: 6,
      badge: '自定义',
      description: item.description ?? '你导入到本机的模型',
      custom: true,
    }));
    return [...MODEL_CATALOG, ...custom];
  }

  findModel(id) {
    const list = this.modelsForLookup();
    return list.find((m) => m.id === id) ?? list[0];
  }

  /** 汇总当前可用状态，UI 启动时调用 */
  async status() {
    const hardware = await this.hardwareInfo();
    const runtime = runtimeStatus(this.userDataDir);
    const activeId = this.getSettings()?.model?.activeModelId ?? MODEL_CATALOG[0].id;
    /**
     * 实际生效的模型：配置的那个没装、但装了别的时，实际会用已装的那个
     * （ensureReady 里有同样的回退逻辑）。这里保持一致，否则界面会标错「当前使用」。
     */
    const catalog = this.modelsForLookup();
    const installedIds = catalog.filter((m) => inspectInstalled(this.modelsDirs, m).installed).map((m) => m.id);
    const effectiveId = installedIds.includes(activeId) ? activeId : (installedIds[0] ?? activeId);
    const models = catalog.map((model) => {
        const local = inspectInstalled(this.modelsDirs, model);
      return {
        id: model.id,
        name: model.name,
        kind: model.kind,
        badge: model.badge,
        description: model.description,
        approxBytes: model.approxBytes,
        minRamGb: model.minRamGb,
        contextSize: model.contextSize,
        repo: model.repo,
        installed: local.installed,
        installedBytes: local.bytes ?? 0,
        source: local.source ?? '',
        active: model.id === effectiveId,
        compatWarning: model.compatWarning ?? '',
      };
    });
    return {
      hardware,
      runtime: { installed: runtime.installed, serverPath: runtime.serverPath, version: process.versions.electron ?? 'node' },
      server: this.server ? this.server.status : { state: 'idle', port: 0, vision: false },
      activeModelId: activeId,
      effectiveModelId: effectiveId,
      models,
      mirrors: MIRRORS,
    };
  }

  /** 安装运行时（llama-server） */
  async installRuntime({ onProgress, signal, variant = 'cpu' } = {}) {
    return installRuntime(this.userDataDir, { variant, onProgress, signal });
  }

  /** 下载某个模型（含 mmproj） */
  async downloadModel(modelId, { onProgress = () => {}, signal, mirror } = {}) {
    const model = this.findModel(modelId);
    const settings = this.getSettings();
    const base = mirror ?? pickMirrorBase(settings);
    const dir = modelDir(this.modelsDir, model);

    onProgress({ stage: 'resolve', percent: 0, message: `查询 ${model.repo} 文件清单…` });
    const files = await resolveModelFiles(model, { base, signal });
    const planned = [{ file: files.model, label: '模型主体', weight: files.mmproj ? 0.78 : 1 }];
    if (files.mmproj) planned.push({ file: files.mmproj, label: '视觉编码器', weight: 0.22 });

    let doneWeight = 0;
    for (const item of planned) {
      const destPath = join(dir, item.file.name.split('/').pop());
      if (existsSync(destPath)) {
        doneWeight += item.weight;
        onProgress({ stage: 'download', percent: doneWeight * 100, message: `${item.label} 已存在，跳过` });
        continue;
      }
      await fetchToFile({
        url: item.file.url,
        destPath,
        signal,
        onProgress: (p) => {
          onProgress({
            stage: 'download',
            percent: (doneWeight + (p.percent / 100) * item.weight) * 100,
            received: p.received,
            total: p.total,
            speed: p.speed,
            message: `下载${item.label} ${p.percent.toFixed(1)}%`,
            currentFile: item.file.name.split('/').pop(),
          });
        },
      });
      doneWeight += item.weight;
    }

    const local = inspectInstalled(this.modelsDirs, model);
    onProgress({ stage: 'done', percent: 100, message: `${model.name} 已就绪` });
    return local;
  }

  /**
   * 确保「运行时 + 指定模型 + 服务」都可用。
   * @param {{modelId?:string, onProgress?:Function, signal?:AbortSignal, autoInstall?:boolean}} options
   */
  async ensureReady({ modelId, onProgress = () => {}, signal, autoInstall = true } = {}) {
    const settings = this.getSettings();
    let targetId = modelId ?? settings?.model?.activeModelId ?? MODEL_CATALOG[0].id;

    /**
     * 关键体验：用户配置的模型还没下载、但机器上已经装了别的模型时，
     * 直接用已装的那个，而不是默默开始下载几个 GB。
     * （否则「就想聊一句」会变成一次大体积下载，用户只会觉得软件卡死了。）
     */
    const installed = this.modelsForLookup().filter((m) => inspectInstalled(this.modelsDirs, m).installed);
    const configured = this.findModel(targetId);
    const configuredReady = installed.some((m) => m.id === configured.id);
    if (!configuredReady && installed.length > 0) {
      const fallback = installed[0];
      log.info(`当前模型 ${configured.name} 未安装，改用已安装的 ${fallback.name}`);
      targetId = fallback.id;
      onProgress({ stage: 'switch', percent: 100, message: `已切换到本机已安装的模型：${fallback.name}` });
    }

    const model = this.findModel(targetId);

    if (this.server?.state === 'ready' && this.loadingModelId === targetId) {
      onProgress({ stage: 'ready', percent: 100, message: '模型已加载' });
      return this.server;
    }
    // 同一个模型正在加载：等它，别重开——重开会让用户一直等不到就绪，
    // 表现就是「提示已就绪，一发消息却报模型还在加载」
    if (this.startPromise && this.loadingModelId === targetId) {
      onProgress({ stage: 'load', percent: 30, message: '模型正在加载中，请稍候…' });
      return this.startPromise;
    }

    const runtime = runtimeStatus(this.userDataDir);
    if (!runtime.installed) {
      if (!autoInstall) throw new Error('本地推理运行时尚未安装');
      onProgress({ stage: 'runtime', percent: 0, message: '首次使用，准备推理运行时…' });
      await this.installRuntime({ onProgress, signal, variant: recommendVariant(settings, await this.hardwareInfo()) });
    }

    const local = inspectInstalled(this.modelsDirs, model);
    if (!local.installed) {
      if (!autoInstall) throw new Error(`模型 ${model.name} 尚未下载`);
      await this.downloadModel(targetId, { onProgress, signal });
    }

    const after = inspectInstalled(this.modelsDirs, model);
    const serverPath = runtimeStatus(this.userDataDir).serverPath;
    const hardware = await this.hardwareInfo();

    if (this.server) await this.server.stop();
    /**
     * 上下文长度取「用户设置」与「模型推荐值」的较大者。
     * 取小了会必然失败：Qwen2.5-VL 建议 8192，而视频分析喂 8 帧就要 4000+ tokens，
     * 用 4096 会直接报 "exceeds the available context size"。
     */
    const contextSize = Math.max(
      Number(settings?.model?.contextsPerSequence ?? 0) || 0,
      Number(model.contextSize ?? 0) || 4096,
    );
    this.server = new LlamaServer({
      serverPath,
      modelPath: after.modelPath,
      mmprojPath: after.mmprojPath,
      contextSize,
      gpuLayers: useGpuLayers(settings) ? 999 : 0,
      threads: hardware.recommendedThreads,
      logger: log,
    });
    this.loadingModelId = targetId;
    this.startPromise = this.server.start({ onProgress, signal });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
    this.#scheduleIdleUnload();
    return this.server;
  }

  /** 对话（支持图片：传入 data URL 数组即走多模态） */
  async chat({ messages, images = [], temperature, topP, maxTokens, signal, onToken, modelId, onProgress }) {
    const server = await this.ensureReady({ modelId, onProgress, signal: undefined });
    const settings = this.getSettings();
    const prepared = images.length > 0 ? attachImages(messages, images) : messages;
    this.activeRequests += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      const result = await server.chat({
        messages: prepared,
        temperature: temperature ?? settings?.model?.temperature ?? 0.6,
        topP: topP ?? settings?.model?.topP ?? 0.9,
        maxTokens: maxTokens ?? 1024,
        signal,
        onToken: (delta, full) => {
          // 长任务（例如多帧视频分析）可能跑十几分钟，每个 token 都续期
          this.#scheduleIdleUnload();
          onToken(delta, full);
        },
      });
      return { ...result, model: modelId ?? this.loadingModelId, vision: Boolean(server.mmprojPath) };
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.#scheduleIdleUnload();
    }
  }

  /**
   * 模型自检。
   *
   * 为什么需要它：GGUF 与推理引擎版本不匹配时，模型能正常加载、进程也不报错，
   * 但输出是乱码（本项目实测 MiniCPM-V 2.6 就是这种情况）。用户只会觉得软件坏了。
   * 这里跑一次极短生成，判断回复是否像正常语言。
   */
  async verifyModel(modelId, { onProgress = () => {}, signal } = {}) {
    const targetId = modelId ?? this.getSettings()?.model?.activeModelId;
    const started = Date.now();
    try {
      await this.ensureReady({ modelId: targetId, onProgress, signal });
      const result = await this.chat({
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Answer briefly.' },
          { role: 'user', content: '请只回答两个字：你好' },
        ],
        maxTokens: 24,
        temperature: 0.1,
        onToken: () => {},
      });
      const reply = String(result.text ?? '').trim();
      const verdict = judgeReply(reply);
      return {
        ok: verdict.ok,
        modelId: targetId,
        reply: reply.slice(0, 120),
        reason: verdict.reason,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        modelId: targetId,
        reply: '',
        reason: `运行失败：${error?.message ?? error}`,
        elapsedMs: Date.now() - started,
      };
    }
  }

  async unload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.loadingModelId = '';
    }
  }

  /** 空闲 N 分钟后自动卸载，释放内存（笔记本用户体验关键） */
  #scheduleIdleUnload(minutes = 12) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // 还有请求在跑就再等一轮：绝不能把正在生成的推理进程杀掉
      if (this.activeRequests > 0) {
        this.#scheduleIdleUnload();
        return;
      }
      this.unload().catch(() => {});
    }, minutes * 60 * 1000);
  }
}

/** 把 data URL 图片插入到最后一条 user 消息 */
export function attachImages(messages, images) {
  const copy = messages.map((m) => ({ ...m }));
  const lastUserIndex = copy.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) return copy;
  const target = copy[lastUserIndex];
  const text = typeof target.content === 'string' ? target.content : '';
  target.content = [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  return copy;
}

function pickMirrorBase(settings) {
  const preferMirror = settings?.network?.preferMirror;
  return (preferMirror ? MIRRORS[1] : MIRRORS[0]).base;
}

/**
 * 加速档位：
 *   auto（默认）→ CPU 版，兼容性最好，装上就能跑
 *   cuda / vulkan → 手动指定，用户在有独显且驱动正常时切换
 * 之所以不自动选 GPU 版，是因为驱动版本不匹配时进程会直接起不来，
 * 对「小白一键可用」来说，先跑起来永远比跑得快更重要。
 */
function recommendVariant(settings, hardware) {
  const accel = settings?.model?.accel ?? 'auto';
  if (accel === 'cuda' || accel === 'vulkan' || accel === 'cpu') return accel;
  void hardware;
  return 'cpu';
}

/** 只有用户显式选择 GPU 加速时才让 llama.cpp 尝试 offload */
function useGpuLayers(settings) {
  const accel = settings?.model?.accel ?? 'auto';
  return accel === 'cuda' || accel === 'vulkan';
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断回复是否像正常语言。
 * 乱码的典型特征：大量 ASCII 符号，几乎不含文字（中文或字母）。
 */
export function judgeReply(reply) {
  const text = String(reply ?? '').trim();
  if (!text) return { ok: false, reason: '模型没有返回任何内容' };
  if (text.length < 2) return { ok: false, reason: '返回内容过短，无法判断' };

  const chars = [...text];
  const wordish = chars.filter((c) => /[\p{Script=Han}\p{L}\p{N}]/u.test(c)).length;
  const punctuation = chars.filter((c) => /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(c)).length;
  const wordRatio = wordish / chars.length;
  const punctRatio = punctuation / chars.length;

  if (wordRatio < 0.4) {
    return {
      ok: false,
      reason: `输出不像正常语言（文字占比仅 ${(wordRatio * 100).toFixed(0)}%，通常意味着该量化版本与当前推理引擎不兼容）`,
    };
  }
  if (punctRatio > 0.5) {
    return { ok: false, reason: `输出以符号为主（${(punctRatio * 100).toFixed(0)}%），疑似乱码` };
  }
  return { ok: true, reason: '正常' };
}

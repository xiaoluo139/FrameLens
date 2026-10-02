/**
 * 配置存储：单个 JSON 文件 + 默认值合并 + 原子写入 + 变更广播。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('store');

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  language: 'zh-CN',
  download: {
    outputDir: '',
    maxParallel: 3,
    downloadInterval: 3,
    concurrencyPerTask: 4,
    autoRetry: 2,
  },
  network: {
    proxy: '',
    timeoutMs: 20000,
    userAgent: 'desktop',
    preferMirror: true,
    /** 启动时预热一次站点（隐藏浏览器加载首页，缓存 JS 与连接），显著加快第一次解析 */
    warmUpSite: true,
  },
  model: {
    activeModelId: 'qwen2.5-vl-3b-q4_k_m',
    contextsPerSequence: 8192,
    /** 启动后在后台把模型加载好，用户点开对话就能用，不用再等 */
    preloadOnStart: true,
    maxFrames: 4,
    frameMaxEdge: 512,
    temperature: 0.6,
    topP: 0.9,
    gpuLayers: 'auto',
  },
  ui: {
    lastPage: 'home',
    sidebarCollapsed: false,
    reduceMotion: false,
  },
  chat: {
    systemPrompt:
      '你是「影析 FrameLens」的内置助手，运行在用户本地电脑上，完全离线。回答保持准确、简洁、可执行；不确定的地方直接说不确定，不要编造。',
    maxTokens: 1024,
    historyTurns: 12,
  },
  vision: {
    prompt: '请详细描述这张图片的内容。如果有文字，请完整提取出来。',
    videoPrompt: '这是一段视频按时间顺序抽取的关键帧，请概括视频讲了什么，并按时间顺序说明画面变化。',
    maxFrames: 8,
    frameMaxEdge: 896,
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深度合并：以 defaults 为骨架，用 patch 覆盖，未知字段保留 */
export function deepMerge(defaults, patch) {
  if (!isPlainObject(defaults) || !isPlainObject(patch)) {
    return patch === undefined ? defaults : patch;
  }
  const out = { ...defaults };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in defaults ? deepMerge(defaults[key], value) : value;
  }
  return out;
}

export class Store {
  constructor(filePath, defaults = DEFAULT_SETTINGS) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.listeners = new Set();
    this.data = this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.filePath)) return structuredClone(this.defaults);
      const raw = readFileSync(this.filePath, 'utf8');
      return deepMerge(this.defaults, JSON.parse(raw));
    } catch (error) {
      log.warn('配置文件损坏，已回退为默认值', error);
      return structuredClone(this.defaults);
    }
  }

  get all() {
    return this.data;
  }

  get(path, fallback) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), this.data) ?? fallback;
  }

  set(path, value) {
    const keys = path.split('.');
    let cursor = this.data;
    for (const key of keys.slice(0, -1)) {
      if (!isPlainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[keys.at(-1)] = value;
    this.save();
    return this.data;
  }

  patch(partial) {
    this.data = deepMerge(this.data, partial);
    this.save();
    return this.data;
  }

  reset() {
    this.data = structuredClone(this.defaults);
    this.save();
  }

  save() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
      for (const fn of this.listeners) {
        try {
          fn(this.data);
        } catch {
          /* 忽略监听器异常 */
        }
      }
    } catch (error) {
      log.error('配置保存失败', error);
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function createStore(userDataDir) {
  return new Store(join(userDataDir, 'framelens.config.json'));
}

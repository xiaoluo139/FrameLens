// 手机端本地模型：模型下载 / 启动推理服务 / 对话。
//
// 关键设计：推理在手机里以子进程方式跑 llama.cpp 的 llama-server，
// WebView 通过 http://127.0.0.1:<port> 与它通信——和桌面端完全同一套接口，
// 因此对话、图片理解、流式输出的代码逻辑两边一致。

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export const MODEL_CATALOG = [
  {
    id: 'smolvlm2-2.2b',
    name: 'SmolVLM2 2.2B（随包内置）',
    desc: '约 1.6 GB · 已随安装包内置，装完开箱即用，无需下载',
    repo: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
    model: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf',
    bytes: 1_626_000_000,
    contextSize: 8192,
  },
  {
    id: 'qwen2.5-vl-3b',
    name: 'Qwen2.5-VL 3B',
    desc: '约 2.6 GB · 中文能力更好，需联网下载（推荐已有网络时升级到此模型）',
    repo: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
    model: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
    bytes: 2_686_000_000,
    contextSize: 8192,
  },
  {
    id: 'smolvlm-256m',
    name: 'SmolVLM 256M',
    desc: '约 300 MB · 体积小、加载快，适合先体验流程',
    repo: 'ggml-org/SmolVLM-256M-Instruct-GGUF',
    model: 'SmolVLM-256M-Instruct-Q8_0.gguf',
    mmproj: 'mmproj-SmolVLM-256M-Instruct-Q8_0.gguf',
    bytes: 300_000_000,
    contextSize: 4096,
  },
];

const MIRROR = 'https://hf-mirror.com';
const PORT = 8791;
const IMPORTED_KEY = 'framelens_imported_models';

/** 已导入的模型清单（存在本机存储里，重启后仍在） */
export function importedModels() {
  try {
    return JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveImportedModels(list) {
  localStorage.setItem(IMPORTED_KEY, JSON.stringify(list));
}

/** 全部可用模型 = 随包/可下载的内置模型 + 用户导入的模型 */
export function allModels() {
  return [...MODEL_CATALOG, ...importedModels()];
}

export class Cha {
  constructor(log = () => {}) {
    this.log = log;
    this.plugin = null;
    this.modelId = '';
    this.port = 0;
    this.busy = false;
    this.startPromise = null;
    this.startingModelId = '';
  }

  /**
   * 等服务端 /health 通过。
   * llama-server 在模型加载期间会对请求返回 503，直接发就会看到
   * 「模型还在加载」这种让人抓狂的提示。
   */
  async waitHealthy(signal, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('已取消');
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal });
        if (res.ok) {
          await res.json().catch(() => ({}));
          return true;
        }
      } catch {
        // 还没起来，继续等
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('模型加载超时，请到「本地模型」里重新启用');
  }

  get pluginAvailable() {
    return Capacitor.getPlatform() === 'android';
  }

  getPlugin() {
    if (!this.plugin) this.plugin = registerPlugin('LlamaServer');
    return this.plugin;
  }

  /** 已下载模型的绝对路径 */
  async modelPaths(spec) {
    const dir = spec.dir ?? `models/${spec.id}`;
    try {
      const modelUri = await Filesystem.getUri({ directory: Directory.Data, path: `${dir}/${spec.model}` });
      const modelStat = await Filesystem.stat({ directory: Directory.Data, path: `${dir}/${spec.model}` });
      let mmprojPath = '';
      if (spec.mmproj) {
        const mmprojUri = await Filesystem.getUri({ directory: Directory.Data, path: `${dir}/${spec.mmproj}` });
        mmprojPath = mmprojUri.uri.replace('file://', '');
      }
      return { dir, modelPath: modelUri.uri.replace('file://', ''), mmprojPath, size: modelStat.size };
    } catch {
      return null;
    }
  }

  /**
   * 全内置版：安装包里已经带了模型，首次使用时展开到应用数据目录。
   * 普通版（包里没有模型）会返回 null，走在线下载流程。
   */
  async bundledPaths(spec, onProgress = () => {}) {
    if (!this.pluginAvailable) return null;
    const plugin = this.getPlugin();
    try {
      const info = await plugin.bundledModels();
      const bundled = (info?.manifest?.models ?? []).some((m) => m.id === spec.id);
      if (!bundled) return null;

      const listener = await plugin.addListener('prepareProgress', (event) => {
        onProgress({ percent: event.percent ?? 0, message: event.message ?? '' });
      });
      try {
        const result = await plugin.prepareBundled({ modelId: spec.id });
        return {
          dir: result.dir,
          modelPath: result.modelPath,
          mmprojPath: result.mmprojPath,
          size: 0,
          bundled: true,
        };
      } finally {
        listener.remove();
      }
    } catch (error) {
      console.warn('[cha] 展开随包模型失败', error);
      return null;
    }
  }

  /** 下载模型：走原生下载，不经过 JS 中转，几个 GB 也不会爆内存 */
  async download(spec, onProgress = () => {}) {
    const files = [
      { name: spec.model, label: '模型主体', weight: 0.8 },
      { name: spec.mmproj, label: '视觉编码器', weight: 0.2 },
    ];
    let doneWeight = 0;

    for (const file of files) {
      const path = `models/${spec.id}/${file.name}`;
      const listener = await Filesystem.addListener('progress', (event) => {
        if (!event.url.includes(file.name)) return;
        const percent = event.contentLength > 0 ? (event.bytes / event.contentLength) * 100 : 0;
        onProgress({
          percent: doneWeight * 100 + (percent * file.weight),
          message: `下载${file.label} ${percent.toFixed(1)}%（${(event.bytes / 1024 / 1024).toFixed(0)} MB）`,
        });
      });
      try {
        await Filesystem.downloadFile({
          url: `${MIRROR}/${spec.repo}/resolve/main/${file.name}?download=true`,
          path,
          directory: Directory.Data,
          progress: true,
        });
      } finally {
        listener.remove();
      }
      doneWeight += file.weight;
      onProgress({ percent: doneWeight * 100, message: `${file.label} 下载完成` });
    }
    return this.modelPaths(spec);
  }

  async deleteModel(spec) {
    try {
      await Filesystem.rmdir({ directory: Directory.Data, path: `models/${spec.id}`, recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 启动本地推理服务（同一时刻只会有一个模型在跑） */
  async ensureServer(spec, onProgress = () => {}) {
    if (this.port && this.modelId === spec.id) return this.port;
    if (!this.pluginAvailable) throw new Error('当前平台不支持本地推理，请在手机上使用');

    // 同一个模型正在加载：把这次的请求挂到那次加载上，别重复启动
    if (this.startPromise && this.startingModelId === spec.id) {
      onProgress({ message: '模型正在加载中，请稍候…' });
      await this.startPromise;
      return this.port;
    }

    this.startingModelId = spec.id;
    this.startPromise = (async () => {
      let paths = await this.modelPaths(spec);
      if (!paths) {
        // 全内置版：先尝试展开随包模型
        paths = await this.bundledPaths(spec, onProgress);
      }
      if (!paths) throw new Error('模型还没准备好（既没有随包自带，也没有下载完成）');

      onProgress({ message: '正在启动本地推理…（首次加载需要十几秒）' });
      const plugin = this.getPlugin();
      if (this.port) {
        await plugin.stop().catch(() => {});
        this.port = 0;
      }
      const result = await plugin.start({
        modelPath: paths.modelPath,
        mmprojPath: paths.mmprojPath,
        port: PORT,
        nCtx: spec.contextSize,
        threads: Math.max(2, (navigator.hardwareConcurrency || 4) - 1),
      });
      this.port = result.port ?? PORT;
      this.modelId = spec.id;
      onProgress({ message: '模型已就绪' });
      return this.port;
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stopServer() {
    if (!this.pluginAvailable) return;
    await this.getPlugin().stop().catch(() => {});
    this.port = 0;
    this.modelId = '';
  }

  async serverStatus() {
    if (!this.pluginAvailable) return { running: false, ready: false };
    try {
      return await this.getPlugin().status();
    } catch {
      return { running: false, ready: false };
    }
  }

  /** 流式对话：与桌面端相同的 OpenAI 兼容接口 */
  async chat({ messages, images = [], maxTokens = 512, onToken = () => {}, signal }) {
    /**
     * 模型还在加载时不要直接报错——等它加载完再发。
     * 之前这里直接抛「模型还在加载」，用户连点三次都是同样的错误。
     */
    if (!this.port) {
      if (this.startPromise) await this.startPromise;
      else throw new Error('本地推理还没启动，请先在「本地模型」里点启用');
    }
    await this.waitHealthy(signal);
    const payload = {
      messages: images.length
        ? messages.map((m, i) =>
            i === messages.length - 1 && m.role === 'user'
              ? { role: 'user', content: [{ type: 'text', text: m.content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
              : m,
          )
        : messages,
      stream: true,
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: maxTokens,
      cache_prompt: true,
    };

    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(friendly(res.status, detail));
    }
    // 非流式响应（原生 HTTP 偶发不支持流）也要能兜住
    if (!res.body) {
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      onToken(text, text);
      return text;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            full += delta;
            onToken(delta, full);
          }
        } catch {
          // 忽略无法解析的分片
        }
      }
    }
    return full;
  }
}

function friendly(status, detail) {
  const text = String(detail ?? '');
  if (/context size/i.test(text)) return '内容超出模型的上下文长度，少发几张图片或减少对话轮数再试。';
  if (/loading model|not loaded/i.test(text)) return '模型还在加载，请稍等几秒后重试。';
  return `推理失败（HTTP ${status}）`;
}

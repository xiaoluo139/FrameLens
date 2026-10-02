/**
 * llama-server 进程管理 + OpenAI 兼容推理客户端。
 *
 * 选择 llama-server 而不是进程内绑定，是因为它原生支持 --mmproj 多模态
 * （图片/视频帧理解），同时保留完整的多轮对话能力，一条链路覆盖两种能力。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('llama');

const HEALTH_PATH = '/health';
const CHAT_PATH = '/v1/chat/completions';

export class LlamaServerError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'LlamaServerError';
    Object.assign(this, extra);
  }
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export class LlamaServer {
  constructor(options) {
    this.serverPath = options.serverPath;
    this.modelPath = options.modelPath;
    this.mmprojPath = options.mmprojPath ?? '';
    this.contextSize = options.contextSize ?? 8192;
    this.gpuLayers = options.gpuLayers ?? 0;
    this.threads = options.threads ?? Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 8) - 1);
    this.extraArgs = options.extraArgs ?? [];
    this.logger = options.logger ?? log;

    this.process = null;
    this.port = 0;
    this.state = 'idle';
    this.logBuffer = [];
    this.lastUsedAt = 0;
    this.loadProgress = 0;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  get status() {
    return {
      state: this.state,
      port: this.port,
      contextSize: this.contextSize,
      model: this.modelPath,
      mmproj: this.mmprojPath,
      vision: Boolean(this.mmprojPath),
      logTail: this.logBuffer.slice(-40),
    };
  }

  buildArgs() {
    const args = [
      '-m',
      this.modelPath,
      '-c',
      String(this.contextSize),
      '-ngl',
      String(this.gpuLayers),
      '-t',
      String(this.threads),
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '--jinja',
    ];
    if (this.mmprojPath) args.push('--mmproj', this.mmprojPath);
    args.push(...this.extraArgs);
    return args;
  }

  /**
   * 启动服务并等待就绪。
   * @param {{onProgress?: Function, timeoutMs?: number, signal?: AbortSignal}} options
   */
  async start({ onProgress = () => {}, timeoutMs = 300_000, signal } = {}) {
    if (this.state === 'ready') return this;
    if (this.state === 'starting') throw new LlamaServerError('模型正在加载中');
    if (!existsSync(this.serverPath)) throw new LlamaServerError(`找不到推理运行时：${this.serverPath}`);
    if (!existsSync(this.modelPath)) throw new LlamaServerError(`找不到模型文件：${this.modelPath}`);

    this.port = await findFreePort();
    this.state = 'starting';
    this.loadProgress = 0;
    const args = this.buildArgs();
    this.logger.info('启动推理服务', { args: args.join(' ') });
    onProgress({ stage: 'spawn', percent: 2, message: '启动推理进程…' });

    this.process = spawn(this.serverPath, args, {
      cwd: this.serverPath.replace(/[\\/][^\\/]+$/, ''),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onLine = (chunk, streamName) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logBuffer.push(`[${streamName}] ${line}`);
        if (this.logBuffer.length > 400) this.logBuffer.shift();
        const percent = parseLoadPercent(line);
        if (percent !== null && percent > this.loadProgress) {
          this.loadProgress = percent;
          onProgress({ stage: 'load', percent: 5 + percent * 0.9, message: `加载模型 ${percent.toFixed(0)}%` });
        }
      }
    };
    this.process.stdout.on('data', (c) => onLine(c, 'out'));
    this.process.stderr.on('data', (c) => onLine(c, 'err'));

    const exited = new Promise((_, reject) => {
      this.process.once('exit', (code) => {
        if (this.state === 'ready') return;
        this.state = 'failed';
        reject(new LlamaServerError(`推理进程退出（code=${code}）`, { logTail: this.logBuffer.slice(-20) }));
      });
    });

    this.process.on('error', (error) => {
      this.state = 'failed';
      this.logger.error('推理进程启动失败', error);
    });

    await Promise.race([this.#waitReady(onProgress, signal), exited]);
    this.state = 'ready';
    this.lastUsedAt = Date.now();
    onProgress({ stage: 'ready', percent: 100, message: '模型就绪' });
    return this;
  }

  async #waitReady(onProgress, signal) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.stop();
        throw new LlamaServerError('已取消');
      }
      if (this.state === 'failed') throw new LlamaServerError('推理进程已退出');
      try {
        const res = await fetch(`${this.baseUrl}${HEALTH_PATH}`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          if (body?.status === 'ok' || body?.status === undefined) return;
        } else if (res.status === 503) {
          onProgress({ stage: 'load', percent: Math.max(this.loadProgress, 20), message: '模型仍在加载…' });
        }
      } catch {
        /* 进程还在启动，继续等 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new LlamaServerError('模型加载超时');
  }

  async stop() {
    if (!this.process) {
      this.state = 'idle';
      return;
    }
    const proc = this.process;
    this.process = null;
    this.state = 'idle';
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 4000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 多轮对话（流式）。messages 支持 OpenAI 结构，content 可为字符串或
   * [{type:'text'|'image_url', ...}] 数组（图片走 base64 data URL）。
   */
  async chat({ messages, temperature = 0.6, topP = 0.9, maxTokens = 1024, signal, onToken = () => {} }) {
    if (this.state !== 'ready') throw new LlamaServerError('模型尚未加载');
    this.lastUsedAt = Date.now();

    const payload = {
      messages,
      stream: true,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      cache_prompt: true,
    };

    const res = await fetch(`${this.baseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlamaServerError(`推理失败 HTTP ${res.status}`, { detail: detail.slice(0, 800) });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text ?? '';
        if (delta) {
          full += delta;
          onToken(delta, full);
        }
        if (json?.usage) usage = json.usage;
      }
    }

    this.lastUsedAt = Date.now();
    return { text: full, usage };
  }
}

/** 从 llama.cpp 的日志里解析加载百分比（形如 `load_tensors: ... 45%`） */
function parseLoadPercent(line) {
  const match = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

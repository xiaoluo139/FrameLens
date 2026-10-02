/**
 * 下载引擎：单文件流式下载（支持断点续传）+ HLS 分片合并 + 并发调度。
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { request } from '../http.js';
import { sanitizeFileName } from './url-tools.js';
import { renameWithRetry } from '../fsutil.js';

const log = createLogger('download');

export class DownloadError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.status = status;
    this.url = url;
  }
}

/**
 * 带重试的请求：CDN 抖动、连接被重置在真实网络里很常见，
 * 单次失败就把任务判死会让「偶尔就是下不动」变成常态。
 * 4xx 不重试（签名过期、无权限重试也没用），5xx 与网络错误重试。
 */
async function requestWithRetry(url, init, { attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(url, init);
      if (res.status >= 500 && i < attempts - 1) {
        lastError = new DownloadError(`服务端错误 ${res.status}`, { status: res.status, url });
        await new Promise((r) => setTimeout(r, 700 * (i + 1)));
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  const cause = lastError?.cause?.message ?? lastError?.cause?.code;
  throw new DownloadError(
    `网络请求失败（已重试 ${attempts} 次）：${lastError?.message ?? '未知错误'}${cause ? `｜底层原因：${cause}` : ''}`,
    { url },
  );
}

/**
 * 下载单个文件。
 * @param {object} task
 * @param {string} task.url
 * @param {string} task.destDir
 * @param {string} task.fileName
 * @param {object} [task.headers]
 * @param {AbortSignal} [task.signal]
 * @param {(p:{received:number,total:number,percent:number,speed:number}) => void} [task.onProgress]
 */
export async function downloadFile(task) {
  const { url, destDir, fileName, headers = {}, signal, onProgress = () => {}, resume = true } = task;
  mkdirSync(destDir, { recursive: true });
  const target = join(destDir, sanitizeFileName(fileName));
  const part = `${target}.fldownload`;

  let startAt = 0;
  if (resume && existsSync(part)) {
    startAt = statSync(part).size;
  }

  const requestHeaders = { ...headers };
  if (startAt > 0) requestHeaders.range = `bytes=${startAt}-`;

  const res = await requestWithRetry(url, { headers: requestHeaders, signal, timeoutMs: 60000 });
  if (res.status === 416) {
    // 已经下完
    if (existsSync(part)) rmSync(target, { force: true });
    return { path: target, size: startAt, resumed: true, done: true };
  }
  if (!res.ok) throw new DownloadError(`下载失败 HTTP ${res.status}`, { status: res.status, url });

  const resumed = startAt > 0 && res.status === 206;
  const contentLength = Number(res.headers.get('content-length') ?? 0);
  const total = contentLength > 0 ? contentLength + (resumed ? startAt : 0) : 0;

  let received = resumed ? startAt : 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      onProgress({
        received,
        total,
        percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
        speed: received / Math.max(1, (now - startedAt) / 1000),
      });
    }
  });

  if (!resumed && existsSync(part)) rmSync(part, { force: true });
  await streamPipeline(source, createWriteStream(part, { flags: resumed ? 'a' : 'w' }));

  if (total > 0 && received < total) {
    throw new DownloadError('连接中断，未下载完整（可重试续传）', { url });
  }

  // 校验完成后改名（Windows 上要重试，见 fsutil）
  await renameWithRetry(part, target);
  onProgress({ received, total: total || received, percent: 100, speed: 0 });
  return { path: target, size: received, resumed, done: true };
}

/**
 * 下载 HLS 流：拉取分片清单并按顺序合并为单个文件。
 */
export async function downloadHls(task) {
  const { url, destDir, fileName, headers = {}, signal, onProgress = () => {} } = task;
  mkdirSync(destDir, { recursive: true });
  const target = join(destDir, sanitizeFileName(fileName.replace(/\.(m3u8)$/i, '.ts')));

  const playlistText = await (await requestWithRetry(url, { headers, signal, timeoutMs: 30000 })).text();
  const segments = parseMediaPlaylist(playlistText, url);
  if (segments.length === 0) throw new DownloadError('HLS 清单里没有分片', { url });

  const tmpPath = `${target}.part`;
  const stream = createWriteStream(tmpPath, { flags: 'w' });
  let received = 0;

  try {
    for (const [index, segmentUrl] of segments.entries()) {
      if (signal?.aborted) throw new Error('已取消');
      const res = await requestWithRetry(segmentUrl, { headers, signal, timeoutMs: 60000 });
      if (!res.ok) throw new DownloadError(`分片下载失败 HTTP ${res.status}`, { status: res.status, url: segmentUrl });
      const buffer = Buffer.from(await res.arrayBuffer());
      received += buffer.length;
      if (!stream.write(buffer)) await new Promise((resolve) => stream.once('drain', resolve));
      onProgress({
        received,
        total: 0,
        percent: ((index + 1) / segments.length) * 100,
        speed: 0,
        segment: `${index + 1}/${segments.length}`,
      });
    }
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }

  await renameWithRetry(tmpPath, target);
  return { path: target, size: received, done: true, segments: segments.length, note: 'HLS 分片已合并为 .ts 文件' };
}

export function parseMediaPlaylist(text, baseUrl) {
  const list = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    try {
      list.push(new URL(line, baseUrl).toString());
    } catch {
      /* 忽略异常行 */
    }
  }
  return list;
}

/**
 * 并发下载调度器：限制并发数 + 任务间隔 + 进度广播 + 取消。
 */
export class DownloadScheduler {
  constructor({ maxParallel = 3, intervalMs = 3000, logger = log } = {}) {
    this.maxParallel = Math.max(1, maxParallel);
    this.intervalMs = Math.max(0, intervalMs);
    this.logger = logger;
    this.queue = [];
    this.active = new Map();
    this.completed = [];
    this.listeners = new Set();
    this.pumping = false;
    this.lastStartAt = 0;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* 忽略 UI 异常 */
      }
    }
  }

  enqueue(task) {
    const item = {
      id: task.id ?? `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      status: 'queued',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      ...task,
    };
    this.queue.push(item);
    this.#emit({ type: 'queued', task: this.snapshot(item) });
    void this.#pump();
    return item.id;
  }

  cancel(id) {
    const queued = this.queue.find((t) => t.id === id);
    if (queued) {
      queued.status = 'canceled';
      this.queue = this.queue.filter((t) => t.id !== id);
      this.#emit({ type: 'canceled', task: this.snapshot(queued) });
      return true;
    }
    const active = this.active.get(id);
    if (active) {
      active.controller?.abort(new Error('用户取消'));
      return true;
    }
    return false;
  }

  cancelAll() {
    [...this.queue].forEach((t) => this.cancel(t.id));
    [...this.active.keys()].forEach((id) => this.cancel(id));
  }

  snapshot(task) {
    return {
      id: task.id,
      status: task.status,
      title: task.title ?? task.fileName,
      platform: task.platform ?? '',
      progress: task.progress,
      received: task.received,
      total: task.total,
      speed: task.speed,
      error: task.error ?? null,
      path: task.path ?? '',
      kind: task.kind ?? 'file',
    };
  }

  list() {
    return [...this.active.values(), ...this.queue, ...this.completed.slice(-50)].map((t) => this.snapshot(t));
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.maxParallel && this.queue.length > 0) {
        const wait = this.intervalMs - (Date.now() - this.lastStartAt);
        if (wait > 0 && this.lastStartAt > 0) await new Promise((r) => setTimeout(r, wait));
        const task = this.queue.shift();
        if (!task) break;
        this.lastStartAt = Date.now();
        task.status = 'running';
        const controller = new AbortController();
        task.controller = controller;
        this.active.set(task.id, task);
        this.#emit({ type: 'start', task: this.snapshot(task) });
        void this.#run(task, controller);
      }
    } finally {
      this.pumping = false;
    }
  }

  async #run(task, controller) {
    try {
      const runner = task.kind === 'hls' ? downloadHls : downloadFile;
      const result = await runner({
        ...task,
        signal: controller.signal,
        onProgress: (p) => {
          task.progress = p.percent;
          task.received = p.received;
          task.total = p.total;
          task.speed = p.speed;
          this.#emit({ type: 'progress', task: this.snapshot(task) });
        },
      });
      task.status = 'completed';
      task.progress = 100;
      task.path = result.path;
      task.size = result.size;
      task.note = result.note ?? '';
      this.#emit({ type: 'completed', task: this.snapshot(task) });
    } catch (error) {
      const canceled = controller.signal.aborted;
      task.status = canceled ? 'canceled' : 'failed';
      task.error = canceled ? '已取消' : (error?.message ?? String(error));
      this.logger.warn(`下载任务 ${task.status}：${task.title}`, error);
      this.#emit({ type: canceled ? 'canceled' : 'failed', task: this.snapshot(task) });
    } finally {
      this.active.delete(task.id);
      this.completed.push(task);
      if (this.completed.length > 200) this.completed.shift();
      void this.#pump();
    }
  }
}

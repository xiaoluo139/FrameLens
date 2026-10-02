/**
 * 模型 / 运行时下载器：断点续传 + 镜像回退 + 进度回调。
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { request } from '../http.js';
import { createLogger } from '../logger.js';
import { renameWithRetry } from '../fsutil.js';

const log = createLogger('fetch');

/**
 * 下载到指定路径，支持续传。
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.destPath
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {received:number,total:number,percent:number,speed:number}) => void} [options.onProgress]
 * @param {number} [options.expectedSize]
 */
export async function fetchToFile({ url, destPath, signal, onProgress = () => {}, expectedSize = 0, headers = {} }) {
  mkdirSync(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;

  if (existsSync(destPath) && expectedSize > 0 && statSync(destPath).size === expectedSize) {
    onProgress({ received: expectedSize, total: expectedSize, percent: 100, speed: 0, cached: true });
    return { path: destPath, size: expectedSize, cached: true };
  }

  let startAt = existsSync(partPath) ? statSync(partPath).size : 0;
  let received = startAt;
  const startedAt = Date.now();
  let lastEmit = 0;
  /** 上次收到数据的时间：用来识别「连接还在但不传数据」的僵死状态 */
  let lastDataAt = Date.now();
  const STALL_MS = 30000;

  for (let attempt = 0; attempt < 5; attempt++) {
    const requestHeaders = { ...headers };
    if (received > 0) requestHeaders.range = `bytes=${received}-`;

    const res = await request(url, { headers: requestHeaders, signal, timeoutMs: 60000 });
    if (res.status === 416) break;
    if (!res.ok && res.status !== 206) {
      throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    }

    const resumed = received > 0 && res.status === 206;
    if (!resumed && received > 0) {
      received = 0;
      rmSync(partPath, { force: true });
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    const total = length > 0 ? length + received : expectedSize;
    const mode = resumed ? 'a' : 'w';

    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      lastDataAt = Date.now();
      const now = Date.now();
      if (now - lastEmit > 150) {
        lastEmit = now;
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(99.9, (received / total) * 100) : 0,
          speed: received / Math.max(1, (now - startedAt) / 1000),
        });
      }
    });

    // 停滞看门狗：30 秒没有任何数据就视为僵死，中断后由外层重试
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > STALL_MS) {
        log.warn(`下载停滞超过 ${STALL_MS / 1000}s，中断重试：${url.slice(0, 80)}`);
        source.destroy(new Error('下载停滞'));
      }
    }, 5000);

    try {
      await streamPipeline(source, createWriteStream(partPath, { flags: mode }));
    } catch (error) {
      log.warn(`第 ${attempt + 1} 次下载中断，准备续传`, error);
      clearInterval(watchdog);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    } finally {
      clearInterval(watchdog);
    }

    if (total > 0 && received < total) {
      log.warn(`下载未完成 ${received}/${total}，继续续传`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    break;
  }

  await renameWithRetry(partPath, destPath);
  const size = statSync(destPath).size;
  if (expectedSize > 0 && size < expectedSize * 0.99) {
    throw new Error(`下载文件不完整：期望 ${expectedSize} 字节，实际 ${size} 字节`);
  }
  onProgress({ received: size, total: size, percent: 100, speed: 0 });
  return { path: destPath, size, cached: false };
}

/** 先探测远端大小（用于展示与校验） */
export async function probeSize(url, { signal } = {}) {
  try {
    const res = await request(url, { method: 'HEAD', redirect: 'follow', signal });
    const length = Number(res.headers.get('content-length') ?? 0);
    return Number.isFinite(length) ? length : 0;
  } catch {
    return 0;
  }
}

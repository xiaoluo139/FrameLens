/**
 * 文件系统小工具。
 * Windows 上刚写完的文件常被杀软/索引服务短暂占用，直接 rename 会 EBUSY，
 * 所以这里统一做「带退避的重试」。
 */

import { renameSync, rmSync } from 'node:fs';

export async function renameWithRetry(from, to, { attempts = 12, delayMs = 150 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(to, { force: true });
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

export async function rmWithRetry(target, { attempts = 6, delayMs = 120 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { force: true, recursive: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

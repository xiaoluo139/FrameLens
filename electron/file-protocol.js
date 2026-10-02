/**
 * `flfile://` 本地文件协议。
 *
 * 渲染进程在 file:// 上下文里直接读磁盘会受同源策略限制，画布也会被污染；
 * 这里注册一个受控协议，由主进程按需读取本地文件并返回正确的 MIME 与
 * Range 支持（视频拖动进度条、抽帧都依赖它）。
 */

import { createReadStream, statSync } from 'node:fs';
import { extname, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';

export const FILE_SCHEME = 'flfile';

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** 必须在 app ready 之前调用 */
export function registerFileScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
}

/** app ready 之后调用，挂上实际处理器 */
export function handleFileProtocol() {
  protocol.handle(FILE_SCHEME, async (request) => {
    let filePath = '';
    try {
      const url = new URL(request.url);
      filePath = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (process.platform === 'win32') filePath = normalize(filePath);
      if (!filePath || filePath.includes('\0')) throw new Error('非法路径');
    } catch {
      return new Response('bad request', { status: 400 });
    }

    let stat;
    try {
      stat = statSync(filePath);
      if (!stat.isFile()) throw new Error('不是文件');
    } catch (error) {
      return new Response(`file not found: ${error.message}`, { status: 404 });
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    };

    const range = request.headers.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : stat.size - 1;
        if (Number.isFinite(start) && start < stat.size) {
          const safeEnd = Math.min(Number.isFinite(end) ? end : stat.size - 1, stat.size - 1);
          const stream = createReadStream(filePath, { start, end: safeEnd });
          return new Response(Readable.toWeb(stream), {
            status: 206,
            headers: {
              ...headers,
              'content-range': `bytes ${start}-${safeEnd}/${stat.size}`,
              'content-length': String(safeEnd - start + 1),
            },
          });
        }
      }
    }

    const stream = createReadStream(filePath);
    return new Response(Readable.toWeb(stream), {
      status: 200,
      headers: { ...headers, 'content-length': String(stat.size) },
    });
  });
}

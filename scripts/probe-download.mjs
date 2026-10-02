// 验证一条直链是否真的能下载：检查 HTTP 状态、内容类型与文件头。
//   node scripts/probe-download.mjs "<url>" [referer]

import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from '../core/http.js';

const url = process.argv[2];
const referer = process.argv[3] ?? '';
if (!url) {
  console.error('用法: node scripts/probe-download.mjs "<url>" [referer]');
  process.exit(2);
}

const headers = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
if (referer) headers.referer = referer;

mkdirSync('D:/jx/.dl-probe', { recursive: true });
const res = await request(url, { headers, timeoutMs: 60000 });
console.log('HTTP', res.status, '| 类型', res.headers.get('content-type'), '| 声明长度', res.headers.get('content-length'));
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('D:/jx/.dl-probe/sample.bin', buf);
console.log('实际下载', (buf.length / 1024 / 1024).toFixed(2), 'MB');
console.log('文件头:', [...buf.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '), '|', buf.subarray(4, 12).toString('ascii'));
const isIso = buf.subarray(4, 8).toString('ascii') === 'ftyp';
console.log(isIso ? '✅ 是合法的 MP4 文件' : '⚠️ 不是标准 MP4（可能是分片或其它格式）');

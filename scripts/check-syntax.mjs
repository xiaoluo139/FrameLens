/**
 * 全量语法检查：node scripts/check-syntax.mjs
 * 逐个文件跑 `node --check`，任何一处语法错误都会以非零码退出。
 */

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.npm-cache', '.cache', 'release', 'dist', '.verify-home', '.smoke-home', '.smoke-packaged', 'shots', '.git']);
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

const check = (file) =>
  new Promise((resolvePromise) => {
    execFile(process.execPath, ['--check', file], (error, _stdout, stderr) => {
      resolvePromise(error ? { file, message: String(stderr || error.message).split('\n').slice(0, 4).join('\n') } : null);
    });
  });

const files = walk(ROOT);
const failures = (await Promise.all(files.map(check))).filter(Boolean);

for (const failure of failures) {
  console.error(`✖ ${failure.file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '')}`);
  console.error(`  ${failure.message.replace(/\n/g, '\n  ')}`);
}

console.log(`检查 ${files.length} 个文件，失败 ${failures.length} 个`);
process.exit(failures.length === 0 ? 0 : 1);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { readZipEntries, extractZip } from '../core/zip.js';

/** 手写一个最小 ZIP（store 或 deflate），用来验证解包器 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const data = entry.deflate ? deflateRawSync(content) : content;
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

test('readZipEntries 能读出条目表', () => {
  const zip = buildZip([
    { name: 'llama-server.exe', content: 'MZ fake exe' },
    { name: 'ggml-base.dll', content: 'dll content', deflate: true },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'llama-server.exe');
  assert.equal(entries[1].method, 8);
});

test('extractZip 正确解出 store 与 deflate 两种条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framelens-zip-'));
  try {
    const zip = buildZip([
      { name: 'bin/a.txt', content: 'hello 影析' },
      { name: 'bin/nested/b.txt', content: 'compressed content '.repeat(20), deflate: true },
    ]);
    const written = extractZip(zip, dir);
    assert.deepEqual(written.sort(), ['bin/a.txt', 'bin/nested/b.txt']);
    assert.equal(readFileSync(join(dir, 'bin', 'a.txt'), 'utf8'), 'hello 影析');
    assert.equal(readFileSync(join(dir, 'bin', 'nested', 'b.txt'), 'utf8').startsWith('compressed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractZip 拒绝路径穿越条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framelens-zip-evil-'));
  try {
    const zip = buildZip([{ name: '../../evil.txt', content: 'pwned' }]);
    assert.throws(() => extractZip(zip, dir), /路径越界/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractZip 支持 filter 跳过部分条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framelens-zip-filter-'));
  try {
    const zip = buildZip([
      { name: 'a.exe', content: 'x' },
      { name: 'a.pdb', content: 'debug symbols' },
    ]);
    extractZip(zip, dir, { filter: (entry) => !entry.name.endsWith('.pdb') });
    assert.equal(readFileSync(join(dir, 'a.exe'), 'utf8'), 'x');
    assert.throws(() => readFileSync(join(dir, 'a.pdb')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

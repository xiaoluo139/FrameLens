/**
 * 极简 ZIP 解包器（纯 Node，无第三方依赖）。
 * 支持 store(0) 与 deflate(8) 两种压缩方式，足够解压 llama.cpp 的发行包。
 */

import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 读取 ZIP 条目表（来自中央目录）。
 * @param {Buffer} buffer
 */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('不是合法的 ZIP 文件（缺少中央目录）');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      method,
      compressedSize,
      size,
      offset: localOffset,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 解出单个条目的内容 */
export function readZipEntry(buffer, entry) {
  const local = entry.offset;
  if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new Error(`条目头损坏：${entry.name}`);
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
}

/**
 * 解压到目标目录（带路径穿越防护）。
 * @param {Buffer} buffer
 * @param {string} targetDir
 * @param {{filter?: (entry: object) => boolean}} options
 * @returns {string[]} 已写出的文件名
 */
export function extractZip(buffer, targetDir, { filter = () => true } = {}) {
  const entries = readZipEntries(buffer);
  const root = resolve(targetDir);
  const written = [];

  for (const entry of entries) {
    if (!filter(entry)) continue;
    const destination = resolve(join(root, normalize(entry.name)));
    if (destination !== root && !destination.startsWith(root + sep)) {
      throw new Error(`ZIP 条目路径越界：${entry.name}`);
    }
    if (entry.isDirectory) {
      mkdirSync(destination, { recursive: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.compressedSize === 0 ? Buffer.alloc(0) : readZipEntry(buffer, entry));
    written.push(entry.name);
  }
  return written;
}

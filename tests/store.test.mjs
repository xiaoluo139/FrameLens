import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, deepMerge, DEFAULT_SETTINGS } from '../core/store.js';

test('deepMerge 保留默认值并覆盖指定字段', () => {
  const merged = deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 9 } });
  assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 9 } });
});

test('Store 读写 / patch / 落盘后重新加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framelens-store-'));
  const file = join(dir, 'config.json');
  try {
    const store = new Store(file);
    assert.equal(store.get('download.maxParallel'), DEFAULT_SETTINGS.download.maxParallel);

    store.set('download.maxParallel', 7);
    store.patch({ network: { preferMirror: false } });

    const reloaded = new Store(file);
    assert.equal(reloaded.get('download.maxParallel'), 7);
    assert.equal(reloaded.get('network.preferMirror'), false);
    assert.equal(reloaded.get('download.downloadInterval'), 3, '未修改的默认值应保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件损坏时回退到默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framelens-bad-'));
  const file = join(dir, 'config.json');
  try {
    writeFileSync(file, '{ this is not json');
    const store = new Store(file);
    assert.equal(store.get('theme'), DEFAULT_SETTINGS.theme);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

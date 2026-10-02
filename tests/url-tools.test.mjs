import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractUrls,
  mediaKind,
  normalizeUrl,
  qualityScore,
  sanitizeFileName,
  formatBytes,
  formatDuration,
  dedupeVariants,
} from '../core/extract/url-tools.js';

test('extractUrls 能从抖音分享文本里取出链接', () => {
  const text = '7.68 复制打开抖音，看看【某某】的作品 https://v.douyin.com/iRNBho6d/ 复制此链接';
  assert.deepEqual(extractUrls(text), ['https://v.douyin.com/iRNBho6d/']);
});

test('extractUrls 去掉中文标点尾巴且自动去重', () => {
  const urls = extractUrls('看这个 https://www.bilibili.com/video/BV1xx411c7mD?p=1。还有 https://www.bilibili.com/video/BV1xx411c7mD?p=1');
  assert.equal(urls.length, 1);
  assert.equal(urls[0], 'https://www.bilibili.com/video/BV1xx411c7mD?p=1');
});

test('extractUrls 支持多个链接换行分隔', () => {
  const urls = extractUrls('https://a.com/1\nhttps://b.com/2');
  assert.deepEqual(urls, ['https://a.com/1', 'https://b.com/2']);
});

test('mediaKind 能识别直链类型', () => {
  assert.equal(mediaKind('https://x.com/a.mp4'), 'video');
  assert.equal(mediaKind('https://x.com/a.m3u8?token=1'), 'video');
  assert.equal(mediaKind('https://x.com/a.jpg'), 'image');
  assert.equal(mediaKind('https://x.com/page'), 'page');
});

test('normalizeUrl 去掉 hash', () => {
  assert.equal(normalizeUrl('https://x.com/a?b=1#frag'), 'https://x.com/a?b=1');
});

test('qualityScore 识别常见清晰度写法', () => {
  assert.equal(qualityScore('1080P 全高清'), 1080);
  assert.equal(qualityScore('4K 超清'), 4000);
  assert.equal(qualityScore('720p60'), 720);
  assert.equal(qualityScore('自适应'), 0);
});

test('sanitizeFileName 过滤非法字符', () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFileName('   '), 'untitled');
  assert.ok(sanitizeFileName('x'.repeat(400)).length <= 120);
});

test('formatBytes / formatDuration 输出可读文本', () => {
  assert.equal(formatBytes(0), '未知');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(75), '1:15');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(0), '');
});

test('dedupeVariants 去除同地址同清晰度的重复项', () => {
  const list = dedupeVariants([
    { url: 'https://a/1.mp4', quality: 1080 },
    { url: 'https://a/1.mp4', quality: 1080 },
    { url: 'https://a/2.mp4', quality: 720 },
    { url: '', quality: 480 },
  ]);
  assert.equal(list.length, 2);
});

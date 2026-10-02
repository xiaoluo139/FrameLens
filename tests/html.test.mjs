import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHtmlMeta, decodeEntities, sliceBalancedObject, collectJsonLd } from '../core/extract/html.js';

const PAGE = `<!doctype html>
<html><head>
  <title>页面标题</title>
  <meta property="og:title" content="OG 标题 &amp; 更多">
  <meta property="og:image" content="/cover.jpg">
  <meta property="og:video" content="https://cdn.example.com/video.mp4">
  <meta name="description" content="描述文本">
  <link rel="image_src" href="https://cdn.example.com/link.jpg">
  <script type="application/ld+json">
  {"@type":"VideoObject","name":"LD 名称","description":"LD 描述","thumbnailUrl":"https://cdn.example.com/ld.jpg",
   "duration":"PT1H2M3S","contentUrl":"https://cdn.example.com/ld.mp4","author":{"name":"作者甲"}}
  </script>
</head><body>
  <video src="/inline.mp4" poster="/poster.jpg"><source src="https://cdn.example.com/hd.mp4" type="video/mp4"></video>
</body></html>`;

test('decodeEntities 处理常见实体与数字实体', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
});

test('extractHtmlMeta 抽取 OG / JSON-LD / video 标签', () => {
  const meta = extractHtmlMeta(PAGE, 'https://site.example.com/post/1');
  assert.equal(meta.title, 'OG 标题 & 更多');
  assert.equal(meta.description, '描述文本');
  assert.equal(meta.cover, 'https://site.example.com/cover.jpg');
  assert.equal(meta.author, '作者甲');
  assert.equal(meta.durationSec, 3723);
  assert.ok(meta.videoUrls.includes('https://cdn.example.com/video.mp4'));
  assert.ok(meta.videoUrls.includes('https://site.example.com/inline.mp4'));
  assert.ok(meta.videoUrls.includes('https://cdn.example.com/hd.mp4'));
  assert.ok(meta.videoUrls.includes('https://cdn.example.com/ld.mp4'));
});

test('collectJsonLd 跳过非法 JSON 而不抛错', () => {
  const blocks = collectJsonLd('<script type="application/ld+json">{bad}</script><script type="application/ld+json">{"a":1}</script>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].a, 1);
});

test('sliceBalancedObject 能处理字符串里的花括号', () => {
  const text = 'window.X = {"a":"}{","b":{"c":1}};';
  const sliced = sliceBalancedObject(text);
  assert.deepEqual(JSON.parse(sliced), { a: '}{', b: { c: 1 } });
});

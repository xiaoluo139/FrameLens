/**
 * 端到端解析测试：本地起一个 HTTP 服务模拟「带 og:video 的网页 + HLS 多码率」，
 * 完整跑一遍 输入文本 -> 平台识别 -> 抓取 -> 归一化 的链路，全程不依赖外网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { analyze, analyzeOne, detectPlatform } from '../core/extract/index.js';
import { isDirectMedia, qualityScore } from '../core/extract/url-tools.js';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
720/index.m3u8
`;

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="测试视频标题">
<meta property="og:image" content="/cover.png">
<meta property="og:description" content="这是描述">
<meta property="og:video" content="/hls/master.m3u8">
</head><body><h1>hi</h1></body></html>`;

function startServer() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.url === '/hls/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(MASTER);
      return;
    }
    if (req.url === '/video.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '10' });
      res.end('0123456789');
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('解析带 og:video 的网页并把 HLS 展开成多清晰度', async () => {
  const { server, port } = await startServer();
  try {
    const asset = await analyzeOne(`http://127.0.0.1:${port}/page`);
    assert.equal(asset.title, '测试视频标题');
    assert.equal(asset.description, '这是描述');
    assert.equal(asset.cover, `http://127.0.0.1:${port}/cover.png`);
    assert.equal(asset.variants.length, 2, 'HLS master 应展开成 2 个清晰度');
    assert.equal(asset.variants[0].quality, 1080);
    assert.equal(asset.variants[0].url, `http://127.0.0.1:${port}/hls/1080/index.m3u8`);
    assert.equal(asset.variants[1].quality, 720);
  } finally {
    server.close();
  }
});

test('直链 mp4 直接产出原始文件清晰度', async () => {
  const { server, port } = await startServer();
  try {
    const asset = await analyzeOne(`http://127.0.0.1:${port}/video.mp4`);
    assert.equal(asset.mediaType, 'video');
    assert.equal(asset.variants.length, 1);
    assert.equal(asset.variants[0].label, '原始文件');
  } finally {
    server.close();
  }
});

test('analyze 一次处理多行输入：正常链接出结果，坏链接进失败列表', async () => {
  const { server, port } = await startServer();
  try {
    const result = await analyze(`看这个 http://127.0.0.1:${port}/page\n还有这个 http://127.0.0.1:${port}/missing-page`);
    assert.equal(result.total, 2);
    assert.equal(result.assets.length, 1, '能解析的链接应产出结果');
    assert.equal(result.failures.length, 1, '404 页面应作为失败项上报，而不是伪装成空结果');
    assert.match(result.failures[0].message, /404/);
    assert.equal(result.ok, true);
  } finally {
    server.close();
  }
});

test('analyze 在没有链接时抛出可读错误', async () => {
  await assert.rejects(() => analyze('这段文字里没有链接'), /没有识别到链接/);
});

test('平台识别覆盖主流站点', () => {
  assert.equal(detectPlatform('https://v.douyin.com/abc/').id, 'douyin');
  assert.equal(detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD').id, 'bilibili');
  assert.equal(detectPlatform('https://youtu.be/abcdefghijk').id, 'youtube');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/abc').id, 'xiaohongshu');
  assert.equal(detectPlatform('https://example.com/video').id, 'generic');
});

test('isDirectMedia / qualityScore 组合使用符合下载器预期', () => {
  assert.equal(isDirectMedia('https://x/a.m3u8'), true);
  assert.equal(isDirectMedia('https://x/page'), false);
  assert.equal(qualityScore('1080P 全高清'), 1080);
});

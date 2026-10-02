import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMasterPlaylist, parseAttributes, isMasterPlaylist, isPlaylist, labelFor, sortVariants } from '../core/extract/hls.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
https://cdn.example.com/480p/index.m3u8
`;

test('isMasterPlaylist / isPlaylist 判断正确', () => {
  assert.equal(isMasterPlaylist(MASTER), true);
  assert.equal(isPlaylist(MASTER), true);
  assert.equal(isPlaylist('#EXTINF:9.0,\nseg1.ts'), true);
  assert.equal(isPlaylist('random text'), false);
});

test('parseMasterPlaylist 解析多码率并解析相对地址', () => {
  const variants = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(variants.length, 3);
  assert.equal(variants[0].quality, 1080);
  assert.equal(variants[0].url, 'https://cdn.example.com/hls/1080p/index.m3u8');
  assert.equal(variants[1].url, 'https://cdn.example.com/hls/720p/index.m3u8');
  assert.equal(variants[2].url, 'https://cdn.example.com/480p/index.m3u8');
  assert.equal(variants[0].label, '1080P 全高清');
});

test('sortVariants 按清晰度降序', () => {
  const sorted = sortVariants([{ quality: 480 }, { quality: 2160 }, { quality: 720 }]);
  assert.deepEqual(sorted.map((v) => v.quality), [2160, 720, 480]);
});

test('parseAttributes 支持引号值', () => {
  const attrs = parseAttributes('BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"');
  assert.equal(attrs.BANDWIDTH, '5000000');
  assert.equal(attrs.RESOLUTION, '1920x1080');
  assert.equal(attrs.CODECS, 'avc1.640028,mp4a.40.2');
});

test('labelFor 给出中文清晰度标签', () => {
  assert.equal(labelFor(2160), '4K 超清');
  assert.equal(labelFor(1080), '1080P 全高清');
  assert.equal(labelFor(0, '640x360'), '360P 自适应');
});

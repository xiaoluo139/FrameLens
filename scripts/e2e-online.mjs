/**
 * 真实网络端到端解析测试：直接打真实平台，检查解析结果是否符合预期。
 *   node scripts/e2e-online.mjs
 */

import { analyze, analyzeOne } from '../core/extract/index.js';
import { extractUrls } from '../core/extract/url-tools.js';

const CASES = [
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/video/BV1GJ411x7h7', expect: 'api' },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expect: 'any' },
  { name: '抖音短链（真实分享文本）', url: '7.74 复制打开抖音 https://v.douyin.com/m5oMyApDvU4/', expect: 'any' },
  { name: '通用网页', url: 'https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.999', expect: 'any' },
];

let pass = 0;
let fail = 0;

for (const item of CASES) {
  const started = Date.now();
  try {
    // 分享文本要先抽链接，再交给 analyzeOne；直接喂文本会被当成 URL 处理
    const urls = extractUrls(item.url);
    if (urls.length === 0) throw new Error('没有从输入里识别到链接');
    const asset = await analyzeOne(urls[0]);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const ok = asset.variants.length > 0 || asset.images.length > 0;
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${item.name}  (${elapsed}s)`);
    console.log(`  平台   : ${asset.platformName}`);
    console.log(`  标题   : ${asset.title}`);
    console.log(`  作者   : ${asset.author || '(空)'}`);
    console.log(`  封面   : ${asset.cover ? '有' : '无'}`);
    console.log(`  时长   : ${asset.durationSec || 0}s    清晰度: ${asset.variants.length}  图片: ${asset.images.length}`);
    for (const v of asset.variants.slice(0, 4)) {
      console.log(`    - ${v.label.padEnd(16)} ${v.url.slice(0, 96)}`);
    }
    if (asset.warnings.length) console.log(`  警告   : ${asset.warnings.join(' / ')}`);
    ok ? pass++ : fail++;
  } catch (error) {
    console.log(`\n[FAIL] ${item.name}`);
    console.log(`  错误   : ${error.message}`);
    fail++;
  }
}

console.log(`\n结果：成功 ${pass}，失败 ${fail}`);
process.exit(0);

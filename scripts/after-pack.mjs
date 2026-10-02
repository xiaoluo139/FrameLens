/**
 * electron-builder 的 afterPack 钩子。
 *
 * rcedit 写 exe 图标/版本信息时，会先复制一份到 RCX*.tmp 再覆盖回去。
 * 刚写完的 180MB exe 常常被杀软或索引服务短暂锁定，改名失败就会把
 * 这份临时副本留在打包目录里，随后被 NSIS 一起打进安装包——
 * 实测安装包会从 78 MB 直接涨到 138 MB 甚至 259 MB。
 *
 * 这个钩子在「打包目录就绪、安装包尚未生成」的时间点清理这些残留。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(context) {
  const appOutDir = context?.appOutDir;
  if (!appOutDir || !existsSync(appOutDir)) return;

  for (let attempt = 0; attempt < 6; attempt++) {
    const leftovers = readdirSync(appOutDir).filter((name) => /^RCX.*\.tmp$/i.test(name));
    if (leftovers.length === 0) return;

    let blocked = 0;
    for (const name of leftovers) {
      const full = join(appOutDir, name);
      try {
        // 被锁的文件大小不变，重试即可；锁释放后立刻能删掉
        statSync(full);
        rmSync(full, { force: true });
        console.log(`  • 已清理打包目录中的临时副本 ${name}`);
      } catch {
        blocked++;
      }
    }
    if (leftovers.length - blocked === 0 && blocked > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    if (blocked === 0) return;
  }
}

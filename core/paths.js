/**
 * 路径解析。
 *
 * 应用同时支持两种发行形态：
 *   1) 精简版：运行时与模型在首次使用时下载到用户数据目录
 *   2) 全内置版：安装包里已经带好运行时与模型，放在 resources/bundled 下
 * 两种形态共用同一套查找逻辑：用户目录优先，安装目录兜底。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 安装包内随附资源的根目录（开发环境下为空） */
export function bundledRoot() {
  const resources = process.resourcesPath;
  if (!resources) return '';
  const candidates = [join(resources, 'bundled'), resources];
  return (
    candidates.find((dir) => existsSync(join(dir, 'bundled.json'))) ??
    candidates.find((dir) => existsSync(join(dir, 'models')) || existsSync(join(dir, 'runtime'))) ??
    ''
  );
}

export function bundledModelsDir() {
  const root = bundledRoot();
  if (!root) return '';
  const dir = join(root, 'models');
  return existsSync(dir) ? dir : '';
}

export function bundledRuntimeDir() {
  const root = bundledRoot();
  if (!root) return '';
  const dir = join(root, 'runtime');
  return existsSync(dir) ? dir : '';
}

/** 是否有随包附带的资源（用于 UI 提示「开箱即用」） */
export function hasBundledAssets() {
  return Boolean(bundledModelsDir() || bundledRuntimeDir());
}

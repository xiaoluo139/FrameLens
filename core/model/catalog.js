/**
 * 模型目录。
 * 设计原则：只声明「仓库 + 量化偏好」，真实文件名由 HuggingFace API 现查，
 * 这样上游改名 / 新增量化都不会让应用失效。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getJson } from '../http.js';

export const MIRRORS = [
  { id: 'hf', label: 'HuggingFace 官方', base: 'https://huggingface.co' },
  { id: 'mirror', label: '国内镜像 hf-mirror', base: 'https://hf-mirror.com' },
];

/**
 * kind:
 *   vision = 能看图 / 看视频帧的多模态模型（加载 mmproj 才具备视觉能力）
 *   text   = 纯文本对话模型
 */
export const MODEL_CATALOG = [
  {
    id: 'qwen2.5-vl-3b-q4_k_m',
    name: 'Qwen2.5-VL 3B · Q4_K_M',
    kind: 'vision',
    repo: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
    modelPattern: /Qwen2\.5-VL-3B-Instruct-Q4_K_M\.gguf$/i,
    mmprojPattern: /mmproj-Qwen2\.5-VL-3B-Instruct-Q8_0\.gguf$/i,
    approxBytes: 2_686_000_000,
    contextSize: 8192,
    minRamGb: 6,
    badge: '推荐',
    description: '3B 多模态模型，中文理解与 OCR 表现好，显存/内存占用低。本项目实测通过（对话与看图均正常）。',
  },
  {
    id: 'gemma-3-4b-q4_k_m',
    name: 'Gemma 3 4B · Q4_K_M',
    kind: 'vision',
    repo: 'ggml-org/gemma-3-4b-it-GGUF',
    modelPattern: /gemma-3-4b-it-Q4_K_M\.gguf$/i,
    mmprojPattern: /mmproj-model-f16\.gguf$/i,
    approxBytes: 3_340_000_000,
    contextSize: 8192,
    minRamGb: 8,
    badge: '多语言',
    description: 'Google Gemma 3 4B 多模态版，多语言能力强，看图稳定。',
  },
  {
    id: 'smolvlm2-2_2b-q4_k_m',
    name: 'SmolVLM2 2.2B · Q4_K_M',
    kind: 'vision',
    repo: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
    modelPattern: /SmolVLM2-2\.2B-Instruct-Q4_K_M\.gguf$/i,
    mmprojPattern: /mmproj-SmolVLM2-2\.2B-Instruct-Q8_0\.gguf$/i,
    approxBytes: 1_700_000_000,
    contextSize: 8192,
    minRamGb: 5,
    badge: '轻量',
    description: '1.6GB 的视觉模型，启动快，适合内存紧张的老机器。',
  },
  {
    id: 'smolvlm-256m-q8_0',
    name: 'SmolVLM 256M · Q8_0',
    kind: 'vision',
    repo: 'ggml-org/SmolVLM-256M-Instruct-GGUF',
    modelPattern: /SmolVLM-256M-Instruct-Q8_0\.gguf$/i,
    mmprojPattern: /mmproj-SmolVLM-256M-Instruct-Q8_0\.gguf$/i,
    approxBytes: 300_000_000,
    contextSize: 4096,
    minRamGb: 4,
    badge: '极速试用',
    description: '约 300MB 的超小视觉模型，任何电脑都能秒装秒跑。中文能力一般，适合先体验流程。',
  },
  {
    id: 'smolvlm-500m-q8_0',
    name: 'SmolVLM 500M · Q8_0',
    kind: 'vision',
    repo: 'ggml-org/SmolVLM-500M-Instruct-GGUF',
    modelPattern: /SmolVLM-500M-Instruct-Q8_0\.gguf$/i,
    mmprojPattern: /mmproj-SmolVLM-500M-Instruct-Q8_0\.gguf$/i,
    approxBytes: 580_000_000,
    contextSize: 4096,
    minRamGb: 4,
    badge: '轻量视觉',
    description: '比 256M 更准一些，仍然只有几百 MB，适合老机器。',
  },
  {
    id: 'minicpm-v-2_6-q4_k_m',
    name: 'MiniCPM-V 2.6 · Q4_K_M（兼容性异常）',
    kind: 'vision',
    repo: 'openbmb/MiniCPM-V-2_6-gguf',
    modelPattern: /Q4_K_M\.gguf$/i,
    mmprojPattern: /mmproj-model-f16\.gguf$/i,
    approxBytes: 5_725_513_498,
    contextSize: 8192,
    minRamGb: 8,
    badge: '不推荐',
    compatWarning:
      '实测在本项目使用的 llama.cpp 版本下，该 GGUF 输出为乱码（原生 /completion 接口同样如此，与本项目的封装无关）。已保留供有需要的用户尝试，建议改用 Qwen2.5-VL 3B。',
    description: '8B 多模态小模型，中文 OCR 与表格识别强。注意：当前推理引擎版本下实测输出异常，请优先选 Qwen2.5-VL 3B。',
  },
  {
    id: 'minicpm-v-2_6-iq3_xs',
    name: 'MiniCPM-V 2.6 · IQ3_XS 轻量',
    kind: 'vision',
    repo: 'openbmb/MiniCPM-V-2_6-gguf',
    modelPattern: /IQ3_XS\.gguf$/i,
    mmprojPattern: /mmproj-model-f16\.gguf$/i,
    approxBytes: 3_600_000_000,
    contextSize: 8192,
    minRamGb: 6,
    badge: '省内存',
    description: '3bit 量化，内存占用明显更低，画质损失可接受，适合 8G 内存笔记本。',
  },
  {
    id: 'minicpm-v-2_6-q4_k_s',
    name: 'MiniCPM-V 2.6 · Q4_K_S 更省',
    kind: 'vision',
    repo: 'openbmb/MiniCPM-V-2_6-gguf',
    modelPattern: /Q4_K_S\.gguf$/i,
    mmprojPattern: /mmproj-model-f16\.gguf$/i,
    approxBytes: 4_900_000_000,
    contextSize: 8192,
    minRamGb: 7,
    badge: '折中',
    description: '比 Q4_K_M 略小，质量差距很小，显存/内存吃紧时的折中方案。',
  },
  {
    id: 'minicpm-v-2_6-q8_0',
    name: 'MiniCPM-V 2.6 · Q8_0 高精度',
    kind: 'vision',
    repo: 'openbmb/MiniCPM-V-2_6-gguf',
    modelPattern: /Q8_0\.gguf$/i,
    mmprojPattern: /mmproj-model-f16\.gguf$/i,
    approxBytes: 9_000_000_000,
    contextSize: 8192,
    minRamGb: 16,
    badge: '高精度',
    description: '接近原始精度，需要 16G 以上内存或独显。',
  },
  {
    id: 'minicpm3-4b-q4_k_m',
    name: 'MiniCPM3-4B · Q4_K_M 纯文本',
    kind: 'text',
    repo: 'openbmb/MiniCPM3-4B-GGUF',
    modelPattern: /q4_k_m\.gguf$/i,
    approxBytes: 2_600_000_000,
    contextSize: 8192,
    minRamGb: 6,
    badge: '轻量对话',
    description: '4B 纯文本模型，启动快、内存友好，只做文字问答时首选。',
  },
];

export function getModel(id) {
  return MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG[0];
}

export function modelDir(modelsDir, model) {
  return join(modelsDir, model.id);
}

/**
 * 查询仓库真实文件清单，匹配出「主模型 + mmproj」。
 */
export async function resolveModelFiles(model, { base = MIRRORS[0].base, signal } = {}) {
  const info = await getJson(`${base}/api/models/${model.repo}`, {
    headers: { 'user-agent': 'FrameLens/1.0', accept: 'application/json' },
    signal,
  });
  const files = (info?.siblings ?? []).map((s) => s.rfilename).filter(Boolean);

  // 注意：mmproj 文件名里通常也含有主模型名（如 mmproj-XXX-Q8_0.gguf），
  // 所以匹配主模型时必须先把 mmproj 排除掉，否则会把视觉编码器当主模型加载。
  const modelName = pickFile(files.filter((f) => !isMmproj(f)), model.modelPattern);
  if (!modelName) throw new Error(`仓库 ${model.repo} 中没有匹配 ${model.modelPattern} 的文件`);
  const mmprojName = model.mmprojPattern ? pickFile(files, model.mmprojPattern) : '';

  return {
    repo: model.repo,
    base,
    model: { name: modelName, url: resolveUrlFor(base, model.repo, modelName) },
    mmproj: mmprojName ? { name: mmprojName, url: resolveUrlFor(base, model.repo, mmprojName) } : null,
  };
}

export function resolveUrlFor(base, repo, fileName) {
  return `${base}/${repo}/resolve/main/${fileName.split('/').map(encodeURIComponent).join('/')}?download=true`;
}

function pickFile(files, pattern) {
  return (
    files
      .filter((f) => pattern.test(f))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0] ?? ''
  );
}

/**
 * 检查本地是否已安装：返回主模型与 mmproj 的路径。
 * @param {string|string[]} modelsDirs 候选根目录（用户目录在前，随包目录在后）
 */
export function inspectInstalled(modelsDirs, model) {
  const roots = (Array.isArray(modelsDirs) ? modelsDirs : [modelsDirs]).filter(Boolean);
  for (const root of roots) {
    const dir = modelDir(root, model);
    if (!existsSync(dir)) continue;

    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gguf'));
    } catch {
      continue;
    }

    const modelFile = files.find((f) => !isMmproj(f) && model.modelPattern.test(f)) ?? '';
    const mmprojFile = model.mmprojPattern ? (files.find((f) => model.mmprojPattern.test(f)) ?? '') : '';
    const needMmproj = Boolean(model.mmprojPattern);
    if (!modelFile || (needMmproj && !mmprojFile)) continue;

    return {
      installed: true,
      dir,
      modelPath: join(dir, modelFile),
      mmprojPath: mmprojFile ? join(dir, mmprojFile) : '',
      files,
      bytes: files.reduce((sum, f) => sum + fileSize(join(dir, f)), 0),
      source: root === roots[0] ? 'user' : 'bundled',
    };
  }
  return {
    installed: false,
    dir: modelDir(roots[0] ?? '.', model),
    modelPath: '',
    mmprojPath: '',
    files: [],
    bytes: 0,
    source: '',
  };
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 视觉编码器文件（clip / mmproj）不能作为主模型加载 */
export function isMmproj(fileName) {
  const name = String(fileName).split('/').pop() ?? '';
  return /mmproj|^clip/i.test(name);
}

/**
 * 硬件探测：用于推荐量化档位与默认线程数。
 */

import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem, platform, arch, release } from 'node:os';

export function detectHardware() {
  const cores = cpus().length || 4;
  const totalRamGb = totalmem() / 1024 ** 3;
  const freeRamGb = freemem() / 1024 ** 3;
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: cpus()[0]?.model?.trim() ?? '未知 CPU',
    cores,
    recommendedThreads: Math.max(2, cores - 1),
    totalRamGb: round(totalRamGb),
    freeRamGb: round(freeRamGb),
    gpu: { detected: false, vendor: '', name: '' },
    tier: ramTier(totalRamGb),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function ramTier(gb) {
  if (gb >= 32) return 'high';
  if (gb >= 16) return 'standard';
  if (gb >= 8) return 'light';
  return 'minimal';
}

/** 尝试用 nvidia-smi 识别独显（不存在就静默跳过） */
export async function detectGpu() {
  return new Promise((resolve) => {
    if (process.platform === 'win32' || process.platform === 'linux') {
      execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 4000 }, (error, stdout) => {
        if (error || !stdout?.trim()) {
          resolve({ detected: false, vendor: '', name: '' });
          return;
        }
        const [name, memory] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
        resolve({ detected: true, vendor: 'nvidia', name: name ?? '', vram: memory ?? '' });
      });
      return;
    }
    resolve({ detected: false, vendor: '', name: '' });
  });
}

/** 依据内存与显存推荐量化档位 */
export function recommendModel(hardware, models) {
  const vision = models.filter((m) => m.kind === 'vision');
  const ram = hardware.totalRamGb;
  const gpuBoost = hardware.gpu?.detected ? 4 : 0;
  const budget = ram + gpuBoost;

  const affordable = vision.filter((m) => (m.approxBytes ?? 0) / 1024 ** 3 <= budget * 0.6);
  return (affordable.at(-1) ?? vision.at(-1) ?? models[0]).id;
}

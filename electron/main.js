/**
 * FrameLens 主进程。
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createStore } from '../core/store.js';
import { configure as configureHttp, setTransport } from '../core/http.js';
import { createLogger, onLog, recentLogs, setLogLevel } from '../core/logger.js';
import { InferenceRuntime } from '../core/model/runtime.js';
import { registerHandlers } from './ipc.js';
import { handleFileProtocol, registerFileScheme } from './file-protocol.js';
import { disposeRenderer, warmUpRenderer } from './media-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
const isShot = process.argv.includes('--shot');
const isE2E = process.argv.includes('--e2e');
const isImportE2E = process.argv.includes('--e2e-import');

// 隐藏窗口渲染页面时，很多站点（YouTube 等）只有在真正开始播放后才请求视频流。
// 关掉「必须用户手势才能自动播放」的限制，否则永远抓不到媒体地址。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const log = createLogger('main');

let mainWindow = null;
let store = null;
let runtime = null;

// 必须在 app ready 之前注册自定义协议
registerFileScheme();

function modelsDir() {
  return join(app.getPath('userData'), 'models');
}

export function getMainWindow() {
  return mainWindow;
}

function resolveIcon() {
  const candidates = [
    join(__dirname, '..', 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png'),
  ];
  return candidates.find((p) => p && existsSync(p));
}

function applyThemeOverlay() {
  if (!mainWindow || process.platform !== 'win32') return;
  const dark = store.get('theme') !== 'light';
  try {
    mainWindow.setTitleBarOverlay({
      color: dark ? '#0d1017' : '#f5f6fa',
      symbolColor: dark ? '#c9d1e4' : '#2b3242',
      height: 44,
    });
  } catch (error) {
    log.debug('标题栏覆盖层设置失败', error);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: store.get('theme') === 'light' ? '#f5f6fa' : '#0b0e14',
    title: '影析 FrameLens',
    icon: resolveIcon(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1017', symbolColor: '#c9d1e4', height: 44 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  await mainWindow.loadFile(join(__dirname, '..', 'src', 'index.html'));
  applyThemeOverlay();

  if (isShot) await capturePages(mainWindow);
  else if (isImportE2E) await runImportE2E(mainWindow);
  else if (isE2E) {
    // 兜底：任何意外都不应该让测试挂死在这个窗口上
    const guard = setTimeout(() => {
      console.error('[e2e] 超时（15 分钟），强制结束');
      app.exit(1);
    }, 15 * 60 * 1000);
    try {
      await runUiE2E(mainWindow);
    } catch (error) {
      console.error('[e2e] 测试脚本异常：', error?.message ?? error);
      app.exit(1);
    } finally {
      clearTimeout(guard);
    }
  } else if (isSmoke) await runSmokeTest(mainWindow);
}

/**
 * 「导入自定义模型」端到端测试。
 *
 * 这条链路会弹原生文件选择框，普通 E2E 点不动它，所以单独跑：
 * 设了 FRAMELENS_IMPORT_FILES 后 IPC 层直接使用这些路径，其余步骤
 * （点击按钮 → 复制文件 → 登记 → 刷新界面）都是真实执行的。
 *
 *   FRAMELENS_IMPORT_FILES=<主模型.gguf;mmproj.gguf> electron . --e2e-import --user-data-dir=<目录>
 */
async function runImportE2E(win) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const guard = setTimeout(() => {
    console.error('[e2e-import] 超时（5 分钟），强制结束');
    app.exit(1);
  }, 5 * 60 * 1000);

  try {
    await sleep(3000);
    const before = await js(`(() => {
      const page = document.querySelector('[data-page="models"]');
      return {
        entries: [...(page?.querySelectorAll('button') ?? [])].filter((b) => b.textContent.includes('导入本地模型')).length,
        card: Boolean(page?.textContent.includes('自定义模型')),
      };
    })()`);
    console.log('[e2e-import] 界面上的导入入口数量:', before.entries, '| 自定义模型卡片:', before.card);
    if (before.entries < 1) throw new Error('模型中心页没有「导入本地模型」按钮');
    if (!before.card) throw new Error('模型中心页没有「自定义模型」卡片');

    console.log('[e2e-import] 1/3 真实点击「导入本地模型」');
    const clicked = await js(`(() => {
      const page = document.querySelector('[data-page="models"]');
      const btns = [...page.querySelectorAll('button')].filter((b) => b.textContent.includes('导入本地模型'));
      const target = btns[btns.length - 1];
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!clicked) throw new Error('按钮点击失败');

    console.log('[e2e-import] 2/3 等待模型复制、登记与界面刷新');
    let imported = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      imported = await js(`(() => {
        const custom = (window.FL.state.modelStatus?.models ?? []).filter((m) => m.repo === '本地导入');
        return custom.length > 0 ? { count: custom.length, name: custom[0].name, installed: custom[0].installed } : null;
      })()`);
      if (imported) break;
    }
    if (!imported) throw new Error('导入后模型列表里没有出现自定义模型');
    console.log('[e2e-import] 自定义模型:', JSON.stringify(imported));

    const ui = await js(`(() => {
      const custom = (window.FL.state.modelStatus?.models ?? []).find((m) => m.repo === '本地导入');
      const modelsPage = document.querySelector('[data-page="models"]');
      const chatPage = document.querySelector('[data-page="chat"]');
      return {
        listedInCard: Boolean(custom) && Boolean(modelsPage?.textContent.includes(custom.name)),
        options: [...(chatPage?.querySelectorAll('select.select option') ?? [])].map((o) => o.textContent),
      };
    })()`);
    console.log('[e2e-import] 3/3 自定义模型卡片里可见:', ui.listedInCard);
    console.log('[e2e-import] 对话页可选模型:', JSON.stringify(ui.options));
    if (!ui.listedInCard) throw new Error('自定义模型没有出现在模型中心的卡片里');

    console.log('[e2e-import] 通过：点击导入 → 登记 → 出现在界面与对话模型列表');
    app.exit(0);
  } catch (error) {
    console.error('[e2e-import] 失败：', error?.message ?? error);
    app.exit(1);
  } finally {
    clearTimeout(guard);
  }
}

/**
 * 界面级端到端测试：真的去点「解析全平台链接」按钮、真的在对话框里发消息，
 * 然后检查 DOM 里到底出现了什么。这是唯一能证明「用户能用」的验证方式。
 *
 *   electron . --e2e --user-data-dir=<可写目录>
 *   electron . --e2e --with-model     额外验证模型对话（需要已装模型）
 */
async function runUiE2E(win) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const withModel = process.argv.includes('--with-model');
  const url = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'https://www.bilibili.com/video/BV1GJ411x7h7';
  const problems = [];
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  console.log('[e2e] 测试链接:', url);

  await sleep(3000);

  /* ---------------------------------------------------------- 1. 解析页 */
  console.log('[e2e] 1/4 打开「全平台解析」并粘贴链接');
  await js(`window.FL.navigate('parse'); true`);
  await sleep(500);
  await js(`(() => {
    const box = document.querySelector('.parse-box .textarea');
    box.value = ${JSON.stringify(url)};
    return box.value.length;
  })()`);

  console.log('[e2e] 2/4 点击「解析全平台链接」');
  const clicked = await js(`(() => {
    const btn = document.querySelector('.parse-box .btn--primary');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) problems.push('找不到解析按钮');

  let parseReport = null;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    parseReport = await js(`(() => {
      const assets = document.querySelectorAll('.asset');
      const first = assets[0];
      return {
        assets: assets.length,
        variants: document.querySelectorAll('.variant').length,
        title: first?.querySelector('.asset__title')?.textContent ?? '',
        chip: first?.querySelector('.chip--brand')?.textContent ?? '',
        firstUrl: document.querySelector('.variant__url')?.textContent ?? '',
        busy: document.querySelector('.parse-box .btn--primary span')?.textContent ?? '',
      };
    })()`);
    if (parseReport.assets > 0 && parseReport.busy !== '解析中…') break;
  }
  console.log('[e2e] 解析结果:', JSON.stringify(parseReport));
  if (!parseReport || parseReport.assets === 0) problems.push('界面上没有出现任何解析结果');
  else {
    if (parseReport.variants === 0) problems.push('解析结果里没有可下载的清晰度');
    if (!/^https?:\/\//.test(parseReport.firstUrl)) problems.push('解析出的第一条地址不是有效 URL');
    if (!parseReport.title) problems.push('解析结果没有标题');
  }
  // 留一张结果页截图，便于人工核对界面元素（下载按钮、图片墙等）
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    const outDir = joinPath(__dirname, '..', 'shots');
    mkdirSync(outDir, { recursive: true });
    const image = await win.webContents.capturePage();
    writeFileSync(joinPath(outDir, 'e2e-parse-result.png'), image.toPNG());
    console.log('[e2e] 结果页截图: shots/e2e-parse-result.png');
    // 再滚到结果卡片下半部分，单独截一张用于核对「图片 / 封面」区块与按钮
    await js(`document.querySelector('.asset')?.scrollIntoView({ block: 'end' }); true`);
    // 等缩略图真正解码出来再截图，否则会拍到一堆空白框，看起来像「图片没解析出来」
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const pending = await js(
        `[...document.querySelectorAll('.thumb img, .asset__cover')].filter((img) => !img.complete || img.naturalWidth === 0).length`,
      );
      if (pending === 0) break;
    }
    await sleep(400);
    const lower = await win.webContents.capturePage();
    writeFileSync(joinPath(outDir, 'e2e-parse-images.png'), lower.toPNG());
    console.log('[e2e] 图片区截图: shots/e2e-parse-images.png');
  } catch (error) {
    console.warn('[e2e] 截图失败', error.message);
  }

  /* ---------------------------------------------------------- 2. 下载任务 */
  console.log('[e2e] 3/4 点击第一条结果的下载按钮，检查任务中心');
  const downloadClicked = await js(`(() => {
    const btns = [...document.querySelectorAll('.variant__actions button')];
    const dl = btns.find((b) => (b.textContent || '').includes('下载') || b.title === '下载');
    if (!dl) return false;
    dl.click();
    return true;
  })()`);
  if (!downloadClicked) problems.push('找不到下载按钮');

  let taskReport = null;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    taskReport = await js(`(() => {
      window.FL.navigate('tasks');
      const rows = document.querySelectorAll('.task-row');
      const row = rows[0];
      const progress = row?.querySelector('.progress__bar')?.style?.width ?? '';
      return {
        rows: rows.length,
        status: row?.querySelector('.task-row__name span')?.textContent ?? '',
        progress,
      };
    })()`);
    if (taskReport.rows === 0) continue;
    // 必须等到终态，只看「有没有出现一行」是不够的
    if (/已完成|失败|已取消/.test(taskReport.status)) break;
  }
  console.log('[e2e] 下载任务:', JSON.stringify(taskReport));
  if (!taskReport || taskReport.rows === 0) problems.push('下载队列里没有出现任务');
  else if (/失败/.test(taskReport.status)) problems.push(`下载任务失败：${taskReport.status}`);
  else if (!/已完成/.test(taskReport.status)) {
    // 长视频（几十分钟）在测试窗口内下不完是正常的，只要没失败就算通过
    console.log(`[e2e] 提示：下载仍在进行（${taskReport.status}），长视频超出测试窗口属正常`);
  }

  /* ---------------------------------------------------------- 3. 模型对话 */
  if (withModel) {
    console.log('[e2e] 4/4 去「模型对话」发一条消息');
    await js(`window.FL.navigate('chat'); true`);
    await sleep(600);
    await js(`(() => {
      const box = document.querySelector('.composer textarea');
      box.value = '用一句话说明你能做什么。';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await js(`document.querySelector('.iconbtn--send').click(); true`);

    let chatReport = null;
    for (let i = 0; i < 300; i++) {
      await sleep(1000);
      chatReport = await js(`(() => {
        const nodes = [...document.querySelectorAll('.msg--assistant .msg__text')];
        return {
          messages: document.querySelectorAll('.msg').length,
          busy: window.FL.state.chat.busy,
          reply: (nodes.at(-1)?.textContent ?? '').trim().slice(0, 120),
        };
      })()`);
      if (!chatReport.busy && chatReport.reply && !chatReport.reply.startsWith('⚠️')) break;
      if (chatReport.reply.startsWith('⚠️')) break;
    }
    console.log('[e2e] 对话结果:', JSON.stringify(chatReport));
    if (!chatReport || !chatReport.reply) problems.push('对话窗口没有产生回复');
    else if (chatReport.reply.startsWith('⚠️')) problems.push(`对话报错：${chatReport.reply}`);

    /* ------------------------------------------------ 4. 图像理解（拖拽 + 识别） */
    console.log('[e2e] 补充：在「图像理解」里拖入一张图并让模型识别');
    await js(`window.FL.navigate('vision'); true`);
    await sleep(500);
    const dropped = await js(`(async () => {
      try {
        const res = await fetch('flfile://local/D:/jx/build/icon.png');
        const blob = await res.blob();
        const file = new File([blob], 'icon.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const zone = document.querySelector('.dropzone');
        zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      } catch (error) {
        return String(error && error.message ? error.message : error);
      }
    })()`);
    if (dropped !== true) problems.push(`拖拽图片失败：${dropped}`);
    await sleep(1200);
    const thumbCount = await js(`document.querySelectorAll('.thumb-grid .thumb').length`);
    console.log('[e2e] 图像缩略图数量:', thumbCount);
    if (!thumbCount) problems.push('拖拽后没有生成图片缩略图');

    await js(`(() => {
      const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('让模型理解'));
      if (btn) btn.click();
      return Boolean(btn);
    })()`);

    let visionReport = null;
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      visionReport = await js(`(() => {
        const box = document.querySelector('.result-box');
        return { text: (box?.textContent ?? '').trim().slice(0, 120), busy: document.querySelector('.btn--primary')?.disabled ?? false };
      })()`);
      if (visionReport.text && !visionReport.text.startsWith('识别结果') && !/正在/.test(visionReport.text)) break;
    }
    console.log('[e2e] 图像理解结果:', JSON.stringify(visionReport));
    if (!visionReport?.text || /正在加载/.test(visionReport.text)) problems.push('图像理解没有返回结果');

    /* ------------------------------------------------ 5. 视频理解（抽帧 + 分析） */
    if (process.env.FL_E2E_FILE) {
      console.log('[e2e] 补充：在「视频理解」里抽关键帧并分析');
      await js(`window.FL.navigate('video'); true`);
      await sleep(600);
      await js(`(() => {
        const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('选择本地视频'));
        btn.click();
        return true;
      })()`);

      // 等视频元数据加载完成
      let meta = '';
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        meta = await js(`document.querySelector('.viewer video')?.duration ?? 0`);
        if (Number(meta) > 0) break;
      }
      console.log('[e2e] 视频时长:', meta);
      if (!(Number(meta) > 0)) problems.push('视频无法被内置解码器读取（可能是 mkv/HEVC 或文件不完整）');

      await js(`(() => {
        const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('只抽关键帧'));
        btn.click();
        return true;
      })()`);

      let frames = 0;
      let extractDone = false;
      // 高清帧的 seek + canvas 编码可能超过 1 分钟，这里给足时间，
      // 否则会在抽帧还没结束时就去点分析按钮，被禁用态吞掉
      for (let i = 0; i < 360; i++) {
        await sleep(500);
        // 必须限定在视频页内：隐藏页面的 DOM 仍在文档里，不限定就会读到图像理解页的元素
        frames = await js(`document.querySelectorAll('.page[data-page="video"] .thumb-grid .thumb').length`);
        extractDone = await js(
          `document.querySelector('.page[data-page="video"] .card__body .card__sub')?.textContent?.includes('已抽取') ?? false`,
        );
        if (frames > 0 && extractDone) break;
      }
      console.log('[e2e] 抽出关键帧:', frames, '抽帧完成:', extractDone);
      if (!frames) problems.push('没有抽出任何关键帧');
      else if (!extractDone) problems.push('抽帧未在超时时间内完成');
      else {
        await js(`(() => {
          const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('抽帧并让模型分析'));
          btn.click();
          return true;
        })()`);
        let videoReport = null;
        for (let i = 0; i < 420; i++) {
          await sleep(1000);
          videoReport = await js(`(() => {
            const box = document.querySelector('.page[data-page="video"] .result-box');
            return { text: (box?.textContent ?? '').trim().slice(0, 140) };
          })()`);
          // 进度提示也算"未完成"，只有既不是占位符也不是进行中文案才算跑完
          const inProgress = /正在把|正在分析|分析结果会显示/.test(videoReport.text);
          if (videoReport.text && !inProgress) break;
        }
        console.log('[e2e] 视频理解结果:', JSON.stringify(videoReport));
        if (!videoReport?.text || /正在把|正在分析|分析结果会显示/.test(videoReport.text)) {
          problems.push(`视频理解没有返回结果（当前显示：${videoReport?.text ?? '空'}）`);
        }
      }
    }
  } else {
    console.log('[e2e] 4/4 跳过模型对话（未加 --with-model）');
  }

  if (problems.length > 0) {
    console.error('\n[e2e] 发现问题：');
    problems.forEach((p) => console.error('  ✖', p));
    if (rendererErrors.length) {
      console.error('[e2e] 渲染层报错：');
      rendererErrors.slice(0, 8).forEach((e) => console.error('  -', e.slice(0, 200)));
    }
    app.exit(1);
  } else {
    console.log('\n[e2e] 通过：界面上的解析、下载、' + (withModel ? '对话' : '') + '流程全部正常');
    app.exit(0);
  }
}

/**
 * 逐页截图（设计走查用）：electron . --shot
 * 产物在 <项目>/shots/*.png
 */
async function capturePages(win) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const outDir = join(__dirname, '..', 'shots');
  mkdirSync(outDir, { recursive: true });
  win.setSize(1360, 900);
  win.show();
  win.focus();
  console.log('[shot] 等待渲染稳定…');
  await new Promise((r) => setTimeout(r, 3000));

  const names = ['home', 'parse', 'chat', 'vision', 'video', 'tasks', 'models', 'settings'];

  // 走 CDP 截图：capturePage 在软件渲染下会返回被降采样再放大的糊图。
  // 缩放用启动参数 --force-device-scale-factor=2 指定（必须在进程启动时生效），
  // 运行中再改缩放会让滚动容器保留旧的 1x 光栅缓存，整帧发虚。
  win.webContents.debugger.attach('1.3');
  await win.webContents.insertCSS(`
    * { animation: none !important; transition: none !important; }
    .titlebar, .rail { backdrop-filter: none !important; }
  `);
  await new Promise((r) => setTimeout(r, 2500));

  for (const name of names) {
    await win.webContents.executeJavaScript(`window.FL.navigate(${JSON.stringify(name)}); true`);
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 1200));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`[shot] ${name}.png`);
  }
  win.webContents.debugger.detach();
  console.log('[shot] done');
  app.exit(0);
}

/**
 * 冒烟自检：确认渲染进程能把所有页面挂载起来、没有抛异常。
 * 用法：electron . --smoke
 */
async function runSmokeTest(win) {
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[smoke] 渲染进程崩溃', details);
    app.exit(1);
  });

  await new Promise((r) => setTimeout(r, 3500));
  try {
    const report = await win.webContents.executeJavaScript(`(() => {
      const pages = [...document.querySelectorAll('.page')].map((p) => ({
        name: p.dataset.page,
        nodes: p.children.length,
      }));
      return {
        pages,
        railItems: document.querySelectorAll('.rail__item').length,
        activePage: document.querySelector('.page.is-active')?.dataset.page ?? null,
        engine: document.getElementById('engine-label')?.textContent ?? '',
        keys: Object.keys(window.FL?.pages ?? {}),
        modalDisplay: getComputedStyle(document.getElementById('modal-root')).display,
        topElementAtCenter: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.className ?? '',
        // 自定义模型入口必须真的在界面上（用户反馈过找不到）
        customEntry: {
          models: document.querySelector('[data-page="models"]')?.textContent.includes('导入本地模型') ?? false,
          chat: document.querySelector('[data-page="chat"]')?.textContent.includes('导入本地模型') ?? false,
        },
        importHelper: typeof window.FL?.importLocalModel === 'function',
      };
    })()`);
    console.log('[smoke] 渲染层状态:', JSON.stringify(report, null, 2));
    if (report.keys.length < 8) errors.push(`只注册了 ${report.keys.length} 个页面，预期 8 个`);
    const empty = report.pages.filter((p) => p.nodes === 0).map((p) => p.name);
    if (empty.length > 0) errors.push(`以下页面没有渲染内容：${empty.join(', ')}`);
    // 回归检查：遮罩层必须彻底不渲染，否则会盖住界面并吃掉所有点击
    if (report.modalDisplay !== 'none') errors.push(`遮罩层未隐藏（display=${report.modalDisplay}），会挡住界面点击`);
    // 回归检查：自定义模型入口（模型中心 + 模型对话）必须存在，且公共导入方法可用
    if (!report.customEntry?.models) errors.push('模型中心页缺少「导入本地模型」入口');
    if (!report.customEntry?.chat) errors.push('模型对话页缺少「导入本地模型」入口');
    if (!report.importHelper) errors.push('公共导入方法 window.FL.importLocalModel 不存在');
  } catch (error) {
    errors.push(`执行检查脚本失败：${error.message}`);
  }

  if (errors.length > 0) {
    console.error('[smoke] 发现问题：');
    errors.forEach((e) => console.error('  -', e));
    app.exit(1);
  } else {
    console.log('[smoke] 通过：8 个页面全部挂载成功，无渲染层报错');
    app.exit(0);
  }
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fl:event', { channel, payload });
  }
}

/**
 * 给热门图床补上 Referer。
 * B 站、抖音、小红书等的图片 CDN 都有防盗链，不带 Referer 会直接 403，
 * 界面上表现为「封面是空白框」。这里统一在请求发出前补上。
 */
function patchImageReferers() {
  const rules = [
    { match: /hdslb\.com|bilivideo\.com/i, referer: 'https://www.bilibili.com/' },
    { match: /douyinpic\.com|douyinvod\.com|byteimg\.com/i, referer: 'https://www.douyin.com/' },
    { match: /xhscdn\.com/i, referer: 'https://www.xiaohongshu.com/' },
    { match: /sinaimg\.cn|weibo\.cn/i, referer: 'https://weibo.com/' },
    { match: /tiktokcdn|tiktokv/i, referer: 'https://www.tiktok.com/' },
    { match: /ytimg\.com|googlevideo\.com/i, referer: 'https://www.youtube.com/' },
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const rule = rules.find((item) => item.match.test(details.url));
    if (rule) {
      const headers = details.requestHeaders;
      const hasReferer = Object.keys(headers).some((key) => key.toLowerCase() === 'referer');
      if (!hasReferer) headers.Referer = rule.referer;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

/**
 * 启动后预热模型。
 * llama.cpp 加载几 GB 的模型要十几秒，如果等用户点「发送」才开始加载，
 * 前几次对话体验会很差。这里在窗口出来之后就在后台把它加载好。
 */
async function warmUpModel() {
  try {
    if (!store.get('model.preloadOnStart', true)) return;
    const status = await runtime.status();
    const installed = status.models.filter((m) => m.installed);
    if (installed.length === 0) return;
    const target = installed.find((m) => m.id === status.effectiveModelId) ?? installed[0];
    log.info(`开始后台预热模型：${target.name}`);
    broadcast('model:progress', { modelId: target.id, stage: 'preload', percent: 2, message: `正在后台加载 ${target.name}…` });
    await runtime.ensureReady({
      modelId: target.id,
      onProgress: (event) => broadcast('model:progress', { modelId: target.id, ...event }),
    });
    broadcast('model:progress', { modelId: target.id, stage: 'preloaded', percent: 100, message: '模型已就绪，可以直接对话' });
    log.info('模型预热完成');
  } catch (error) {
    log.warn('模型预热失败（不影响使用，首次对话时会重试）', error);
  }
}

function bootstrapServices() {
  store = createStore(app.getPath('userData'));
  configureHttp({
    timeoutMs: store.get('network.timeoutMs', 20000),
    userAgent: store.get('network.userAgent', 'desktop'),
    proxy: store.get('network.proxy', ''),
  });

  // Electron 的 net 走系统代理与证书，比裸 fetch 更可靠
  setTransport((input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    return globalThis.fetch(target, init);
  });

  if (store.get('theme') === 'dark') nativeTheme.themeSource = 'dark';
  else nativeTheme.themeSource = 'light';

  runtime = new InferenceRuntime({
    userDataDir: app.getPath('userData'),
    modelsDir: modelsDir(),
    settings: () => store.all,
  });

  onLog((entry) => broadcast('log:entry', entry));

  registerHandlers({
    ipcMain,
    app,
    dialog,
    shell,
    store,
    runtime,
    modelsDir,
    getMainWindow,
    broadcast,
    isDev,
    isE2E,
    applyThemeOverlay,
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setLogLevel(isDev ? 'debug' : 'info');
    bootstrapServices();
    handleFileProtocol();
    patchImageReferers();
    await createWindow();
    log.info(`FrameLens 启动完成（${app.getVersion()}）`);
    // 后台预热模型：装好模型的情况下，用户点开对话时已经是就绪状态
    warmUpModel();
    // 预建隐藏浏览器窗口并预热站点，第一次解析链接时不用再等窗口创建与首次加载
    if (store.get('network.warmUpSite', true)) warmUpRenderer();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (runtime) {
      event.preventDefault();
      try {
        await runtime.unload();
      } catch {
        /* 忽略退出时的卸载异常 */
      }
      disposeRenderer();
      runtime = null;
      app.exit(0);
    }
  });
}

export { store, runtime, broadcast, recentLogs, modelsDir };

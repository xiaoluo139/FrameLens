/**
 * 移动端入口：复用桌面端 core/extract 解析引擎。
 *
 * 网络说明：Capacitor 的 CapacitorHttp 会把 window.fetch 接管为原生请求，
 * 因此网页抓取不受 WebView 的同源策略限制——这正是解析类应用能在手机上跑通的关键。
 */

import { analyze } from '../../core/extract/index.js';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Cha, MODEL_CATALOG, allModels, importedModels, saveImportedModels } from './cha.js';

const modelImport = Capacitor.getPlatform() === 'android' ? registerPlugin('ModelImport') : null;

const $ = (id) => document.getElementById(id);

const els = {
  input: $('input'),
  go: $('go'),
  paste: $('paste'),
  clear: $('clear'),
  status: $('status'),
  results: $('results'),
  toast: $('toast'),
  badge: $('engine-badge'),
};

const cha = new Cha((line) => console.log('[cha]', line));

/**
 * 手机端的「用浏览器渲染页面」能力：交给 Android 侧的隐藏 WebView 插件。
 * 与桌面端主进程里的 renderPageForMedia 是同一角色——抖音这类站点
 * 必须让真实浏览器去跑它的 JS 才能拿到播放地址。
 */
const mediaExtractor = Capacitor.getPlatform() === 'android' ? registerPlugin('MediaExtractor') : null;
const downloader = Capacitor.getPlatform() === 'android' ? registerPlugin('Downloader') : null;

/** 最近一次浏览器渲染的结果，用于诊断「为什么没拿到地址」 */
const renderTrace = { calls: 0, urls: 0, images: 0, error: '', lastUrl: '' };

async function renderMedia(url, options = {}) {
  if (!mediaExtractor) return { pageTitle: '', mediaUrls: [] };
  renderTrace.calls += 1;
  renderTrace.lastUrl = url;
  try {
    const result = await mediaExtractor.extract({ url, timeoutMs: options.timeoutMs ?? 30000 });
    const urls = result.mediaUrls ?? [];
    renderTrace.urls = urls.length;
    renderTrace.images = (result.images ?? []).length;
    return {
      pageTitle: result.pageTitle ?? '',
      mediaUrls: urls,
      images: result.images ?? [],
      pageUrl: result.finalUrl ?? '',
    };
  } catch (error) {
    renderTrace.error = error?.message ?? String(error);
    throw error;
  }
}

/**
 * 短链展开：交给隐藏 WebView，它会跟完重定向并把最终地址带回来。
 * 直接用 fetch 不行——Capacitor 会把 response.url 改写成拦截器地址。
 */
async function resolveUrlViaBrowser(url) {
  if (!mediaExtractor) return '';
  try {
    const result = await mediaExtractor.extract({ url, timeoutMs: 20000 });
    if (result.finalUrl) return result.finalUrl;
  } catch (error) {
    console.warn('[resolve] 失败', error);
  }
  return '';
}

/* ------------------------------------------------------------------ 标签页 */
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const node of document.querySelectorAll('.tab')) node.classList.toggle('is-active', node === tab);
    document.getElementById('page-parse').hidden = tab.dataset.tab !== 'parse';
    document.getElementById('page-chat').hidden = tab.dataset.tab !== 'chat';
    if (tab.dataset.tab === 'chat') refreshModelUi().catch(() => {});
  });
}

/* ------------------------------------------------------------------ 本地模型 */
const modelState = { installed: '', busy: false };

async function refreshModelUi() {
  const statusEl = $('model-status');
  const actions = $('model-actions');
  const progress = $('model-progress');
  actions.replaceChildren();
  progress.replaceChildren();

  if (!cha.pluginAvailable) {
    statusEl.textContent = '本地推理目前只支持 Android 手机；请在手机上使用本功能。';
    return;
  }

  const server = await cha.serverStatus();
  let installedId = '';
  // 导入模型入口：系统文件选择器 + 原生拷贝，2GB 的模型也不会爆内存
  if (modelImport) {
    const importRow = document.createElement('div');
    importRow.className = 'model-option';
    const importInfo = document.createElement('div');
    importInfo.innerHTML = '<b>导入本地模型</b><span>选择手机里的 .gguf 文件（主模型与 mmproj 可一起选）</span>';
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn--mini';
    importBtn.textContent = '选择文件';
    importBtn.onclick = () => importModelFromPhone(importBtn);
    const importSpacer = document.createElement('div');
    importSpacer.className = 'spacer';
    importRow.append(importInfo, importSpacer, importBtn);
    actions.append(importRow);
  }

  for (const spec of allModels()) {
    const paths = (await cha.modelPaths(spec)) ?? (await cha.bundledPaths(spec));
    if (paths) {
      installedId = spec.id;
      spec.bundled = Boolean(paths.bundled);
      break;
    }
  }
  modelState.installed = installedId;

  if (server.ready) {
    const spec = allModels().find((m) => m.id === cha.modelId) ?? allModels().find((m) => m.id === installedId);
    statusEl.textContent = `本地推理运行中（端口 ${server.port}）${spec ? ` · ${spec.name}` : ''}`;
  } else if (installedId) {
    const spec = allModels().find((m) => m.id === installedId);
    statusEl.textContent = `已下载：${spec.name}`;
  } else {
    statusEl.textContent = '还没有下载模型。下载后即可离线对话与看图，不需要联网。';
  }

  for (const spec of allModels()) {
    const paths = (await cha.modelPaths(spec)) ?? (await cha.bundledPaths(spec));
    const row = document.createElement('div');
    row.className = 'model-option';

    const info = document.createElement('div');
    info.innerHTML = `<b>${spec.name}</b><span>${
      paths ? (paths.bundled ? '已随安装包内置，开箱可用' : `已下载 ${(paths.size / 1024 / 1024 / 1024).toFixed(2)} GB`) : spec.desc
    }</span>`;
    row.append(info);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    row.append(spacer);

    if (!paths) {
      if (spec.imported) {
        // 导入的模型文件被系统清理了
        const tag = document.createElement('span');
        tag.textContent = '文件缺失';
        tag.style.color = 'var(--warn)';
        row.append(tag);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn btn--mini btn--primary';
        btn.textContent = '下载';
        btn.onclick = () => downloadModel(spec, btn);
        row.append(btn);
      }
    } else if (spec.id === installedId && !cha.port) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--mini';
      btn.textContent = paths.bundled ? '启用' : '启用';
      btn.onclick = () => startModel(spec, btn);
      row.append(btn);
    } else {
      const tag = document.createElement('span');
      tag.textContent = cha.modelId === spec.id ? '使用中' : '已就绪';
      tag.style.color = 'var(--ok)';
      row.append(tag);
    }
    actions.append(row);
  }
}

/** 从手机里导入 GGUF 模型 */
async function importModelFromPhone(btn) {
  if (!modelImport) return;
  try {
    btn.disabled = true;
    btn.textContent = '选择中';
    const result = await modelImport.pick();
    if (result?.canceled) return;
    const files = result?.files ?? [];
    if (files.length === 0) {
      toast('没有导入任何文件', 3000);
      return;
    }

    // 主模型是大的那个，mmproj 按名字识别
    const mmproj = files.find((f) => /mmproj|^clip/i.test(f.name));
    const main = files.find((f) => f !== mmproj) ?? files[0];
    const name = main.name.replace(/\.gguf$/i, '');
    const id = `imported-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || Date.now()}`;
    const entry = {
      id,
      name,
      desc: `从手机导入${mmproj ? '（含视觉编码器）' : '（纯文本）'}`,
      dir: 'models/imported',
      model: main.name,
      mmproj: mmproj?.name ?? '',
      bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
      contextSize: 8192,
      imported: true,
    };

    const list = importedModels().filter((m) => m.id !== id);
    list.push(entry);
    saveImportedModels(list);
    toast('模型导入成功', `${name}，点「启用」即可使用`, 5000);
    await refreshModelUi();
  } catch (error) {
    toast('导入失败', error.message, 'err', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '选择文件';
  }
}

async function downloadModel(spec, btn) {
  if (modelState.busy) return;
  modelState.busy = true;
  btn.disabled = true;
  btn.textContent = '下载中';
  const progress = $('model-progress');
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('i');
  bar.append(fill);
  const text = document.createElement('div');
  text.className = 'card-desc';
  progress.replaceChildren(bar, text);

  try {
    await cha.download(spec, (event) => {
      fill.style.width = `${Math.min(100, event.percent ?? 0)}%`;
      text.textContent = event.message ?? '';
    });
    toast('模型下载完成');
    await refreshModelUi();
    await startModel(spec);
  } catch (error) {
    text.textContent = `下载失败：${error.message}`;
    toast(`下载失败：${error.message}`, 5000);
  } finally {
    modelState.busy = false;
    btn.disabled = false;
  }
}

async function startModel(spec, btn) {
  const text = $('model-progress').querySelector('.card-desc') ?? document.createElement('div');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '加载中';
  }
  try {
    await cha.ensureServer(spec, (event) => {
      if (event.message) text.textContent = event.message;
    });
    toast('本地模型已就绪');
    await refreshModelUi();
  } catch (error) {
    toast(`启动失败：${error.message}`, 6000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '启用';
    }
  }
}

/* ------------------------------------------------------------------ 对话 */
const chat = { messages: [], images: [] };

function renderChat() {
  const scroll = $('chat-scroll');
  if (chat.messages.length === 0) {
    scroll.replaceChildren($('chat-empty') ?? document.createElement('div'));
    return;
  }
  scroll.replaceChildren(
    ...chat.messages.map((message) => {
      const node = document.createElement('div');
      node.className = `msg msg--${message.role === 'user' ? 'user' : 'assistant'}`;
      const avatar = document.createElement('div');
      avatar.className = 'msg__avatar';
      avatar.textContent = message.role === 'user' ? '你' : 'AI';
      const body = document.createElement('div');
      body.className = 'msg__body';
      if (message.images?.length) {
        const box = document.createElement('div');
        box.className = 'msg__images';
        for (const url of message.images) {
          const img = document.createElement('img');
          img.src = url;
          box.append(img);
        }
        body.append(box);
      }
      const text = document.createElement('div');
      text.className = 'msg__text';
      text.textContent = message.content || (message.streaming ? '…' : '');
      body.append(text);
      node.append(avatar, body);
      node.dataset.text = '';
      return node;
    }),
  );
  scroll.scrollTop = scroll.scrollHeight;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

/**
 * 防盗链兜底：图片直连被拒时，用原生请求带上 Referer 再取一次，转成 data URL 显示。
 * B 站、抖音等图床不给空 Referer 的请求返回图片，WebView 里会直接裂图。
 */
async function retryImageViaNative(img, url, onFail) {
  try {
    const referer = /hdslb|bilivideo/i.test(url)
      ? 'https://www.bilibili.com/'
      : /douyinpic|douyinvod/i.test(url)
        ? 'https://www.douyin.com/'
        : /xhscdn/i.test(url)
          ? 'https://www.xiaohongshu.com/'
          : '';
    const res = await CapacitorHttp.get({
      url,
      headers: referer ? { Referer: referer } : {},
      responseType: 'arraybuffer',
    });
    if (typeof res.data === 'string' && res.data.length > 0) {
      const type = res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? 'image/jpeg';
      img.src = `data:${type};base64,${res.data}`;
      img.onerror = null;
      return;
    }
  } catch (error) {
    console.warn('[image] 防盗链兜底失败', error);
  }
  onFail?.();
}

$('chat-attach').addEventListener('click', () => $('file-picker').click());
$('file-picker').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  chat.images.push(await readFileAsDataUrl(file));
  toast('已添加图片');
  $('chat-hint').textContent = `已附 ${chat.images.length} 张图片，发送后会一起交给模型`;
  event.target.value = '';
});
$('chat-clear').addEventListener('click', () => {
  chat.messages = [];
  chat.images = [];
  $('chat-hint').textContent = '';
  renderChat();
});

async function sendChat() {
  const input = $('chat-input');
  const content = input.value.trim();
  if (!content && chat.images.length === 0) return;
  if (cha.busy) return;

  if (!cha.port) {
    const spec = allModels().find((m) => m.id === modelState.installed);
    if (!spec) {
      toast('先下载一个模型', 4000);
      return;
    }
    try {
      await startModel(spec);
    } catch {
      return;
    }
  }

  const images = [...chat.images];
  chat.messages.push({ role: 'user', content, images });
  chat.messages.push({ role: 'assistant', content: '', streaming: true });
  chat.images = [];
  input.value = '';
  input.style.height = 'auto';
  $('chat-hint').textContent = '';
  renderChat();

  cha.busy = true;
  $('chat-hint').textContent = '模型正在生成…';
  const payload = chat.messages
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content || '（图片）' }));

  try {
    await cha.chat({
      messages: payload,
      images: images.map((i) => i),
      maxTokens: 512,
      onToken: (_delta, full) => {
        const last = chat.messages[chat.messages.length - 1];
        last.content = full;
        const scroll = $('chat-scroll');
        const texts = scroll.querySelectorAll('.msg__text');
        const node = texts[texts.length - 1];
        if (node) node.textContent = full;
        scroll.scrollTop = scroll.scrollHeight;
      },
    });
    delete chat.messages[chat.messages.length - 1].streaming;
  } catch (error) {
    chat.messages[chat.messages.length - 1].content = `⚠️ ${error.message}`;
  } finally {
    cha.busy = false;
    $('chat-hint').textContent = '';
    renderChat();
  }
}

$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('input', (event) => {
  const node = event.target;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
});

let busy = false;

function toast(message, timeout = 2200) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, timeout);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制直链');
  } catch {
    toast('复制失败，请长按选择');
  }
}

function openExternal(url) {
  // Capacitor 会把 _blank 交给系统浏览器打开，从而走手机自带的下载管理器
  window.open(url, '_blank');
}

function variantRow(asset, variant) {
  const row = document.createElement('div');
  row.className = 'variant';

  const label = document.createElement('span');
  label.className = 'variant__label';
  label.textContent = variant.label;

  const url = document.createElement('span');
  url.className = 'variant__url';
  url.textContent = variant.url;
  url.title = variant.url;

  const actions = document.createElement('div');
  actions.className = 'variant__actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'iconbtn';
  downloadBtn.textContent = '⬇';
  downloadBtn.title = '下载';
  downloadBtn.onclick = () =>
    downloadFile(variant.url, `${asset.title}-${variant.label}.${variant.format || 'mp4'}`, variant.headers?.referer ?? '');

  const copyBtn = document.createElement('button');
  copyBtn.className = 'iconbtn';
  copyBtn.textContent = '⧉';
  copyBtn.title = '复制直链';
  copyBtn.onclick = () => copy(variant.url);

  const openBtn = document.createElement('button');
  openBtn.className = 'iconbtn';
  openBtn.textContent = '↗';
  openBtn.title = '在浏览器中打开';
  openBtn.onclick = () => openExternal(variant.url);

  actions.append(downloadBtn, copyBtn, openBtn);
  row.append(label, url, actions);
  return row;
}

/**
 * 下载：交给系统浏览器，它会走手机自带的下载管理器，
 * 文件落在「手机存储 / Download」，比存到应用私有目录好找得多。
 */
async function downloadFile(url, name = '', referer = '') {
  if (downloader) {
    try {
      await downloader.enqueue({ url, fileName: name, referer });
      toast('已开始下载，完成后在「手机存储 / Download」查看', 4000);
      return;
    } catch (error) {
      // 落到浏览器兜底
      console.warn('[download] 系统下载失败', error);
    }
  }
  toast('已用浏览器打开，可在浏览器里保存', 3500);
  window.open(url, '_blank');
}

/** 图片墙：图文笔记（小红书、抖音图集）在这里展示并可逐张保存 */
function imageGallery(asset) {
  if (!asset.images?.length) return null;
  const box = document.createElement('div');
  box.className = 'gallery';

  const head = document.createElement('div');
  head.className = 'gallery__head';
  head.textContent = `${asset.mediaType === 'image' ? '图片' : '图片与封面'}（${asset.images.length} 张）`;
  const all = document.createElement('button');
  all.className = 'btn btn--mini';
  all.textContent = '全部保存';
  all.onclick = () => {
    toast(`开始保存 ${asset.images.length} 张图片…`, 3000);
    asset.images.slice(0, 12).forEach((url, index) => {
      setTimeout(() => downloadFile(url, `${asset.title}-${String(index + 1).padStart(2, '0')}.jpg`), index * 600);
    });
  };
  head.append(all);
  box.append(head);

  const grid = document.createElement('div');
  grid.className = 'gallery__grid';
  asset.images.slice(0, 20).forEach((url, index) => {
    const cell = document.createElement('div');
    cell.className = 'gallery__cell';
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    // 图床防盗链会触发 onerror：退回用原生请求重取一次（带 Referer）
    img.onerror = () => retryImageViaNative(img, url, () => cell.classList.add('is-broken'));
    const save = document.createElement('button');
    save.className = 'gallery__save';
    save.textContent = '保存';
    save.onclick = (event) => {
      event.stopPropagation();
      downloadFile(url, `${asset.title}-${String(index + 1).padStart(2, '0')}.jpg`);
    };
    cell.onclick = () => openExternal(url);
    cell.append(img, save);
    if (index === 0 && asset.mediaType !== 'image') {
      const tag = document.createElement('span');
      tag.className = 'gallery__tag';
      tag.textContent = '封面';
      cell.append(tag);
    }
    grid.append(cell);
  });
  box.append(grid);
  return box;
}

function assetCard(asset) {
  const card = document.createElement('div');
  card.className = 'card asset';

  const head = document.createElement('div');
  head.className = 'asset__head';

  if (asset.cover) {
    const cover = document.createElement('img');
    cover.className = 'asset__cover';
    cover.src = asset.cover;
    cover.loading = 'lazy';
    cover.referrerPolicy = 'no-referrer';
    cover.onerror = () => cover.remove();
    head.append(cover);
  }

  const info = document.createElement('div');
  info.style.minWidth = '0';
  const title = document.createElement('h3');
  title.className = 'asset__title';
  title.textContent = asset.title;
  const meta = document.createElement('div');
  meta.className = 'asset__meta';
  for (const [text, cls] of [
    [asset.platformName, 'chip chip--brand'],
    [asset.author, 'chip'],
    [`${asset.variants.length} 个清晰度`, 'chip'],
  ]) {
    if (!text) continue;
    const chip = document.createElement('span');
    chip.className = cls;
    chip.textContent = text;
    meta.append(chip);
  }
  info.append(title, meta);
  head.append(info);
  card.append(head);

  if (asset.variants.length > 0) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = `视频清晰度（${asset.variants.length}）`;
    card.append(label);
    for (const variant of asset.variants.slice(0, 8)) card.append(variantRow(asset, variant));
  }

  const gallery = imageGallery(asset);
  if (gallery) card.append(gallery);

  for (const warning of asset.warnings ?? []) {
    const chip = document.createElement('div');
    chip.className = 'chip chip--warn';
    chip.style.marginTop = '10px';
    chip.textContent = warning;
    card.append(chip);
  }

  if (asset.webpageUrl) {
    const openPage = document.createElement('button');
    openPage.className = 'btn btn--sm';
    openPage.style.marginTop = '12px';
    openPage.textContent = '打开原页面';
    openPage.onclick = () => openExternal(asset.webpageUrl);
    card.append(openPage);
  }

  return card;
}

function renderResults(assets) {
  els.results.replaceChildren();
  if (assets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有结果，先粘贴一个视频链接吧';
    els.results.append(empty);
    return;
  }
  for (const asset of assets) els.results.append(assetCard(asset));
}

async function run() {
  const input = els.input.value.trim();
  if (!input) {
    toast('先粘贴视频链接');
    return;
  }
  if (busy) return;

  busy = true;
  els.go.disabled = true;
  els.go.textContent = '解析中…';
  els.status.textContent = '正在识别平台并抓取页面…';

  try {
    const result = await analyze(input, {
      renderMedia,
      resolveUrl: resolveUrlViaBrowser,
      onProgress: (event) => {
        if (event.stage === 'start') els.status.textContent = `处理第 ${event.index + 1}/${event.total} 条…`;
        if (event.stage === 'done') els.status.textContent = `已完成：${event.title ?? ''}`;
      },
    });
    renderResults(result.assets);
    const empty = result.assets.filter((a) => a.variants.length === 0);
    els.status.textContent =
      `解析完成：成功 ${result.assets.length} 条${result.failures.length ? `，失败 ${result.failures.length} 条` : ''}` +
      // 拿不到直链时把关键信息摊开，便于定位是识别错平台还是浏览器没抓到地址
      (empty.length
        ? `\n诊断：平台=${empty.map((a) => a.platformId).join(',')} · 浏览器渲染 ${renderTrace.calls} 次 · 捕获地址 ${renderTrace.urls} 个 · 图片 ${renderTrace.images} 张` +
          (renderTrace.error ? ` · 渲染报错：${renderTrace.error}` : '') +
          (renderTrace.lastUrl ? `\n渲染地址：${renderTrace.lastUrl}` : '') +
          `\n实际解析地址：${empty[0].webpageUrl || '(空)'}`
        : '');
    if (result.failures.length > 0) toast(result.failures[0].message);
  } catch (error) {
    els.status.textContent = error.message;
    toast(error.message);
  } finally {
    busy = false;
    els.go.disabled = false;
    els.go.textContent = '解析全平台链接';
  }
}

els.go.addEventListener('click', run);
els.clear.addEventListener('click', () => {
  els.input.value = '';
  els.status.textContent = '';
});
els.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    els.input.value = els.input.value ? `${els.input.value}\n${text}` : text;
    toast('已粘贴');
  } catch {
    toast('读取剪贴板失败，请长按输入框粘贴');
  }
});

renderResults([]);

// 启动后后台预热模型：手机上加载 1~2GB 的模型要十几秒，
// 等用户点开对话再加载会很难受；这里在界面就绪后就开始加载。
setTimeout(async () => {
  try {
    if (!cha.pluginAvailable) return;
    const spec = allModels()[0];
    const paths = (await cha.modelPaths(spec)) ?? (await cha.bundledPaths(spec));
    if (!paths) return; // 一个模型都没有，没什么可预热的
    console.log('[cha] 开始后台预热模型');
    await cha.ensureServer(spec, () => {});
    $('engine-badge').textContent = '本地模型已就绪';
    refreshModelUi().catch(() => {});
  } catch (error) {
    console.warn('[cha] 预热失败（不影响使用）', error);
  }
}, 1500);

// 预热隐藏 WebView（加载站点首页缓存 JS 与连接），第一次解析能快好几秒
setTimeout(() => {
  mediaExtractor?.warmUp?.().catch(() => {});
}, 2000);

window.addEventListener('error', (event) => {
  els.badge.textContent = '引擎异常';
  els.status.textContent = event.message;
});

/**
 * FrameLens 渲染层基础库。
 * 采用经典脚本 + 全局命名空间（而非 ES Module），
 * 这样 file:// 下不需要任何打包器也能稳定运行。
 */

(function () {
  const FL = (window.FL = window.FL || {});

  /* ------------------------------------------------------------ IPC 桥 */
  const bridge = window.framelens;

  if (!bridge) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#ff6b81">预加载脚本未注入（window.framelens 不存在），应用无法启动。</div>';
    throw new Error('preload bridge missing');
  }

  FL.api = {
    invoke: (channel, payload) => bridge.invoke(channel, payload),
    on: (event, handler) => bridge.on(event, handler),
    platform: bridge.platform,
  };

  /* ------------------------------------------------------------ DOM 工具 */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /**
   * 极简建元素：h('div.card', { onclick }, [children])
   * 选择器支持 `标签.类名.类名#id`
   */
  function h(selector, props, children) {
    const parts = String(selector).match(/^([a-zA-Z0-9-]*)((?:[.#][\w-]+)*)$/);
    const tag = parts?.[1] || 'div';
    const node = document.createElement(tag);
    for (const token of (parts?.[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
      if (token[0] === '.') node.classList.add(token.slice(1));
      else node.id = token.slice(1);
    }
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className += ` ${value}`;
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
      }
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      children.forEach((child) => append(node, child));
      return;
    }
    node.append(children instanceof Node ? children : document.createTextNode(String(children)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) svg.setAttribute('class', cls);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function button(label, { icon: iconName, variant = 'ghost', size = '', onClick, title } = {}) {
    const node = h(`button.btn.btn--${variant}`, {
      type: 'button',
      title: title ?? label,
      onclick: onClick,
    });
    if (size) node.classList.add(`btn--${size}`);
    if (iconName) node.append(icon(iconName));
    if (label) node.append(h('span', { text: label }));
    return node;
  }

  /* ------------------------------------------------------------ 格式化 */
  const fmt = {
    bytes(value) {
      if (!value || value <= 0) return '未知';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
      const size = value / 1024 ** i;
      return `${size >= 100 || i === 0 ? Math.round(size) : size.toFixed(1)} ${units[i]}`;
    },
    duration(seconds) {
      if (!seconds) return '';
      const total = Math.round(seconds);
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
    },
    time(ts) {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    },
    relative(ts) {
      const diff = Date.now() - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
      return `${Math.floor(diff / 86400000)} 天前`;
    },
    speed(bytesPerSecond) {
      if (!bytesPerSecond) return '';
      return `${fmt.bytes(bytesPerSecond)}/s`;
    },
  };

  /* ------------------------------------------------------------ 文件 URL */
  /** 把本地绝对路径转成渲染进程可安全读取的 flfile:// 地址 */
  function fileUrl(absolutePath) {
    if (!absolutePath) return '';
    const normalized = String(absolutePath).replace(/\\/g, '/').replace(/^\//, '');
    return `flfile://local/${normalized.split('/').map(encodeURIComponent).join('/')}`;
  }

  /* ------------------------------------------------------------ Toast */
  const toastIcons = { ok: 'check', err: 'warn', warn: 'warn', info: 'info' };

  function toast(title, message = '', type = 'info', timeout = 4200) {
    const root = $('#toasts');
    const node = h('div.toast', { class: `toast--${type}` });
    node.append(icon(toastIcons[type] ?? 'info'));
    node.append(
      h('div.toast__body', {}, [
        h('div.toast__title', { text: title }),
        message ? h('div.toast__msg', { text: message }) : null,
      ]),
    );
    root.append(node);
    const dismiss = () => {
      node.classList.add('toast--out');
      setTimeout(() => node.remove(), 240);
    };
    node.addEventListener('click', dismiss);
    if (timeout) setTimeout(dismiss, timeout);
    return dismiss;
  }

  /* ------------------------------------------------------------ 状态 */
  const state = {
    settings: null,
    info: null,
    modelStatus: null,
    parseResults: [],
    tasks: [],
    chat: { messages: [], images: [], busy: false, streaming: '' },
    listeners: new Set(),
  };

  function emit(event) {
    state.listeners.forEach((fn) => {
      try {
        fn(event);
      } catch (error) {
        console.error('[state listener]', error);
      }
    });
  }

  function subscribe(fn) {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  }

  async function loadSettings() {
    state.settings = await FL.api.invoke('settings:get');
    applyTheme(state.settings.theme);
    emit({ type: 'settings', settings: state.settings });
    return state.settings;
  }

  async function patchSettings(partial) {
    state.settings = await FL.api.invoke('settings:patch', partial);
    applyTheme(state.settings.theme);
    emit({ type: 'settings', settings: state.settings });
    return state.settings;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  async function refreshModelStatus() {
    state.modelStatus = await FL.api.invoke('model:status');
    emit({ type: 'models', status: state.modelStatus });
    updateEngineBadge();
    return state.modelStatus;
  }

  /**
   * 导入用户自己的 GGUF 模型（主模型 + mmproj 可一次选中，按文件名自动区分）。
   * 放在公共层是因为「模型中心」和「模型对话」两个页面都有入口，
   * 两边调用同一套逻辑，避免只有一处能导入。
   */
  async function importLocalModel() {
    let stop = null;
    try {
      stop = toast('请选择 GGUF 模型文件', '可一次选中主模型与 mmproj 两个文件', 'info', 0);
      const result = await FL.api.invoke('model:import');
      if (result?.canceled) return { canceled: true };
      if (!result?.ok) throw new Error(result?.error ?? '导入失败');
      stop?.();
      toast('模型导入成功', `${result.model.name}，已登记为自定义模型，可直接切换使用`, 'ok', 6000);
      await refreshModelStatus();
      return result;
    } catch (error) {
      stop?.();
      toast('导入失败', error.message, 'err', 7000);
      return { ok: false, error: error.message };
    }
  }

  function updateEngineBadge(override) {
    const dot = $('#engine-dot');
    const label = $('#engine-label');
    if (!dot || !label) return;
    let stateName = 'idle';
    let text = '引擎未加载';

    if (override) {
      stateName = override.state;
      text = override.text;
    } else if (state.modelStatus) {
      const server = state.modelStatus.server;
      const active = state.modelStatus.models.find((m) => m.active);
      const installed = state.modelStatus.models.filter((m) => m.installed);
      if (server?.state === 'ready') {
        stateName = 'ready';
        text = `${active?.name ?? '模型'} 已加载${server.vision ? ' · 视觉就绪' : ''}`;
      } else if (installed.length > 0) {
        stateName = 'warn';
        text = '模型已就绪，等待唤醒';
      } else {
        stateName = 'idle';
        text = '还没有本地模型';
      }
    }
    dot.dataset.state = stateName;
    label.textContent = text;
  }

  /* ------------------------------------------------------------ 剪贴板 */
  async function copyText(text, message = '已复制') {
    try {
      await navigator.clipboard.writeText(String(text));
      toast(message, '', 'ok', 1800);
      return true;
    } catch {
      const area = h('textarea', { value: String(text) });
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      toast(ok ? message : '复制失败，请手动选择', '', ok ? 'ok' : 'err', 2200);
      return ok;
    }
  }

  /* ------------------------------------------------------------ 页面容器 */
  function pageRoot(name) {
    return $(`.page[data-page="${name}"]`);
  }

  /* ------------------------------------------------------------ 弹层 */
  function closeModal() {
    const root = $('#modal-root');
    if (!root) return;
    root.classList.remove('is-open');
    root.replaceChildren();
    document.removeEventListener('keydown', onModalKey);
  }

  function onModalKey(event) {
    if (event.key === 'Escape') closeModal();
  }

  /**
   * 通用弹层。
   * @param {{title:string, body:Node|string, footer?:Node[], width?:number}} options
   */
  function modal({ title, body, footer = [], width }) {
    const root = $('#modal-root');
    const dialog = h('div.modal', width ? { style: { width: `${width}px` } } : {});
    const head = h('div.card__head', {}, [
      h('div.card__title', { text: title }),
      h('div', { style: { marginLeft: 'auto' } }, [
        h('button.iconbtn', { type: 'button', title: '关闭', onclick: closeModal }, [icon('close')]),
      ]),
    ]);
    const content = h('div.card__body', {}, [
      typeof body === 'string' ? h('div', { text: body }) : body,
      footer.length ? h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' } }, footer) : null,
    ]);
    dialog.append(head, content);
    root.replaceChildren(dialog);
    root.classList.add('is-open');
    root.addEventListener('click', (event) => {
      if (event.target === root) closeModal();
    });
    document.addEventListener('keydown', onModalKey);
    return closeModal;
  }

  /** 图片预览：解析结果里的封面/图片点开就能大图查看 */
  function previewImage(url, caption = '') {
    if (!url) return;
    modal({
      title: caption || '图片预览',
      width: 860,
      body: h('div', { style: { display: 'grid', placeItems: 'center', gap: '12px' } }, [
        h('img', { src: url, referrerpolicy: 'no-referrer', style: { maxWidth: '100%', maxHeight: '62vh', borderRadius: '12px' } }),
        h('div.variant__url', { text: url, style: { maxWidth: '100%' } }),
      ]),
      footer: [
        button('复制图片地址', { icon: 'copy', onClick: () => copyText(url, '图片地址已复制') }),
        button('在浏览器打开', { icon: 'globe', variant: 'primary', onClick: () => FL.api.invoke('app:openExternal', { url }) }),
      ],
    });
  }

  function pageHead(title, subtitle, actions = []) {
    const head = h('div.page-head', {}, [
      h('div', {}, [h('h1', { text: title }), subtitle ? h('p', { text: subtitle }) : null]),
      h('div.page-head__actions', {}, actions),
    ]);
    return head;
  }

  function emptyState(iconName, title, description) {
    return h('div.empty', {}, [icon(iconName), h('h3', { text: title }), description ? h('p', { text: description }) : null]);
  }

  /* ------------------------------------------------------------ 简易 Markdown */
  /** 只处理代码块 / 行内代码 / 粗体 / 行内链接，够用且绝对安全 */
  function renderMarkdown(text) {
    const escaped = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/```([\s\S]*?)```/g, (_, code) => `\n${code.trim()}\n`)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  }

  function debounce(fn, wait = 220) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * 页面注册表。
   * 必须放在 core.js（最先加载）里：pages/*.js 在 app.js 之前执行，
   * 那时如果 registerPage 还不存在，所有页面都会注册失败。
   */
  const pages = {};

  function registerPage(name, definition) {
    pages[name] = definition;
  }

  Object.assign(FL, {
    h,
    $,
    $$,
    clear,
    append,
    icon,
    button,
    fmt,
    fileUrl,
    toast,
    state,
    subscribe,
    emit,
    loadSettings,
    patchSettings,
    applyTheme,
    refreshModelStatus,
    importLocalModel,
    updateEngineBadge,
    copyText,
    modal,
    closeModal,
    previewImage,
    pageRoot,
    pageHead,
    emptyState,
    renderMarkdown,
    debounce,
    uid,
    pages,
    registerPage,
  });
})();

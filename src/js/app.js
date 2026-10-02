/**
 * 应用外壳：路由、事件总线接线、启动流程。
 */

(function () {
  const { h, $, $$, api, state, toast, updateEngineBadge } = window.FL;
  const FL = window.FL;

  let currentPage = 'home';

  function navigate(name, options = {}) {
    if (!FL.pages[name]) return;
    if (currentPage === name && !options.force) {
      FL.pages[name].focus?.(options);
      return;
    }

    $$('.rail__item').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === name));
    $$('.page').forEach((page) => page.classList.toggle('is-active', page.dataset.page === name));
    $('#main').scrollTop = 0;

    const previous = currentPage;
    currentPage = name;
    FL.pages[name].enter?.({ previous, ...options });
    FL.patchSettings({ ui: { lastPage: name } }).catch(() => {});
  }

  /* ---------------------------------------------------------- 全局事件 */
  function wireEvents() {
    api.on('download:event', (event) => {
      const task = event.task;
      const index = state.tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) state.tasks[index] = task;
      else state.tasks.unshift(task);

      const label = $('#task-badge');
      const running = state.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
      label.textContent = running > 0 ? String(running) : '';
      label.classList.toggle('is-on', running > 0);

      if (event.type === 'completed') toast('下载完成', task.title, 'ok');
      if (event.type === 'failed') toast('下载失败', `${task.title}：${task.error}`, 'err');

      FL.emit({ type: 'tasks' });
    });

    api.on('extract:progress', (event) => FL.emit({ type: 'extract-progress', event }));
    api.on('model:progress', (event) => FL.emit({ type: 'model-progress', event }));
    api.on('chat:token', (event) => FL.emit({ type: 'chat-token', event }));
    api.on('log:entry', (entry) => FL.emit({ type: 'log', entry }));
  }

  function wireNav() {
    $$('.rail__item').forEach((item) => {
      item.addEventListener('click', () => navigate(item.dataset.nav));
    });
    // Ctrl/Cmd + 1..8 快速切换
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1) return;
      const names = ['home', 'parse', 'chat', 'vision', 'video', 'tasks', 'models', 'settings'];
      if (names[index - 1]) {
        event.preventDefault();
        navigate(names[index - 1]);
      }
    });
  }

  async function boot() {
    wireNav();
    wireEvents();

    try {
      state.info = await api.invoke('app:info');
    } catch (error) {
      console.error(error);
    }

    try {
      await FL.loadSettings();
    } catch (error) {
      toast('读取配置失败', error.message, 'err');
    }

    Object.entries(FL.pages).forEach(([name, definition]) => {
      const root = FL.pageRoot(name);
      if (!root) return;
      try {
        definition.mount?.(root);
      } catch (error) {
        console.error(`[page:${name}] mount 失败`, error);
      }
    });

    try {
      await FL.refreshModelStatus();
    } catch (error) {
      updateEngineBadge({ state: 'error', text: '引擎状态未知' });
    }

    const startPage = state.settings?.ui?.lastPage || 'home';
    navigate(FL.pages[startPage] ? startPage : 'home', { force: true });
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
      console.error(error);
      document.body.append(
        h('div', {
          style: { padding: '40px', fontFamily: 'monospace', color: '#ff6b81' },
          text: `启动失败：${error.message}`,
        }),
      );
    });
  });

  FL.navigate = navigate;
})();

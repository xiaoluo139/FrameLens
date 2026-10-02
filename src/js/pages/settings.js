/**
 * 设置：外观、下载、网络、模型参数、诊断与日志。
 */

(function () {
  const { h, button, icon, api, state, toast, subscribe } = window.FL;

  let root = null;
  let diagBox = null;
  let logBox = null;
  let infoBox = null;
  const logs = [];

  function buildHeader() {
    return window.FL.pageHead('设置', '所有配置保存在本机，改完立即生效。', [
      button('恢复默认', { icon: 'refresh', onClick: reset }),
    ]);
  }

  function row(title, description, control, wide = false) {
    return h('div.setting-row', {}, [
      h('div.setting-row__text', {}, [h('b', { text: title }), description ? h('span', { text: description }) : null]),
      h('div', { class: `setting-row__control${wide ? ' setting-row__control--wide' : ''}` }, [control]),
    ]);
  }

  function section(title, subtitle, rows) {
    return h('div.card', { style: { marginBottom: '16px' } }, [
      h('div.card__head', {}, [h('div.card__title', { text: title }), subtitle ? h('div.card__sub', { text: subtitle }) : null]),
      h('div.card__body', {}, rows),
    ]);
  }

  function buildBody() {
    const settings = state.settings;

    const themeSelect = h('select.select', {
      onchange: (event) => window.FL.patchSettings({ theme: event.target.value }),
    }, [
      h('option', { value: 'dark', selected: settings.theme === 'dark', text: '深色（默认）' }),
      h('option', { value: 'light', selected: settings.theme === 'light', text: '浅色' }),
    ]);

    const outputInput = h('input.input', {
      value: settings.download.outputDir || state.info?.paths?.downloads || '',
      placeholder: '默认：用户目录 / Downloads / FrameLens',
      onchange: (event) => window.FL.patchSettings({ download: { outputDir: event.target.value } }).then(() => toast('下载目录已更新', '', 'ok')),
    });

    const parallelInput = h('input.input', {
      type: 'number',
      min: 1,
      max: 12,
      value: settings.download.maxParallel,
      onchange: (event) => window.FL.patchSettings({ download: { maxParallel: Number(event.target.value) } }),
    });

    const intervalInput = h('input.input', {
      type: 'number',
      min: 0,
      max: 60,
      value: settings.download.downloadInterval,
      onchange: (event) => window.FL.patchSettings({ download: { downloadInterval: Number(event.target.value) } }),
    });

    const timeoutInput = h('input.input', {
      type: 'number',
      min: 5000,
      max: 120000,
      step: 1000,
      value: settings.network.timeoutMs,
      onchange: (event) => window.FL.patchSettings({ network: { timeoutMs: Number(event.target.value) } }).then(() => toast('超时时间已更新', '重启后生效', 'ok')),
    });

    const temperatureInput = h('input', {
      type: 'range',
      min: 0,
      max: 1.5,
      step: 0.05,
      value: settings.model.temperature,
      oninput: (event) => {
        temperatureValue.textContent = Number(event.target.value).toFixed(2);
      },
      onchange: (event) => window.FL.patchSettings({ model: { temperature: Number(event.target.value) } }),
    });
    const temperatureValue = h('span.card__sub', { text: Number(settings.model.temperature).toFixed(2) });

    const contextSelect = h('select.select', {
      onchange: (event) => window.FL.patchSettings({ model: { contextsPerSequence: Number(event.target.value) } }),
    }, [2048, 4096, 8192, 16384].map((size) =>
      h('option', { value: size, selected: settings.model.contextsPerSequence === size, text: `${size} tokens` }),
    ));

    const systemPrompt = h('textarea.textarea', {
      value: settings.chat.systemPrompt,
      onchange: (event) => window.FL.patchSettings({ chat: { systemPrompt: event.target.value } }).then(() => toast('系统提示词已保存', '', 'ok')),
    });

    diagBox = h('div');
    logBox = h('div.log-view');
    infoBox = h('div');

    return h('div', {}, [
      section('外观', '', [row('主题', '深色适合夜间与演示，浅色适合明亮环境', themeSelect)]),
      section('下载', '视频默认下载到「下载目录 / 平台-标题」子文件夹里', [
        row('保存目录', outputInput.value, h('div', { style: { display: 'flex', gap: '6px', width: '100%' } }, [
          outputInput,
          button('', { icon: 'folder', size: 'sm', title: '选择目录', onClick: pickFolder }),
        ]), true),
        row('最大并行下载数', '同时下载几个视频，默认 3', parallelInput),
        row('任务间隔（秒）', '每个下载任务之间的启动间隔，默认 3 秒', intervalInput),
      ]),
      section('网络', '所有解析请求都由本机发出', [
        row('请求超时（毫秒）', '网络较慢时可以调大', timeoutInput),
      ]),
      section('模型与生成', '影响对话与识别的表现', [
        row('上下文长度', '越大越能记住长内容，也更吃内存；下次加载模型生效', contextSelect),
        row('温度', '越低越稳定，越高越发散', h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%' } }, [temperatureInput, temperatureValue]), true),
        row('系统提示词', '每次对话都会带上这段设定', systemPrompt, true),
      ]),
      h('div.card', { style: { marginBottom: '16px' } }, [
        h('div.card__head', {}, [
          h('div.card__title', { text: '运行诊断' }),
          h('div', { style: { marginLeft: 'auto' } }, [button('开始检测', { icon: 'refresh', size: 'sm', onClick: runDiagnose })]),
        ]),
        h('div.card__body', {}, [diagBox]),
      ]),
      h('div.card', { style: { marginBottom: '16px' } }, [
        h('div.card__head', {}, [
          h('div.card__title', { text: '运行日志' }),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, [
            button('复制日志', {
              size: 'sm',
              icon: 'copy',
              onClick: () => window.FL.copyText(logs.map((l) => `${l.level} [${l.scope}] ${l.message}`).join('\n'), '日志已复制'),
            }),
          ]),
        ]),
        h('div.card__body', {}, [logBox]),
      ]),
      h('div.card', {}, [
        h('div.card__head', {}, [h('div.card__title', { text: '关于' })]),
        h('div.card__body', {}, [infoBox]),
      ]),
    ]);
  }

  async function pickFolder() {
    const dir = await api.invoke('app:chooseDirectory', { title: '选择下载目录' });
    if (!dir) return;
    await window.FL.patchSettings({ download: { outputDir: dir } });
    toast('下载目录已更新', dir, 'ok');
    draw();
  }

  async function reset() {
    state.settings = await api.invoke('settings:reset');
    window.FL.applyTheme(state.settings.theme);
    toast('已恢复默认设置', '', 'ok');
    draw();
  }

  async function runDiagnose() {
    diagBox.replaceChildren(h('div.skeleton', { style: { height: '120px' } }));
    try {
      const result = await api.invoke('system:diagnose');
      diagBox.replaceChildren(
        ...result.checks.map((check) =>
          h('div.diag-item', {}, [
            icon(check.ok ? 'check' : 'warn', check.ok ? 'diag-ok' : 'diag-warn'),
            h('div', {}, [
              h('b', { text: `${check.ok ? '✅' : '⚠️'} ${check.name}` }),
              h('p', { text: check.detail }),
              check.hint ? h('p', { text: `建议：${check.hint}` }) : null,
            ]),
          ]),
        ),
      );
      diagBox.querySelectorAll('svg').forEach((svg) => {
        svg.style.color = svg.classList.contains('diag-ok') ? 'var(--ok)' : 'var(--warn)';
      });
    } catch (error) {
      diagBox.replaceChildren(h('div.diag-item', {}, [icon('warn'), h('div', {}, [h('b', { text: '检测失败' }), h('p', { text: error.message })])]));
    }
  }

  function renderLogs() {
    logBox.replaceChildren(
      ...logs.slice(-120).map((entry) =>
        h('div.log-line', { dataset: { level: entry.level } }, [
          h('b', { text: window.FL.fmt.time(entry.ts) }),
          h('span', { text: `[${entry.scope}] ${entry.message}` }),
        ]),
      ),
    );
    logBox.scrollTop = logBox.scrollHeight;
  }

  function renderInfo() {
    const info = state.info;
    if (!info) return;
    infoBox.replaceChildren(
      h('div.grid.grid--2', {}, [
        h('div', {}, [
          h('div.card__sub', { text: '版本' }),
          h('div', { text: `${info.name} ${info.version}` }),
          h('div.card__sub', { text: '内核', style: { marginTop: '10px' } }),
          h('div', { text: `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}` }),
        ]),
        h('div', {}, [
          h('div.card__sub', { text: '数据目录' }),
          h('div', { text: info.paths.userData, style: { userSelect: 'text', wordBreak: 'break-all' } }),
          h('div.card__sub', { text: '模型目录', style: { marginTop: '10px' } }),
          h('div', { text: info.paths.models, style: { userSelect: 'text', wordBreak: 'break-all' } }),
        ]),
      ]),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } }, [
        button('打开数据目录', { size: 'sm', icon: 'folder', onClick: () => api.invoke('app:openPath', { path: info.paths.userData }) }),
        button('打开模型目录', { size: 'sm', icon: 'folder', onClick: () => api.invoke('app:openPath', { path: info.paths.models }) }),
        button('项目主页', { size: 'sm', icon: 'globe', onClick: () => api.invoke('app:openExternal', { url: 'https://github.com/ggml-org/llama.cpp' }) }),
      ]),
      h('p.card__sub', {
        style: { marginTop: '14px' },
        text: '本软件仅提供本地解析与本地推理能力，请遵守各平台的服务条款与著作权规定，仅下载你有权保存的内容。',
      }),
    );
  }

  function draw() {
    if (!root) return;
    root.replaceChildren(buildHeader(), buildBody());
    renderInfo();
    renderLogs();
  }

  window.FL.registerPage('settings', {
    mount(container) {
      root = container;
      api.invoke('logs:recent').then((entries) => {
        logs.push(...entries);
        renderLogs();
      });
      subscribe((event) => {
        if (event.type === 'log') {
          logs.push(event.entry);
          if (logs.length > 400) logs.splice(0, logs.length - 400);
          renderLogs();
        }
      });
      draw();
    },
    enter() {
      draw();
    },
  });
})();

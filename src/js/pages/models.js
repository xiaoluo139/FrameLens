/**
 * 模型中心：运行时安装、模型下载与管理、镜像选择、硬件建议。
 */

(function () {
  const { h, button, icon, api, state, toast, subscribe, fmt } = window.FL;

  let root = null;
  let runtimeCard = null;
  let catalogGrid = null;
  let hardwareCard = null;
  let customCard = null;
  const progressMap = new Map();
  /** 模型自检结果：id -> { ok, reason, reply } */
  const verifyMap = new Map();

  function buildHeader() {
    return window.FL.pageHead('模型中心', '推理引擎与模型都装在你自己电脑上。先下载一个模型即可离线使用，之后换模型只需切换。', [
      button('导入本地模型', { icon: 'plus', variant: 'primary', onClick: importModel }),
      button('刷新状态', { icon: 'refresh', onClick: refresh }),
    ]);
  }

  /**
   * 导入用户自己的 GGUF 模型。
   * 选文件时可以把「主模型 + mmproj」一起选上，程序会按文件名自动区分。
   */
  async function importModel() {
    // 与「模型对话」页共用同一套导入逻辑
    await window.FL.importLocalModel();
    await refresh();
  }

  /**
   * 自定义模型卡片：常驻在页面正文里。
   * 之前只有页面右上角一个按钮，窗口窄或被忽略时用户就找不到入口了。
   */
  function renderCustom() {
    if (!customCard) return;
    const custom = (state.modelStatus?.models ?? []).filter((model) => model.repo === '本地导入');

    customCard.replaceChildren(
      h('div.card', {}, [
        h('div.card__head', {}, [
          h('div.card__title', { text: '自定义模型' }),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '9px', flexWrap: 'wrap' } }, [
            h('span.chip', { text: custom.length > 0 ? `已导入 ${custom.length} 个` : '还没有导入' }),
            button('导入本地模型', { icon: 'plus', variant: 'primary', size: 'sm', onClick: importModel }),
          ]),
        ]),
        h('div.card__body', {}, [
          h('div.setting-row', {}, [
            h('div.setting-row__text', {}, [
              h('b', { text: '用自己的 GGUF 模型' }),
              h('span', {
                text: '选「主模型 .gguf」和可选的 mmproj 视觉投影文件即可，导入后在本机离线运行，也可以随时移除。',
              }),
            ]),
          ]),
          custom.length === 0
            ? h('div.card__sub', { text: '还没有自定义模型。点上面的「导入本地模型」，选中电脑里的 .gguf 文件就行。' })
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' } },
                custom.map((model) =>
                  h('div.setting-row', {}, [
                    h('div.setting-row__text', {}, [
                      h('b', { text: model.name }),
                      h('span', {
                        text: `${model.installed ? `可用 · ${fmt.bytes(model.installedBytes)}` : '文件缺失，请重新导入'}${model.active ? ' · 当前使用中' : ''}`,
                      }),
                    ]),
                    h('div.setting-row__control', {}, [
                      model.installed && !model.active
                        ? button('设为当前', { size: 'sm', onClick: () => activate(model.id) })
                        : null,
                      button('移除', {
                        size: 'sm',
                        icon: 'trash',
                        onClick: async () => {
                          const result = await api.invoke('model:removeCustom', { modelId: model.id });
                          if (result.ok) {
                            toast('已移除自定义模型', model.name, 'ok');
                            await refresh();
                          } else {
                            toast('移除失败', result.error ?? '', 'err');
                          }
                        },
                      }),
                    ]),
                  ]),
                ),
              ),
        ]),
      ]),
    );
  }

  function renderRuntime() {
    const status = state.modelStatus;
    if (!status) return;
    const preferMirror = state.settings?.network?.preferMirror;
    const accel = state.settings?.model?.accel ?? 'auto';

    runtimeCard.replaceChildren(
      h('div.card', {}, [
        h('div.card__head', {}, [
          h('div.card__title', { text: '推理引擎（llama.cpp）' }),
          h('div', { style: { marginLeft: 'auto' } }, [
            status.runtime.installed
              ? h('span.chip.chip--ok', {}, [icon('check'), '已安装'])
              : h('span.chip.chip--warn', {}, [icon('warn'), '未安装']),
          ]),
        ]),
        h('div.card__body', {}, [
          h('div.setting-row', {}, [
            h('div.setting-row__text', {}, [
              h('b', { text: status.runtime.installed ? '已就绪' : '首次使用会自动下载（约 15 MB）' }),
              h('span', { text: status.runtime.serverPath || '安装后完全离线运行，不再需要联网' }),
            ]),
            h('div.setting-row__control', {}, [
              status.runtime.installed
                ? null
                : button('立即安装', { icon: 'download', variant: 'primary', onClick: () => installRuntime() }),
            ]),
          ]),
          h('div.setting-row', {}, [
            h('div.setting-row__text', {}, [
              h('b', { text: '加速方式' }),
              h('span', {
                text:
                  status.hardware?.gpu?.detected
                    ? `检测到显卡：${status.hardware.gpu.name}${accel === 'cpu' ? '，当前用 CPU 跑（最稳），可切换 GPU 提速' : ''}`
                    : '未检测到独立显卡，建议保持 CPU',
              }),
            ]),
            h('div.setting-row__control', {}, [
              h('select.select', {
                onchange: (event) => window.FL.patchSettings({ model: { accel: event.target.value } }).then(() => toast('加速方式已更新', '下次加载模型生效', 'ok')),
              }, [
                h('option', { value: 'auto', selected: accel === 'auto', text: '自动（CPU，最稳）' }),
                h('option', { value: 'cpu', selected: accel === 'cpu', text: 'CPU' }),
                h('option', { value: 'cuda', selected: accel === 'cuda', text: 'NVIDIA CUDA' }),
                h('option', { value: 'vulkan', selected: accel === 'vulkan', text: 'Vulkan（通用 GPU）' }),
              ]),
            ]),
          ]),
          h('div.setting-row', {}, [
            h('div.setting-row__text', {}, [
              h('b', { text: '模型下载源' }),
              h('span', { text: preferMirror ? '国内镜像 hf-mirror.com（推荐国内网络）' : 'HuggingFace 官方' }),
            ]),
            h('div.setting-row__control', {}, [
              h('select.select', {
                onchange: (event) => window.FL.patchSettings({ network: { preferMirror: event.target.value === 'mirror' } }),
              }, [
                h('option', { value: 'mirror', selected: preferMirror, text: '国内镜像（推荐）' }),
                h('option', { value: 'hf', selected: !preferMirror, text: 'HuggingFace 官方' }),
              ]),
            ]),
          ]),
        ]),
      ]),
    );
  }

  function modelCard(model) {
    const progress = progressMap.get(model.id);
    const busy = progress && progress < 100;

    return h('div.model-card', { class: model.active ? 'is-active' : '' }, [
      h('div.model-card__head', {}, [
        h('div', {}, [
          h('h3', { text: model.name }),
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } }, [
            h('span.chip.chip--brand', { text: model.badge }),
            h('span.chip', { text: model.kind === 'vision' ? '视觉 + 文本' : '纯文本' }),
            h('span.chip', { text: `约 ${fmt.bytes(model.approxBytes)}` }),
            h('span.chip', { text: `需 ${model.minRamGb}G 内存` }),
          ]),
        ]),
        h('div', { style: { marginLeft: 'auto', flex: 'none' } }, [
          model.active ? h('span.chip.chip--ok', {}, [icon('check'), '当前使用']) : null,
          model.installed && !model.active
            ? button('设为当前', { size: 'sm', onClick: () => activate(model.id) })
            : null,
        ]),
      ]),
      h('p.model-card__desc', { text: model.description }),
      busy
        ? h('div', {}, [
            h('div.progress', {}, [h('div.progress__bar', { style: { width: `${progress}%` } })]),
            h('div.card__sub', { text: progressMap.get(`${model.id}:msg`) ?? '下载中…', style: { marginTop: '6px' } }),
          ])
        : null,
      h('div.model-card__foot', {}, [
        model.installed
          ? h('span.chip.chip--ok', {}, [icon('check'), `已下载 ${fmt.bytes(model.installedBytes)}`])
          : model.repo === '本地导入'
            ? h('span.chip.chip--warn', {}, [icon('warn'), '文件缺失'])
            : button('下载模型', { icon: 'download', variant: 'primary', size: 'sm', onClick: () => download(model.id) }),
        model.installed
          ? button(verifyMap.has(model.id) ? '重新自检' : '自检', {
              size: 'sm',
              icon: 'refresh',
              onClick: () => verify(model.id),
            })
          : null,
        verifyMap.has(model.id)
          ? h(
              'span',
              {
                class: `chip ${verifyMap.get(model.id).ok ? 'chip--ok' : 'chip--err'}`,
                title: verifyMap.get(model.id).reason,
              },
              [verifyMap.get(model.id).ok ? '自检通过' : '自检未通过'],
            )
          : null,
        // 自定义模型可以删掉（内置模型只提供下载，不提供删除）
        model.repo === '本地导入'
          ? button('移除', {
              size: 'sm',
              icon: 'trash',
              onClick: async () => {
                const result = await api.invoke('model:removeCustom', { modelId: model.id });
                if (result.ok) {
                  toast('已移除自定义模型', model.name, 'ok');
                  await refresh();
                } else {
                  toast('移除失败', result.error ?? '', 'err');
                }
              },
            })
          : null,
        h('span.card__sub', { text: model.repo, style: { marginLeft: 'auto', fontSize: '11px' } }),
      ]),
      verifyMap.has(model.id) && !verifyMap.get(model.id).ok
        ? h('div.card__sub', { text: `自检未通过：${verifyMap.get(model.id).reason}`, style: { color: 'var(--err)' } })
        : null,
      model.compatWarning
        ? h('div.card__sub', { text: `兼容性提示：${model.compatWarning}`, style: { color: 'var(--warn)' } })
        : null,
    ]);
  }

  function renderCatalog() {
    const models = state.modelStatus?.models ?? [];
    catalogGrid.replaceChildren(...models.map(modelCard));
  }

  function renderHardware() {
    const hw = state.modelStatus?.hardware;
    if (!hw) return;
    hardwareCard.replaceChildren(
      h('div.card', {}, [
        h('div.card__head', {}, [h('div.card__title', { text: '本机硬件' })]),
        h('div.card__body', {}, [
          h('div.grid.grid--3', {}, [
            h('div', {}, [h('div.card__sub', { text: '处理器' }), h('div', { text: hw.cpuModel })]),
            h('div', {}, [h('div.card__sub', { text: '核心 / 线程' }), h('div', { text: `${hw.cores}` })]),
            h('div', {}, [h('div.card__sub', { text: '内存' }), h('div', { text: `${hw.totalRamGb} GB（可用 ${hw.freeRamGb} GB）` })]),
            h('div', {}, [h('div.card__sub', { text: '显卡' }), h('div', { text: hw.gpu?.detected ? hw.gpu.name : '未检测到独立显卡' })]),
            h('div', {}, [h('div.card__sub', { text: '系统' }), h('div', { text: `${hw.platform} ${hw.arch}` })]),
            h('div', {}, [h('div.card__sub', { text: '推荐模型' }), h('div', { text: state.modelStatus.models.find((m) => m.id === hw.recommendedModelId)?.name ?? '—' })]),
          ]),
        ]),
      ]),
    );
  }

  async function refresh() {
    state.modelStatus = await api.invoke('model:status');
    renderAll();
  }

  function renderAll() {
    renderRuntime();
    renderCatalog();
    renderCustom();
    renderHardware();
  }

  async function download(modelId) {
    const requestId = window.FL.uid('model');
    progressMap.set(modelId, 0);
    renderCatalog();
    try {
      const result = await api.invoke('model:download', { modelId, requestId });
      if (result.ok) {
        toast('模型下载完成', '', 'ok');
        await refresh();
        // 下载完立刻自检：模型与推理引擎不兼容时用户会立刻知道，而不是等到提问才发现
        await verify(modelId);
      }
    } catch (error) {
      toast('模型下载失败', error.message, 'err', 8000);
    } finally {
      progressMap.delete(modelId);
      renderCatalog();
    }
  }

  /** 模型自检：跑一次极短生成，判断输出是否像正常语言 */
  async function verify(modelId) {
    verifyMap.set(modelId, { ok: true, reason: '检测中…' });
    renderCatalog();
    try {
      const result = await api.invoke('model:verify', { modelId });
      verifyMap.set(modelId, result);
      if (result.ok) toast('模型自检通过', result.reply || '', 'ok');
      else toast('模型自检未通过', result.reason, 'err', 9000);
    } catch (error) {
      verifyMap.set(modelId, { ok: false, reason: error.message });
      toast('自检失败', error.message, 'err');
    }
    renderCatalog();
  }

  async function installRuntime() {
    const requestId = window.FL.uid('runtime');
    toast('开始安装推理引擎', '约 15 MB，稍等片刻', 'info');
    try {
      await api.invoke('model:installRuntime', { requestId });
      toast('推理引擎安装完成', '', 'ok');
      await refresh();
    } catch (error) {
      toast('安装失败', error.message, 'err', 8000);
    }
  }

  async function activate(modelId) {
    state.modelStatus = await api.invoke('model:activate', { modelId });
    window.FL.updateEngineBadge();
    toast('已切换当前模型', '', 'ok');
    renderAll();
  }

  window.FL.registerPage('models', {
    mount(container) {
      root = container;
      runtimeCard = h('div');
      catalogGrid = h('div.grid.grid--2', { style: { marginTop: '16px' } });
      customCard = h('div', { style: { marginTop: '16px' } });
      hardwareCard = h('div', { style: { marginTop: '16px' } });
      container.append(
        buildHeader(),
        runtimeCard,
        customCard,
        h('div.card__title', { text: '可选模型', style: { marginTop: '20px' } }),
        catalogGrid,
        hardwareCard,
      );
      subscribe((event) => {
        if (event.type === 'models') renderAll();
        if (event.type === 'model-progress') {
          const { modelId, percent, message } = event.event;
          if (!modelId) return;
          progressMap.set(modelId, percent);
          progressMap.set(`${modelId}:msg`, message);
          renderCatalog();
        }
      });
      renderAll();
    },
    enter() {
      refresh().catch(() => {});
    },
  });
})();

/**
 * 工作台：一屏看全「解析 + 对话」两条主线的入口与状态。
 */

(function () {
  const { h, $, button, icon, fmt, state, api, subscribe, emptyState } = window.FL;

  let root = null;

  function statCard(label, iconName, value, unit, hint) {
    return h('div.stat', {}, [
      h('div.stat__label', {}, [icon(iconName), label]),
      h('div.stat__value', {}, [String(value), unit ? h('small', { text: unit }) : null]),
      hint ? h('div.stat__label', { text: hint, style: { marginTop: '4px' } }) : null,
    ]);
  }

  function quickAction(iconName, title, subtitle, onclick) {
    return h('button.quick', { type: 'button', onclick }, [
      h('div.quick__icon', {}, [icon(iconName)]),
      h('div.quick__text', {}, [h('b', { text: title }), h('span', { text: subtitle })]),
    ]);
  }

  function render() {
    const models = state.modelStatus?.models ?? [];
    const installed = models.filter((m) => m.installed);
    const active = models.find((m) => m.active);
    const server = state.modelStatus?.server ?? {};
    const doneTasks = state.tasks.filter((t) => t.status === 'completed').length;
    const hw = state.modelStatus?.hardware;

    const hero = h('div.hero', {}, [
      h('h1', { text: '一个软件，解析全平台视频，也能跟本地模型聊天' }),
      h('p', {
        text: '把链接丢进来就能拿到各清晰度直链并下载；图片、视频关键帧交给本地小模型理解。模型与推理引擎全部在本机运行，断网也能用，不需要注册账号。',
      }),
      h('div.hero__actions', {}, [
        button('解析全平台链接', {
          icon: 'globe',
          variant: 'primary',
          size: 'xl',
          onClick: () => window.FL.navigate('parse', { focus: true }),
        }),
        button('跟模型聊聊', { icon: 'chat', variant: 'ghost', size: 'xl', onClick: () => window.FL.navigate('chat', { focus: true }) }),
      ]),
      h('div.hero__meta', {}, [
        h('span', {}, ['本地模型：', h('b', { text: installed.length > 0 ? (active?.name ?? installed[0].name) : '尚未下载' })]),
        h('span', {}, ['推理引擎：', h('b', { text: server.state === 'ready' ? '运行中' : state.modelStatus?.runtime?.installed ? '已就绪' : '未安装' })]),
        h('span', {}, ['运行模式：', h('b', { text: '完全离线' })]),
      ]),
    ]);

    const stats = h('div.grid.grid--4', { style: { marginBottom: '18px' } }, [
      statCard('本次解析', 'link', state.parseResults.length, '条', state.parseResults.length ? `最近：${state.parseResults[0]?.platformName ?? ''}` : '还没有解析记录'),
      statCard('下载任务', 'download', state.tasks.length, '个', doneTasks > 0 ? `已完成 ${doneTasks} 个` : '暂无完成记录'),
      statCard('本地模型', 'chip', installed.length, '/ ' + models.length, installed.length === 0 ? '去模型中心下载' : '已可离线使用'),
      statCard(
        '本机配置',
        'cog',
        hw ? hw.cores : '—',
        hw ? '核 CPU' : '',
        hw ? `${hw.totalRamGb} GB 内存 · ${hw.gpu?.detected ? hw.gpu.name : '未检测到独显'}` : '',
      ),
    ]);

    const quick = h('div.card', {}, [
      h('div.card__head', {}, [h('div.card__title', { text: '快速开始' }), h('div.card__sub', { text: '四个最常用的动作' })]),
      h('div.card__body', {}, [
        h('div.grid.grid--2', {}, [
          quickAction('globe', '解析视频链接', '抖音 / B站 / 快手 / 小红书 …', () => window.FL.navigate('parse', { focus: true })),
          quickAction('chat', '和模型对话', '本地推理，内容不出这台电脑', () => window.FL.navigate('chat', { focus: true })),
          quickAction('image', '看懂一张图', 'OCR、表格、截图问答', () => window.FL.navigate('vision')),
          quickAction('video', '看懂一段视频', '抽关键帧后交给模型', () => window.FL.navigate('video')),
        ]),
      ]),
    ]);

    const recent = h('div.card', { style: { marginTop: '16px' } }, [
      h('div.card__head', {}, [
        h('div.card__title', { text: '最近解析' }),
        h('div', { style: { marginLeft: 'auto' } }, [
          button('全部记录', { size: 'sm', onClick: () => window.FL.navigate('parse') }),
        ]),
      ]),
      state.parseResults.length === 0
        ? emptyState('link', '还没有解析记录', '去「全平台解析」粘贴一个视频链接试试')
        : h(
            'div.card__body',
            {},
            state.parseResults.slice(0, 4).map((asset) =>
              h('div.variant', {}, [
                h('span', { class: 'pdot', style: { width: '8px', height: '8px', borderRadius: '50%', background: asset.platformColor, flex: 'none' } }),
                h('span.variant__label', { text: asset.title, style: { minWidth: '0', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
                h('span.chip', { text: `${asset.variants.length} 个清晰度` }),
                button('下载', { size: 'sm', icon: 'download', onClick: () => window.FL.navigate('parse') }),
              ]),
            ),
          ),
    ]);

    return [hero, stats, quick, recent];
  }

  window.FL.registerPage('home', {
    mount(container) {
      root = container;
      subscribe((event) => {
        if (['tasks', 'models', 'parse'].includes(event.type)) draw();
      });
      draw();
    },
    enter() {
      draw();
    },
    focus() {
      draw();
    },
  });

  function draw() {
    if (!root) return;
    root.replaceChildren(...render());
  }
})();

/**
 * 全平台解析：一个输入框 + 一个大按钮，产出各清晰度直链并可一键下载。
 */

(function () {
  const { h, $, button, icon, fmt, state, api, toast, subscribe, emptyState, copyText } = window.FL;

  let root = null;
  let textarea = null;
  let statusLine = null;
  let resultsBox = null;
  let parseBtn = null;
  let busy = false;

  const PLATFORM_LABELS = [
    ['douyin', '抖音', '#FE2C55'],
    ['kuaishou', '快手', '#FF5000'],
    ['bilibili', '哔哩哔哩', '#00A1D6'],
    ['xiaohongshu', '小红书', '#FF2442'],
    ['weibo', '微博', '#E6162D'],
    ['youtube', 'YouTube', '#FF0033'],
    ['tiktok', 'TikTok', '#00F2EA'],
    ['xigua', '西瓜视频', '#F4622A'],
    ['qqvideo', '腾讯视频', '#FF6A00'],
    ['youku', '优酷', '#1EB8FF'],
    ['iqiyi', '爱奇艺', '#00BE06'],
    ['mgtv', '芒果TV', '#FF7E00'],
    ['vimeo', 'Vimeo', '#1AB7EA'],
    ['twitter', 'X / Twitter', '#1D9BF0'],
    ['instagram', 'Instagram', '#E1306C'],
    ['generic', '其它任意网页', '#7C8CF8'],
  ];

  function buildHeader() {
    return window.FL.pageHead('全平台解析', '粘贴视频分享文本或链接，自动识别平台并展开所有清晰度直链。支持抖音、快手、B站、小红书、微博、YouTube、TikTok 等平台，以及任意公开网页里的视频。', [
      button('批量下载最高清晰度', { icon: 'download', onClick: () => downloadAllBest() }),
    ]);
  }

  function buildParseBox() {
    textarea = h('textarea.textarea', {
      placeholder: '把分享文本整段粘进来就行，例如：\n7.68 复制打开抖音，看看【XXX的作品】... https://v.douyin.com/xxxxx/\n也可以直接粘贴 B站 / YouTube 链接，一行一个，最多 8 条。',
      spellcheck: false,
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runAnalyze();
      }
    });

    parseBtn = button('解析全平台链接', { icon: 'globe', variant: 'primary', size: 'xl', onClick: () => runAnalyze() });

    statusLine = h('div', { class: 'card__sub', style: { marginTop: '10px', minHeight: '18px' } });

    const strip = h(
      'div.platform-strip',
      {},
      PLATFORM_LABELS.map(([id, name, color]) =>
        h('span.platform-tag', { title: `${name}（${id}）` }, [
          h('i.pdot', { style: { background: color } }),
          name,
        ]),
      ),
    );

    return h('div.parse-box', { style: { marginBottom: '18px' } }, [
      h('div.parse-box__input', {}, [
        textarea,
        h('div.parse-box__paste', {}, [
          button('', { icon: 'paste', size: 'sm', title: '从剪贴板粘贴', onClick: pasteFromClipboard }),
        ]),
      ]),
      h('div.parse-box__row', {}, [
        parseBtn,
        button('解析并下载最高清', { icon: 'download', onClick: async () => runAnalyze({ thenDownload: true }) }),
        button('清空', { icon: 'trash', onClick: () => { textarea.value = ''; textarea.focus(); statusLine.textContent = ''; } }),
        h('div.spacer'),
        h('span.card__sub', { text: 'Ctrl + Enter 快速解析' }),
      ]),
      strip,
      statusLine,
    ]);
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error('剪贴板是空的');
      textarea.value = textarea.value ? `${textarea.value}\n${text}` : text;
      textarea.focus();
      statusLine.textContent = '已从剪贴板粘贴';
    } catch (error) {
      toast('读取剪贴板失败', '可以手动 Ctrl+V 粘贴', 'warn');
    }
  }

  /* ------------------------------------------------------------ 解析 */
  async function runAnalyze({ thenDownload = false } = {}) {
    const input = textarea.value.trim();
    if (!input) {
      toast('还没有内容', '先粘贴视频分享文本或链接', 'warn');
      textarea.focus();
      return;
    }
    if (busy) return;

    setBusy(true, '正在识别链接…');
    const jobId = window.FL.uid('parse');
    try {
      const result = await api.invoke('extract:analyze', { input, jobId });
      state.parseResults = [...result.assets, ...state.parseResults].slice(0, 60);
      window.FL.emit({ type: 'parse' });
      renderResults();

      if (result.assets.length === 0) {
        toast('解析失败', result.failures[0]?.message ?? '没有拿到可用地址', 'err');
      } else {
        toast(`解析完成，共 ${result.assets.length} 条`, result.failures.length ? `${result.failures.length} 条失败` : '', 'ok');
        if (thenDownload) downloadAllBest();
      }
    } catch (error) {
      toast('解析出错', error.message, 'err');
      statusLine.textContent = error.message;
    } finally {
      setBusy(false, '');
    }
  }

  function setBusy(value, message) {
    busy = value;
    parseBtn.disabled = value;
    parseBtn.querySelector('span').textContent = value ? '解析中…' : '解析全平台链接';
    if (message) statusLine.textContent = message;
  }

  /* ------------------------------------------------------------ 渲染结果 */
  function assetCard(asset) {
    const cover = asset.cover
      ? h('img.asset__cover', { src: asset.cover, loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div.asset__cover.asset__cover--empty', {}, [icon('video')]);

    cover.addEventListener('error', () => {
      cover.replaceWith(h('div.asset__cover.asset__cover--empty', {}, [icon('video')]));
    });

    const meta = [
      h('span.chip.chip--brand', { text: asset.platformName }),
      asset.author ? h('span.chip', { text: asset.author }) : null,
      asset.durationSec ? h('span.chip', { text: fmt.duration(asset.durationSec) }) : null,
      h('span.chip', { text: `${asset.variants.length} 个清晰度` }),
      asset.mediaType === 'image' ? h('span.chip', { text: '图文' }) : null,
    ];

    const variantList = h('div.variants', {}, [
      h('div.section-label', {}, [
        h('span', { text: `视频清晰度（${asset.variants.length}）` }),
        asset.variants.length > 1
          ? h(
              'button.linkbtn',
              {
                type: 'button',
                onclick: () => asset.variants.slice(0, 6).forEach((v) => downloadVariant(asset, v)),
              },
              ['全部下载'],
            )
          : null,
      ]),
      ...asset.variants.slice(0, 8).map((variant) =>
        h('div.variant', {}, [
          h('span.variant__label', { text: variant.label }),
          variant.note ? h('span.chip', { text: variant.note }) : null,
          h('span.variant__url', { text: variant.url, title: variant.url }),
          h('div.variant__actions', {}, [
            // 用带文字的按钮而不是纯图标：用户反馈过「看不出哪里能单独下载」
            button('复制', { size: 'sm', icon: 'copy', title: '复制直链', onClick: () => copyText(variant.url, '直链已复制') }),
            button('下载', { size: 'sm', icon: 'download', variant: 'primary', onClick: () => downloadVariant(asset, variant) }),
          ]),
        ]),
      ),
      asset.variants.length === 0
        ? h('div.card__sub', { text: asset.warnings[0] ?? '该页面没有解析到可下载地址' })
        : null,
    ]);

    const imageGrid = asset.images?.length
      ? h('div', { style: { marginTop: '14px' } }, [
          h('div.section-label', {}, [
            h('span', {
              text: `${asset.mediaType === 'image' ? '图片' : '图片与封面'}（${asset.images.length}）`,
            }),
            h(
              'button.linkbtn',
              {
                type: 'button',
                onclick: () => asset.images.slice(0, 12).forEach((url, index) => downloadImage(asset, url, index)),
              },
              ['全部下载'],
            ),
          ]),
          h(
            'div.thumb-grid',
            {},
            asset.images.slice(0, 12).map((url, index) =>
              h('div.thumb', { title: url }, [
                h('img', {
                  src: url,
                  loading: 'lazy',
                  referrerpolicy: 'no-referrer',
                  onclick: () => window.FL.previewImage?.(url, `图片 ${index + 1}`),
                }),
                h('span', { text: index === 0 && asset.mediaType !== 'image' ? '封面' : `图 ${index + 1}` }),
                h('div.thumb__actions', {}, [
                  // 带文字的按钮：纯图标版本被反馈「找不到封面图片的下载按钮」
                  h('button.thumbbtn', {
                    type: 'button',
                    title: '预览大图',
                    onclick: () => window.FL.previewImage?.(url, `图片 ${index + 1}`),
                  }, ['预览']),
                  h('button.thumbbtn.thumbbtn--primary', {
                    type: 'button',
                    title: '下载这张图片',
                    onclick: () => downloadImage(asset, url, index),
                  }, ['下载']),
                ]),
              ]),
            ),
          ),
        ])
      : null;

    const warnings = asset.warnings?.length
      ? h(
          'div',
          { style: { marginTop: '10px', display: 'flex', gap: '7px', flexWrap: 'wrap' } },
          asset.warnings.map((text) => h('span.chip.chip--warn', {}, [icon('warn'), text])),
        )
      : null;

    return h('div.asset', {}, [
      cover,
      h('div', {}, [
        h('h3.asset__title', { text: asset.title }),
        h('div.asset__meta', {}, meta),
        asset.description ? h('p.asset__desc', { text: asset.description }) : null,
        variantList,
        imageGrid,
        warnings,
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, [
          asset.webpageUrl ? button('打开原页面', { icon: 'globe', size: 'sm', onClick: () => api.invoke('app:openExternal', { url: asset.webpageUrl }) }) : null,
          button('复制全部信息', { icon: 'copy', size: 'sm', onClick: () => copyText(assetToText(asset)) }),
        ]),
      ]),
    ]);
  }

  function assetToText(asset) {
    return [
      `标题：${asset.title}`,
      asset.author ? `作者：${asset.author}` : '',
      `平台：${asset.platformName}`,
      asset.durationSec ? `时长：${fmt.duration(asset.durationSec)}` : '',
      asset.webpageUrl ? `页面：${asset.webpageUrl}` : '',
      '',
      '清晰度列表：',
      ...asset.variants.map((v) => `- ${v.label}：${v.url}`),
      asset.images.length ? `\n图片（${asset.images.length} 张）：\n${asset.images.join('\n')}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  async function downloadVariant(asset, variant) {
    const extension = variant.format || 'mp4';
    const fileName = `${asset.title}.${extension}`.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    try {
      await api.invoke('download:enqueue', {
        items: [
          {
            url: variant.url,
            title: `${asset.title} · ${variant.label}`,
            fileName,
            platform: asset.platformName,
            headers: variant.headers ?? {},
          },
        ],
      });
      toast('已加入下载队列', `${asset.title} · ${variant.label}`, 'ok');
    } catch (error) {
      // 不要静默失败：用户点了下载却什么都不发生是最糟糕的体验
      toast('加入下载队列失败', error.message, 'err', 6000);
    }
  }

  /** 单张图片下载：图文笔记（小红书、抖音图集）要能一张一张存 */
  async function downloadImage(asset, url, index) {
    try {
      await api.invoke('download:enqueue', {
        items: [
          {
            url,
            title: `${asset.title} · 图片 ${index + 1}`,
            fileName: `${String(index + 1).padStart(2, '0')}.jpg`,
            platform: asset.platformName,
          },
        ],
      });
      toast('已加入下载队列', `图片 ${index + 1}`, 'ok');
    } catch (error) {
      toast('下载失败', error.message, 'err', 5000);
    }
  }

  async function downloadAllBest() {
    const targets = state.parseResults.filter((asset) => asset.variants.length > 0);
    if (targets.length === 0) {
      toast('没有可下载的内容', '先解析一个链接', 'warn');
      return;
    }
    const items = targets.map((asset) => {
      const best = asset.variants[0];
      return {
        url: best.url,
        title: `${asset.title} · ${best.label}`,
        fileName: `${asset.title}.${best.format || 'mp4'}`.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100),
        platform: asset.platformName,
        headers: best.headers ?? {},
      };
    });
    await api.invoke('download:enqueue', { items });
    toast('已加入下载队列', `${items.length} 个任务`, 'ok');
    window.FL.navigate('tasks');
  }

  function renderResults() {
    const children =
      state.parseResults.length === 0
        ? [emptyState('globe', '还没有解析结果', '粘贴链接后点击上面的按钮，结果会显示在这里')]
        : [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } }, [
              h('div.card__title', { text: `解析结果（${state.parseResults.length}）` }),
              h('div', { style: { marginLeft: 'auto' } }, [
                button('清空结果', { size: 'sm', icon: 'trash', onClick: () => { state.parseResults = []; renderResults(); window.FL.emit({ type: 'parse' }); } }),
              ]),
            ]),
            ...state.parseResults.map(assetCard),
          ];
    resultsBox.replaceChildren(...children);
  }

  window.FL.registerPage('parse', {
    mount(container) {
      root = container;
      resultsBox = h('div');
      container.append(buildHeader(), buildParseBox(), resultsBox);
      subscribe((event) => {
        if (event.type === 'extract-progress') {
          const { stage, index = 0, total = 1, message } = event.event;
          if (stage === 'done') statusLine.textContent = `已完成 ${index + 1}/${total}：${event.event.title ?? ''}`;
          else if (stage === 'error') statusLine.textContent = `第 ${index + 1} 条失败：${message ?? ''}`;
          else statusLine.textContent = `正在处理第 ${index + 1}/${total} 条…`;
        }
      });
      renderResults();
    },
    enter() {
      renderResults();
    },
    focus() {
      textarea?.focus();
    },
  });
})();

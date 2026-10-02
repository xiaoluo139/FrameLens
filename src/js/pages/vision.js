/**
 * 图像理解：把本地图片交给内置多模态模型，做描述 / OCR / 表格 / 翻译。
 */

(function () {
  const { h, $, button, icon, api, state, toast, subscribe, copyText, fileUrl, renderMarkdown } = window.FL;

  let dropzone = null;
  let thumbGrid = null;
  let promptBox = null;
  let resultBox = null;
  let runBtn = null;
  let images = [];
  let busy = false;
  let requestId = null;

  const PRESETS = [
    ['详细描述', '请详细描述这张图片的内容，包括主体、场景、色调和可能的用途。'],
    ['提取文字 OCR', '请把图片里的所有文字完整、准确地提取出来，保持原有换行与顺序；如果没有文字请说明。'],
    ['表格转 Markdown', '如果图片里有表格，请转成 Markdown 表格；如果没有表格请说明。'],
    ['翻译成中文', '请把图片里的外文内容翻译成中文，并保留原文。'],
    ['找出可疑之处', '请指出这张图片里看起来不合理、可疑或像是伪造的细节。'],
  ];

  function buildHeader() {
    return window.FL.pageHead('图像理解', '把截图、照片、扫描件拖进来，本地模型离线识别。图片不会被上传到任何服务器。', [
      button('清空', { icon: 'trash', onClick: clearAll }),
    ]);
  }

  function buildBody() {
    dropzone = h('div.dropzone', { onclick: pick }, [
      h('div.dropzone__icon', {}, [icon('image')]),
      h('h3', { text: '把图片拖到这里，或点击选择' }),
      h('p', { text: '支持 jpg / png / webp / gif / bmp，单次最多 6 张' }),
    ]);

    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
    dropzone.addEventListener('drop', async (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
      const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return toast('没有识别到图片', '请拖入图片文件', 'warn');
      for (const file of files.slice(0, 6)) {
        const dataUrl = await readFile(file);
        pushImage({ dataUrl, name: file.name });
      }
    });

    thumbGrid = h('div.thumb-grid', { style: { marginTop: '14px' } });
    promptBox = h('textarea.textarea', {
      value: state.settings?.vision?.prompt ?? '请详细描述这张图片的内容。',
      spellcheck: false,
    });
    runBtn = button('让模型理解这些图片', { icon: 'spark', variant: 'primary', size: 'xl', onClick: run });
    resultBox = h('div.result-box', { text: '识别结果会显示在这里。' });

    const left = h('div.card', {}, [
      h('div.card__head', {}, [
        h('div.card__title', { text: '提问方式' }),
        h('div.card__sub', { text: '点一下即可套用' }),
      ]),
      h('div.card__body', {}, [
        h(
          'div.preset-row',
          {},
          PRESETS.map(([label, text]) =>
            h('button.chip', { type: 'button', onclick: () => { promptBox.value = text; } }, [icon('spark'), label]),
          ),
        ),
        h('div.field', {}, [h('label', { text: '提示词' }), promptBox]),
        h('div', { style: { display: 'flex', gap: '9px', marginTop: '14px', flexWrap: 'wrap' } }, [
          runBtn,
          button('停止', { icon: 'stop', onClick: stop }),
        ]),
      ]),
    ]);

    const right = h('div.card', {}, [
      h('div.card__head', {}, [
        h('div.card__title', { text: '识别结果' }),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, [
          button('', { icon: 'copy', size: 'sm', title: '复制结果', onClick: () => copyText(resultBox.textContent, '结果已复制') }),
          button('', { icon: 'folder', size: 'sm', title: '保存为文本', onClick: save }),
        ]),
      ]),
      h('div.card__body', {}, [resultBox]),
    ]);

    return h('div', {}, [
      dropzone,
      thumbGrid,
      h('div.grid.grid--2', { style: { marginTop: '18px', alignItems: 'start' } }, [left, right]),
    ]);
  }

  function readFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  function pushImage(image) {
    if (!image.dataUrl) return;
    if (images.length >= 6) {
      toast('最多 6 张', '先移除一张再添加', 'warn');
      return;
    }
    images.push(image);
    renderThumbs();
  }

  function renderThumbs() {
    thumbGrid.replaceChildren(
      ...images.map((image, index) =>
        h('div.thumb', {}, [
          h('img', { src: image.dataUrl, alt: image.name }),
          h('span', { text: image.name.slice(0, 16) }),
          h(
            'button.iconbtn',
            {
              type: 'button',
              title: '移除',
              style: {
                position: 'absolute',
                top: '4px',
                right: '4px',
                background: 'rgba(0,0,0,.55)',
                color: '#fff',
                width: '24px',
                height: '24px',
              },
              onclick: () => {
                images.splice(index, 1);
                renderThumbs();
              },
            },
            [icon('close')],
          ),
        ]),
      ),
    );
  }

  async function pick() {
    const paths = await api.invoke('app:chooseFiles', {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    for (const path of paths.slice(0, 6)) {
      try {
        const blob = await fetch(fileUrl(path)).then((r) => r.blob());
        const dataUrl = await readFile(new File([blob], 'image'));
        pushImage({ dataUrl, name: path.split(/[\\/]/).pop() });
      } catch (error) {
        toast('读取失败', error.message, 'err');
      }
    }
  }

  async function save() {
    const path = await api.invoke('app:saveText', { content: resultBox.textContent, defaultPath: 'framelens-图像理解.md' });
    if (path) toast('已保存', path, 'ok');
  }

  async function run() {
    if (busy) return;
    if (images.length === 0) return toast('先选图片', '拖入或点击选择图片', 'warn');

    const active = state.modelStatus?.models.find((m) => m.active);
    if (active && active.kind === 'text') {
      return toast('当前模型看不了图', `「${active.name}」是纯文本模型，请到模型中心切换视觉模型`, 'warn', 6000);
    }

    busy = true;
    runBtn.disabled = true;
    runBtn.querySelector('span').textContent = '识别中…';
    resultBox.textContent = '正在加载模型并识别…（首次使用需要先下载模型）';
    requestId = window.FL.uid('vision');

    try {
      const result = await api.invoke('model:chat', {
        requestId,
        messages: [
          { role: 'system', content: 'You are a precise vision assistant. Answer in the same language as the user request.' },
          { role: 'user', content: promptBox.value.trim() || '请描述这些图片。' },
        ],
        images: images.map((i) => i.dataUrl),
        options: { maxTokens: state.settings?.chat?.maxTokens ?? 1024 },
      });
      if (!result.ok) {
        resultBox.textContent = `⚠️ ${result.error}\n${result.detail ?? ''}`;
        toast('识别失败', result.error, 'err');
      } else {
        resultBox.innerHTML = renderMarkdown(result.text || '（模型没有返回内容）');
      }
    } catch (error) {
      resultBox.textContent = `⚠️ ${error.message}`;
      toast('识别出错', error.message, 'err');
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.querySelector('span').textContent = '让模型理解这些图片';
      requestId = null;
    }
  }

  async function stop() {
    if (requestId) await api.invoke('model:cancel', { requestId });
  }

  function clearAll() {
    images = [];
    renderThumbs();
    resultBox.textContent = '识别结果会显示在这里。';
  }

  window.FL.registerPage('vision', {
    mount(container) {
      container.append(buildHeader(), buildBody());
      subscribe((event) => {
        if (event.type === 'chat-token' && requestId && event.event.requestId === requestId) {
          resultBox.innerHTML = renderMarkdown(event.event.full) + '<span class="cursor"></span>';
        }
        if (event.type === 'model-progress' && event.event.stage === 'download') {
          resultBox.textContent = `正在下载模型：${event.event.message ?? ''}`;
        }
      });
    },
  });
})();

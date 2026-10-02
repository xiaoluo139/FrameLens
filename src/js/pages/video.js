/**
 * 视频理解：用 Chromium 解码 + Canvas 抽关键帧，再交给本地视觉模型。
 * 不依赖 ffmpeg，装完即用。
 */

(function () {
  const { h, button, icon, api, state, toast, subscribe, copyText, fileUrl, renderMarkdown, fmt } = window.FL;

  let video = null;
  let infoLine = null;
  let thumbGrid = null;
  let resultBox = null;
  let frameCountInput = null;
  let maxEdgeInput = null;
  let promptBox = null;
  let frames = [];
  let currentPath = '';
  let busy = false;
  let requestId = null;
  const actionButtons = [];
  let extractBtn = null;
  let analyzeBtn = null;
  let stopBtn = null;

  /**
   * 抽帧与分析期间禁用操作按钮。
   * 否则用户连点会被 busy 判断静默吞掉，界面看起来像卡死了。
   */
  function setBusy(value) {
    busy = value;
    for (const node of actionButtons) {
      node.disabled = value;
      node.style.opacity = value ? '0.5' : '';
    }
  }

  function buildHeader() {
    return window.FL.pageHead('视频理解', '选一个本地视频，自动按时间轴抽关键帧交给模型，让它概括内容、找重点。全程离线，视频不出本机。', [
      button('清空', { icon: 'trash', onClick: clearAll }),
    ]);
  }

  function buildBody() {
    extractBtn = button('只抽关键帧', { icon: 'image', onClick: () => extract(false) });
    analyzeBtn = button('抽帧并让模型分析', { icon: 'spark', variant: 'primary', onClick: () => extract(true) });
    stopBtn = button('停止', { icon: 'stop', onClick: stop });
    actionButtons.push(extractBtn, analyzeBtn, stopBtn);

    video = h('video', {
      controls: true,
      preload: 'metadata',
      crossorigin: 'anonymous',
      style: { maxHeight: '360px', width: '100%' },
    });
    video.addEventListener('error', () => {
      toast(
        '这个视频无法用内置解码器播放',
        '内置解码器支持 mp4(H.264)/webm 等常见格式；mkv、HEVC 需要先转码',
        'err',
        8000,
      );
      infoLine.textContent = '⚠️ 无法解码该视频文件';
    });
    video.addEventListener('loadedmetadata', () => {
      const name = currentPath.split(/[\\/]/).pop();
      infoLine.textContent = `已载入：${name} · 时长 ${fmt.duration(video.duration)} · ${video.videoWidth}×${video.videoHeight}`;
    });

    infoLine = h('div.card__sub', { text: '还没有选择视频' });
    frameCountInput = h('input.input', {
      type: 'number',
      min: 2,
      max: 16,
      value: state.settings?.vision?.maxFrames ?? 4,
    });
    maxEdgeInput = h('input.input', {
      type: 'number',
      min: 256,
      max: 1600,
      step: 32,
      value: state.settings?.vision?.frameMaxEdge ?? 512,
    });
    promptBox = h('textarea.textarea', {
      value: state.settings?.vision?.videoPrompt ?? '这是一段视频的关键帧，请概括视频内容。',
      spellcheck: false,
    });
    thumbGrid = h('div.thumb-grid');
    resultBox = h('div.result-box', { text: '分析结果会显示在这里。' });

    const sourceCard = h('div.card', { style: { marginBottom: '16px' } }, [
      h('div.card__head', {}, [
        h('div.card__title', { text: '视频来源' }),
        h('div', { style: { marginLeft: 'auto' } }, [
          button('选择本地视频', { icon: 'video', variant: 'primary', onClick: pick }),
        ]),
      ]),
      h('div.card__body', {}, [h('div.viewer', {}, [video]), h('div', { style: { marginTop: '10px' } }, [infoLine])]),
    ]);

    const controlsCard = h('div.card', {}, [
      h('div.card__head', {}, [h('div.card__title', { text: '抽帧与分析' })]),
      h('div.card__body', {}, [
        h('div.grid.grid--2', {}, [
          h('div.field', {}, [h('label', { text: '关键帧数量' }), frameCountInput, h('div.field__hint', { text: '每帧都要编码，CPU 建议 4–6 帧' })]),
          h('div.field', {}, [h('label', { text: '单帧最长边（像素）' }), maxEdgeInput, h('div.field__hint', { text: '512 够用；调大更清晰但明显更慢' })]),
        ]),
        h('div.field', { style: { marginTop: '12px' } }, [h('label', { text: '提示词' }), promptBox]),
        // 注意：不要把 splice 的返回值当子节点用——splice 返回的是被删除的元素
        h('div', { style: { display: 'flex', gap: '9px', marginTop: '14px', flexWrap: 'wrap' } }, [
          extractBtn,
          analyzeBtn,
          stopBtn,
        ]),
      ]),
    ]);

    const resultCard = h('div.card', {}, [
      h('div.card__head', {}, [
        h('div.card__title', { text: '关键帧与结论' }),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, [
          button('', { icon: 'copy', size: 'sm', title: '复制分析结果', onClick: () => copyText(resultBox.textContent, '已复制') }),
          button('', { icon: 'folder', size: 'sm', title: '导出分析结果', onClick: save }),
        ]),
      ]),
      h('div.card__body', {}, [thumbGrid, h('div', { style: { marginTop: '14px' } }, [resultBox])]),
    ]);

    return h('div', {}, [sourceCard, h('div.grid.grid--2', { style: { alignItems: 'start' } }, [controlsCard, resultCard])]);
  }

  async function pick() {
    const paths = await api.invoke('app:chooseFiles', {
      title: '选择视频',
      multi: false,
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'flv'] }],
    });
    if (paths.length === 0) return;
    currentPath = paths[0];
    frames = [];
    thumbGrid.replaceChildren();
    video.src = fileUrl(currentPath);
    video.load();
    infoLine.textContent = '正在读取视频信息…';
  }

  function seekTo(time) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        reject(new Error('跳转到该时间点超时（视频可能不完整或不支持）'));
      }, 9000);
      function onSeeked() {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
    });
  }

  async function extract(thenAnalyze) {
    if (!currentPath) return toast('先选择视频', '', 'warn');
    if (busy) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return toast('视频还没准备好', '等播放器载入完成后再试', 'warn');
    }
    setBusy(true);
    const count = Math.max(2, Math.min(16, Number(frameCountInput.value) || 8));
    const maxEdge = Math.max(320, Math.min(1600, Number(maxEdgeInput.value) || 896));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    frames = [];

    try {
      const width = video.videoWidth || maxEdge;
      const height = video.videoHeight || maxEdge;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      canvas.width = Math.max(64, Math.round(width * scale));
      canvas.height = Math.max(64, Math.round(height * scale));

      for (let i = 0; i < count; i++) {
        const time = (video.duration * (i + 0.5)) / count;
        await seekTo(time);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({ time, dataUrl: canvas.toDataURL('image/jpeg', 0.82) });
        renderFrames();
      }
      infoLine.textContent = `已抽取 ${frames.length} 帧（${canvas.width}×${canvas.height}）`;
    } catch (error) {
      toast('抽帧失败', error.message, 'err');
      setBusy(false);
      return;
    }
    setBusy(false);

    if (thenAnalyze) await analyze();
  }

  function renderFrames() {
    thumbGrid.replaceChildren(
      ...frames.map((frame) =>
        h('div.thumb', { title: `第 ${frame.time.toFixed(1)} 秒` }, [
          h('img', { src: frame.dataUrl }),
          h('span', { text: fmt.duration(frame.time) }),
        ]),
      ),
    );
  }

  async function analyze() {
    if (frames.length === 0) return toast('还没有关键帧', '先点「只抽关键帧」', 'warn');
    if (busy) return;

    const active = state.modelStatus?.models.find((m) => m.active);
    if (active && active.kind === 'text') {
      return toast('当前模型看不了图', '请切换到视觉模型', 'warn', 6000);
    }
    setBusy(true);
    requestId = window.FL.uid('video');
    const startedAt = Date.now();
    // 多帧推理是分钟级操作，必须有实时反馈，否则用户会以为卡死了
    const ticker = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      resultBox.textContent = `正在分析 ${frames.length} 帧…已用时 ${seconds} 秒（CPU 推理，请稍候）`;
    }, 1000);
    resultBox.textContent = `正在把 ${frames.length} 帧交给模型分析…`;

    try {
      const result = await api.invoke('model:chat', {
        requestId,
        messages: [
          { role: 'system', content: 'You are a video analyst. The user sends keyframes in chronological order. Answer in Chinese.' },
          { role: 'user', content: promptBox.value.trim() || '请概括这段视频。' },
        ],
        images: frames.map((f) => f.dataUrl),
        // 视频要喂多帧，CPU 上生成很慢，输出上限收紧一些
        // 视频要喂多帧，CPU 上视觉编码很慢，输出上限收紧
        options: { maxTokens: 256 },
      });
      if (!result.ok) {
        resultBox.textContent = `⚠️ ${result.error}\n${result.detail ?? ''}`;
        toast('分析失败', result.error, 'err');
      } else {
        resultBox.innerHTML = renderMarkdown(result.text || '（模型没有返回内容）');
      }
    } catch (error) {
      resultBox.textContent = `⚠️ ${error.message}`;
      toast('分析出错', error.message, 'err');
    } finally {
      clearInterval(ticker);
      setBusy(false);
      requestId = null;
    }
  }

  async function stop() {
    if (requestId) await api.invoke('model:cancel', { requestId });
    setBusy(false);
  }

  async function save() {
    const content = ['# 视频理解结果', `来源：${currentPath}`, `关键帧：${frames.length} 张`, '', resultBox.textContent].join('\n');
    const path = await api.invoke('app:saveText', { content, defaultPath: 'framelens-视频理解.md' });
    if (path) toast('已保存', path, 'ok');
  }

  function clearAll() {
    frames = [];
    thumbGrid.replaceChildren();
    resultBox.textContent = '分析结果会显示在这里。';
    if (video.src) {
      video.removeAttribute('src');
      video.load();
    }
    currentPath = '';
    infoLine.textContent = '还没有选择视频';
  }

  window.FL.registerPage('video', {
    mount(container) {
      container.append(buildHeader(), buildBody());
      subscribe((event) => {
        if (event.type === 'chat-token' && requestId && event.event.requestId === requestId) {
          resultBox.innerHTML = renderMarkdown(event.event.full) + '<span class="cursor"></span>';
        }
      });
    },
  });
})();

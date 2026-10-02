/**
 * 模型对话：本地多轮对话 + 图片附件（走同一个多模态模型）。
 */

(function () {
  const { h, $, button, icon, api, state, toast, subscribe, copyText, renderMarkdown, fileUrl, uid } = window.FL;

  let root = null;
  let scrollBox = null;
  let inner = null;
  let input = null;
  let attachmentsBox = null;
  let sendBtn = null;
  let stopBtn = null;
  let modelSelect = null;
  let hint = null;
  let requestId = null;

  const PRESETS = [
    ['帮我总结这段文字', '把下面内容总结成 5 条要点，每条不超过 20 字：\n'],
    ['翻译成英文', '把下面内容翻译成地道的英文，保持原意：\n'],
    ['写一段解析文案', '帮我把这个视频的分享文案写得更有吸引力：\n'],
    ['解释代码', '逐行解释下面这段代码在做什么：\n'],
  ];

  function buildHeader() {
    modelSelect = h('select.select', { style: { width: '230px' }, onchange: onModelChange });

    return window.FL.pageHead('模型对话', '完全在你本机运行的多轮对话。模型加载后断网也能用，聊天记录不离开这台电脑。', [
      modelSelect,
      button('导入本地模型', { icon: 'plus', onClick: () => window.FL.importLocalModel() }),
      button('卸载模型', { icon: 'chip', onClick: unloadModel }),
      button('清空对话', { icon: 'trash', onClick: clearChat }),
    ]);
  }

  function buildChat() {
    inner = h('div.chat__inner');
    scrollBox = h('div.chat__scroll', {}, [inner]);

    input = h('textarea', {
      rows: 1,
      placeholder: '问点什么…（Enter 发送，Shift + Enter 换行）',
      spellcheck: false,
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    input.addEventListener('input', autosize);

    attachmentsBox = h('div.composer__attachments');

    sendBtn = h('button.iconbtn.iconbtn--send', { type: 'button', title: '发送', onclick: send }, [icon('send')]);
    stopBtn = h('button.iconbtn', { type: 'button', title: '停止生成', onclick: stop, style: { display: 'none' } }, [icon('stop')]);

    const composer = h('div.composer', {}, [
      h('div.composer__inner', {}, [
        attachmentsBox,
        h('div.composer__box', {}, [
          input,
          h('div.composer__tools', {}, [
            h('button.iconbtn', { type: 'button', title: '添加图片', onclick: pickImages }, [icon('image')]),
            stopBtn,
            sendBtn,
          ]),
        ]),
        h('div.composer__hint', {}, [
          h('span', { text: '图片可以直接拖进来，模型会一起看' }),
          hint = h('span', { text: '' }),
        ]),
      ]),
    ]);

    // 拖放图片
    composer.addEventListener('dragover', (event) => {
      event.preventDefault();
      composer.style.outline = '2px dashed rgba(111,92,247,.6)';
    });
    composer.addEventListener('dragleave', () => {
      composer.style.outline = 'none';
    });
    composer.addEventListener('drop', async (event) => {
      event.preventDefault();
      composer.style.outline = 'none';
      const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      for (const file of files) await addAttachment(file);
    });

    const presets = h(
      'div.preset-row',
      {},
      PRESETS.map(([label, text]) =>
        h('button.chip', { type: 'button', onclick: () => { input.value = text; input.focus(); autosize(); } }, [icon('spark'), label]),
      ),
    );

    return h('div', {}, [presets, h('div.chat', {}, [scrollBox, composer])]);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
  }

  /* ---------------------------------------------------------- 模型 */
  function syncModelSelect() {
    const status = state.modelStatus;
    if (!status || !modelSelect) return;
    const installed = status.models.filter((m) => m.installed);
    const list = installed.length > 0 ? installed : status.models;
    modelSelect.replaceChildren(
      ...list.map((model) =>
        h('option', {
          value: model.id,
          selected: model.id === status.activeModelId,
          text: `${model.name}${model.installed ? '' : '（未下载）'}`,
        }),
      ),
    );
  }

  async function onModelChange() {
    const modelId = modelSelect.value;
    state.modelStatus = await api.invoke('model:activate', { modelId });
    window.FL.updateEngineBadge();
    toast('已切换模型', state.modelStatus.models.find((m) => m.id === modelId)?.name ?? modelId, 'ok');
  }

  async function unloadModel() {
    state.modelStatus = await api.invoke('model:unload');
    window.FL.updateEngineBadge();
    toast('已卸载模型', '内存已释放，下次提问会自动重新加载', 'ok');
  }

  /* ---------------------------------------------------------- 附件 */
  async function pickImages() {
    const paths = await api.invoke('app:chooseFiles', {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    for (const path of paths) {
      try {
        const blob = await fetch(fileUrl(path)).then((r) => r.blob());
        await addAttachment(blob, path.split(/[\\/]/).pop());
      } catch (error) {
        toast('读取图片失败', error.message, 'err');
      }
    }
  }

  function addAttachment(fileOrBlob, name) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        state.chat.images.push({ dataUrl: reader.result, name: name ?? fileOrBlob.name ?? 'image' });
        renderAttachments();
        resolve();
      };
      reader.onerror = () => resolve();
      reader.readAsDataURL(fileOrBlob);
    });
  }

  function renderAttachments() {
    attachmentsBox.replaceChildren(
      ...state.chat.images.map((image, index) =>
        h('div.attachment', {}, [
          h('img', { src: image.dataUrl, alt: image.name, title: image.name }),
          h('button', { type: 'button', title: '移除', onclick: () => { state.chat.images.splice(index, 1); renderAttachments(); } }, [icon('close')]),
        ]),
      ),
    );
    const active = state.modelStatus?.models.find((m) => m.active);
    if (state.chat.images.length > 0 && active && active.kind === 'text') {
      hint.textContent = `当前模型「${active.name}」是纯文本模型，看不了图片，请切到视觉模型`;
      hint.style.color = 'var(--warn)';
    } else {
      hint.textContent = '';
    }
  }

  /* ---------------------------------------------------------- 消息 */
  function messageNode(message, { streaming = false } = {}) {
    const isUser = message.role === 'user';
    const body = h('div.msg__body');
    body.append(h('div.msg__name', { text: isUser ? '你' : `影析助手 · ${state.modelStatus?.models.find((m) => m.active)?.name ?? '本地模型'}` }));

    if (message.images?.length) {
      body.append(
        h('div.msg__images', {}, message.images.map((url) => h('img', { src: url, alt: '附件' }))),
      );
    }

    const textNode = h('div.msg__text', { class: streaming ? 'cursor' : '' });
    if (isUser) textNode.textContent = message.content;
    else textNode.innerHTML = renderMarkdown(message.content || (streaming ? '' : '（空回复）'));
    body.append(textNode);

    if (!isUser && !streaming) {
      body.append(
        h('div.msg__tools', {}, [
          h('button.iconbtn', { type: 'button', title: '复制', onclick: () => copyText(message.content, '已复制回复') }, [icon('copy')]),
          h('button.iconbtn', { type: 'button', title: '重新生成', onclick: () => regenerate(message) }, [icon('refresh')]),
        ]),
      );
    }

    const node = h(`div.msg.msg--${isUser ? 'user' : 'assistant'}`, {}, [
      h('div.msg__avatar', { text: isUser ? '你' : 'FL' }),
      body,
    ]);
    node.__textNode = textNode;
    return node;
  }

  function renderMessages() {
    if (state.chat.messages.length === 0) {
      inner.replaceChildren(
        window.FL.emptyState('chat', '开始跟本地模型聊天', '模型跑在你自己电脑上。也可以先拖一张图进来，让它描述图片内容。'),
      );
      return;
    }
    inner.replaceChildren(...state.chat.messages.map((m) => messageNode(m)));
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollBox.scrollTop = scrollBox.scrollHeight;
    });
  }

  /* ---------------------------------------------------------- 发送 */
  async function send() {
    if (state.chat.busy) return;
    const content = input.value.trim();
    const images = state.chat.images.map((i) => i.dataUrl);
    if (!content && images.length === 0) return;

    const userMessage = { role: 'user', content, images };
    state.chat.messages.push(userMessage);
    input.value = '';
    autosize();
    state.chat.images = [];
    renderAttachments();

    const assistantMessage = { role: 'assistant', content: '' };
    state.chat.messages.push(assistantMessage);
    inner.replaceChildren(...state.chat.messages.map((m) => messageNode(m)));
    const streamingNode = messageNode(assistantMessage, { streaming: true });
    inner.replaceChildren(
      ...state.chat.messages.slice(0, -1).map((m) => messageNode(m)),
      streamingNode,
    );
    scrollToBottom();

    setBusy(true);
    requestId = uid('chat');

    const history = state.chat.messages
      .slice(0, -1)
      .slice(-(state.settings?.chat?.historyTurns ?? 12) * 2)
      .map((m) => ({ role: m.role, content: m.content || '（图片）' }));

    const system = state.settings?.chat?.systemPrompt?.trim();
    const payloadMessages = system ? [{ role: 'system', content: system }, ...history] : history;

    try {
      const result = await api.invoke('model:chat', {
        requestId,
        messages: payloadMessages,
        images,
        options: { maxTokens: state.settings?.chat?.maxTokens ?? 1024 },
      });
      if (!result.ok) {
        assistantMessage.content = `⚠️ ${result.error}`;
        streamingNode.__textNode.innerHTML = renderMarkdown(assistantMessage.content);
        toast('推理失败', result.error, 'err');
      } else if (!result.text) {
        assistantMessage.content = '（模型没有返回内容）';
        streamingNode.__textNode.textContent = assistantMessage.content;
      }
    } catch (error) {
      assistantMessage.content = `⚠️ ${error.message}`;
      streamingNode.__textNode.textContent = assistantMessage.content;
      toast('对话出错', error.message, 'err');
    } finally {
      setBusy(false);
      streamingNode.__textNode.classList.remove('cursor');
      renderMessages();
    }
  }

  function regenerate(message) {
    const index = state.chat.messages.indexOf(message);
    if (index < 0) return;
    state.chat.messages.splice(index);
    renderMessages();
    const lastUser = [...state.chat.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      input.value = lastUser.content;
      state.chat.images = (lastUser.images ?? []).map((url) => ({ dataUrl: url, name: 'image' }));
      renderAttachments();
      state.chat.messages.splice(state.chat.messages.indexOf(lastUser), 1);
      renderMessages();
      send();
    }
  }

  async function stop() {
    if (!requestId) return;
    await api.invoke('model:cancel', { requestId });
    toast('已停止生成', '', 'info', 1800);
  }

  function setBusy(value) {
    state.chat.busy = value;
    sendBtn.style.display = value ? 'none' : 'grid';
    stopBtn.style.display = value ? 'grid' : 'none';
    sendBtn.disabled = value;
    input.disabled = value;
    if (value) {
      window.FL.updateEngineBadge({ state: 'busy', text: '正在生成…' });
    } else {
      window.FL.updateEngineBadge();
      requestId = null;
    }
  }

  function clearChat() {
    state.chat.messages = [];
    state.chat.images = [];
    renderAttachments();
    renderMessages();
    toast('对话已清空', '', 'ok', 1600);
  }

  window.FL.registerPage('chat', {
    mount(container) {
      root = container;
      container.append(buildHeader(), buildChat());
      subscribe((event) => {
        if (event.type === 'models') syncModelSelect();
        if (event.type === 'chat-token' && requestId && event.event.requestId === requestId) {
          const streaming = inner.lastElementChild?.__textNode;
          if (streaming) {
            streaming.innerHTML = renderMarkdown(event.event.full) + '<span class="cursor"></span>';
            const pending = state.chat.messages.at(-1);
            if (pending) pending.content = event.event.full;
            scrollToBottom();
          }
        }
        if (event.type === 'model-progress' && event.event.stage === 'load') {
          window.FL.updateEngineBadge({ state: 'busy', text: event.event.message ?? '加载模型中…' });
        }
        if (event.type === 'model-progress' && event.event.stage === 'download') {
          window.FL.updateEngineBadge({ state: 'busy', text: event.event.message ?? '下载模型中…' });
        }
      });
      syncModelSelect();
      renderMessages();
    },
    enter() {
      syncModelSelect();
    },
    focus() {
      input?.focus();
    },
  });
})();

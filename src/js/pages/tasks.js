/**
 * 任务中心：下载队列的实时进度、取消与产物定位。
 */

(function () {
  const { h, button, icon, api, state, toast, subscribe, emptyState } = window.FL;

  let listBox = null;
  let statsBox = null;

  function buildHeader() {
    return window.FL.pageHead('任务中心', '下载队列实时进度。支持断点续传，中途关掉软件下次会接着下。', [
      button('打开下载目录', { icon: 'folder', onClick: openFolder }),
      button('全部取消', { icon: 'close', onClick: cancelAll }),
    ]);
  }

  function buildBody() {
    statsBox = h('div.grid.grid--4', { style: { marginBottom: '16px' } });
    listBox = h('div.card.card--flush');
    return h('div', {}, [statsBox, listBox]);
  }

  function stat(label, value) {
    return h('div.stat', {}, [
      h('div.stat__label', { text: label }),
      h('div.stat__value', { text: String(value) }),
    ]);
  }

  function renderTasks() {
    const tasks = state.tasks;
    statsBox.replaceChildren(
      stat('总任务', tasks.length),
      stat('进行中', tasks.filter((t) => t.status === 'running').length),
      stat('已完成', tasks.filter((t) => t.status === 'completed').length),
      stat('失败 / 取消', tasks.filter((t) => t.status === 'failed' || t.status === 'canceled').length),
    );

    if (tasks.length === 0) {
      listBox.replaceChildren(emptyState('tasks', '队列是空的', '在「全平台解析」里点下载，任务会出现在这里'));
      return;
    }

    const body = h('div');
    for (const task of tasks) {
      body.append(
        h('div.task-row', {}, [
          h('div.task-row__name', {}, [
            h('b', { text: task.title, title: task.title }),
            h('span', { text: `${task.platform || '未知来源'} · ${statusText(task.status)}${task.error ? ` · ${task.error}` : ''}` }),
          ]),
          h('div.task-row__col--hide', {}, [
            h('div.progress', {}, [h('div.progress__bar', { style: { width: `${task.progress || 0}%` } })]),
            h('div.card__sub', {
              text: task.total > 0 ? `${window.FL.fmt.bytes(task.received)} / ${window.FL.fmt.bytes(task.total)}` : `${window.FL.fmt.bytes(task.received)}`,
              style: { marginTop: '4px' },
            }),
          ]),
          h('div.task-row__col--hide.card__sub', { text: task.speed ? window.FL.fmt.speed(task.speed) : '' }),
          h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } }, [
            task.status === 'completed' && task.path
              ? h('button.iconbtn', { type: 'button', title: '在文件夹中显示', onclick: () => api.invoke('app:showItemInFolder', { path: task.path }) }, [icon('folder')])
              : null,
            task.status === 'running' || task.status === 'queued'
              ? h('button.iconbtn', { type: 'button', title: '取消', onclick: () => api.invoke('download:cancel', { id: task.id }) }, [icon('close')])
              : null,
          ]),
        ]),
      );
    }
    listBox.replaceChildren(body);
  }

  function statusText(status) {
    return (
      {
        queued: '排队中',
        running: '下载中',
        completed: '已完成',
        failed: '失败',
        canceled: '已取消',
      }[status] ?? status
    );
  }

  async function openFolder() {
    const path = state.settings?.paths?.downloads ?? state.info?.paths?.downloads;
    try {
      await api.invoke('app:openPath', { path });
    } catch (error) {
      toast('打开目录失败', error.message, 'err');
    }
  }

  async function cancelAll() {
    await api.invoke('download:cancelAll');
    toast('已取消全部任务', '', 'info', 2000);
  }

  window.FL.registerPage('tasks', {
    mount(container) {
      container.append(buildHeader(), buildBody());
      subscribe((event) => {
        if (event.type === 'tasks') renderTasks();
      });
      api.invoke('download:list').then((tasks) => {
        state.tasks = tasks.slice().reverse();
        renderTasks();
      });
      renderTasks();
    },
    enter() {
      renderTasks();
    },
  });
})();

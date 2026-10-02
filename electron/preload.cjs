/**
 * 预加载脚本：在隔离上下文里暴露一个受控的 API。
 * 渲染进程只能调用白名单通道，拿不到任何 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'app:info',
  'app:openExternal',
  'app:showItemInFolder',
  'app:openPath',
  'app:chooseDirectory',
  'app:chooseFiles',
  'app:saveText',
  'app:readText',
  'app:writeBinary',
  'app:windowAction',
  'settings:get',
  'settings:patch',
  'settings:reset',
  'logs:recent',
  'extract:analyze',
  'extract:platforms',
  'download:enqueue',
  'download:cancel',
  'download:list',
  'download:cancelAll',
  'model:status',
  'model:download',
  'model:installRuntime',
  'model:unload',
  'model:verify',
  'model:import',
  'model:removeCustom',
  'model:activate',
  'model:chat',
  'model:cancel',
  'model:resolveFiles',
  'system:diagnose',
]);

contextBridge.exposeInMainWorld('framelens', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`未授权的通道：${channel}`));
    }
    return ipcRenderer.invoke('fl:invoke', { channel, payload });
  },
  on(event, handler) {
    const listener = (_event, message) => {
      if (message?.channel === event) handler(message.payload);
    };
    ipcRenderer.on('fl:event', listener);
    return () => ipcRenderer.removeListener('fl:event', listener);
  },
  platform: process.platform,
});

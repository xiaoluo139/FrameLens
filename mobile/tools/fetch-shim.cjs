// 把页面里的 fetch 换成走主进程的原生请求。
// 这是 CapacitorHttp 在真机上的等价物：绕开 WebView 的同源策略，
// 让解析引擎可以直接抓取任意站点的网页。

const { ipcRenderer } = require('electron');

const nativeFetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = {};
  if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) headers[key] = value;
  }
  const result = await ipcRenderer.invoke('native-http', {
    url,
    method: init.method ?? 'GET',
    headers,
  });
  return {
    ok: result.ok,
    status: result.status,
    url: result.url,
    headers: { get: (name) => result.headers[String(name).toLowerCase()] ?? null },
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
    arrayBuffer: async () => new TextEncoder().encode(result.body).buffer,
  };
};

Object.defineProperty(window, 'fetch', { value: nativeFetch, writable: true, configurable: true });
window.__nativeFetchInstalled = true;

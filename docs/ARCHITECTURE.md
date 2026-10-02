# 架构说明

## 一、整体分层

| 层 | 目录 | 职责 |
|---|---|---|
| 渲染层 | `src/` | 无框架、无打包器的经典脚本 + 设计令牌 CSS |
| 主进程 | `electron/` | 窗口生命周期、IPC 通道实现、本地文件协议 |
| 解析引擎 | `core/extract/` | 平台注册、页面抽取、HLS 展开、下载调度 |
| 推理层 | `core/model/` | 运行时自举、模型管理、服务进程、多模态对话 |

设计原则：**core/ 里不出现 Electron、不出现 window**。核心逻辑都是纯 Node ESM，
因此可以被 `node --test` 直接测试，也可以被 esbuild 打包进移动端。

## 二、解析引擎

### 1. 输入到结果

```
分享文本 / URL
   -> extractUrls()          抽取、去重、去掉中文标点尾巴
URL 列表
   -> isShortUrl() + request()  短链展开（v.douyin.com / b23.tv / t.cn …）
真实地址
   -> findPlatformByHost()   平台识别（含短链域名）
平台
   -> 有专用解析器：bilibili / douyin / kuaishou / xiaohongshu / youtube / weibo
   -> 无专用解析器：通用解析器（OG / Twitter Card / JSON-LD / video 标签 / 内嵌 JSON）
归一化媒体对象 assets[]
```

关键设计：**专用解析器失败一定回退通用解析器**，并把失败原因写进 `warnings`。
用户永远能看到「拿到了什么、为什么没拿到更多」，而不是一个空结果。

### 2. 归一化模型

```
{
  id, platformId, platformName, platformColor, mediaType,
  title, author, description, cover, durationSec, webpageUrl,
  variants: [{ id, label, quality, format, url, headers, bandwidth, isManifest, note }],
  images, extra, warnings, resolvedAt
}
```

变体按清晰度降序排列，UI 只消费这一份 schema，新增平台不需要改界面。

### 3. HLS 处理

- master playlist 经 `parseMasterPlaylist()` 按 `RESOLUTION`/`BANDWIDTH` 展开成多条清晰度
- 下载时 `downloadHls()` 顺序拉取分片并合并为单个 `.ts` 文件
- 相对地址统一用 `resolveUrl()` 基于清单地址解析

### 4. 下载器

- 单文件：`Range` 续传 + `.part` 中间态 + 完成后改名
- 调度：并发上限、任务间隔、进度广播、单个/全部取消
- Windows 上所有「写完后改名」都走 `renameWithRetry()`，因为刚写完的文件
  常被杀软或索引服务短暂占用，直接 rename 会报 EBUSY

## 三、推理层

### 为什么是 llama-server 而不是进程内绑定

llama.cpp 的多模态（`--mmproj`）目前只在 `llama-server` 这个可执行文件上完整可用。
用它还有一个附带好处：**对话与看图共用一条链路**（OpenAI 兼容的
`/v1/chat/completions`，图片以 base64 data URL 传入），不需要维护两套推理代码。

### 运行时自举流程

1. `findInstalledServer()` 扫描用户目录与随包目录
2. 没有则 `fetchLatestTag()` 读 GitHub releases.atom（无需 token、不限流）
3. `listAssets()` 读该版本的 expanded_assets 页面，匹配平台资产名
4. 下载 zip 后用自研 `core/zip.js` 解包，落到 `runtime/llama-<tag>/`

两个容易踩的坑，代码里都做了防护：

- 资产名必须带 `llama-` 前缀，否则会错选 `cudart-llama-...` 运行库包（里面没有可执行文件）
- CUDA 版本需要额外下载 cudart 包并解压到同一目录

`core/zip.js` 是自己写的 ZIP 读取器（中央目录解析 + `inflateRawSync`），
带路径穿越防护，避免为了解压一个文件引入第三方依赖。

### 模型管理

- 目录只声明「仓库 + 量化正则」，真实文件名通过 HuggingFace API 现查，
  上游改名或新增量化都不会让应用失效
- 支持官方源与 `hf-mirror.com` 镜像切换
- **主模型匹配必须排除 mmproj**：视觉编码器文件名里通常也含主模型名，
  不排除就会把 clip 当主模型加载，llama.cpp 会直接报
  `CLIP cannot be used as main model`
- 下载完成后才落正式文件名，中断可续传

### 加速策略

默认使用 CPU 版运行时。原因是驱动版本不匹配时 GPU 版进程会直接起不来，
对「小白一键可用」来说先跑起来比跑得快重要；设置里可手动切 CUDA / Vulkan。

## 四、主进程与安全边界

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- preload 只暴露 `invoke(channel)` 与 `on(event)`，通道在 preload 里做白名单校验，
  主进程再做一层 handler 存在性校验
- 渲染进程拿不到任何 Node 能力，也读不到任意磁盘文件
- `flfile://` 自定义协议是唯一的本地文件入口：只读、支持 Range（视频抽帧需要）、
  返回 `Access-Control-Allow-Origin` 让 canvas 不被污染

## 五、界面层

- 无框架、无打包器：`file://` 下直接跑经典脚本，避免 ESM/CORS 与构建链问题
- 设计令牌集中在 `src/styles/app.css` 顶部，深浅色只是两组变量
- 页面统一 `registerPage(name, { mount, enter, focus })`，切换路由即挂载

### 两个必须记住的坑

**毛玻璃会让主内容变糊。** 给顶栏/侧栏加 `backdrop-filter` 时，
Chromium 为了生成背景模糊会把根图层降采样，主内容一起被牺牲；
在软件渲染（远程桌面、驱动异常、`--disable-gpu`）下尤其明显。
本项目因此改用分层半透明加描边，任何机器上文字都是清晰的。

**`display: grid` 会盖掉 `[hidden]`。** 全屏遮罩层如果只写
`display: grid`，`hidden` 属性就会失效，一层看不见的遮罩永久压在最上层，
页面发暗、发虚而且点不动。遮罩必须默认 `display: none`，用类名开启。

## 六、移动端

`mobile/` 是 Capacitor 工程，用 esbuild 把 `core/extract/index.js` 打包成
37 KB 的单文件脚本，直接跑在 WebView 里。

关键点：**CapacitorHttp 会把 `window.fetch` 接管为原生请求**，
因此网页抓取不受 WebView 同源策略限制，这是解析类应用能在手机上跑通的前提。
构建时通过 `plugins.CapacitorHttp.enabled` 打开。

`core/extract/downloader.js` 依赖 `node:fs`，不参与移动端打包；
手机端由系统下载能力（浏览器 / 分享）承接下载动作。

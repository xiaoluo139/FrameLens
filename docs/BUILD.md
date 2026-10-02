# 构建与打包

## 环境要求

| 目标 | 需要 |
|---|---|
| 桌面端 | Node.js 20 以上、npm |
| Windows 安装包 | 上述即可（electron-builder 会自动下载所需组件） |
| Android APK | JDK 17、Android SDK（platform 34 + build-tools） |

## 一、桌面端

开发与自检命令：

| 命令 | 作用 |
|---|---|
| `npm start` | 启动应用 |
| `npm test` | 单元 + 集成测试（31 项） |
| `npm run check` | 全量语法检查 |
| `npm run smoke` | 启动后自检 8 个页面是否挂载、遮罩层是否误挡界面 |
| `npm run shot` | 逐页截图到 `shots/` |
| `npm run verify` | 端到端验证本地推理（自动下载运行时与一个小模型） |

### 两种安装包

```
npm run build:win         精简版，约 78 MB，只有程序本体
npm run build:win:full    全内置版，运行时与模型一起打进安装包
```

全内置版可以指定随包模型，第二个参数是模型 id：

```
node scripts/build-win.mjs --bundled smolvlm-256m-q8_0     约 +300 MB
node scripts/build-win.mjs --bundled minicpm-v-2_6-iq3_xs  约 +3.6 GB
```

产物在 `release/`：

```
影析FrameLens-<版本>-x64-安装包.exe     NSIS 一键安装，双击即装，无需选目录
win-unpacked/                           免安装目录版
```

全内置版会在安装包里生成 `resources/bundled/`；应用启动时按
「用户数据目录优先、安装目录兜底」的顺序查找运行时与模型。

### 关于签名

默认不做代码签名，Windows 首次运行会提示「未知发布者」。
正式分发请配置 `CSC_LINK` 与 `CSC_KEY_PASSWORD` 环境变量接入代码签名证书。

### 已知问题与处理

**构建时报 rename Access is denied 或 file does not exist。**
某些杀毒软件或 Windows 索引服务会短暂占用刚解压的文件，
导致 electron-builder 无法把随机数字临时目录改名为正式名字。
`scripts/build-win.mjs` 已内置检测与自动重试；若仍失败，手动归位即可：

```powershell
Rename-Item .cache\electron-builder\nsis\<随机数字> nsis-3.0.4.1
```

**打包目录里出现 RCX 开头的 tmp 文件。**
这是 rcedit 写 exe 图标时的临时副本，被占用时删不掉会残留，让安装包凭空变大
（实测能多出 180 MB）。构建脚本每次都会自动清理，也可以用 `npm run clean`。

**npm 缓存不可写。**
内网或受限环境下把缓存指到项目内：`npm install --cache .\.npm-cache`。

## 二、Android

```
cd mobile
npm install
npm run build             用 esbuild 打包解析引擎到 www/
npm run android           调试版 APK
npm run android:release   已签名发布版 APK
```

产物：`mobile/android/app/build/outputs/apk/release/app-release.apk`

### 三种手机版

| 版本 | 体积 | 说明 |
|---|---|---|
| `npm run android:release` | 约 17 MB | 精简版：**推理运行时随包**，模型在应用内一键下载 |
| `npm run android:release:full` | 约 1.7 GB | **全内置版：模型也打进安装包**，装完开箱即用，无需联网 |
| 换更大的模型 | 约 2.7 GB | `node scripts/embed-model.mjs qwen2.5-vl-3b && npm run android:release` |

全内置版的模型来自 `scripts/embed-model.mjs`：它把 GGUF 复制进
`android/app/src/main/assets/models/`，应用首次使用时再展开到应用数据目录
（APK 里的 assets 不能直接给原生进程当文件用）。

两个必须注意的点：

1. `app/build.gradle` 里要 `noCompress 'so', 'gguf'`：可执行文件必须能直接运行，
   模型若被压缩，安装和首次读取都会极慢。
2. `android/gradle.properties` 里堆内存要调到 6G：
   默认 1.5G 在处理 1.6GB 资源时会 `Java heap space` 失败。

### 签名

`android/app/build.gradle` 默认读取项目自带的开发签名
（`mobile/framelens-release.keystore`，口令写在构建脚本里，仅供内部安装测试）。
正式发版请用环境变量替换为自有证书：

```powershell
$env:FRAMELENS_KEYSTORE="D:\keys\your.keystore"
$env:FRAMELENS_STORE_PASSWORD="..."
$env:FRAMELENS_KEY_ALIAS="..."
$env:FRAMELENS_KEY_PASSWORD="..."
npm run android:release
```

### 构建环境变量

Gradle 需要能找到 SDK 与 JDK，并需要一个可写的 `.android` 与 Gradle 主目录：

```powershell
$env:ANDROID_HOME="<你的 Android SDK>"
$env:ANDROID_USER_HOME="<可写目录>\.android"
$env:JAVA_HOME="<JDK 17>"
$env:GRADLE_USER_HOME="<可写目录>\.gradle"
```

`.android` 不可写时会报 `Failed to apply plugin 'com.android.internal.application'`，
就是缺 `ANDROID_USER_HOME` 这一项。

若 Gradle 发行包下载中断，可用项目自带下载器续传：

```powershell
node --input-type=module --eval "import {fetchToFile} from './core/model/downloader.js'; await fetchToFile({url:'https://services.gradle.org/distributions/gradle-8.2.1-all.zip',destPath:'<GRADLE_USER_HOME>/wrapper/dists/gradle-8.2.1-all/<hash>/gradle-8.2.1-all.zip'})"
```

### Capacitor CLI 在受限环境崩溃

若报 `uv_os_get_passwd ENOMEM`（沙箱或没有 passwd 条目的环境），用自带 shim：

```
node --require ./tools/userinfo-shim.cjs node_modules/@capacitor/cli/bin/capacitor add android
npm run sync:safe
```

## 三、macOS 与 Linux

```
npm run build:mac     dmg
npm run build:linux   AppImage 与 deb
```

注意：llama.cpp 官方最新 release 目前主要提供 Windows 资产。
非 Windows 平台需要自行准备 `llama-server`，放到
`<用户数据目录>/runtime/llama-<任意名>/` 下，应用启动时会自动识别。

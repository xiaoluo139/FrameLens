package com.framelens.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册手机端本地推理插件（启动/停止随包的 llama.cpp 服务）
        registerPlugin(LlamaServerPlugin.class);
        // 注册隐藏 WebView 提取插件（抖音等需要真实浏览器渲染的站点）
        registerPlugin(MediaExtractorPlugin.class);
        // 注册系统下载插件（保存视频/图片到「下载」目录）
        registerPlugin(DownloaderPlugin.class);
        // 注册模型导入插件（系统文件选择器 + 原生流式拷贝）
        registerPlugin(ModelImportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package com.framelens.mobile;

// 手机端的真正下载：用系统下载管理器。
//
// 为什么不直接在浏览器里打开链接：打开视频直链浏览器会「播放」而不是下载，
// 小白用户根本不知道该长按保存。系统下载管理器会把文件放到
// 「手机存储 / Download」，并在通知栏显示进度与完成提示——这才是用户预期。

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {

    private static final String TAG = "FrameLensDownload";
    private static final String UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    @PluginMethod
    public void enqueue(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "");
        String referer = call.getString("referer", "");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        try {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.addRequestHeader("User-Agent", UA);
            if (referer != null && !referer.isEmpty()) request.addRequestHeader("Referer", referer);

            String safe = fileName == null || fileName.isEmpty() ? null : sanitize(fileName);
            // 放到公共「下载」目录，用户在任何文件管理器里都能找到
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safe == null ? "" : safe);

            long id = manager.enqueue(request);
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("fileName", safe);
            call.resolve(ret);
        } catch (Exception error) {
            Log.e(TAG, "加入系统下载失败", error);
            call.reject("加入系统下载失败：" + error.getMessage());
        }
    }

    private String sanitize(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (cleaned.length() > 100) {
            int dot = cleaned.lastIndexOf('.');
            String ext = dot > 0 ? cleaned.substring(dot) : "";
            cleaned = cleaned.substring(0, Math.max(1, 100 - ext.length())) + ext;
        }
        return cleaned.isEmpty() ? "framelens-download" : cleaned;
    }
}

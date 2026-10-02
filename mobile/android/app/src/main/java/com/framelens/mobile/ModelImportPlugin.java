package com.framelens.mobile;

// 手机端的「导入本地模型」。
//
// 用的是系统文件选择器（SAF）+ 原生流式拷贝：
// GGUF 动辄一两 GB，走 WebView 的 FileReader/base64 会直接把内存打爆，
// 所以必须由原生代码直接把文件流写进应用目录。

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name = "ModelImport")
public class ModelImportPlugin extends Plugin {

    private static final String TAG = "FrameLensImport";

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            JSObject ret = new JSObject();
            ret.put("canceled", true);
            call.resolve(ret);
            return;
        }
        Intent data = result.getData();
        File targetDir = new File(getContext().getFilesDir(), "models/imported");
        targetDir.mkdirs();

        new Thread(() -> {
            JSArray files = new JSArray();
            try {
                java.util.List<Uri> uris = new java.util.ArrayList<>();
                if (data != null) {
                    if (data.getClipData() != null) {
                        for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                            uris.add(data.getClipData().getItemAt(i).getUri());
                        }
                    } else if (data.getData() != null) {
                        uris.add(data.getData());
                    }
                }
                if (uris.isEmpty()) {
                    call.reject("没有选择文件");
                    return;
                }

                for (Uri uri : uris) {
                    String name = displayName(uri);
                    if (name == null || name.isEmpty()) name = "model-" + System.currentTimeMillis() + ".gguf";
                    File out = new File(targetDir, name);
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                         FileOutputStream fos = new FileOutputStream(out)) {
                        if (in == null) continue;
                        byte[] buffer = new byte[1 << 20];
                        int read;
                        while ((read = in.read(buffer)) > 0) fos.write(buffer, 0, read);
                    }
                    JSObject item = new JSObject();
                    item.put("name", name);
                    item.put("bytes", out.length());
                    files.put(item);
                    Log.i(TAG, "已导入 " + name + " (" + out.length() / 1024 / 1024 + " MB)");
                }

                JSObject ret = new JSObject();
                ret.put("files", files);
                ret.put("dir", targetDir.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception error) {
                Log.e(TAG, "导入失败", error);
                call.reject("导入失败：" + error.getMessage());
            }
        }).start();
    }

    /** 取文件在系统里的显示名（聊天软件里的文件也是这样拿到的） */
    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // 取不到就退回按路径猜
        }
        String path = uri.getLastPathSegment();
        return path == null ? "" : path.substring(path.lastIndexOf('/') + 1);
    }
}

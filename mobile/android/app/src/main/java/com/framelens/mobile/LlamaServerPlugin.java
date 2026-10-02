package com.framelens.mobile;

// 手机端本地推理：把随 APK 分发的 llama.cpp（llama-server）跑起来，
// 然后在 WebView 里用和桌面端完全相同的 HTTP 接口对话。
//
// 为什么要用「启动子进程」而不是 JNI：这样手机端能直接复用桌面端那套
// 已经验证过的服务管理与对话代码，两边行为一致，出问题也好排查。

import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "LlamaServer")
public class LlamaServerPlugin extends Plugin {

    private static final String TAG = "FrameLensLlama";
    /** 随 APK 分发的可执行文件：必须以 lib*.so 命名才会被安装包解压到本机库目录 */
    private static final String EXECUTABLE = "libframelens-llama.so";

    private Process process;
    private int port = 8081;
    private boolean ready = false;

    /** 读取随包模型清单（全内置版才有；普通版返回空数组） */
    @PluginMethod
    public void bundledModels(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            InputStream in = getContext().getAssets().open("models/manifest.json");
            BufferedReader reader = new BufferedReader(new InputStreamReader(in));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            ret.put("manifest", new org.json.JSONObject(sb.toString()));
        } catch (Exception ignored) {
            ret.put("manifest", new org.json.JSONObject());
        }
        ret.put("modelDir", new File(getContext().getFilesDir(), "models").getAbsolutePath());
        call.resolve(ret);
    }

    /**
     * 把随包模型展开到应用数据目录。
     * APK 里的 assets 不能直接给原生进程当文件用，必须先落到真实文件系统。
     * 已经展开过（大小一致）就直接返回，避免重复拷贝。
     */
    @PluginMethod
    public void prepareBundled(PluginCall call) {
        String modelId = call.getString("modelId");
        if (modelId == null || modelId.isEmpty()) {
            call.reject("缺少 modelId");
            return;
        }
        File targetDir = new File(getContext().getFilesDir(), "models/" + modelId);
        AssetManager assets = getContext().getAssets();

        new Thread(() -> {
            try {
                java.util.List<String> names = new java.util.ArrayList<>();
                java.util.List<Long> sizes = new java.util.ArrayList<>();
                java.util.List<String> all = java.util.Arrays.asList(assets.list("models/" + modelId));
                for (String name : all) {
                    if (!name.toLowerCase().endsWith(".gguf")) continue;
                    names.add(name);
                    sizes.add(assetSize(assets, "models/" + modelId + "/" + name));
                }
                if (names.isEmpty()) {
                    call.reject("安装包里没有该模型");
                    return;
                }

                long total = 0;
                for (Long size : sizes) total += size;
                long done = 0;

                targetDir.mkdirs();
                for (int i = 0; i < names.size(); i++) {
                    String name = names.get(i);
                    File out = new File(targetDir, name);
                    if (out.exists() && out.length() == sizes.get(i)) {
                        done += sizes.get(i);
                        continue;
                    }
                    notifyProgress(done, total, "正在展开随包模型：" + name);
                    try (InputStream in = assets.open("models/" + modelId + "/" + name);
                         FileOutputStream fos = new FileOutputStream(out)) {
                        byte[] buffer = new byte[1 << 20];
                        int read;
                        while ((read = in.read(buffer)) > 0) {
                            fos.write(buffer, 0, read);
                            done += read;
                            notifyProgress(done, total, "正在展开随包模型：" + name);
                        }
                    }
                }

                JSObject ret = new JSObject();
                ret.put("dir", targetDir.getAbsolutePath());
                File model = new File(targetDir, names.get(0));
                File mmproj = names.size() > 1 ? new File(targetDir, names.get(1)) : null;
                // 主模型是大的那个，视觉编码器名字里通常带 mmproj
                for (String name : names) {
                    if (name.toLowerCase().contains("mmproj")) mmproj = new File(targetDir, name);
                    else model = new File(targetDir, name);
                }
                ret.put("modelPath", model.getAbsolutePath());
                ret.put("mmprojPath", mmproj == null ? "" : mmproj.getAbsolutePath());
                notifyProgress(total, total, "随包模型已就绪");
                call.resolve(ret);
            } catch (Exception error) {
                Log.e(TAG, "展开随包模型失败", error);
                call.reject("展开随包模型失败：" + error.getMessage());
            }
        }).start();
    }

    private long assetSize(AssetManager assets, String path) {
        try {
            android.content.res.AssetFileDescriptor fd = assets.openFd(path);
            long size = fd.getLength();
            fd.close();
            return size;
        } catch (Exception error) {
            // 被压缩的资产拿不到长度，退回流式统计
            try (InputStream in = assets.open(path)) {
                long size = 0;
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = in.read(buffer)) > 0) size += read;
                return size;
            } catch (Exception ignored) {
                return 0;
            }
        }
    }

    private void notifyProgress(long done, long total, String message) {
        JSObject progress = new JSObject();
        progress.put("done", done);
        progress.put("total", total);
        progress.put("percent", total > 0 ? Math.min(100, (done * 100.0) / total) : 0);
        progress.put("message", message);
        notifyListeners("prepareProgress", progress);
    }

    private String executablePath() {
        ApplicationInfo info = getContext().getApplicationInfo();
        return new File(info.nativeLibraryDir, EXECUTABLE).getAbsolutePath();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", process != null && process.isAlive());
        ret.put("ready", ready);
        ret.put("port", port);
        ret.put("executable", executablePath());
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String modelPath = call.getString("modelPath");
        if (modelPath == null || !new File(modelPath).exists()) {
            call.reject("模型文件不存在：" + modelPath);
            return;
        }
        if (process != null && process.isAlive()) {
            JSObject already = new JSObject();
            already.put("port", port);
            already.put("alreadyRunning", true);
            call.resolve(already);
            return;
        }

        String mmprojPath = call.getString("mmprojPath", "");
        port = call.getInt("port", 8081);
        int nCtx = call.getInt("nCtx", 4096);
        int threads = call.getInt("threads", Math.max(2, Runtime.getRuntime().availableProcessors() - 1));

        List<String> cmd = new ArrayList<>();
        cmd.add(executablePath());
        cmd.add("-m");
        cmd.add(modelPath);
        if (mmprojPath != null && !mmprojPath.isEmpty() && new File(mmprojPath).exists()) {
            cmd.add("--mmproj");
            cmd.add(mmprojPath);
        }
        cmd.add("-c");
        cmd.add(String.valueOf(nCtx));
        cmd.add("-t");
        cmd.add(String.valueOf(threads));
        cmd.add("--host");
        cmd.add("127.0.0.1");
        cmd.add("--port");
        cmd.add(String.valueOf(port));
        cmd.add("--jinja");
        cmd.add("--no-webui");

        try {
            ProcessBuilder builder = new ProcessBuilder(cmd);
            builder.redirectErrorStream(true);
            builder.directory(getContext().getFilesDir());
            // 关键：从 APK 解压出来的可执行文件，其依赖的 .so 都在应用的本机库目录里，
            // 动态链接器默认不去那里找，必须显式加进搜索路径，
            // 否则会报 "library libllama-server-impl.so not found"。
            builder.environment().put("LD_LIBRARY_PATH", getContext().getApplicationInfo().nativeLibraryDir);
            process = builder.start();
            ready = false;
            pipeLogs(process);
            Log.i(TAG, "已启动推理进程：" + String.join(" ", cmd));
        } catch (Exception error) {
            Log.e(TAG, "启动推理进程失败", error);
            call.reject("启动本地推理失败：" + error.getMessage());
            return;
        }

        // 等待 /health 就绪：手机加载几 GB 模型需要时间，给足 5 分钟
        final int waitPort = port;
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + 300_000;
            while (System.currentTimeMillis() < deadline) {
                if (process == null || !process.isAlive()) break;
                if (pingHealth(waitPort)) {
                    ready = true;
                    JSObject ret = new JSObject();
                    ret.put("port", waitPort);
                    ret.put("ready", true);
                    call.resolve(ret);
                    return;
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
            call.reject("模型加载超时或进程已退出，请查看运行日志");
        }).start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopProcess();
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    /** 进程输出转发到 logcat，方便真机排查 */
    private void pipeLogs(Process target) {
        new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(target.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.contains("error") || line.contains("ERR")) Log.e(TAG, line);
                    else Log.i(TAG, line);
                }
            } catch (Exception ignored) {
                // 进程结束时流会关闭，属正常
            }
        }).start();
    }

    private boolean pingHealth(int targetPort) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL("http://127.0.0.1:" + targetPort + "/health");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            return connection.getResponseCode() == 200;
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void stopProcess() {
        ready = false;
        if (process == null) return;
        try {
            process.destroy();
            if (!process.waitFor(4, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (Exception ignored) {
            process.destroyForcibly();
        } finally {
            process = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopProcess();
        super.handleOnDestroy();
    }
}

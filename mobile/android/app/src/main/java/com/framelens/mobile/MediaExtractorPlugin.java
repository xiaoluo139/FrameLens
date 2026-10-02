package com.framelens.mobile;

// 手机端的「用浏览器渲染页面提取媒体地址」。
//
// 抖音这类站点已经不在服务端 HTML 里放视频数据，老的公开接口也返回空。
// 桌面端用隐藏的 Electron 窗口解决，手机端就用一个不可见的 WebView：
// 让页面自己的 JS 去请求播放地址，我们拦截它发出的媒体请求。

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

@CapacitorPlugin(name = "MediaExtractor")
public class MediaExtractorPlugin extends Plugin {

    /** 复用的隐藏 WebView：每次新建要几百毫秒，而且缓存全丢，连续解析差别很明显 */
    private WebView sharedWebView;
    private FrameLayout sharedHolder;

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    private static final String[] MEDIA_HINTS = {
        "douyinvod.com", "/aweme/v1/play/", "googlevideo.com/videoplayback",
        "bilivideo.com", "tiktokcdn", "xhscdn", ".mp4", ".m3u8", ".webm", ".m4s",
    };

    /** 图文作品的配图：内容 CDN + 排除头像/图标 */
    private static boolean isContentImage(String url) {
        if (url == null) return false;
        if (!url.matches(".*\\.(jpg|jpeg|png|webp|avif)(\\?.*)?$")) return false;
        String lower = url.toLowerCase();
        if (lower.matches(".*(avatar|headimg|emoji|icon|logo|qrcode|favicon|profile).*")) return false;
        return lower.contains("douyinpic.com") || lower.contains("sns-img") || lower.contains("xhscdn.com/spectrum")
            || lower.contains("sinaimg.cn/large") || lower.contains("tiktokcdn");
    }

    private static boolean isMedia(String url) {
        if (url == null || !url.startsWith("http")) return false;
        if (url.matches(".*\\.(jpg|jpeg|png|webp|gif|svg|ico|css|js)(\\?|$).*")) return false;
        for (String hint : MEDIA_HINTS) {
            if (url.contains(hint)) return true;
        }
        return false;
    }

    @PluginMethod
    public void extract(PluginCall call) {
        String url = call.getString("url");
        int timeoutMs = call.getInt("timeoutMs", 30000);
        if (url == null || url.isEmpty()) {
            call.reject("缺少 url");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                final Set<String> found = Collections.synchronizedSet(new LinkedHashSet<>());
                final Set<String> images = Collections.synchronizedSet(new LinkedHashSet<>());
                final String[] title = {""};
                // 重定向后的真实地址：Capacitor 的 HTTP 拦截器拿不到，WebView 里的 location 是准的
                final String[] finalUrl = {url};
                final String[] cover = {""};

                final WebView web = ensureWeb();

                web.setWebViewClient(new WebViewClient() {
                    /**
                     * 只允许 http/https。
                     * 抖音、小红书这类页面会主动跳转 snssdk://、intent://、market:// 之类的
                     * 自定义协议去唤起自家 App——不拦住的话，系统会把它交给浏览器或对应 App，
                     * 用户就会遇到「切到某个页面突然跳到抖音」。
                     */
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        String target = request.getUrl().toString();
                        return !(target.startsWith("http://") || target.startsWith("https://"));
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String target) {
                        return !(target != null && (target.startsWith("http://") || target.startsWith("https://")));
                    }

                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        String target = request.getUrl().toString();
                        String scheme = request.getUrl().getScheme();
                        // 非 http(s) 一律返回空内容，别让它有机会把用户甩到别的 App
                        if (scheme != null && !scheme.equals("http") && !scheme.equals("https")) {
                            return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                        }
                        // 字体与埋点请求对解析没用，拦掉能明显加快页面加载
                        String lower = target.toLowerCase();
                        if (lower.matches(".*\\.(woff2?|ttf|otf|eot)(\\?.*)?$")
                            || lower.matches(".*(analytics|beacon|sentry|logreport|monitor).*")) {
                            return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                        }
                        if (isMedia(target)) {
                            synchronized (found) {
                                found.add(target);
                            }
                        } else if (isContentImage(target)) {
                            synchronized (images) {
                                images.add(target.split("\\?")[0]);
                            }
                        }
                        return super.shouldInterceptRequest(view, request);
                    }

                    @Override
                    public void onPageFinished(WebView view, String loaded) {
                        if (loaded != null && loaded.startsWith("http")) finalUrl[0] = loaded;
                        view.evaluateJavascript(
                            "(function(){var v=document.querySelector('video');" +
                            "var m=document.querySelector('meta[property=\"og:image\"]');" +
                            "var c=(v&&v.poster)||(m&&m.content)||'';" +
                            "return (document.title||'')+'\\u0001'+c;})()",
                            value -> {
                                String raw = value == null ? "" : value.replaceAll("^\"|\"$", "");
                                String[] parts = raw.split("\u0001", 2);
                                title[0] = parts[0];
                                if (parts.length > 1) cover[0] = parts[1];
                            }
                        );
                    }
                });

                web.loadUrl(url);

                new Thread(() -> {
                    long deadline = System.currentTimeMillis() + timeoutMs;
                    long firstMediaAt = 0;
                    while (System.currentTimeMillis() < deadline) {
                        boolean has;
                        synchronized (found) {
                            has = !found.isEmpty();
                        }
                        if (has && firstMediaAt == 0) firstMediaAt = System.currentTimeMillis();
                        // 拿到第一个地址后再多等一会儿，收集其它清晰度
                        // 拿到第一个地址后再等 700ms 收集其它清晰度即可
                        if (firstMediaAt > 0 && System.currentTimeMillis() - firstMediaAt > 700) break;
                        try {
                            Thread.sleep(500);
                        } catch (InterruptedException ignored) {
                            break;
                        }
                    }

                    JSArray list = new JSArray();
                    synchronized (found) {
                        for (String item : found) list.put(item);
                    }
                    JSArray imageList = new JSArray();
                    synchronized (images) {
                        int count = 0;
                        for (String item : images) {
                            if (count++ >= 24) break;
                            imageList.put(item);
                        }
                    }

                    final JSObject ret = new JSObject();
                    ret.put("mediaUrls", list);
                    ret.put("images", imageList);
                    ret.put("pageTitle", title[0]);
                ret.put("finalUrl", finalUrl[0]);
                    ret.put("cover", cover[0]);

                    // 窗口保留复用，只清掉本次的拦截器，避免下次把旧数据当成结果
                    getActivity().runOnUiThread(() -> {
                        try {
                            // 解析结束后换回「安全客户端」，继续保持拦截，别裸奔
                            web.setWebViewClient(createSafeClient());
                        } catch (Exception ignored) {
                            // 忽略清理异常
                        }
                        call.resolve(ret);
                    });
                }).start();
            } catch (Exception error) {
                call.reject("页面渲染失败：" + error.getMessage());
            }
        });
    }

    /** 隐藏 WebView 只创建一次，后续解析直接复用（省掉创建开销与首次加载成本） */
    private WebView ensureWeb() {
        if (sharedWebView != null) return sharedWebView;
        WebView web = new WebView(getContext());
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(UA);
                settings.setMediaPlaybackRequiresUserGesture(false);
                settings.setCacheMode(WebSettings.LOAD_DEFAULT);
                // 不要开新窗口，避免页面里 window.open 跳出系统浏览器
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        /**
         * 建的时候就挂上「只放行 http/https」的客户端。
         * 之前只有解析时才设置，预热阶段页面一跳转就没人拦，
         * 系统会把它交给浏览器/抖音 App——用户看到的就是「打开对话页自动跳到抖音」。
         */
        web.setWebViewClient(createSafeClient());

        sharedHolder = new FrameLayout(getContext());
        sharedHolder.setAlpha(0f);
        sharedHolder.setBackgroundColor(Color.TRANSPARENT);
        web.setLayoutParams(new FrameLayout.LayoutParams(2, 2));
        sharedHolder.addView(web);
        getActivity().addContentView(sharedHolder, new ViewGroup.LayoutParams(2, 2));
        sharedWebView = web;
        return web;
    }

    /** 只允许 http/https 的最小客户端：所有自定义协议与弹窗一律拦掉 */
    private WebViewClient createSafeClient() {
        return new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                return !(target.startsWith("http://") || target.startsWith("https://"));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String target) {
                return !(target != null && (target.startsWith("http://") || target.startsWith("https://")));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                // iframe / 图片等子资源里的自定义协议同样不能放行
                if (scheme != null && !scheme.equals("http") && !scheme.equals("https") && !scheme.equals("data")) {
                    return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
        };
    }

    /** 启动预热：建好 WebView 并加载一次站点首页，把 JS 与连接缓存起来 */
    @PluginMethod
    public void warmUp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                ensureWeb().loadUrl("https://www.iesdouyin.com/");
            } catch (Exception ignored) {
                // 预热失败不影响正常使用
            }
            JSObject ret = new JSObject();
            ret.put("warmed", true);
            call.resolve(ret);
        });
    }
}

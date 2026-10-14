package com.avelec.chatlite;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * v122 自写流式插件（取代 npm 的 capacitor-stream-http 用于聊天链路）。
 *
 * 相对 npm 版的四处关键差异：
 *  1. readTimeout 由 JS 传入 —— npm 版把读超时写死 30 秒，模型静默思考超过 30 秒就被掐断，
 *     且 JS 侧的 120 秒空闲超时永远先到不了。现在原生读超时 = JS 空闲超时 + 15 秒缓冲。
 *  2. 原始文本直接透传 —— 不再在原生侧做 SSE 事件拼装，行缓冲交给 JS（JS 本来就有跨分包的
 *     行缓冲），少一层就可能少丢一截。
 *  3. end 事件带 completed 标记 —— 区分「读到 [DONE]」与「连接被提前关闭」；npm 版两种情况
 *     都发 end，JS 一律当正常完成 → 静默截断。
 *  4. 非 2xx 明确报错 —— npm 版把错误体当 SSE 读一遍、什么都没解出来，最后发 end，
 *     JS 侧视为「成功但空回复」；现在直接发 error，并带上响应体里的错误信息。
 *
 * 放在 android/app 模块（不是 node_modules）——cap sync / npm install 都不会覆盖，
 * 与 MediaSaverPlugin 同一套路。
 */
@CapacitorPlugin(name = "ChatStream")
public class ChatStreamPlugin extends Plugin {

    private static final String TAG = "ChatStreamPlugin";

    private static final int DEFAULT_CONNECT_TIMEOUT_MS = 30000;
    private static final int DEFAULT_READ_TIMEOUT_MS = 180000;
    private static final int MIN_READ_TIMEOUT_MS = 10000;
    private static final int MAX_READ_TIMEOUT_MS = 3700000;

    private final Map<String, HttpURLConnection> activeConnections = new ConcurrentHashMap<>();
    private final Map<String, Thread> activeThreads = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelledStreams = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void startStream(PluginCall call) {
        String urlString = call.getString("url");
        if (urlString == null || urlString.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        final String streamId = UUID.randomUUID().toString();
        final String method = call.getString("method", "POST");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body");

        Integer ct = call.getInt("connectTimeoutMs", DEFAULT_CONNECT_TIMEOUT_MS);
        Integer rt = call.getInt("readTimeoutMs", DEFAULT_READ_TIMEOUT_MS);
        final int connectTimeoutMs = clamp(ct, 5000, 120000);
        final int readTimeoutMs = clamp(rt, MIN_READ_TIMEOUT_MS, MAX_READ_TIMEOUT_MS);

        executor.execute(new Runnable() {
            @Override
            public void run() {
                runStream(streamId, urlString, method, headers, body, connectTimeoutMs, readTimeoutMs);
            }
        });

        JSObject ret = new JSObject();
        ret.put("id", streamId);
        call.resolve(ret);
    }

    private void runStream(String streamId, String urlString, String method, JSObject headers,
                           String body, int connectTimeoutMs, int readTimeoutMs) {
        HttpURLConnection connection = null;
        boolean gotData = false;
        boolean sawDone = false;
        boolean cancelled = false;
        String failReason = null;
        int charCount = 0;

        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            activeConnections.put(streamId, connection);
            activeThreads.put(streamId, Thread.currentThread());

            connection.setRequestMethod(method);
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);

            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.getString(key);
                if (value != null) {
                    connection.setRequestProperty(key, value);
                }
            }

            // 与 npm 版保持一致：请求体走 chunked，避免依赖 Content-Length
            connection.setChunkedStreamingMode(0);

            if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                connection.setDoOutput(true);
                OutputStream os = connection.getOutputStream();
                try {
                    os.write(body.getBytes("UTF-8"));
                    os.flush();
                } finally {
                    os.close();
                }
            }

            int status = connection.getResponseCode();
            Log.d(TAG, "status=" + status + " sid=" + streamId);

            if (status < 200 || status >= 300) {
                connection.setReadTimeout(10000);
                failReason = "HTTP " + status + readErrorBody(connection);
            } else {
                InputStream inputStream = connection.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, "UTF-8"), 8192);
                char[] buf = new char[4096];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    if (Boolean.TRUE.equals(cancelledStreams.get(streamId))) {
                        cancelled = true;
                        break;
                    }
                    String text = new String(buf, 0, n);
                    gotData = true;
                    charCount += n;
                    if (!sawDone && text.contains("[DONE]")) {
                        sawDone = true;
                    }
                    JSObject chunkData = new JSObject();
                    chunkData.put("id", streamId);
                    chunkData.put("chunk", text);
                    notifyListeners("chunk", chunkData);
                }
                reader.close();
            }
        } catch (SocketTimeoutException e) {
            failReason = "读取超时（原生 " + (readTimeoutMs / 1000) + " 秒无数据）";
            Log.w(TAG, "read timeout sid=" + streamId);
        } catch (IOException e) {
            failReason = (e.getMessage() == null) ? e.getClass().getSimpleName() : e.getMessage();
            Log.w(TAG, "io error sid=" + streamId + " : " + failReason);
        } catch (Exception e) {
            failReason = (e.getMessage() == null) ? e.getClass().getSimpleName() : e.getMessage();
            Log.w(TAG, "stream error sid=" + streamId + " : " + failReason);
        } finally {
            HttpURLConnection conn = activeConnections.remove(streamId);
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignore) { }
            }
            activeThreads.remove(streamId);
            if (Boolean.TRUE.equals(cancelledStreams.remove(streamId))) {
                cancelled = true;
            }
            Log.d(TAG, "closed sid=" + streamId + " chars=" + charCount
                    + " gotData=" + gotData + " sawDone=" + sawDone
                    + " cancelled=" + cancelled + " fail=" + failReason);

            if (cancelled) {
                // 取消：不发任何事件。JS 侧（用户停止 / 空闲超时）已经自己收尾，
                // 再补一个 end 会被当成「正常完成」，把停止标记吃掉。
                return;
            }
            if (failReason != null) {
                if (gotData) {
                    // 已经吐出过数据 → 按「提前中断」上报，JS 保留内容并标记疑似截断
                    JSObject endData = new JSObject();
                    endData.put("id", streamId);
                    endData.put("completed", false);
                    endData.put("reason", "interrupted");
                    endData.put("error", failReason);
                    notifyListeners("end", endData);
                } else {
                    JSObject errorData = new JSObject();
                    errorData.put("id", streamId);
                    errorData.put("error", failReason);
                    notifyListeners("error", errorData);
                }
                return;
            }

            JSObject endData = new JSObject();
            endData.put("id", streamId);
            endData.put("completed", sawDone);
            endData.put("reason", sawDone ? "done" : "eof");
            endData.put("bytes", charCount);
            notifyListeners("end", endData);
        }
    }

    @PluginMethod
    public void cancelStream(PluginCall call) {
        String streamId = call.getString("id");
        if (streamId == null) {
            call.reject("Stream ID is required");
            return;
        }
        cancelledStreams.put(streamId, Boolean.TRUE);
        HttpURLConnection connection = activeConnections.remove(streamId);
        if (connection != null) {
            try { connection.disconnect(); } catch (Exception ignore) { }
        }
        Thread thread = activeThreads.remove(streamId);
        if (thread != null) {
            thread.interrupt();
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (HttpURLConnection connection : activeConnections.values()) {
            try { connection.disconnect(); } catch (Exception ignore) { }
        }
        activeConnections.clear();
        for (Thread thread : activeThreads.values()) {
            thread.interrupt();
        }
        activeThreads.clear();
        executor.shutdown();
        super.handleOnDestroy();
    }

    /** 非 2xx 时把响应体里的错误信息读出来（限长，避免畸形响应拖死线程） */
    private String readErrorBody(HttpURLConnection connection) {
        try {
            InputStream es = connection.getErrorStream();
            if (es == null) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(es, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            int guard = 0;
            while ((line = br.readLine()) != null && guard < 20) {
                sb.append(line);
                guard++;
            }
            br.close();
            String s = sb.toString();
            if (s.length() > 400) s = s.substring(0, 400);
            return s.isEmpty() ? "" : ": " + s;
        } catch (Exception e) {
            return "";
        }
    }

    private static int clamp(Integer value, int min, int max) {
        int v = (value == null) ? min : value.intValue();
        if (v < min) v = min;
        if (v > max) v = max;
        return v;
    }
}

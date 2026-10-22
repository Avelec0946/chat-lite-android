package com.avelec.chatlite;

import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * CallKeepAlive —— 通话期间的三件套：局部唤醒锁 + Wi-Fi 高性能锁 + 前台服务。
 *
 * 真机实测（v132，小米 22081212C / MIUI，息屏 35 秒）：
 *   · 采集照常：35s 内仍收到 820 个音频块（≈23/s）→ 麦克风与 AudioContext 都没被冻；
 *   · 但 JS 定时器被节流：250ms 的 interval 只跑了 38 次（本该 141 次），约 1 次/秒；
 *   · 更致命的是**网络断了**：API 调用直接
 *     "Unable to resolve host api.xiaomimimo.com: No address associated with hostname"，
 *     也就是息屏后连 DNS 都解析不了 —— 通话在这一刻就已经死了。
 *
 * 所以"息屏还能通话"不是靠 JS 努力，而是要让系统承认"这个进程正在为用户工作"：
 *   1) PARTIAL_WAKE_LOCK —— CPU 不休眠（定时器、流式读取才不会停摆）；
 *   2) WifiLock(FULL_HIGH_PERF) —— 息屏后 Wi-Fi 无线不进省电模式（这是 DNS 失败的直接原因）；
 *   3) 前台服务（CallKeepService）—— 进程不被冻结/回收，后台网络不受限。
 *
 * 三条都是"尽力而为"：任何一条失败都只记日志，**绝不 reject** ——
 * 保活失败最多是这通电话不抗息屏，不能因此把通话主链路弄断。
 */
@CapacitorPlugin(name = "CallKeepAlive")
public class CallKeepAlivePlugin extends Plugin {

    private static final String TAG = "CallKeepAlive";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private android.os.Handler tickHandler;
    private Runnable tickRunnable;
    private boolean ticking = false;

    /**
     * v132：原生心跳。
     *
     * 为什么需要它：息屏后页面进入 hidden 状态，Chromium 把 JS 定时器节流到
     * 1 次/30 秒量级（实测 250ms 的 interval 35 秒只跑了 38 次），而"采集是不是停了"
     * 这类判断必须及时。原生线程不受这个节流约束 —— 每 5 秒 evaluateJavascript 一次
     * 页面里的 __callTick()，让 JS 有机会跑看门狗。
     *
     * 顺带效果：定期执行 JS 也让渲染进程保持活跃，不至于被当成"纯后台页面"彻底冻住。
     */
    private void startTick() {
        if (ticking) return;
        ticking = true;
        if (tickHandler == null) tickHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        tickRunnable = new Runnable() {
            @Override
            public void run() {
                if (!ticking) return;
                try {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        android.webkit.WebView wv = getBridge().getWebView();
                        // 两步都要做：
                        //  · resumeTimers() —— 把 WebView 的 JS 定时器重新拉起来；
                        //  · onResume()     —— 让 AwContents 认为页面仍是活动页（对隐藏页冻结的对抗）。
                        // 两者都在后台被系统"顺手暂停"过，只 executeJavascript 是不够的。
                        try { wv.resumeTimers(); } catch (Exception e) {}
                        try { wv.onResume(); } catch (Exception e) {}
                        wv.evaluateJavascript("window.__callTick&&window.__callTick()", null);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "心跳执行失败", e);
                }
                if (ticking) tickHandler.postDelayed(this, 5000);
            }
        };
        tickHandler.postDelayed(tickRunnable, 5000);
    }

    private void stopTick() {
        ticking = false;
        if (tickHandler != null && tickRunnable != null) {
            try { tickHandler.removeCallbacks(tickRunnable); } catch (Exception e) {}
        }
        tickRunnable = null;
    }

    private void ensureLocks() {
        Context ctx = getContext();
        if (wakeLock == null) {
            try {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chatlite:call");
                    wakeLock.setReferenceCounted(false);
                }
            } catch (Exception e) {
                Log.w(TAG, "创建唤醒锁失败", e);
            }
        }
        if (wifiLock == null) {
            try {
                WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "chatlite:call-wifi");
                    wifiLock.setReferenceCounted(false);
                }
            } catch (Exception e) {
                Log.w(TAG, "创建 Wi-Fi 锁失败", e);
            }
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject ret = new JSObject();
        boolean wake = false;
        boolean wifi = false;
        boolean service = false;
        try {
            ensureLocks();
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
            wake = wakeLock != null && wakeLock.isHeld();
        } catch (Exception e) {
            Log.w(TAG, "获取唤醒锁失败", e);
        }
        try {
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
            wifi = wifiLock != null && wifiLock.isHeld();
        } catch (Exception e) {
            Log.w(TAG, "获取 Wi-Fi 锁失败", e);
        }
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, CallKeepService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            service = true;
        } catch (Exception e) {
            // Android 12+ 后台启动前台服务会抛 ForegroundServiceStartNotAllowedException；
            // 我们是在通话开始（应用可见）时调用，正常不会命中，命中也不上报失败
            Log.e(TAG, "启动前台服务失败", e);
        }
        startTick();
        ret.put("started", wake || wifi || service);
        ret.put("wakeLock", wake);
        ret.put("wifiLock", wifi);
        ret.put("service", service);
        ret.put("sdk", Build.VERSION.SDK_INT);
        Log.i(TAG, "start -> wake=" + wake + " wifi=" + wifi + " service=" + service);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject ret = new JSObject();
        stopTick();
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) {
            Log.w(TAG, "释放唤醒锁失败", e);
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception e) {
            Log.w(TAG, "释放 Wi-Fi 锁失败", e);
        }
        try {
            getContext().stopService(new Intent(getContext(), CallKeepService.class));
        } catch (Exception e) {
            Log.w(TAG, "停止前台服务失败", e);
        }
        ret.put("stopped", true);
        Log.i(TAG, "stop");
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("wakeLock", wakeLock != null && wakeLock.isHeld());
        ret.put("wifiLock", wifiLock != null && wifiLock.isHeld());
        ret.put("ticking", ticking);
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        // Activity 销毁：心跳与两把锁都不能留着（前台服务的清理由 JS 侧 stop() 负责，
        //   这里只处理"进程还在但没有通话界面"的场景）
        stopTick();
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception e) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception e) {}
        super.handleOnDestroy();
    }
}

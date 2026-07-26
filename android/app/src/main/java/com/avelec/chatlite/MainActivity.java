package com.avelec.chatlite;

import android.os.Bundle;
import android.os.PowerManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private PowerManager.WakeLock networkWakeLock;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // v71: 创建 WakeLock，用于后台期间保持 CPU 活跃
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        networkWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chatlite:network");
        networkWakeLock.setReferenceCounted(false);
    }

    @Override
    public void onPause() {
        super.onPause();
        // v71: 恢复 WebView，保持 JS 定时器和网络请求活跃
        // Capacitor 默认在 onPause 时调用 webView.onPause() 暂停 JS，导致 fetch 连接被
        // 系统中断（"Software caused connection abort"）。调用 onResume() 恢复 WebView。
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().onResume();
            }
        } catch (Exception e) {
            // 忽略异常，避免影响 Activity 生命周期
        }
        // 获取 WakeLock，防止 CPU 休眠（10 分钟自动释放）
        if (networkWakeLock != null && !networkWakeLock.isHeld()) {
            try {
                networkWakeLock.acquire(10 * 60 * 1000);
            } catch (Exception e) {
                // 忽略
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 释放后台期间获取的锁
        if (networkWakeLock != null && networkWakeLock.isHeld()) {
            networkWakeLock.release();
        }
    }

    @Override
    public void onDestroy() {
        if (networkWakeLock != null && networkWakeLock.isHeld()) {
            networkWakeLock.release();
        }
        super.onDestroy();
    }
}

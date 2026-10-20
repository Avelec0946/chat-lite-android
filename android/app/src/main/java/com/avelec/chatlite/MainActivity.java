package com.avelec.chatlite;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "ChatLiteMain";

    /** v125: 麦克风运行时权限的请求码，与其它权限请求互不干扰 */
    private static final int REQ_CODE_MIC = 4101;

    private PowerManager.WakeLock networkWakeLock;

    /** v125: 正在进行中的 WebView 权限请求（getUserMedia 弹出的那个），系统权限对话框回来后要给它回话 */
    private PermissionRequest pendingWebPermissionRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // v113: 注册自写插件——通过 MediaStore 把图片存入系统相册
        // （原 Filesystem EXTERNAL_STORAGE 路径在 Android 10 + targetSdk 34 下必然被拒）
        registerPlugin(MediaSaverPlugin.class);
        // v122: 注册自写流式插件——读超时可配 + 区分「正常结束」与「提前中断」
        // （npm 的 capacitor-stream-http 把 readTimeout 写死 30 秒，长思考模型必被掐断）
        registerPlugin(ChatStreamPlugin.class);
        super.onCreate(savedInstanceState);
        // v71: 创建 WakeLock，用于后台期间保持 CPU 活跃
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        networkWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chatlite:network");
        networkWakeLock.setReferenceCounted(false);

        // v125: 装上支持麦克风的 WebChromeClient（必须在 super.onCreate 之后，此时 bridge/webView 才存在）
        installMicChromeClient();
    }

    /**
     * v125: 把 Capacitor 默认的 BridgeWebChromeClient 替换成我们的子类。
     *
     * 为什么不能直接用 Capacitor 6 自带的那份：
     *  - 它会为 AUDIO_CAPTURE 同时申请 MODIFY_AUDIO_SETTINGS（install-time 权限，无需运行时申请）；
     *  - 更关键的是它的授权结果回调是成员变量 permissionListener，与文件选择器
     *    (onShowFileChooser) 共用同一个槽位——两者并发时后一个会覆盖前一个，
     *    导致 getUserMedia 的 Promise 永远挂着，界面卡在"连接中"且没有任何报错。
     *    通话场景下用户可能一边通话一边发图片，这个竞态是真实可触发的。
     *
     * 选择「继承 BridgeWebChromeClient 只覆盖 onPermissionRequest」而不是重写一个
     * 全新的 WebChromeClient：JS alert/confirm、文件选择、视频全屏、控制台日志
     * 全部原样继承，不可能因为我们的改动而回归。
     */
    private void installMicChromeClient() {
        try {
            Bridge bridge = getBridge();
            if (bridge == null || bridge.getWebView() == null) {
                Log.w(TAG, "installMicChromeClient: bridge/webView 为空，跳过（getUserMedia 将退回 Capacitor 默认实现）");
                return;
            }
            WebView webView = bridge.getWebView();
            webView.setWebChromeClient(new MicWebChromeClient(bridge));
            Log.i(TAG, "v125 麦克风 WebChromeClient 已安装");
        } catch (Exception e) {
            // 兜底：安装失败时保持 Capacitor 默认实现，App 其余功能不受影响
            Log.e(TAG, "installMicChromeClient 失败，保留 Capacitor 默认实现", e);
        }
    }

    /**
     * v125: 只改 onPermissionRequest 的 WebChromeClient。
     * 其余一切行为继承 Capacitor 的 BridgeWebChromeClient。
     */
    private class MicWebChromeClient extends BridgeWebChromeClient {

        MicWebChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            handleWebPermissionRequest(request);
        }
    }

    /**
     * v125: 网页调用 navigator.mediaDevices.getUserMedia({audio:true}) 时走到这里。
     * 两件事缺一不可：
     *   1) 确认 App 已拿到 RECORD_AUDIO 运行时权限（没有就弹系统对话框）；
     *   2) 把 WebView 的 PermissionRequest 显式 grant 掉。
     * 只 grant 没系统权限 → 采集时抛 SecurityException；
     * 只申请系统权限不 grant → getUserMedia 报 NotAllowedError。
     */
    private void handleWebPermissionRequest(final PermissionRequest request) {
        try {
            String[] requested = request.getResources();
            boolean wantsAudio = false;
            boolean wantsVideo = false;
            for (int i = 0; i < requested.length; i++) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(requested[i])) {
                    wantsAudio = true;
                } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(requested[i])) {
                    wantsVideo = true;
                }
            }

            Log.i(TAG, "onPermissionRequest: wantsAudio=" + wantsAudio + " wantsVideo=" + wantsVideo +
                    " origin=" + request.getOrigin());

            if (!wantsAudio && !wantsVideo) {
                // 不支持的能力（如 MIDI）明确拒绝，绝不让 JS 干等
                request.deny();
                return;
            }

            List<String> missing = new ArrayList<String>();
            if (wantsAudio) {
                String err = collectMissing(Manifest.permission.RECORD_AUDIO, missing);
                if (err != null) {
                    Log.e(TAG, err);
                    request.deny();
                    return;
                }
            }
            if (wantsVideo) {
                String err = collectMissing(Manifest.permission.CAMERA, missing);
                if (err != null) {
                    Log.e(TAG, err);
                    request.deny();
                    return;
                }
            }

            if (missing.isEmpty()) {
                Log.i(TAG, "麦克风运行时权限已就绪，直接 grant");
                request.grant(request.getResources());
                return;
            }

            // 需要弹系统对话框：先存下 request，等 onRequestPermissionsResult 回来再回话
            if (pendingWebPermissionRequest != null) {
                try {
                    pendingWebPermissionRequest.deny();
                } catch (Exception ignored) {
                    // 旧 request 可能已失效，忽略
                }
            }
            pendingWebPermissionRequest = request;
            ActivityCompat.requestPermissions(MainActivity.this, missing.toArray(new String[0]), REQ_CODE_MIC);
        } catch (Exception e) {
            Log.e(TAG, "handleWebPermissionRequest 异常", e);
            try {
                request.deny();
            } catch (Exception ignored) {
                // 已失效则忽略
            }
        }
    }

    /**
     * v125: 检查某个权限：没在 manifest 里声明 → 返回错误描述；已授予 → 不入 missing；
     * 未授予 → 加进 missing。返回 null 表示可以继续。
     */
    private String collectMissing(String permission, List<String> missing) {
        boolean declared = false;
        try {
            declared = getPackageManager().getPermissionInfo(permission, 0) != null;
        } catch (PackageManager.NameNotFoundException e) {
            declared = false;
        }
        if (!declared) {
            return "权限 " + permission + " 未在 AndroidManifest.xml 中声明，getUserMedia 必然失败";
        }
        if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
            missing.add(permission);
        }
        return null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        // 先交给 Capacitor 默认处理（其它插件也走这套）
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != REQ_CODE_MIC) {
            return;
        }

        PermissionRequest request = pendingWebPermissionRequest;
        pendingWebPermissionRequest = null;
        if (request == null) {
            return;
        }

        boolean allGranted = grantResults != null && grantResults.length > 0;
        if (allGranted) {
            for (int i = 0; i < grantResults.length; i++) {
                if (grantResults[i] != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                }
            }
        }

        try {
            if (allGranted) {
                Log.i(TAG, "运行时权限已授予 → grant getUserMedia 请求");
                request.grant(request.getResources());
            } else {
                Log.w(TAG, "运行时权限被拒绝 → deny getUserMedia 请求");
                request.deny();
            }
        } catch (Exception e) {
            Log.e(TAG, "回话 PermissionRequest 失败（可能已失效）", e);
        }
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

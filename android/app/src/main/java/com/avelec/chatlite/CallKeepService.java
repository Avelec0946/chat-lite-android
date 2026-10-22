package com.avelec.chatlite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * v132 —— 通话保活的前台服务。
 *
 * 为什么必须是「前台服务」而不是只加个 WakeLock：
 *   Android 会把"没有前台可见组件"的进程当成后台进程：屏幕一关，进程可能被冻结、
 *   被杀，网络也会被限制（实测：息屏后 DNS 直接解析失败
 *   "Unable to address host: No address associated with hostname"）。
 *   光有 PARTIAL_WAKE_LOCK 只能让 CPU 不休眠，挡不住"后台网络受限/进程冻结"。
 *   前台服务带常驻通知，系统就把这个进程当"正在为用户做事"，网络与 CPU 都不受限。
 *
 * 类型必须是 microphone | mediaPlayback（Android 14 / targetSdk 34 强制）：
 *   · microphone     —— 通话要一直收音，声明了才允许后台采集；
 *   · mediaPlayback  —— 通话要一直放 TTS 音频。
 *   缺声明的后果不是"降级"，是启动即崩（MissingForegroundServiceTypeException）。
 *
 * 通知本身只做两件事：告诉用户在通话中、点一下回到应用。挂断必须在应用内做 ——
 * 通知按钮直接挂断会让 JS 侧状态机与服务端音频状态脱节。
 */
public class CallKeepService extends Service {
    private static final String TAG = "CallKeep";
    public static final String CHANNEL_ID = "chatlite-call";
    public static final int NOTIF_ID = 4201;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "通话中", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("语音通话进行时保持通话不被系统掐断");
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.w(TAG, "创建通知渠道失败（不影响服务运行）", e);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = null;
        try {
            pi = PendingIntent.getActivity(this, 0, open, flags);
        } catch (Exception e) {
            Log.w(TAG, "PendingIntent 创建失败", e);
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("语音通话中")
                .setContentText("息屏后仍保持通话；挂断请回到应用内操作")
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setShowWhen(false);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                        | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(NOTIF_ID, n, types);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, n);
            }
            Log.i(TAG, "前台服务已启动（通话保活生效）");
        } catch (Exception e) {
            // 起不来也不能让 App 崩：调用方（JS）会把失败记进日志，通话本身继续
            Log.e(TAG, "startForeground 失败", e);
        }
        // 不要把服务重启成"没有通话"的僵尸：通话状态只在 JS 里，进程被杀就让它干净结束
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "前台服务结束");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

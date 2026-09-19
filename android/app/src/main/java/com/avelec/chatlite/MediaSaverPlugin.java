package com.avelec.chatlite;

import android.Manifest;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;

/**
 * MediaSaver —— 把图片写入系统媒体库（相册）。
 *
 * 背景（v113）：原来的 saveImageToDevice 用 Capacitor Filesystem 的
 * directory:'EXTERNAL_STORAGE' 直接写 /sdcard/Download，需要
 * READ/WRITE_EXTERNAL_STORAGE（Android 9-）或 MANAGE_EXTERNAL_STORAGE
 * （Android 11+，需用户去系统设置手动开"所有文件访问"），本项目从未声明过，
 * 因此在目标设备（华为平板 M6 / Android 10 / targetSdk 34）上必然被拒，
 * 报错：Missing the following permissions in AndroidManifest.xml。
 *
 * 正确做法是走 MediaStore：
 *   - Android 10 (Q) 及以上：插入自己的媒体到 MediaStore 无需任何权限，
 *     配合 IS_PENDING 保证写入原子性，完成后系统相册自动可见
 *   - Android 9 及以下：仍需 WRITE_EXTERNAL_STORAGE（manifest 中声明
 *     maxSdkVersion="28"，仅在老系统生效，不影响新系统的权限模型）
 *
 * 图片落地位置：Pictures/chat-lite/
 */
@CapacitorPlugin(
    name = "MediaSaver",
    permissions = {
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class MediaSaverPlugin extends Plugin {

    @PluginMethod
    public void saveImage(PluginCall call) {
        // Android 9 及以下：MediaStore 插入需要 WRITE_EXTERNAL_STORAGE
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermsCallback");
            return;
        }
        doSave(call);
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            doSave(call);
        } else {
            call.reject("PERMISSION_DENIED: 需要存储权限才能保存到相册");
        }
    }

    private void doSave(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 is required");
            return;
        }

        String fileName = call.getString("fileName");
        if (fileName == null || fileName.isEmpty()) {
            fileName = "chatlite_" + System.currentTimeMillis() + ".png";
        }
        String mimeType = call.getString("mimeType", "image/png");
        String album = call.getString("album", "chat-lite");

        Context ctx = getContext();
        Uri inserted = null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(
                    MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/" + album
                );
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            }

            inserted = ctx.getContentResolver()
                .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (inserted == null) {
                call.reject("SAVE_FAILED: MediaStore insert returned null uri");
                return;
            }

            OutputStream os = ctx.getContentResolver().openOutputStream(inserted);
            if (os == null) {
                call.reject("SAVE_FAILED: openOutputStream returned null");
                return;
            }
            try {
                os.write(bytes);
                os.flush();
            } finally {
                try { os.close(); } catch (Exception ignored) { }
            }

            // 解除 pending，系统相册此刻起可见
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                ctx.getContentResolver().update(inserted, done, null, null);
            }

            JSObject ret = new JSObject();
            ret.put("uri", inserted.toString());
            ret.put("fileName", fileName);
            ret.put("album", album);
            ret.put("size", bytes.length);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ret.put("path", Environment.DIRECTORY_PICTURES + "/" + album + "/" + fileName);
            } else {
                ret.put("path", fileName);
            }
            call.resolve(ret);
        } catch (Exception e) {
            // 写入失败时清掉半成品记录，避免相册里留下空条目
            if (inserted != null) {
                try {
                    ctx.getContentResolver().delete(inserted, null, null);
                } catch (Exception ignored) { }
            }
            call.reject("SAVE_FAILED: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }
}

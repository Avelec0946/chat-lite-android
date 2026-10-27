package com.avelec.chatlite;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * BackupArchive —— 全量备份包的打包 / 解包（数据管理 v2）。
 *
 * 为什么必须原生做（2026-10-27 审计结论）：
 *   Capacitor 的 Filesystem.readFile **没有 offset/length**，只能把整个文件读成 base64，
 *   而用户的图库实测 333 MB —— 任何"在 JS 里读写 zip"的方案都会直接把 WebView 撑爆。
 *   这里用 java.util.zip 流式处理，峰值内存与包大小无关（单个缓冲 64 KB）。
 *
 * 包内结构（STORE 不压缩：PNG/JPEG 已压过，deflate 只烧 CPU）：
 *   manifest.json   版本 / 时间 / 条目数 / 总字节 / 图片清单
 *   data.json       会话 · 分组 · 接口 · 设置 · 图库元数据（不含任何大 base64）
 *   images/         图库原图
 *   thumbs/         图库缩略图（*_thumb.jpg）
 *   refs/           参考图（可选）
 *
 * 所有相对路径都相对 app 的 files 目录（= Capacitor Directory.DATA）。
 * 导入走两步：先 extractImages 解到 staging 目录并校验，再 commitStaging 整体替换，
 * 保证"失败时原目录一个字节都不动"。
 */
@CapacitorPlugin(name = "BackupArchive")
public class BackupArchivePlugin extends Plugin {

    private static final String IMAGES_DIR = "chatlite_images";

    private File filesDir() {
        return getContext().getFilesDir();
    }

    private File cacheDir() {
        return getContext().getCacheDir();
    }

    /** 相对 files 目录 → File；也接受绝对路径（staging 用） */
    private File resolve(String path) {
        if (path == null) return null;
        File f = new File(path);
        if (f.isAbsolute()) return f;
        return new File(filesDir(), path);
    }

    /**
     * 读备份包用的路径解析：**先 CACHE 再 files**。
     *   create() 把 zip 写到 CACHE（导出产物，临时）；stage() 把用户选的文件落到 files（导入暂存）。
     *   两种来源都要能用相对名访问，所以这里两边都找。
     */
    private File resolveArchive(String path) {
        if (path == null) return null;
        File f = new File(path);
        if (f.isAbsolute()) return f;
        File inCache = new File(cacheDir(), path);
        if (inCache.exists()) return inCache;
        File inFiles = new File(filesDir(), path);
        if (inFiles.exists()) return inFiles;
        return inCache;   // 都不存在时返回 cache 路径，报错信息里能看出
    }

    private static void copyStream(InputStream in, OutputStream out, byte[] buf) throws IOException {
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static long crcOf(File f) throws IOException {
        CRC32 crc = new CRC32();
        byte[] buf = new byte[64 * 1024];
        FileInputStream in = new FileInputStream(f);
        try {
            int n;
            while ((n = in.read(buf)) > 0) crc.update(buf, 0, n);
        } finally {
            in.close();
        }
        return crc.getValue();
    }

    private static void addStoredEntry(ZipOutputStream zos, String entryName, File file) throws IOException {
        // STORE 必须在写 local header 之前拿到 size 与 crc，所以先算一遍（常量内存）
        long size = file.length();
        long crc = crcOf(file);
        ZipEntry e = new ZipEntry(entryName);
        e.setMethod(ZipEntry.STORED);
        e.setSize(size);
        e.setCompressedSize(size);
        e.setCrc(crc);
        zos.putNextEntry(e);
        FileInputStream in = new FileInputStream(file);
        try {
            copyStream(in, zos, new byte[64 * 1024]);
        } finally {
            in.close();
        }
        zos.closeEntry();
    }

    private static void addStoredBytes(ZipOutputStream zos, String entryName, byte[] data) throws IOException {
        CRC32 crc = new CRC32();
        crc.update(data, 0, data.length);
        ZipEntry e = new ZipEntry(entryName);
        e.setMethod(ZipEntry.STORED);
        e.setSize(data.length);
        e.setCompressedSize(data.length);
        e.setCrc(crc.getValue());
        zos.putNextEntry(e);
        zos.write(data);
        zos.closeEntry();
    }

    // ── 1) 打包 ────────────────────────────────────────────────────────────

    /**
     * create({ outPath, dataJsonPath, imagesDir?, refsDir?, manifest? })
     *   outPath      输出 zip（相对 CACHE）
     *   dataJsonPath 已由 JS 写好的 data.json（相对 CACHE）
     *   imagesDir    图库目录（相对 files，默认 chatlite_images）
     *   refsDir      参考图目录（相对 CACHE，可空）
     *   manifest     额外字段（JS 侧拼进来：exportedAt / counts / appVersion）
     * → { size, entries, images, thumbs, ms }
     */
    @PluginMethod
    public void create(PluginCall call) {
        String outPath = call.getString("outPath", "chat-lite-backup.zip");
        String dataJsonPath = call.getString("dataJsonPath", "data.json");
        String imagesDir = call.getString("imagesDir", IMAGES_DIR);
        String refsDir = call.getString("refsDir", null);
        long t0 = System.currentTimeMillis();

        File dataJson = new File(cacheDir(), dataJsonPath);
        if (!dataJson.exists()) {
            call.reject("data.json 不存在：" + dataJsonPath);
            return;
        }
        File imgDir = resolve(imagesDir);
        List<File> images = new ArrayList<>();
        List<File> thumbs = new ArrayList<>();
        if (imgDir != null && imgDir.isDirectory()) {
            File[] all = imgDir.listFiles();
            if (all != null) {
                for (File f : all) {
                    if (!f.isFile()) continue;
                    if (f.getName().endsWith("_thumb.jpg")) thumbs.add(f);
                    else images.add(f);
                }
            }
        }
        List<File> refs = new ArrayList<>();
        File refDirFile = refsDir == null ? null : new File(cacheDir(), refsDir);
        if (refDirFile != null && refDirFile.isDirectory()) {
            File[] all = refDirFile.listFiles();
            if (all != null) for (File f : all) if (f.isFile()) refs.add(f);
        }

        File out = new File(cacheDir(), outPath);
        // 先删旧的，避免 append 出双份
        if (out.exists() && !out.delete()) {
            call.reject("无法覆盖旧备份文件：" + outPath);
            return;
        }
        int entries = 0;
        try {
            try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(out), 64 * 1024))) {
                // manifest：条目清单在写之前就要知道，所以先扫一遍（只是列目录，不读内容）
                JSONObject mf = new JSONObject();
                mf.put("formatVersion", 2);
                mf.put("createdAt", new java.util.Date().toInstant().toString());
                mf.put("images", images.size());
                mf.put("thumbs", thumbs.size());
                mf.put("refs", refs.size());
                if (call.getObject("manifest") != null) {
                    JSONObject extra = call.getObject("manifest");
                    for (java.util.Iterator<String> it = extra.keys(); it.hasNext(); ) {
                        String k = it.next();
                        mf.put(k, extra.get(k));
                    }
                }
                addStoredBytes(zos, "manifest.json", mf.toString().getBytes(StandardCharsets.UTF_8));
                entries++;
                addStoredEntry(zos, "data.json", dataJson);
                entries++;
                for (File f : images) { addStoredEntry(zos, "images/" + f.getName(), f); entries++; }
                for (File f : thumbs) { addStoredEntry(zos, "thumbs/" + f.getName(), f); entries++; }
                for (File f : refs) { addStoredEntry(zos, "refs/" + f.getName(), f); entries++; }
            }
        } catch (Exception e) {
            out.delete();
            call.reject("打包失败：" + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("size", out.length());
        ret.put("entries", entries);
        ret.put("images", images.size());
        ret.put("thumbs", thumbs.size());
        ret.put("ms", System.currentTimeMillis() - t0);
        ret.put("path", outPath);
        call.resolve(ret);
    }

    // ── 2) 看一眼（导入前预览"这份备份里有什么"）─────────────────────────

    /** info({ path? , uri? }) → { entries, bytes, manifest, images, thumbs } */
    @PluginMethod
    public void info(PluginCall call) {
        String path = call.getString("path", null);
        String uri = call.getString("uri", null);
        try {
            ZipFile zip = openZip(path, uri);
            if (zip == null) { call.reject("打不开备份文件"); return; }
            int entries = 0, images = 0, thumbs = 0, refs = 0;
            long bytes = 0;
            Enumeration<? extends ZipEntry> en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                entries++;
                bytes += e.getSize();
                String n = e.getName();
                if (n.startsWith("images/")) images++;
                else if (n.startsWith("thumbs/")) thumbs++;
                else if (n.startsWith("refs/")) refs++;
            }
            JSObject manifest = null;
            ZipEntry me = zip.getEntry("manifest.json");
            if (me != null) {
                try (InputStream in = zip.getInputStream(me)) {
                    String txt = readAll(in);
                    manifest = new JSObject(txt);
                } catch (Exception ignore) {}
            }
            zip.close();
            JSObject ret = new JSObject();
            ret.put("entries", entries);
            ret.put("bytes", bytes);
            ret.put("images", images);
            ret.put("thumbs", thumbs);
            ret.put("refs", refs);
            if (manifest != null) ret.put("manifest", manifest);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取备份信息失败：" + e.getMessage());
        }
    }

    private ZipFile openZip(String path, String uri) throws IOException {
        if (uri != null && !uri.isEmpty()) {
            // content:// → 先拷到 cache，再按普通文件打开（ZipFile 需要随机访问）
            File tmp = new File(filesDir(), "import-src.zip");
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
                 OutputStream out = new FileOutputStream(tmp)) {
                if (in == null) return null;
                copyStream(in, out, new byte[64 * 1024]);
            }
            return new ZipFile(tmp);
        }
        File f = path == null ? null : resolveArchive(path);
        if (f == null || !f.exists()) return null;
        return new ZipFile(f);
    }

    // ── 3) 读包里的文本（data.json，通常几百 KB ~ 几 MB）─────────────────

    /** readText({ path? , uri? , entry? }) → { text } */
    @PluginMethod
    public void readText(PluginCall call) {
        String entry = call.getString("entry", "data.json");
        try {
            ZipFile zip = openZip(call.getString("path", null), call.getString("uri", null));
            if (zip == null) { call.reject("打不开备份文件"); return; }
            ZipEntry e = zip.getEntry(entry);
            if (e == null) { zip.close(); call.reject("备份里没有 " + entry); return; }
            String txt;
            try (InputStream in = zip.getInputStream(e)) { txt = readAll(in); }
            zip.close();
            JSObject ret = new JSObject();
            ret.put("text", txt);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取 " + entry + " 失败：" + e.getMessage());
        }
    }

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        copyStream(in, bos, new byte[64 * 1024]);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    // ── 4) 解包图片到 staging（不碰正式目录）──────────────────────────────

    /**
     * extractImages({ path? , uri? , stagingDir }) → { images, thumbs, bytes, ms }
     *   只解 images/ 与 thumbs/，全部写进 stagingDir（相对 files，默认 chatlite_images.new）
     *   先清空 stagingDir，保证幂等
     */
    @PluginMethod
    public void extractImages(PluginCall call) {
        String stagingRel = call.getString("stagingDir", IMAGES_DIR + ".new");
        File staging = resolve(stagingRel);
        long t0 = System.currentTimeMillis();
        ZipFile zip;
        try {
            zip = openZip(call.getString("path", null), call.getString("uri", null));
        } catch (Exception e) {
            call.reject("打不开备份文件：" + e.getMessage());
            return;
        }
        if (zip == null) { call.reject("打不开备份文件"); return; }

        deleteRecursive(staging);
        if (!staging.mkdirs() && !staging.isDirectory()) {
            call.reject("无法创建临时目录：" + stagingRel);
            try { zip.close(); } catch (Exception ignore) {}
            return;
        }
        int images = 0, thumbs = 0;
        long bytes = 0;
        try {
            Enumeration<? extends ZipEntry> en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                String n = e.getName();
                boolean isImg = n.startsWith("images/");
                boolean isThumb = n.startsWith("thumbs/");
                if (!isImg && !isThumb) continue;
                String base = n.substring(n.indexOf('/') + 1);
                if (base.isEmpty() || base.contains("/") || base.contains("..")) continue;   // 防目录穿越
                File out = new File(staging, base);
                try (InputStream in = zip.getInputStream(e);
                     OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 64 * 1024)) {
                    copyStream(in, os, new byte[64 * 1024]);
                }
                bytes += out.length();
                if (isImg) images++; else thumbs++;
            }
            zip.close();
        } catch (Exception e) {
            try { zip.close(); } catch (Exception ignore) {}
            deleteRecursive(staging);
            call.reject("解包失败（已回滚临时目录）：" + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("images", images);
        ret.put("thumbs", thumbs);
        ret.put("bytes", bytes);
        ret.put("ms", System.currentTimeMillis() - t0);
        ret.put("stagingDir", stagingRel);
        call.resolve(ret);
    }

    // ── 5) 提交 staging（原子替换）─────────────────────────────────────────

    /**
     * commitStaging({ stagingDir?, targetDir?, keepOld? }) → { ok, replaced, kept }
     *   目标目录先改名为 <target>.old，再把 staging 改名成 target，最后删 .old
     *   任一步失败 → 回滚成原名，原数据不动
     */
    @PluginMethod
    public void commitStaging(PluginCall call) {
        String stagingRel = call.getString("stagingDir", IMAGES_DIR + ".new");
        String targetRel = call.getString("targetDir", IMAGES_DIR);
        boolean keepOld = call.getBoolean("keepOld", false) != null && call.getBoolean("keepOld", false);
        File staging = resolve(stagingRel);
        File target = resolve(targetRel);
        File old = new File(target.getParentFile(), target.getName() + ".old");
        if (!staging.isDirectory()) { call.reject("临时目录不存在：" + stagingRel); return; }
        try {
            deleteRecursive(old);
            boolean hadTarget = target.exists();
            if (hadTarget && !target.renameTo(old)) {
                call.reject("无法移走原图目录（可能有文件被占用）");
                return;
            }
            if (!staging.renameTo(target)) {
                if (hadTarget) old.renameTo(target);   // 回滚
                call.reject("无法把新目录就位，已回滚");
                return;
            }
            if (!keepOld) deleteRecursive(old);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("replaced", hadTarget);
            ret.put("kept", keepOld);
            call.resolve(ret);
        } catch (Exception e) {
            if (!target.exists() && old.exists()) old.renameTo(target);
            call.reject("提交失败（已回滚）：" + e.getMessage());
        }
    }

    // ── 4b) 系统文件选择器（WebView 的 <input type=file> 只能给 JS 一个 File 对象，
    //        几百 MB 的 zip 没法经过 JS 内存；所以选择这一步也放到原生）────────

    /** pickArchive() → { uri, name, size }（用户用系统选择器挑一个 zip） */
    @PluginMethod
    public void pickArchive(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/zip", "application/x-zip-compressed", "application/octet-stream"});
        try {
            startActivityForResult(call, intent, "archivePicked");
        } catch (Exception e) {
            call.reject("无法打开文件选择器：" + e.getMessage());
        }
    }

    @ActivityCallback
    private void archivePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK) {
            call.reject("未选择文件");
            return;
        }
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            call.reject("没有拿到文件");
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignore) { /* 部分提供方不支持持久化权限 */ }
        long size = 0;
        try {
            android.database.Cursor c = getContext().getContentResolver()
                    .query(uri, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (idx >= 0 && c.moveToFirst()) size = c.getLong(idx);
                c.close();
            }
        } catch (Exception ignore) {}
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", "import-staging.zip");
        ret.put("size", size);
        call.resolve(ret);
    }

    /**
     * stage({ uri, outPath? }) → { path, size, ms }
     *   把 content:// 的文件复制到 app files 目录（一次复制，之后所有操作都走本地路径，
     *   避免每次 info/readText/extract 都重拷一遍几百 MB）。
     */
    @PluginMethod
    public void stage(PluginCall call) {
        String uriStr = call.getString("uri", null);
        String outPath = call.getString("outPath", "import-staging.zip");
        if (uriStr == null) { call.reject("缺少 uri"); return; }
        long t0 = System.currentTimeMillis();
        File out = new File(filesDir(), outPath);
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr));
             OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 64 * 1024)) {
            if (in == null) { call.reject("无法读取所选文件"); return; }
            copyStream(in, os, new byte[64 * 1024]);
        } catch (Exception e) {
            out.delete();
            call.reject("复制到本地失败：" + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("path", outPath);
        ret.put("size", out.length());
        ret.put("ms", System.currentTimeMillis() - t0);
        call.resolve(ret);
    }

    /**
     * readChunk({ path, entry, offset, length }) → { data(base64), eof }
     *   按字节区间读包内条目 —— data.json 可能上百 MB，JS 侧要分块读回来做流式解析，
     *   而 Capacitor Filesystem.readFile 没有 offset，只能由原生按区间给。
     */
    @PluginMethod
    public void readChunk(PluginCall call) {
        String path = call.getString("path", null);
        String entry = call.getString("entry", "data.json");
        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 2 * 1024 * 1024);
        if (path == null) { call.reject("缺少 path"); return; }
        if (length <= 0 || length > 8 * 1024 * 1024) length = 2 * 1024 * 1024;
        try {
            File f = resolveArchive(path);
            ZipFile zip = new ZipFile(f);
            ZipEntry e = zip.getEntry(entry);
            if (e == null) { zip.close(); call.reject("备份里没有 " + entry); return; }
            byte[] buf = new byte[length];
            int got = 0;
            try (InputStream in = zip.getInputStream(e)) {
                long skipped = 0;
                while (skipped < offset) {
                    long s = in.skip(offset - skipped);
                    if (s <= 0) { if (in.read() < 0) break; skipped++; }
                    else skipped += s;
                }
                while (got < length) {
                    int n = in.read(buf, got, length - got);
                    if (n < 0) break;
                    got += n;
                }
            }
            zip.close();
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buf, 0, got, Base64.NO_WRAP));
            ret.put("read", got);
            ret.put("eof", got < length);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("读取分块失败：" + ex.getMessage());
        }
    }

    /** cleanDir({ dir }) → { ok }（导入失败时清掉 staging 目录） */
    @PluginMethod
    public void cleanDir(PluginCall call) {
        String dir = call.getString("dir", IMAGES_DIR + ".new");
        File f = resolve(dir);
        try {
            deleteRecursive(f);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("清理失败：" + e.getMessage());
        }
    }

    /** entrySize({ path, entry }) → { size }（给 JS 端做进度百分比用） */
    @PluginMethod
    public void entrySize(PluginCall call) {
        String path = call.getString("path", null);
        String entry = call.getString("entry", "data.json");
        if (path == null) { call.reject("缺少 path"); return; }
        try {
            File f = resolveArchive(path);
            ZipFile zip = new ZipFile(f);
            ZipEntry e = zip.getEntry(entry);
            long size = (e == null) ? -1 : e.getSize();
            zip.close();
            JSObject ret = new JSObject();
            ret.put("size", size);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("读取条目大小失败：" + ex.getMessage());
        }
    }

    // ── 工具 ───────────────────────────────────────────────────────────────

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}

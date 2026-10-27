// ===== io.js : 导入导出 + 角色卡 + 格式转换模块（v2.0 拆分）=====
// 模块名：io.js
// 版本：v84（cache-bust）
// 迁移日期：2026-07-27
// 来源：从 app.js 拆分
// 职责：数据导入导出、会话导入导出、角色卡 PNG 导入导出、DZMM/豆包格式转换
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / currentConv / isCapacitor / CapFilesystem / Capacitor / CapShare /
//       parseJsonField / migrateImportedImagesToFilesystem / normalizeProvider /
//       getProvider / normalizeImageProvider / renderSidebar / renderMessages / renderProviderList
// 加载顺序：在 chat.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   导入导出：backupAllData, restoreFromBackup, exportConversation,
//             importConversation, ensureDataLoaded, tryParseJSON
//   角色卡：parseCharacterCard, generateCharacterCard, buildCardPrompt, crc32
//   格式转换：convertDZMM, convertDoubao
//
// 保留在 app.js：
//   loadData / loadFromServer（数据加载，与 init 相关）

// ===== 导入导出 =====
async function ensureDataLoaded() {
  if (state._dataLoaded) return;
  // loadData() 在 init() 里被 await，这里轮询等待
  let tries = 0;
  while (!state._dataLoaded && tries < 50) {
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }
}
// ===== 数据管理 v2：全量备份（单文件 .zip，含图库原图 / 缩略图）=====
// 动机与完整审计见 DSH 工作区《数据管理-v2-审计与设计.md》；看板 §2.4-E / §2.5。
// v1 的「导出全部数据」只导出 JSON 元数据，**图库文件从来不跟着走** —— 换设备/换包后
// 图库只剩 96px 缩略图（2026-10-27 用户实际踩到）。v2 把它装进一个 zip 单文件。
// zip 的读写在原生插件 BackupArchive 里做（Capacitor Filesystem 无法随机访问 zip）。

function _backupPlugin() {
  try {
    return (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.BackupArchive) || null;
  } catch (e) { return null; }
}

// 剥掉「可由原图重建」的大字段：dataUrl、thumbDataUrl。
//   注意 v1 的 bug：剥的是 thumbnailDataUrl —— 而真实字段叫 thumbDataUrl，
//   那个字段根本不存在，等于一次都没剥（所以备份里混着 96px 缩略图 base64）。
//   referenceImages **保留**：那是用户自己选的文件，属于内容，剥了就永久丢。
function buildExportSettingsV2() {
  const s = Object.assign({}, settings);
  if (Array.isArray(s.images)) {
    s.images = s.images.map(function (img) {
      if (!img || typeof img !== 'object') return img;
      const lite = Object.assign({}, img);
      lite.dataUrl = null;
      lite.thumbDataUrl = null;
      lite.thumbnailDataUrl = null;
      return lite;
    });
  }
  return s;
}

async function backupAllData() {
  await ensureDataLoaded();
  const plugin = _backupPlugin();
  if (!plugin || !isCapacitor() || !CapFilesystem) {
    showToast('备份功能需要 APK 版', 'warn');
    return;
  }
  showToast('正在准备备份...', 'info');
  await new Promise(function (r) { setTimeout(r, 50); });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const zipName = 'chat-lite-backup-' + stamp + '.zip';
  const jsonName = 'chat-lite-data-' + stamp + '.json';
  try {
    // 1) data.json —— 沿用分块流式导出（峰值 = 单批 200KB，不随数据量涨）
    await exportAllDataStreamed(jsonName, buildExportSettingsV2(), { version: 2, format: 'chat-lite-backup-zip' });
    // 2) 打包：data.json + 图库原图 + 缩略图（STORE 不压缩，333MB 约 2s）
    const imgCount = (settings.images || []).length;
    showToast('正在打包 ' + imgCount + ' 张图片...', 'info');
    const res = await plugin.create({
      outPath: zipName,
      dataJsonPath: jsonName,
      imagesDir: 'chatlite_images',
      manifest: {
        appVersion: '3.0.4',
        conversations: (state.conversations || []).length,
        providers: (state.providers || []).length,
        imageRecords: imgCount
      }
    });
    // 3) 落到「下载 / chat-lite」—— 用户在文件管理器里直接看得见、能传到电脑，
    //    之后恢复时用系统选择器也能直接选中它（不打断操作，也不用系统分享面板）
    const saved = await plugin.saveToDownloads({ srcPath: zipName, fileName: zipName, mime: 'application/zip' });
    const mb = (res.size / 1048576).toFixed(1);
    showToast('备份已保存到「' + saved.path + '」（' + mb + 'MB）', 'success');
  } catch (err) {
    console.error('Backup failed:', err);
    showToast('备份失败：' + ((err && err.message) || err), 'danger');
  } finally {
    // 中间产物清掉（备份包已经进了「下载/chat-lite」，CACHE 里这份是临时的）
    try { await CapFilesystem.deleteFile({ path: jsonName, directory: 'CACHE' }); } catch (e) {}
    try { await CapFilesystem.deleteFile({ path: zipName, directory: 'CACHE' }); } catch (e2) {}
  }
}

// ===== v2 导入：单文件 zip =====
// 流程：系统选择器挑文件 → 落地到 app 目录 → 先说清"里面有什么" → 导入前自动备份 →
//       图片解到 staging（正式目录一个字节都不动）→ 流式读 data.json 落库 →
//       图库目录原子替换 → 清理。任何一步失败：staging 删掉，正式数据原样。
async function restoreFromBackup(e) {
  const input = e && e.target;
  if (input && input.files) input.value = '';   // 允许重复选同一个文件
  const plugin = _backupPlugin();
  if (!plugin || !CapFilesystem) {
    showToast('恢复功能需要 APK 版，请更新 App', 'warn');
    return;
  }
  const modeEl = document.getElementById('import-mode-select');
  const mode = modeEl ? modeEl.value : 'overwrite';
  let stagedPath = null;
  try {
    showToast('请选择备份文件...', 'info');
    const picked = await plugin.pickArchive();
    if (!picked || !picked.uri) return;          // 用户取消
    showToast('正在读取备份文件...', 'info');
    const staged = await plugin.stage({ uri: picked.uri });
    stagedPath = staged.path;

    // 1) 认格式：新备份是 zip，旧备份是 json（v3.0.4 之前导出的那种）
    const probe = await plugin.probe({ path: stagedPath });
    if (probe.type === 'zip') {
      const info = await plugin.info({ path: stagedPath });
      const mb = ((info.bytes || 0) / 1048576).toFixed(1);
      const lines = ['这份备份包含：',
        '· ' + (info.entries || 0) + ' 个条目，共 ' + mb + ' MB'];
      if (info.images) {
        lines.push('· 图库原图 ' + info.images + ' 张' + (info.thumbs ? '，缩略图 ' + info.thumbs + ' 张' : ''));
      } else {
        lines.push('· 不含图片（这是一份纯文本备份，图库不会带过来）');
      }
      if (info.manifest && info.manifest.conversations != null) {
        lines.push('· 会话 ' + info.manifest.conversations + ' 条');
      }
      lines.push('');
      lines.push('恢复方式：' + (mode === 'merge' ? '合并（按 ID 去重）' : '覆盖（替换当前全部数据）'));
      if (!confirm(lines.join('\n') + '\n\n确定恢复吗？')) {
        await _cleanupImportStaging(stagedPath);
        return;
      }
      // 2) 导入前自动备份 —— v1 的 APK 流式路径**根本没有这一步**（审计 P0-3）
      await _autoBackupBeforeImport(plugin);
      // 3) 图片解到 staging（正式目录不动）
      showToast('正在解包图片...', 'info');
      const ex = await plugin.extractImages({ path: stagedPath, stagingDir: 'chatlite_images.new' });
      // 4) 流式读 data.json 并落库
      showToast('正在写入数据...', 'info');
      await importAllDataStreamed(makeZipChunkReader(plugin, stagedPath, 'data.json'), mode);
      // 5) 图库目录原子替换
      await plugin.commitStaging({ stagingDir: 'chatlite_images.new', targetDir: 'chatlite_images' });
      await _cleanupImportStaging(stagedPath);
      showToast('恢复完成（' + (ex.images || 0) + ' 张原图）', 'success');
      if (typeof renderImageStream === 'function') renderImageStream();
      if (typeof scheduleLegacyThumbUpgrade === 'function') scheduleLegacyThumbUpgrade();
    } else if (probe.type === 'json') {
      // 旧格式备份：只有元数据，没有图片文件 —— 明确告知，别让人以为图丢了是 bug
      if (!confirm('这是旧格式的备份（不含图片文件）。\n\n恢复后：会话、接口、设置会照旧，' +
                   '但图库只会剩缩略图。\n\n确定继续吗？')) {
        await _cleanupImportStaging(stagedPath);
        return;
      }
      await _autoBackupBeforeImport(plugin);
      showToast('正在写入数据...', 'info');
      await importAllDataStreamed(makePlainFileChunkReader(plugin, stagedPath), mode);
      await _cleanupImportStaging(stagedPath);
      showToast('旧格式备份已恢复（不含图片）', 'success');
      if (typeof renderImageStream === 'function') renderImageStream();
    } else {
      throw new Error('认不出这个文件的格式（既不是 .zip 备份，也不是 .json 备份）');
    }
  } catch (err) {
    console.error('Restore failed:', err);
    try { if (plugin) await plugin.cleanDir({ dir: 'chatlite_images.new' }); } catch (e2) {}
    showToast('恢复失败：' + ((err && err.message) || err), 'danger');
  }
}

// 导入前的自动兜底备份：把**当前**数据打成一个 zip 放到 files 目录（不经过系统分享）
async function _autoBackupBeforeImport(plugin) {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const jsonName = 'pre-import-' + stamp + '.json';
    const zipName = 'pre-import-' + stamp + '.zip';
    await exportAllDataStreamed(jsonName, buildExportSettingsV2(), { version: 2, format: 'chat-lite-pre-import' });
    await plugin.create({
      outPath: zipName, dataJsonPath: jsonName, imagesDir: 'chatlite_images',
      manifest: { note: '导入前自动备份', at: new Date().toISOString() }
    });
    // CACHE 会被系统回收 → 复制到 files 目录留存
    try {
      await CapFilesystem.copy({ from: zipName, to: zipName, directory: 'CACHE', toDirectory: 'DATA' });
    } catch (e2) { /* 复制失败就留在 CACHE 里 */ }
    try { await CapFilesystem.deleteFile({ path: jsonName, directory: 'CACHE' }); } catch (e3) {}
    showToast('已自动备份当前数据（' + zipName + '）', 'info');
  } catch (e) {
    console.warn('pre-import backup failed:', e);
    showToast('注意：导入前自动备份失败，原数据将无法恢复', 'warn');
  }
}

async function _cleanupImportStaging(path) {
  try {
    if (path) await CapFilesystem.deleteFile({ path: path, directory: 'DATA' });
  } catch (e) {}
}

// 分块流式导出（APK 专用，根治大备份 OOM）：
// 头部一次 writeFile，conversations 逐批 appendFile（每 30 条 或累计 200KB 刷盘一次），尾部一次 appendFile。
// 峰值内存 = 单批字符串 + 进度计数，与数据总量无关。
async function exportAllDataStreamed(fileName, exportSettings, opts) {
  // v3.0.4: opts 可指定 version / format（v2 备份包里的 data.json 用它标记自己）
  opts = opts || {};
  const DIR = 'CACHE';
  const convs = state.conversations || [];
  const total = convs.length;
  const head = '{"version":' + (opts.version || 1) + ',"format":' +
    JSON.stringify(opts.format || 'chat-lite-json') + ',"exportedAt":"' + new Date().toISOString() +
    '","convGroups":' + JSON.stringify(state.convGroups || []) + ',"conversations":[';
  await CapFilesystem.writeFile({ path: fileName, data: head, directory: DIR, encoding: 'utf8', recursive: true });
  let first = true;          // 是否文件内第一条 conversation（控制逗号）
  let buf = [];
  let bufChars = 0;
  const FLUSH_COUNT = 30;    // 每批条数
  const FLUSH_CHARS = 200000; // 每批字符上限（保守，防单条超大会话撑爆）

  async function flush() {
    if (!buf.length) return;
    const chunk = (first ? '' : ',') + buf.join(',');
    first = false;
    buf = [];
    bufChars = 0;
    await CapFilesystem.appendFile({ path: fileName, data: chunk, directory: DIR, encoding: 'utf8' });
  }

  for (let i = 0; i < total; i++) {
    const piece = JSON.stringify(convs[i]);
    buf.push(piece);
    bufChars += piece.length;
    if (buf.length >= FLUSH_COUNT || bufChars >= FLUSH_CHARS) {
      await flush();
      await new Promise(r => setTimeout(r, 0));   // yield：让 UI 线程喘息，避免"卡死"观感
      if (i % Math.max(1, Math.floor(total / 10)) === 0) {
        showToast('导出中 ' + Math.min(100, Math.round(i / total * 100)) + '%…', 'info');
      }
    }
  }
  await flush();
  const tail = '],"providers":' + JSON.stringify(state.providers || []) +
    ',"settings":' + JSON.stringify(exportSettings) +
    ',"currentId":' + JSON.stringify(state.currentId) + '}';
  await CapFilesystem.appendFile({ path: fileName, data: tail, directory: DIR, encoding: 'utf8' });
}
// ===== 流式分块导入（APK 覆盖模式专用，根治 108MB 级大备份 OOM） =====
const CHUNK_TOTAL_MARK = 2 * 1024 * 1024 * 10;   // 每 20MB 报一次进度
// 原理：File.slice 分块 readAsText（2MB/块）+ 增量扫描 conversations 数组逐条 JSON.parse，
//      峰值内存 = 单块缓冲 + 单条会话对象，与总量无关；头部/尾部小字段最后整体 parse。
// 数据安全：overwrite 语义下先清空再逐条填充；解析失败 toast 报错（main 数据源仍在，可重新导出）。

// 增量扫描器：从分块文本中定位 "conversations" 数组的起止，逐条提取顶层对象
// 设计：feed 为无状态纯函数——扫描状态全部本地化；buf 只保留"未完成单元开头"
//       （进行中的对象 '{' 或 未闭合字符串的 '"'），每块从开头无状态重扫（幂等），
//       彻底规避跨块状态残留（字符串引号配对错乱）问题。
// feed(chunk) → { objs: 完整对象字符串[], found: {posInChunk}|null, done: bool, tailText: string|null }
function createConvScanner() {
  var buf = '';
  var phase = 0;      // 0=头部搜索 1=数组中 2=数组已结束（跨块阶段标记，非扫描状态）
  var arrEnd = -1;
  return {
    feed: function(chunk) {
      buf += chunk;
      var out = [];
      var found = null;
      var tailText = null;
      if (phase === 0) {
        var ki = buf.indexOf('"conversations"');
        if (ki >= 0) {
          var ai = buf.indexOf('[', ki);
          if (ai >= 0) {
            found = { posInChunk: ai - (buf.length - chunk.length) };
            phase = 1;
            buf = buf.slice(ai + 1);
            // 不 return：继续扫描本块剩余（小文件/大块场景整个文件可能在一个块内，剩余必须当场处理）
          }
        }
        if (phase === 0) {
          if (buf.length > 4 * 1024 * 1024) buf = buf.slice(buf.length - 4 * 1024 * 1024);
          return { objs: out, found: null, done: false, tailText: null };
        }
      }
      if (phase === 2) {
        tailText = buf; buf = '';
        return { objs: out, found: null, done: true, tailText: tailText };
      }
      // phase 1：无状态重扫（幂等）——状态全本地，由 buf 内容决定
      var i = 0, depth = 0, objStart = -1, inStr = false, esc = false, strStart = -1;
      while (i < buf.length) {
        var c = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          i++; continue;
        }
        if (c === '"') { inStr = true; strStart = i; i++; continue; }
        if (objStart < 0) {
          if (c === '{') { objStart = i; depth = 1; }
          else if (c === ']') { phase = 2; arrEnd = i; break; }
          i++; continue;
        }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) { out.push(buf.slice(objStart, i + 1)); objStart = -1; }
        }
        i++;
      }
      if (phase === 2) {
        tailText = buf.slice(arrEnd + 1); buf = '';
        return { objs: out, found: found, done: true, tailText: tailText };
      }
      // 保留"未完成单元开头"：进行中对象 '{' 优先；否则未闭合字符串 '"'；否则全部消费
      var keepFrom = objStart >= 0 ? objStart : (inStr ? strStart : buf.length);
      buf = buf.slice(keepFrom);
      return { objs: out, found: found, done: false, tailText: null };
    }
  };
}

// 分块读取器：v1 从 File 对象切片，v2 从 zip 条目按字节区间读（原生插件）。
//   统一接口：{ total: number|null, next(): Promise<{text, bytes, done}> }
function makeFileChunkReader(file) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0;
  return {
    total: file.size,
    next: function () {
      return new Promise(function (resolve, reject) {
        if (offset >= file.size) { resolve({ text: '', bytes: 0, done: true }); return; }
        const end = Math.min(offset + CHUNK, file.size);
        const blob = file.slice(offset, end);
        const r = new FileReader();
        r.onload = function () {
          const bytes = end - offset;
          offset = end;
          resolve({ text: r.result || '', bytes: bytes, done: offset >= file.size });
        };
        r.onerror = function () { reject(r.error || new Error('read failed')); };
        r.readAsText(blob);
      });
    }
  };
}

function makeZipChunkReader(plugin, path, entry) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0;
  return {
    total: null,
    next: async function () {
      const r = await plugin.readChunk({ path: path, entry: entry, offset: offset, length: CHUNK });
      const bytes = r.read || 0;
      offset += bytes;
      let text = '';
      if (bytes > 0) {
        const bin = atob(r.data || '');
        const arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        text = new TextDecoder('utf-8').decode(arr);
      }
      return { text: text, bytes: bytes, done: !!r.eof || bytes === 0 };
    }
  };
}

// 旧 .json 备份的读取器：按字节区间读普通文件（整读上百 MB 会把 WebView 撑爆）
function makePlainFileChunkReader(plugin, path) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0;
  return {
    total: null,
    next: async function () {
      const r = await plugin.readFileChunk({ path: path, offset: offset, length: CHUNK });
      const bytes = r.read || 0;
      offset += bytes;
      let text = '';
      if (bytes > 0) {
        const bin = atob(r.data || '');
        const arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        text = new TextDecoder('utf-8').decode(arr);
      }
      return { text: text, bytes: bytes, done: !!r.eof || bytes === 0 };
    }
  };
}

async function importAllDataStreamed(reader, mode) {
  const scanner = createConvScanner();
  const newConvs = [];
  let headText = '';
  let tailText = '';
  let inConvs = false;      // 已进入 conversations 数组（headText 停止累积）
  let done = false;
  let offset = 0;
  const total = reader.total || 0;

  while (true) {
    const chunk = await reader.next();
    const text = chunk.text;
    if (text) {
      const res = scanner.feed(text);
      if (!inConvs) {
        if (res.found) { headText += text.slice(0, res.found.posInChunk); inConvs = true; }
        else headText += text;   // phase 0 整块累积
      }
      for (let k = 0; k < res.objs.length; k++) {
        newConvs.push(JSON.parse(res.objs[k]));   // 逐条 parse（单条小）
      }
      if (res.done) { done = true; if (res.tailText !== null) tailText += res.tailText; }   // 累积（phase 2 每块都是 tail 片段，覆盖会丢前段）
      else if (done && res.tailText !== null) { tailText += res.tailText; }
      offset += chunk.bytes || text.length;
    }
    if (chunk.done) break;
    if (total && offset % (CHUNK_TOTAL_MARK) === 0) {
      showToast('导入中 ' + Math.min(100, Math.round(offset / total * 100)) + '%…', 'info');
    }
    await new Promise(r => setTimeout(r, 0));   // yield
  }
  if (!done) throw new Error('备份格式异常：未找到 conversations 数组结束');

  // 头部字段：headText 形如 {"version":1,"convGroups":[...],"conversations":  → 去掉尾部键 + 补根对象闭合
  let headObj = {};
  try {
    const ht = headText.replace(/,\s*"conversations"\s*:\s*$/, '').trim();
    headObj = JSON.parse(ht + '}');
  } catch (e) { headObj = {}; }

  // 尾部字段：tailText 形如 ,"providers":[...],...,"currentId":"x"}  → 去前导 ]/, 后包成对象
  let tailObj = {};
  const tailRaw = tailText.replace(/^[\s,\]]+/, '').trim();
  if (tailRaw) { try { tailObj = JSON.parse('{' + tailRaw.slice(0, -1) + '}'); } catch (e) { tailObj = {}; } }

  // v126 修：更早版本的备份里，conversation 用 messages 数组而不是 messageMap。
  //   loadData() 有这一步迁移（data.version < 2 时逐条 migrateV1toV2），但导入路径一直没有 ——
  //   结果这类会话导进来后 messageMap 为空，getActiveChain 直接抛
  //   "Cannot read properties of undefined (reading 'map')"，界面上就是一片空白。
  //   这里补齐：只对"有 messages 但没有 messageMap"的会话动手，幂等。
  for (let ci = 0; ci < newConvs.length; ci++) {
    const cv = newConvs[ci];
    if (cv && Array.isArray(cv.messages) && !cv.messageMap && typeof migrateV1toV2 === 'function') {
      try { migrateV1toV2(cv); } catch (e) { console.warn('migrateV1toV2 failed:', cv.id, e); }
    }
  }

  // 落库（覆盖 / 合并两种语义）
  applyImportedData(headObj, tailObj, newConvs, mode || 'overwrite');
  return true;
}

// 落库：覆盖 = 以出厂默认打底再叠加备份值（避免本地残留项）；合并 = 按 ID 去重，导入方优先
function applyImportedData(headObj, tailObj, newConvs, mode) {
  if (mode === 'merge') {
    const importedIds = new Set(newConvs.map(function (c) { return c.id; }));
    const kept = state.conversations.filter(function (c) { return !importedIds.has(c.id); });
    state.conversations = kept.concat(newConvs);
    if (Array.isArray(tailObj.providers)) {
      const pids = new Set(tailObj.providers.map(function (p) { return p.id; }));
      state.providers = (state.providers || []).filter(function (p) { return !pids.has(p.id); }).concat(tailObj.providers);
      saveProviders();
    }
    if (tailObj.settings && typeof tailObj.settings === 'object') {
      settings = migrateSettings(Object.assign(settings, tailObj.settings));
    }
    if (!state.conversations.find(function (c) { return c.id === state.currentId; })) {
      state.currentId = state.conversations.length > 0 ? state.conversations[0].id : null;
    }
  } else {
    state.conversations = newConvs;
    if (Array.isArray(tailObj.providers)) { state.providers = tailObj.providers; saveProviders(); }
    if (tailObj.settings && typeof tailObj.settings === 'object') {
      settings = Object.assign(defaultSettings(), tailObj.settings);
    } else {
      settings = defaultSettings();
    }
    if (headObj.convGroups && Array.isArray(headObj.convGroups)) state.convGroups = headObj.convGroups;
    state.currentId = tailObj.currentId || (state.conversations.length > 0 ? state.conversations[0].id : null);
    settings = migrateSettings(settings);
  }
  saveSettings();
  save();
  renderSidebar();
  renderModelSelector();
  if (state.currentId) renderMessages();
  if (isCapacitor() && CapFilesystem && Array.isArray(settings.images)) {
    migrateImportedImagesToFilesystem();
  }
}

async function exportConversation() {
  const conv = currentConv();
  if (!conv) return;
  const data = { version: 2, exportedAt: new Date().toISOString(), conversation: conv };
  // 紧凑格式，与会话图片/长文累积场景兼容
  const jsonText = JSON.stringify(data);
  const fileName = `chat-lite-${conv.title || 'conversation'}-${new Date().toISOString().slice(0, 10)}.json`;

  if (isCapacitor() && CapFilesystem && CapShare) {
    // APK 模式：<a download> 在 WebView 里不生效，改用 Filesystem + Share
    // 修复（v1.3.0 批次1+）：encoding:'utf8' 直写，避免 base64 转换的内存峰值
    try {
      const result = await CapFilesystem.writeFile({
        path: fileName,
        data: jsonText,
        directory: 'CACHE',
        encoding: 'utf8',
        recursive: true
      });
      await CapShare.share({
        title: 'chat-lite 会话导出',
        text: fileName,
        url: result.uri,
        dialogTitle: '保存会话文件到...'
      });
      showToast('已导出，请选择保存位置', 'success');
    } catch (err) {
      console.error('Export conversation failed:', err);
      showToast('导出失败：' + (err.message || err), 'danger');
    }
  } else {
    // Web 模式
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function tryParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    let fixed = raw.trim();
    if (!fixed.startsWith('[')) fixed = '[' + fixed;
    if (!fixed.endsWith(']')) {
      fixed = fixed.replace(/,\s*$/, '');
      fixed = fixed + ']';
    }
    return JSON.parse(fixed);
  }
}

function importConversation(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = tryParseJSON(ev.target.result);
      let conv;
      
      // Format 1: chat-lite export
      if (data.version && data.conversation) {
        conv = data.conversation;
        if (!conv.id || !conv.messageMap) throw new Error('chat-lite format corrupted');
      }
      // Format 2: DZMM export
      else if (data.chatId && data.chat && data.messages) {
        conv = convertDZMM(data);
      }
      // Format 3: plain chat-lite conversation (no wrapper)
      else if (data.id && data.messageMap) {
        conv = data;
      }
      // Format 4: 豆包/类角色平台导出的会话数组（每个元素含 conversation_id + messages）
      else if (Array.isArray(data) && data.length > 0 && data[0].conversation_id && Array.isArray(data[0].messages)) {
        conv = convertDoubao(data[0]);
      }
      // Format 5: old v1 linear array
      else if (data.messages && Array.isArray(data.messages)) {
        conv = { messages: data.messages };
        migrateV1toV2(conv);
      }
      else {
        alert('不支持的格式，请导入 chat-lite 导出的 JSON 或 DZMM 导出的 JSON');
        return;
      }
      
      conv.id = uid();
      state.conversations.push(conv);
      state.currentId = conv.id;
      save();
      renderSidebar();
      renderMessages();
      // Match provider for imported conversation
      if (!conv.providerId && conv.model) {
        var matched = state.providers.find(function(p) { return p.models && p.models.some(function(m) { return m.id === conv.model; }); });
        if (matched) conv.providerId = matched.id;
        else if (state.providers.length > 0) { conv.providerId = state.providers[0].id; }
      }
      syncModelSelector();
    } catch (err) {
      alert('文件解析失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ===== 格式转换 =====
function convertDZMM(data) {
  const chat = data.chat || {};
  const chunks = chat.chunks || [];
  const messages = data.messages || [];
  
  // Build message lookup by chunk_id
  const chunkMsgs = {};
  for (const entry of messages) {
    chunkMsgs[entry.chunk_id] = entry.messages || [];
  }
  
  // Build chunk map  
  const chunkMap = {};
  for (const c of chunks) {
    chunkMap[c.id] = c;
  }
  
  // Find root chunks
  const roots = chunks.filter(c => !c.parent);
  const rootId = uid();
  const rootMsg = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  const messageMap = { [rootId]: rootMsg };
  
  // Helper to create a message node
  function createMsgNode(role, content, parentId) {
    const text = String(content || '');
    const node = {
      id: uid(), role, content: text,
      parentId, children: [],
      title: (role === 'user' ? (text.substring(0, 30) + (text.length > 30 ? '...' : '')) : '回复').replace(/\n/g, ' '),
      wordCount: countWords(text),
      versions: [{ content: text, timestamp: Date.now(), reason: 'import' }],
      activeVersion: 0, files: [], createdAt: Date.now()
    };
    messageMap[node.id] = node;
    messageMap[parentId].children.push(node.id);
    return node.id;
  }
  
  // Cache: chunkId → [nodeIds] so we can trace active path
  const chunkNodeIds = {};
  // Cache: chunkId → lastNodeId for child chunk attachment
  const chunkLastNode = {};
  
  // Walk the tree: create individual nodes per message, NOT merged
  function walk(chunkId, parentId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return parentId;
    
    // If already walked, just re-attach first node
    if (chunkLastNode[chunkId] !== undefined) {
      const lastId = chunkLastNode[chunkId];
      const nids = chunkNodeIds[chunkId] || [];
      if (nids.length > 0 && messageMap[nids[0]] && !messageMap[parentId].children.includes(nids[0])) {
        messageMap[nids[0]].parentId = parentId;
        messageMap[parentId].children.push(nids[0]);
      }
      return lastId;
    }
    
    const msgs = chunkMsgs[chunkId] || [];
    let lastId = parentId;
    
    // Create individual nodes for each message (NO merging)
    const nodeIds = [];
    for (const m of msgs) {
      const ct = (typeof m.content === 'string' ? m.content : String(m.content || ''));
      if (!ct) continue;
      lastId = createMsgNode(m.role || 'user', ct, lastId);
      nodeIds.push(lastId);
    }
    
    chunkNodeIds[chunkId] = nodeIds;
    chunkLastNode[chunkId] = lastId;
    
    // Walk children — they attach to lastId
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    for (const childId of children) {
      walk(childId, lastId);
    }
    
    return lastId;
  }
  
  // Walk all chunks from each root
  for (const r of roots) {
    walk(r.id, rootId);
  }
  
  // Build activePath: follow chunk.active chain, use chunkNodeIds cache directly
  const convActivePath = [rootId];
  function followActive(chunkId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return;
    
    // Push all nodes from this chunk
    const nodeIds = chunkNodeIds[chunkId] || [];
    for (const nid of nodeIds) {
      convActivePath.push(nid);
    }
    
    // Find active child chunk and recurse
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    const activeChild = children.find(c => chunkMap[c]?.active);
    if (activeChild) {
      followActive(activeChild);
    }
  }
  
  for (const r of roots) {
    if (chunkMap[r]?.active) {
      followActive(r.id);
      break;
    }
  }
  
  // If activePath failed, fallback to first-child chain
  if (convActivePath.length <= 1) {
    let cur = rootId;
    while (true) {
      const node = messageMap[cur];
      if (!node || !node.children || node.children.length === 0) break;
      cur = node.children[0];
      convActivePath.push(cur);
    }
  }


  return {
    id: uid(),
    title: chat.title || '导入的对话',
    model: 'deepseek-v4-flash',
    thinkingEnabled: true,
    systemPrompt: '',
    userIdentity: '',
    rootId,
    activePath: convActivePath,
    messageMap,
    createdAt: Date.now()
  };
}

function convertDoubao(convData) {
  const messages = convData.messages || [];
  const rootId = uid();
  const rootMsg = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  const messageMap = { [rootId]: rootMsg };
  const activePath = [rootId];
  let parentId = rootId;

  function createMsgNode(role, content) {
    const text = String(content || '');
    const node = {
      id: uid(), role, content: text,
      parentId,
      children: [],
      title: (role === 'user' ? (text.substring(0, 30) + (text.length > 30 ? '...' : '')) : '回复').replace(/\n/g, ' '),
      wordCount: countWords(text),
      versions: [{ content: text, timestamp: Date.now(), reason: 'import' }],
      activeVersion: 0, files: [], createdAt: Date.now()
    };
    messageMap[node.id] = node;
    messageMap[parentId].children.push(node.id);
    parentId = node.id;
    activePath.push(node.id);
    return node.id;
  }

  for (const m of messages) {
    if (m.content_type !== 'text') continue;
    const text = String(m.show_content || '');
    if (!text) continue;
    const role = m.user_type === 'user' ? 'user' : 'assistant';
    createMsgNode(role, text);
  }

  return {
    id: uid(),
    title: convData.conversation_name || convData.bot_name || '导入的对话',
    model: '',
    thinkingEnabled: true,
    systemPrompt: '',
    userIdentity: '',
    rootId,
    activePath,
    messageMap,
    createdAt: Date.now()
  };
}

// ===== 角色卡 =====
function parseCharacterCard(buffer) {
  const bytes = new Uint8Array(buffer);
  // PNG signature check
  const sig = [137,80,78,71,13,10,26,10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('Not a valid PNG file');
  
  let offset = 8;
  let charaJSON = null, ccv3JSON = null;
  
  while (offset < bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3];
    const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    const dataStart = offset + 8;
    
    if (type === 'tEXt') {
      const textBytes = bytes.slice(dataStart, dataStart + length);
      let nullIdx = -1;
      for (let i = 0; i < textBytes.length; i++) { if (textBytes[i] === 0) { nullIdx = i; break; } }
      if (nullIdx >= 0) {
        // Try UTF-8 first, fallback to Latin-1 (PNG spec default for tEXt)
        let keyword, value;
        try {
          const td8 = new TextDecoder('utf-8', {fatal:true});
          keyword = td8.decode(textBytes.slice(0, nullIdx));
          value = td8.decode(textBytes.slice(nullIdx + 1));
        } catch(e) {
          const td1 = new TextDecoder('latin1');
          keyword = td1.decode(textBytes.slice(0, nullIdx));
          value = td1.decode(textBytes.slice(nullIdx + 1));
        }
        function decodeB64(b64) {
          try {
            // atob gives bytes as 0-255 codepoints; convert via TextDecoder
            const raw = atob(b64);
            const buf = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
            return new TextDecoder('utf-8').decode(buf);
          } catch(e) { return null; }
        }
        function tryDecode(val) {
          try { return JSON.parse(val); } catch(e) {}
          var dec = decodeB64(val);
          if (dec) { try { return JSON.parse(dec); } catch(e) {} }
          return null;
        }
        if (keyword === 'chara') {
          charaJSON = tryDecode(value);
        } else if (keyword === 'ccv3') {
          ccv3JSON = tryDecode(value);
        }
      }
    }
    
    offset = dataStart + length + 4; // skip CRC
  }
  
  const result = ccv3JSON || charaJSON;
  // Prefer data field for V2/V3 cards
  if (result && result.data) {
    return result.data;
  }
  return result;
}
function generateCharacterCard(fields, avatarBuffer) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const srcBytes = new Uint8Array(e.target.result);
        // Validate PNG
        const sig = [137,80,78,71,13,10,26,10];
        for (let i = 0; i < 8; i++) if (srcBytes[i] !== sig[i]) throw new Error('Avatar must be a PNG file');
        
        // Build card JSON (V2 format via ccv3 for longer content support)
        const cardData = {
          data: {
            name: fields.name || '',
            description: fields.description || '',
            personality: fields.personality || '',
            scenario: fields.scenario || '',
            first_mes: fields.first_mes || '',
            mes_example: fields.mes_example || '',
            system_prompt: fields.system_prompt || '',
            creator: fields.creator || '',
            creator_notes: fields.creator_notes || '',
            character_version: fields.character_version || '1.0'
          }
        };
        const jsonStr = JSON.stringify(cardData);
        const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
        const tEXtData = 'ccv3\0' + b64;
        
        // Find IEND position in source
        let iendPos = -1;
        let offset = 8;
        while (offset < srcBytes.length - 8) {
          const len = (srcBytes[offset] << 24) | (srcBytes[offset+1] << 16) | (srcBytes[offset+2] << 8) | srcBytes[offset+3];
          const type = String.fromCharCode(srcBytes[offset+4], srcBytes[offset+5], srcBytes[offset+6], srcBytes[offset+7]);
          if (type === 'IEND') { iendPos = offset; break; }
          offset += 8 + len + 4;
        }
        if (iendPos < 0) { reject(new Error('Invalid PNG')); return; }
        
        // Build output: copy everything up to IEND, insert tEXt chunk, then IEND
        const beforeIEND = srcBytes.slice(0, iendPos);
        const iendChunk = srcBytes.slice(iendPos);
        
        const tEXtBytes = new TextEncoder().encode(tEXtData);
        const chunkLen = tEXtBytes.length;
        
        // Build chunk: length(4) + 'tEXt'(4) + data + CRC(4)
        const chunk = new Uint8Array(4 + 4 + chunkLen + 4);
        chunk[0] = (chunkLen >> 24) & 0xFF;
        chunk[1] = (chunkLen >> 16) & 0xFF;
        chunk[2] = (chunkLen >> 8) & 0xFF;
        chunk[3] = chunkLen & 0xFF;
        chunk[4] = 116; chunk[5] = 69; chunk[6] = 88; chunk[7] = 116; // 'tEXt'
        chunk.set(tEXtBytes, 8);
        
        // CRC32 (simplified)
        const crcData = chunk.slice(4, 8 + chunkLen);
        const crc = crc32(crcData);
        chunk[8 + chunkLen] = (crc >> 24) & 0xFF;
        chunk[8 + chunkLen + 1] = (crc >> 16) & 0xFF;
        chunk[8 + chunkLen + 2] = (crc >> 8) & 0xFF;
        chunk[8 + chunkLen + 3] = crc & 0xFF;
        
        const result = new Uint8Array(beforeIEND.length + chunk.length + iendChunk.length);
        result.set(beforeIEND, 0);
        result.set(chunk, beforeIEND.length);
        result.set(iendChunk, beforeIEND.length + chunk.length);
        
        resolve(new Blob([result], { type: 'image/png' }));
      } catch(err) { reject(err); }
    };
    reader.readAsArrayBuffer(avatarBuffer);
  });
}
// ===== 扩展数据自然语言解读（酒馆生态卡专用）=====
// 背景：PNG 角色卡常携带酒馆（SillyTavern）生态的机器规则——tavern_helper 脚本（MVU 变量系统）、
//       正则替换规则（HTML 状态栏美化、标记清理）、深度提示词、世界书等。chat-lite 不执行这些规则，
//       本组函数将其翻译为自然语言规则说明，让用户看得懂、可选择性复制。
function extractSchemaKeys(content) {
  // 多行缩进格式：逐行跟踪 z.object({...}) 深度提取键名（支持嵌套）
  const lines = String(content || '').split('\n');
  if (lines.length > 1) {
    const keys = [];
    let depth = 0, inObj = false;
    for (const line of lines) {
      const t = line.trim();
      if (!inObj) {
        if (t.indexOf('z.object({') >= 0) { inObj = true; depth = 1; continue; }
        continue;
      }
      const opens = (t.match(/\{/g) || []).length;
      const closes = (t.match(/\}/g) || []).length;
      const m = t.match(/^([^:{\s]+):/);
      if (m) keys.push(m[1].replace(/['"]/g, ''));
      depth += opens - closes;
      if (depth <= 0) break;
    }
    if (keys.length) return keys;
  }
  // 单行/紧凑格式兜底：全局提取「键名:」
  const keys2 = [];
  const re = /([^:{\s,()][^:{\s,()]*)\s*:/g;
  let mm;
  while ((mm = re.exec(String(content || ''))) !== null) {
    const k = mm[1].trim();
    if (k && !/\s/.test(k) && k.indexOf('z.object') < 0) keys2.push(k);
  }
  return keys2;
}

function explainScript(s) {
  const name = s.name || '未命名脚本';
  const content = String(s.content || '');
  const parts = ['「' + name + '」'];
  if (s.enabled === false) parts.push('（已禁用）');
  if (content.indexOf('registerMvuSchema') >= 0 || content.indexOf('z.object({') >= 0) {
    const keys = extractSchemaKeys(content);
    parts.push('定义变量系统：' + (keys.length ? keys.join('、') : '（Schema 定义）'));
  } else {
    const imp = content.match(/import\s*['"]([^'"]+)['"]/);
    if (imp) {
      const libPath = imp[1];
      // 优先取路径中的仓库/库名（支持 github 域与 jsdelivr /gh/ 路径），去版本后缀与扩展名
      const gh = libPath.match(/(?:github\.com\/|gh\/)([^/]+)\/([^/@]+)/);
      let lib = gh ? gh[2] : (libPath.split('/').filter(Boolean).pop() || libPath);
      lib = lib.replace(/\.(js|mjs|ts)$/, '').replace(/@.*$/, '').trim();
      parts.push('引入外部库：' + (lib || libPath));
    } else {
      parts.push('脚本代码（' + content.length + ' 字符）' + (content ? '：' + content.slice(0, 40).replace(/\n/g, ' ') : ''));
    }
  }
  return parts.join('');
}

function explainRegexScript(r) {
  const name = r.scriptName || '未命名规则';
  const find = String(r.findRegex || '');
  const replace = String(r.replaceString || '');
  const parts = ['「' + name + '」'];
  if (r.disabled) parts.push('（已禁用）');
  // 替换行为
  if (!replace.trim()) {
    parts.push('删除匹配内容');
  } else if (replace.length > 200 && (replace.indexOf('<div') >= 0 || replace.indexOf('<style') >= 0 || replace.indexOf('```html') >= 0)) {
    parts.push('渲染为 HTML 界面组件（美化展示）');
  } else if (replace.length > 200) {
    parts.push('替换为长文本（' + replace.length + ' 字符）');
  } else {
    parts.push('替换为：' + replace.slice(0, 60).replace(/\n/g, ' '));
  }
  // 作用域
  if (r.promptOnly) parts.push('仅作用于发送给 AI 的提示词');
  if (r.markdownOnly) parts.push('仅作用于界面显示');
  if (r.runOnEdit) parts.push('编辑消息时执行');
  // 匹配对象推断
  const f = find.replace(/^\/|\/[dgimsuvy]*$/g, '');
  let target = null;
  if (/StatusPlaceHolder/i.test(f)) target = '状态占位标记 <StatusPlaceHolderImpl/>';
  else if (/Analysis/i.test(f)) target = '思维链内容 <Analysis>…</Analysis>';
  else if (/UpdateVariable/i.test(f)) target = '变量更新标记 <UpdateVariable>…</UpdateVariable>';
  else if (/content/i.test(f)) target = '内容标签 <content>';
  parts.push('匹配：' + (target || (find ? find.slice(0, 50) + (find.length > 50 ? '…' : '') : '（无正则）')));
  return parts.join('；');
}

function explainExtensions(ext) {
  const lines = [];
  // 基础字段
  const basics = [];
  if (ext.talkativeness !== undefined && ext.talkativeness !== null) {
    const t = Number(ext.talkativeness);
    basics.push('话痨度 ' + t + (t >= 0.7 ? '（健谈）' : t >= 0.3 ? '（适中）' : '（偏安静）'));
  }
  if (ext.world) basics.push('世界观「' + ext.world + '」');
  if (ext.fav !== undefined) basics.push('收藏标记 ' + ext.fav);
  if (basics.length) lines.push('● ' + basics.join('；') + '。');
  // 深度提示词
  if (ext.depth_prompt && typeof ext.depth_prompt === 'object') {
    const dp = ext.depth_prompt;
    const dpParts = [];
    if (dp.depth) dpParts.push('深度 ' + dp.depth + ' 层');
    if (dp.role) dpParts.push('注入角色 ' + dp.role);
    if (dp.prompt) dpParts.push('内容：' + String(dp.prompt).slice(0, 80));
    if (dpParts.length) lines.push('● 深度提示词配置：' + dpParts.join('，') + '。');
  }
  // 脚本（tavern_helper.scripts）
  const scripts = (ext.tavern_helper && Array.isArray(ext.tavern_helper.scripts)) ? ext.tavern_helper.scripts : [];
  if (scripts.length) {
    lines.push('● 变量与脚本（' + scripts.length + ' 个）：');
    scripts.forEach(function(s) { lines.push('  - ' + explainScript(s)); });
  }
  // 正则规则（tavern_helper.regex_scripts 优先，顶层 regex_scripts 按 id 去重补充）
  const seen = {};
  const regexes = [];
  const thRegex = (ext.tavern_helper && Array.isArray(ext.tavern_helper.regex_scripts)) ? ext.tavern_helper.regex_scripts : [];
  const topRegex = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
  thRegex.concat(topRegex).forEach(function(r) {
    const id = r.id || r.scriptName || JSON.stringify(r).slice(0, 40);
    if (!seen[id]) { seen[id] = true; regexes.push(r); }
  });
  if (regexes.length) {
    lines.push('● 正则替换规则（' + regexes.length + ' 条）：');
    regexes.forEach(function(r) { lines.push('  - ' + explainRegexScript(r)); });
  }
  // 未识别扩展字段：简单值（人话字符串/数字/布尔）直接展示，机器数据仅提示数量
  const knownKeys = ['talkativeness', 'fav', 'world', 'depth_prompt', 'tavern_helper', 'regex_scripts'];
  const unknownSimple = [];
  const unknownComplex = [];
  for (const k of Object.keys(ext)) {
    if (knownKeys.indexOf(k) >= 0) continue;
    const v = ext[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') {
      unknownSimple.push(k + '：' + String(v));
    } else if (typeof v === 'string') {
      const s = String(v).trim();
      const looksMachine = /[<>{}\[\]\\/]/.test(s) || /\b(function|const|let|import|export|script|html|json|prompt)\b/i.test(s);
      if (s && s.length <= 80 && !looksMachine && s.indexOf('\n') < 0) unknownSimple.push(k + '：' + s);
      else unknownComplex.push(k);
    } else {
      unknownComplex.push(k);
    }
  }
  if (unknownSimple.length) lines.push('● 其他扩展字段：' + unknownSimple.join('；') + '。');
  if (unknownComplex.length) lines.push('● 另有未识别扩展字段 ' + unknownComplex.length + ' 个（' + unknownComplex.join('、') + '），机器数据已省略。');
  return lines.join('\n');
}

// 角色卡字段 → 带标签大文本（完整呈现解析内容，空字段跳过，可编辑后反解析）
// 定位：角色卡栏目作为 PNG 角色卡内容解析工具——大文本框完整呈现卡内全部内容，用户按需复制
function formatCardFields(data) {
  const labelMap = [
    ['name', '名称'],
    ['description', '简介'],
    ['personality', '性格'],
    ['scenario', '场景'],
    ['first_mes', '开场白'],
    ['mes_example', '示例对话'],
    ['system_prompt', '系统提示词'],
    ['creator', '作者'],
    ['character_version', '版本'],
    ['creator_notes', '备注']
  ];
  const lines = [];
  for (const [key, label] of labelMap) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    lines.push('【' + label + '】' + s);
  }
  // 替代开场白（多条）
  if (Array.isArray(data.alternate_greetings) && data.alternate_greetings.length) {
    lines.push('【替代开场白】');
    data.alternate_greetings.forEach(function(g, i) {
      const gs = String(g || '').trim();
      if (gs) lines.push((i + 1) + '. ' + gs);
    });
  }
  // 标签
  if (Array.isArray(data.tags) && data.tags.length) {
    lines.push('【标签】' + data.tags.join(', '));
  }
  // 扩展数据（自然语言解读——酒馆机器规则翻译成人话）
  if (data.extensions && typeof data.extensions === 'object' && Object.keys(data.extensions).length) {
    const explained = explainExtensions(data.extensions);
    if (explained) {
      lines.push('【扩展数据解读】' + explained);
    } else {
      lines.push('【扩展数据】' + JSON.stringify(data.extensions));
    }
  }
  // 世界书（lorebook，自然语言设定 + 触发规则元信息）
  if (data.character_book && Array.isArray(data.character_book.entries) && data.character_book.entries.length) {
    const cb = data.character_book;
    const headerParts = [];
    if (cb.name && String(cb.name).trim()) headerParts.push('「' + String(cb.name).trim() + '」');
    if (cb.description && String(cb.description).trim()) headerParts.push(String(cb.description).trim());
    let head = '【世界书（知识库）】' + (headerParts.length ? ' ' + headerParts.join(' ') : '');
    const cfg = [];
    if (cb.scan_depth !== undefined && cb.scan_depth !== null) cfg.push('扫描深度 ' + cb.scan_depth + ' 层');
    if (cb.token_budget !== undefined && cb.token_budget !== null) cfg.push('令牌预算 ' + cb.token_budget);
    if (cb.recursive_scanning !== undefined && cb.recursive_scanning !== null) cfg.push('递归扫描 ' + (cb.recursive_scanning ? '开' : '关'));
    if (cfg.length) head += '（' + cfg.join('；') + '）';
    lines.push(head);
    data.character_book.entries.forEach(function(e, i) {
      const title = (e.comment || '').trim() || (Array.isArray(e.keys) && e.keys.length ? e.keys.join('、') : ('条目 ' + (i + 1)));
      let item = (i + 1) + '. 「' + title + '」';
      const meta = [];
      if (Array.isArray(e.keys) && e.keys.length) meta.push('关键词：' + e.keys.join('、'));
      if (Array.isArray(e.secondary_keys) && e.secondary_keys.length) meta.push('副关键词：' + e.secondary_keys.join('、'));
      if (e.enabled === false) meta.push('停用');
      if (e.position === 'before_char') meta.push('注入角色前');
      else if (e.position === 'after_char') meta.push('注入角色后');
      if (meta.length) item += '【' + meta.join('；') + '】';
      lines.push(item);
      const content = String(e.content || '').trim();
      if (content) lines.push(content);
    });
  }
  // 对话后指令
  if (data.post_history_instructions && String(data.post_history_instructions).trim()) {
    lines.push('【对话后指令】' + String(data.post_history_instructions).trim());
  }
  return lines.join('\n');
}

// 带标签大文本 → 字段对象（导出用；缺字段填空值，容错解析）
function parseCardText(text) {
  const labelMap = {
    '名称': 'name', '简介': 'description', '性格': 'personality', '场景': 'scenario',
    '开场白': 'first_mes', '示例对话': 'mes_example', '系统提示词': 'system_prompt',
    '作者': 'creator', '版本': 'character_version', '备注': 'creator_notes'
  };
  const fields = { name:'', description:'', personality:'', scenario:'', first_mes:'', mes_example:'', system_prompt:'', creator:'', creator_notes:'', character_version:'1.0' };
  const lines = String(text || '').split('\n');
  let current = null;
  for (const line of lines) {
    const m = line.match(/^【(.+?)】(.*)$/);
    if (m && labelMap[m[1]]) {
      current = labelMap[m[1]];
      fields[current] = m[2].trim();
      continue;
    }
    if (m && (m[1] === '标签' || m[1] === '扩展数据')) { current = null; continue; }
    if (m && m[1] === '替代开场白') { current = 'alternate_greetings'; continue; }
    // 其他【标签】块（如【扩展数据解读】【世界书】）：未知语义块，跳过其后续内容，不混入字段
    if (m) { current = null; continue; }
    if (current === 'alternate_greetings') {
      const nm = line.match(/^\d+\.\s*(.*)$/);
      if (nm) {
        if (!Array.isArray(fields.alternate_greetings)) fields.alternate_greetings = [];
        fields.alternate_greetings.push(nm[1].trim());
      }
      continue;
    }
    if (current && current !== 'alternate_greetings') {
      fields[current] = fields[current] ? fields[current] + '\n' + line : line;
    }
  }
  return fields;
}

function buildCardPrompt(fields) {
  const parts = [];
  if (fields.name) parts.push(fields.name);
  if (fields.description) parts.push(fields.description);
  if (fields.personality) parts.push('性格：' + fields.personality);
  if (fields.scenario) parts.push('场景：' + fields.scenario);
  const header = parts.length > 0 ? '[角色：' + parts.join('；') + ']' : '';
  const sys = fields.system_prompt || '';
  const example = fields.mes_example ? '\n# 对话示例\n' + fields.mes_example : '';
  return [header, sys, example].filter(Boolean).join('\n\n');
}
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

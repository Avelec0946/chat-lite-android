// ===== tests/import.test.js =====
// 全量备份导入的回归测试（node 直接跑，不依赖浏览器）
//   node tests/import.test.js
//
// 为什么需要这个文件：用户报告「旧的全量备份导入不支持」。实测查出 4 个真实缺陷，
//   全部落在「没报错但结果不对」这一档 —— 最难查的那种：
//     ① 导入的 settings 没走 migrateSettings → 老 modelPrompts 结构原样留下，模型修饰语变空白
//     ② 老备份的 conversations 是 messages 数组 → 导入后 messageMap 为空，打开会话抛错、界面空白
//     ③ 「覆盖」模式只做 Object.assign → 本地独有的键残留，用户点覆盖却还是旧配置
//     ④ 流式导入（APK 覆盖路径）同样漏了 ①②
//   这些都不会崩，所以必须靠断言钉住。
//
// 做法：io.js 是普通脚本（挂全局函数），顶层引用 document/state，不能直接 require。
//   所以用 vm 沙箱只取需要的纯函数，并注入最小桩。

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var failures = 0;
var passes = 0;

function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + name); }
  else { failures++; console.log('  \u2717 ' + name + (detail ? '  \u2192 ' + detail : '')); }
}

// ---- 从 io.js 源码里抠出纯函数（不执行整个文件，避免触碰 DOM）----
var ioSrc = fs.readFileSync(path.join(__dirname, '..', 'www', 'io.js'), 'utf8');

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  var i = src.indexOf('{', start);
  var depth = 0, inStr = false, esc = false, end = -1;
  for (; i < src.length; i++) {
    var c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math,
  String: String, Number: Number, parseFloat: parseFloat, isFinite: isFinite
};
vm.createContext(sandbox);
vm.runInContext(extractFn(ioSrc, 'createConvScanner'), sandbox);

// 复刻 importAllDataStreamed 的尾部解析（与源码同一套正则/切片，改动要同步）
function tailParse(tailText) {
  var tailRaw = tailText.replace(/^[\s,\]]+/, '').trim();
  if (!tailRaw) return {};
  try { return JSON.parse('{' + tailRaw.slice(0, -1) + '}'); } catch (e) { return {}; }
}

function streamScan(text) {
  var CHUNK = 2 * 1024 * 1024;
  var scanner = sandbox.createConvScanner();
  var convs = [];
  var headText = '', tailText = '', inConvs = false, done = false, offset = 0;
  while (offset < text.length) {
    var chunk = text.slice(offset, offset + CHUNK);
    var res = scanner.feed(chunk);
    if (!inConvs) {
      if (res.found) { headText += chunk.slice(0, res.found.posInChunk); inConvs = true; }
      else headText += chunk;
    }
    for (var k = 0; k < res.objs.length; k++) convs.push(JSON.parse(res.objs[k]));
    if (res.done) { done = true; if (res.tailText !== null) tailText += res.tailText; }
    else if (done && res.tailText !== null) tailText += res.tailText;
    offset += chunk.length;
  }
  if (!done) throw new Error('未找到 conversations 数组结束');
  var headObj = {};
  try {
    headObj = JSON.parse(headText.replace(/,\s*"conversations"\s*:\s*$/, '').trim() + '}');
  } catch (e) { headObj = {}; }
  return { convs: convs, head: headObj, tail: tailParse(tailText) };
}

function mkConv(id) {
  return {
    id: id, title: 't-' + id, rootId: 'r1', activePath: ['r1', 'm1'],
    messageMap: {
      r1: { id: 'r1', role: 'system', content: '', parentId: null, children: ['m1'] },
      m1: { id: 'm1', role: 'user', content: 'hi', parentId: 'r1', children: [] }
    }
  };
}

// =====================================================================================
console.log('\n[1] 流式扫描：各种备份形态都要能读出来');
// =====================================================================================
(function () {
  var data = {
    version: 1, convGroups: [], conversations: [mkConv('c1'), mkConv('c2')],
    providers: [{ id: 'p1' }], settings: { fontSize: '15' }, currentId: 'c1'
  };

  var compact = streamScan(JSON.stringify(data));
  ok('compact（新版导出）', compact.convs.length === 2 && compact.tail.providers.length === 1);

  var pretty = streamScan(JSON.stringify(data, null, 2));
  ok('pretty-print（最早版本导出，缩进+换行）', pretty.convs.length === 2, 'got ' + pretty.convs.length);

  var withNl = streamScan(JSON.stringify(data) + '\n\n');
  ok('末尾带换行（编辑器/传输追加）', withNl.convs.length === 2);

  var bom = streamScan('\uFEFF' + JSON.stringify(data));
  ok('带 BOM 开头', bom.convs.length === 2);

  var noGroups = streamScan(JSON.stringify({
    version: 1, conversations: [mkConv('c1')], providers: [], settings: {}, currentId: null
  }));
  ok('没有 convGroups 字段（更老的备份）', noGroups.convs.length === 1 && noGroups.head.convGroups === undefined);

  var noTail = streamScan(JSON.stringify({ version: 1, conversations: [mkConv('c1')], currentId: 'c1' }));
  ok('缺 providers/settings 也不炸', noTail.convs.length === 1);

  var empty = streamScan(JSON.stringify({ version: 1, conversations: [], providers: [], settings: {}, currentId: null }));
  ok('conversations 为空数组', empty.convs.length === 0);

  var tricky = mkConv('c1');
  tricky.messageMap.m1.content = '他说 "conversations": [1,2,3] 是啥意思';
  var trickyOut = streamScan(JSON.stringify({
    version: 1, conversations: [tricky], providers: [], settings: {}, currentId: 'c1'
  }));
  ok('正文里出现 "conversations" 字样不会截错',
     trickyOut.convs.length === 1 && trickyOut.convs[0].messageMap.m1.content.indexOf('1,2,3') >= 0);
})();

// =====================================================================================
console.log('\n[2] 老 schema 会话（messages 数组，无 messageMap）');
// =====================================================================================
(function () {
  var legacy = {
    id: 'oc1', title: '老会话', model: 'gpt-4', providerId: 'p1',
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
  };
  var out = streamScan(JSON.stringify({
    version: 1, conversations: [legacy], providers: [], settings: {}, currentId: 'oc1'
  }));
  ok('老 schema 能读进来', out.convs.length === 1);
  ok('老 schema 原样保留 messages（迁移由 io.js 收尾做，不在扫描器里）',
     Array.isArray(out.convs[0].messages) && !out.convs[0].messageMap);

  var convSrc = fs.readFileSync(path.join(__dirname, '..', 'www', 'conversation.js'), 'utf8');
  ok('conversation.js 里有 migrateV1toV2', convSrc.indexOf('function migrateV1toV2(') >= 0);

  var sb2 = { Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number };
  sb2.uid = function () { return 'id' + Math.random().toString(36).slice(2, 8); };
  sb2.countWords = function (s) { return String(s || '').length; };
  vm.createContext(sb2);
  vm.runInContext(extractFn(convSrc, 'migrateV1toV2'), sb2);
  var cv = { id: 'oc2', title: 'x', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] };
  sb2.migrateV1toV2(cv);
  ok('migrateV1toV2 生成 messageMap', !!cv.messageMap);
  ok('migrateV1toV2 生成 rootId / activePath',
     !!cv.rootId && Array.isArray(cv.activePath) && cv.activePath.length >= 2);
})();

// =====================================================================================
console.log('\n[3] 导入收尾必须调用 migrateSettings（源码级契约断言）');
// =====================================================================================
(function () {
  // 只要有人在导入路径里把 migrateSettings 删了，这里就红。
  var importBlock = ioSrc.slice(
    ioSrc.indexOf('async function importAllData('),
    ioSrc.indexOf('function importAllDataFromFile(')
  );
  ok('importAllData 调用了 migrateSettings', importBlock.indexOf('migrateSettings(') >= 0);
  ok('importAllData 用 defaultSettings 打底（否则本地残留键）', importBlock.indexOf('defaultSettings()') >= 0);
  ok('importAllData 迁移老 schema 会话', importBlock.indexOf('migrateV1toV2(') >= 0);

  var streamBlock = ioSrc.slice(
    ioSrc.indexOf('async function importAllDataStreamed('),
    ioSrc.indexOf('async function exportConversation(')
  );
  ok('importAllDataStreamed 调用了 migrateSettings', streamBlock.indexOf('migrateSettings(') >= 0);
  ok('importAllDataStreamed 用 defaultSettings 打底', streamBlock.indexOf('defaultSettings()') >= 0);
  ok('importAllDataStreamed 迁移老 schema 会话', streamBlock.indexOf('migrateV1toV2(') >= 0);
})();

// =====================================================================================
console.log('\n[4] 覆盖 vs 合并的 settings 语义（纯函数模拟）');
// =====================================================================================
(function () {
  var defaults = { fontSize: '15', a: 1, b: 2 };
  function overwrite(local, backup) { return Object.assign({}, defaults, backup); }
  function merge(local, backup) { return Object.assign({}, local, backup); }

  var local = { fontSize: '20', onlyLocal: 'X', a: 9, b: 2 };
  var backup = { fontSize: '13' };

  var ow = overwrite(local, backup);
  ok('覆盖：备份里的值生效', ow.fontSize === '13', ow.fontSize);
  ok('覆盖：本地独有的键不残留', ow.onlyLocal === undefined, String(ow.onlyLocal));
  ok('覆盖：备份没写的项回到默认', ow.a === 1, String(ow.a));

  var mg = merge(local, backup);
  ok('合并：本地独有的键保留', mg.onlyLocal === 'X', String(mg.onlyLocal));
  ok('合并：备份里的值生效', mg.fontSize === '13', mg.fontSize);
})();

// =====================================================================================
console.log('\n==========================================================');
console.log('导入回归：' + passes + '/' + (passes + failures) + ' 通过，' + failures + ' 失败');
console.log('==========================================================');
process.exit(failures ? 1 : 0);

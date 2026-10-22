// ===== tests/voice-order.test.js =====
//   node tests/voice-order.test.js
//
// v130 两条用户实测反馈的单测：
//   ① 「通话里看不见我挂在上下文的文件，挂断之后再问又能看见」
//      → historyMessages() 从来不带 msg.files（普通对话带，通话不带）。
//   ② 「模型念回复时吐字是乱的，根本没法听」
//      → 句子级并发（maxActive=3）的 PCM 全部直写同一个播放器，按**到达顺序**拼接，
//        第 2 句的音频被插进第 1 句中间。createSpool 负责"并发下载、串行播放"。
//
// 这两条都写成了可执行断言；每条断言都同时给出"旧行为会怎样"，避免又变成自说自话。

'use strict';

var path = require('path');
var root = globalThis;
var failures = 0;
var passes = 0;

function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + name); }
  else { failures++; console.log('  \u2717 ' + name + (detail ? '  \u2192 ' + detail : '')); }
}

require(path.join(__dirname, '..', 'www', 'voice.js'));
var VoiceCall = root.VoiceCall;
if (!VoiceCall || !VoiceCall.__test) {
  console.error('无法加载 www/voice.js 的 __test 导出');
  process.exit(1);
}
var T = VoiceCall.__test;

// 每次 push 的字节内容就是它的"身份标签"：把字节当字符串读回来，拼接顺序一目了然
function b(tag) { return new Uint8Array(Buffer.from(tag, 'utf8')); }
function join(list) { return list.map(function (x) { return Buffer.from(x).toString('utf8'); }).join(''); }

// =====================================================================================
console.log('\n[1] 播放顺序：并发到达也必须按句序出声音');
// =====================================================================================
(function () {
  var out = [];
  var flushes = 0;
  var sp = T.createSpool({
    append: function (bytes) { out.push(bytes); },
    flush: function () { flushes++; }
  });

  var s1 = sp.open();
  var s2 = sp.open();
  var s3 = sp.open();

  // 真实时序：三句的 TTS 同时在下发，块是交替到达的
  s1.push(b('1a'));
  s2.push(b('2a'));   // ← 第 2 句先到，旧版就在这一行插队
  s1.push(b('1b'));
  s3.push(b('3a'));
  s2.push(b('2b'));
  s1.push(b('1c'));
  s3.push(b('3b'));

  // 此刻只有第 1 句该出声
  ok('第 1 句未完时只播第 1 句的块', join(out) === '1a1b1c', join(out));
  ok('第 2/3 句的音频被扣在缓冲区里（没有插队）',
    join(out).indexOf('2a') < 0 && join(out).indexOf('3a') < 0, join(out));
  ok('取证：outOfOrder 真的记到了（这批字节在旧版就是乱序的源头）',
    sp.stats().outOfOrder >= 3, JSON.stringify(sp.stats()));
  ok('缓冲里有字节（pendingBytes>0）', sp.pendingBytes() > 0, String(sp.pendingBytes()));

  s1.finish();
  ok('第 1 句结束 → 第 2 句立即接上（不用再等，数据早就到了）',
    join(out) === '1a1b1c2a2b', join(out));
  ok('第 1 句结束就吐了一次 WSOLA 尾巴（每句一次，不多不少）', flushes === 1, String(flushes));

  s3.finish();   // 第 3 句先于第 2 句"合成完"
  ok('第 3 句先合成完也不会越过第 2 句',
    join(out) === '1a1b1c2a2b', join(out));

  s2.finish();
  ok('第 2 句结束 → 第 3 句接上，顺序仍是 1→2→3',
    join(out) === '1a1b1c2a2b3a3b', join(out));
  ok('三句各吐一次尾巴（flush 次数 = 句子数）', flushes === 3, String(flushes));
  ok('全部播完时缓冲区归零', sp.pendingBytes() === 0, String(sp.pendingBytes()));

  ok('对照：不加 spool 的直写方式（= 旧版）在这批到达顺序下就是乱的',
    ['1a', '2a', '1b', '3a', '2b', '1c', '3b'].join('') !== join(out),
    'naive=' + ['1a', '2a', '1b', '3a', '2b', '1c', '3b'].join(''));
})();

// =====================================================================================
console.log('\n[2] 句子失败/超时必须放行，不能把后面的句子永久顶住');
// =====================================================================================
(function () {
  var out = [];
  var flushes = 0;
  var sp = T.createSpool({
    append: function (bytes) { out.push(bytes); },
    flush: function () { flushes++; }
  });
  var a = sp.open();
  var c = sp.open();
  c.push(b('C1'));
  a.push(b('A1'));
  a.finish();              // 第 1 句正常
  c.finish();              // 第 2 句一个字都没收到（TTS 报错）→ 由 startOne 的 finally 调 finish
  ok('零字节句子也能推进 head（否则后面全哑）', join(out) === 'A1C1', join(out));
  ok('零字节句子不算一次多余的 flush 之外仍有 flush',
    flushes === 2, String(flushes));

  // 只有 finish 没 push 的一句（整句失败）夹在中间
  var out2 = [];
  var sp2 = T.createSpool({
    append: function (bytes) { out2.push(bytes); },
    flush: function () {}
  });
  var x = sp2.open();
  var y = sp2.open();
  var z = sp2.open();
  z.push(b('Z'));
  x.finish();              // 第 1 句失败
  y.finish();              // 第 2 句失败
  ok('连续失败后第 3 句仍能正常播出', join(out2) === 'Z', join(out2));
  z.finish();
})();

// =====================================================================================
console.log('\n[3] 关闭后不再吐字节（打断/挂断）');
// =====================================================================================
(function () {
  var out = [];
  var sp = T.createSpool({ append: function (x) { out.push(x); }, flush: function () {} });
  var s1 = sp.open();
  var s2 = sp.open();
  s1.push(b('A'));
  s2.push(b('B'));
  sp.close();
  s1.push(b('A2'));
  s1.finish();
  ok('close 之后缓冲区与直通都停止', join(out) === 'A', join(out));
})();

// =====================================================================================
console.log('\n[4] 附件进通话上下文（用户反馈 ①）');
// =====================================================================================
(function () {
  var md = '# 2022考研英语二 Text1\n第一段正文……\n关键词：气候变化';
  var conv = {
    id: 'c1', rootId: 'r', messageMap: {}, activePath: []
  };
  var u1 = {
    id: 'u1', role: 'user',
    content: '收到这个文件先不要回复，等我接下来的指令',
    files: [{ name: '2022考研英语二-Text1气候友好型.md', type: 'text/markdown', content: md, size: md.length }]
  };
  var a1 = { id: 'a1', role: 'assistant', content: '好的，已收到。等待您的下一步指令。' };
  conv.messageMap = { u1: u1, a1: a1 };
  conv.activePath = ['u1', 'a1'];

  var hist = T.historyMessages(conv, 14);
  ok('带附件的消息没有被过滤掉', hist.length === 2, JSON.stringify(hist.length));
  ok('文件正文真的进了历史（旧版这里是空的）',
    hist[0].content.indexOf('气候变化') >= 0, hist[0].content.slice(0, 120));
  ok('文件名也带上了（模型能说出"哪个文件"）',
    hist[0].content.indexOf('2022考研英语二-Text1气候友好型.md') >= 0, hist[0].content.slice(0, 120));
  ok('原话仍然在（不被文件正文顶掉）',
    hist[0].content.indexOf('等我接下来的指令') >= 0, hist[0].content.slice(-80));
  ok('文件在正文之前（和 chat.js 的 buildFileContent 顺序一致）',
    hist[0].content.indexOf('气候变化') < hist[0].content.indexOf('等我接下来的指令'), hist[0].content.slice(0, 200));

  // 走完整的大脑血管：system + history + 本轮用户话
  var msgs = T.buildBrainMessages(conv, '就是我刚发你的文件啊，你看不到吗？', null);
  var joined = msgs.map(function (m) { return String(m.content); }).join('\n');
  ok('buildBrainMessages 里能搜到文件正文', joined.indexOf('气候变化') >= 0, String(joined.length));
  ok('末条仍是本轮用户话', msgs[msgs.length - 1].role === 'user' &&
    msgs[msgs.length - 1].content.indexOf('你看不到吗') >= 0);

  // 纯附件消息（正文为空）也不能丢
  var conv2 = { id: 'c2', rootId: 'r', messageMap: {}, activePath: [] };
  conv2.messageMap = {
    u9: { id: 'u9', role: 'user', content: '', files: [{ name: 'a.txt', content: '只有附件没有正文', size: 8 }] }
  };
  conv2.activePath = ['u9'];
  var h2 = T.historyMessages(conv2, 8);
  ok('纯附件消息（无正文）也进历史', h2.length === 1 && h2[0].content.indexOf('只有附件没有正文') >= 0,
    JSON.stringify(h2));

  // 图片：v131 起与文本对话同源 —— 走 image_url parts，**真的把图给模型看**
  var conv3 = { id: 'c3', rootId: 'r', messageMap: {}, activePath: [] };
  var pngB64 = 'AAAA'.repeat(1000);
  conv3.messageMap = {
    u8: {
      id: 'u8', role: 'user', content: '看这张图',
      files: [{ name: 'shot.png', isImage: true, mimeType: 'image/png', base64: pngB64 }]
    }
  };
  conv3.activePath = ['u8'];
  var h3 = T.historyMessages(conv3, 8);
  var c3 = h3[0].content;
  ok('图片变成 content 数组（image_url parts）', Array.isArray(c3), typeof c3);
  ok('数组里有 image_url 且带完整 data URL（视觉真的可用）', Array.isArray(c3) &&
    c3.some(function (p) { return p.type === 'image_url' && String(p.image_url && p.image_url.url).indexOf('data:image/png;base64,') === 0; }),
    JSON.stringify(Array.isArray(c3) ? c3.map(function (p) { return p.type; }) : c3));
  ok('文字与原话都在数组里', Array.isArray(c3) &&
    c3.some(function (p) { return p.type === 'text' && String(p.text).indexOf('看这张图') >= 0; }),
    JSON.stringify(c3 && c3[0]));

  // assistant 的 files 不该被注入（只有用户消息才代表"挂在上下文里的文件"）
  var conv4 = { id: 'c4', rootId: 'r', messageMap: {}, activePath: [] };
  conv4.messageMap = {
    a7: { id: 'a7', role: 'assistant', content: '给你一个文件', files: [{ name: 'x.md', content: '不应注入' }] }
  };
  conv4.activePath = ['a7'];
  var h4 = T.historyMessages(conv4, 8);
  ok('assistant 的附件不注入', h4[0].content === '给你一个文件', JSON.stringify(h4[0].content));

  // v131：**不截断** —— 与文本对话一致（用户明确要求"无缝无损"，不许语音版更瘸）
  var big = 'x'.repeat(120000);
  var conv5 = { id: 'c5', rootId: 'r', messageMap: {}, activePath: [] };
  conv5.messageMap = {
    u5: { id: 'u5', role: 'user', content: '长文', files: [{ name: 'big.md', content: big }] }
  };
  conv5.activePath = ['u5'];
  var h5 = T.historyMessages(conv5, 8);
  var bigBody = Array.isArray(h5[0].content) ? JSON.stringify(h5[0].content) : h5[0].content;
  ok('12 万字的附件一字不截', bigBody.indexOf(big) >= 0, 'len=' + bigBody.length);
  ok('没有"只带了前 N 字"这类截断说明', bigBody.indexOf('只带了前') < 0, 'len=' + bigBody.length);

  // 多文件也全带
  var f1 = 'y'.repeat(30000);
  var conv6 = { id: 'c6', rootId: 'r', messageMap: {}, activePath: [] };
  conv6.messageMap = {
    u6: { id: 'u6', role: 'user', content: '', files: [{ name: 'f1.md', content: f1 }, { name: 'f2.md', content: 'z'.repeat(30000) }] }
  };
  conv6.activePath = ['u6'];
  var h6 = T.historyMessages(conv6, 8);
  ok('多文件全部带上（合计 6 万字不截）',
    h6[0].content.indexOf(f1) >= 0 && h6[0].content.indexOf('z'.repeat(30000)) >= 0,
    String(h6[0].content.length));
})();

// =====================================================================================
console.log('\n[5] 历史长度与文本对话一致（不再只带 14 条）');
// =====================================================================================
(function () {
  var conv = { id: 'c7', rootId: 'r', messageMap: {}, activePath: [] };
  var ids = [];
  for (var i = 0; i < 40; i++) {
    var id = 'm' + i;
    conv.messageMap[id] = { id: id, role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句' };
    ids.push(id);
  }
  conv.activePath = ids;
  var hist = T.historyMessages(conv, 0);
  ok('40 条历史一条不少（文本对话就是全发）', hist.length === 40, String(hist.length));
  var msgs = T.buildBrainMessages(conv, '现在呢', null);
  var histCount = msgs.filter(function (m) { return /^第\d+句$/.test(String(m.content)); }).length;
  ok('buildBrainMessages 里也是 40 条历史（+ system + 本轮）', histCount === 40, String(histCount) + ' / 共 ' + msgs.length);
  ok('历史顺序没乱', String(hist[0].content) === '第0句' && String(hist[39].content) === '第39句',
    String(hist[0].content) + '…' + String(hist[39].content));
})();

// =====================================================================================
console.log('\n[6] 上下文与文本对话同源（同一个 buildContext）');
// =====================================================================================
(function () {
  var conv = { id: 'c8', rootId: 'r', messageMap: {}, activePath: [], systemPrompt: '你是猫娘' };
  conv.messageMap = {
    u1: { id: 'u1', role: 'user', content: '看这个', files: [{ name: 'a.md', content: 'A正文' }] }
  };
  conv.activePath = ['u1'];

  // 冒充 chat.js 的 buildContext：记录参数，返回一份"文本对话会发的东西"
  var seenOpts = null;
  globalThis.buildFileContent = function (m) {
    if (!m.files) return m.content;
    return m.content + '\n【附件:' + (m.files[0] && m.files[0].name) + '】';
  };
  globalThis.buildContext = function (c, o) {
    seenOpts = o || null;
    return [
      { role: 'system', content: '会话人设：你是猫娘\n用户身份：老板' },
      { role: 'user', content: globalThis.buildFileContent(c.messageMap.u1) },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '继续聊' }
    ];
  };

  var msgs = T.buildBrainMessages(conv, '继续', null);
  ok('调用了 chat.js 的 buildContext', !!seenOpts, 'seen=' + JSON.stringify(seenOpts));
  ok('明确要求关闭状态栏（statusBar:false）', !!seenOpts && seenOpts.statusBar === false, JSON.stringify(seenOpts));
  ok('文本对话的每条历史都原样带过来（4 条 + 本轮）', msgs.length === 5,
    JSON.stringify(msgs.map(function (m) { return m.role; })));
  ok('附件处理走的就是 buildFileContent（同源，不是另一份实现）',
    String(msgs[1].content).indexOf('【附件:a.md】') >= 0, String(msgs[1].content));
  ok('system 里既有会话人设又有通话层与输出指令',
    String(msgs[0].content).indexOf('你是猫娘') >= 0 &&
    String(msgs[0].content).indexOf('【怎么输出】') >= 0, String(msgs[0].content).slice(0, 60));
  ok('全篇只有一条 system（不重复注入）',
    msgs.filter(function (m) { return m.role === 'system'; }).length === 1,
    JSON.stringify(msgs.map(function (m) { return m.role; })));

  // 反证：buildContext 不存在时走本地兜底，附件仍然带（不是瘸的）
  delete globalThis.buildContext;
  var fb = T.buildBrainMessages(conv, '继续', null);
  var flat = fb.map(function (m) { return JSON.stringify(m.content); }).join('\n');
  ok('无 buildContext 时兜底仍带附件（buildFileContent 优先）',
    flat.indexOf('【附件:a.md】') >= 0, flat.slice(-200));
  ok('兜底路径下本轮用户话仍在最后',
    fb[fb.length - 1].role === 'user' && String(fb[fb.length - 1].content).indexOf('继续') === 0,
    JSON.stringify(fb.map(function (m) { return m.role; })));

  delete globalThis.buildFileContent;
  ok('buildFileContent 也没有时，仍能内联出附件正文', (function () {
    var c2 = { id: 'c9', rootId: 'r', messageMap: {}, activePath: [] };
    c2.messageMap = { u1: { id: 'u1', role: 'user', content: '看这个', files: [{ name: 'b.md', content: '内联正文' }] } };
    c2.activePath = ['u1'];
    var h = T.historyMessages(c2, 0);
    return String(h[0].content).indexOf('内联正文') >= 0 && String(h[0].content).indexOf('b.md') >= 0;
  })());

  // 通话的真实时序：addUserMsg + addAssistantPlaceholder **先于** callBrain 落库。
  //   于是"文本对话的上下文"里已经有本轮用户话和一条空的 assistant 占位。
  //   v131 直接复用它，就必须处理这两条，否则同一句话发两遍 + 空 assistant 污染上下文。
  var convD = { id: 'cd', rootId: 'r', messageMap: {}, activePath: [] };
  convD.messageMap = {
    h1: { id: 'h1', role: 'user', content: '昨天聊到哪儿了' },
    h2: { id: 'h2', role: 'assistant', content: '聊到你要考试。' },
    u1: { id: 'u1', role: 'user', content: '今天好累' },
    a0: { id: 'a0', role: 'assistant', content: '' }        // ← 本轮空气泡占位
  };
  convD.activePath = ['h1', 'h2', 'u1', 'a0'];
  var dm = T.buildBrainMessages(convD, '今天好累', null);
  ok('空气泡占位不发给模型', dm.filter(function (m) { return m.role === 'assistant' && !String(m.content).trim(); }).length === 0,
    JSON.stringify(dm.map(function (m) { return m.role; })));
  ok('本轮用户话只发一次（不因"已落库"而重复）',
    dm.filter(function (m) { return m.role === 'user' && String(m.content).indexOf('今天好累') === 0; }).length === 1,
    JSON.stringify(dm.map(function (m) { return m.role + ':' + String(m.content).slice(0, 10); })));
  ok('易变块补在已有的那条用户消息上（末条仍是 user）',
    dm[dm.length - 1].role === 'user' && String(dm[dm.length - 1].content).indexOf('今天好累') === 0,
    JSON.stringify(dm[dm.length - 1]));
  ok('前面那轮的历史没被动过',
    String(dm[0].content).indexOf('昨天聊到哪儿了') >= 0 || String(dm[1].content).indexOf('昨天聊到哪儿了') >= 0,
    JSON.stringify(dm.slice(0, 2)));
})();

// =====================================================================================
console.log('\n[7] 念之前把 <status> 清掉（上下文同源后的必要防护）');
// =====================================================================================
(function () {
  ok('完整状态栏块被清掉',
    T.stripSpeechNoise('好，那我们继续。\n<status>心情：平静｜时间：20:15</status>') === '好，那我们继续。',
    T.stripSpeechNoise('好，那我们继续。\n<status>心情：平静｜时间：20:15</status>'));
  ok('被流式切开的半个标签也不会念出来',
    T.stripSpeechNoise('知道了。<status>心情：平静').indexOf('status') < 0,
    T.stripSpeechNoise('知道了。<status>心情：平静'));
  ok('结尾残留的半截标签被清掉',
    T.stripSpeechNoise('好<sta') === '好', T.stripSpeechNoise('好<sta'));
  ok('普通文本不受影响', T.stripSpeechNoise('今天有点累，早点睡。') === '今天有点累，早点睡。',
    T.stripSpeechNoise('今天有点累，早点睡。'));
})();

// =====================================================================================
// [6] 整条流水线（不是零件）：并发预取 → 按句序出声音 → 排空回调
//     这一段才是"接线"的验证：句子队列、maxActive 并发、spool、whenIdle 一起跑。
// =====================================================================================
function b2(tag) { return new Uint8Array(Buffer.from(tag, 'utf8')); }

function runPipelineCase(specs, opts) {
  // specs: [{ text, chunks:[{at, tag}], resolveAt, reject }]
  return new Promise(function (resolve) {
    var sink = [];
    var flushes = 0;
    var peak = 0;
    var inFlight = 0;
    var timers = [];
    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

    var fakeTts = function (text, o) {
      var spec = null;
      for (var i = 0; i < specs.length; i++) if (text.indexOf(specs[i].text) >= 0) spec = specs[i];
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      return new Promise(function (res, rej) {
        if (!spec) { inFlight--; res({ firstChunkMs: 1 }); return; }
        (spec.chunks || []).forEach(function (c) {
          at(c.at, function () { o.onPcm(b2(c.tag)); });
        });
        at(spec.resolveAt === undefined ? 40 : spec.resolveAt, function () {
          inFlight--;
          if (spec.reject) rej(new Error('mock tts fail'));
          else res({ firstChunkMs: 12 });
        });
      });
    };

    var pl = T.createPipeline(null, function () { return true; }, '', fakeTts, {
      append: function (bytes) { sink.push(Buffer.from(bytes).toString('utf8')); },
      flush: function () { flushes++; }
    });

    var idleAt = 0;
    var t0 = Date.now();
    pl.whenIdle(function () { idleAt = Date.now() - t0; resolve({ sink: sink, flushes: flushes, peak: peak, idleAt: idleAt, pl: pl }); });

    // 大脑是一句一句吐出来的：模拟流式到达
    (specs || []).forEach(function (s, i) {
      at(5 + i * 8, function () { pl.push(s.text); });
    });
    if (opts && opts.finishAt) at(opts.finishAt, function () { pl.finish(); });
    else at(200, function () { pl.finish(); });
  });
}

(async function () {
  console.log('\n[8] 整条流水线：并发预取 + 串行播放 + 排空回调');
  var r = await runPipelineCase([
    { text: '第一句。', chunks: [{ at: 30, tag: 'A1' }, { at: 70, tag: 'A2' }, { at: 110, tag: 'A3' }], resolveAt: 130 },
    { text: '第二句。', chunks: [{ at: 20, tag: 'B1' }, { at: 40, tag: 'B2' }], resolveAt: 60 },
    { text: '第三句。', chunks: [{ at: 25, tag: 'C1' }, { at: 45, tag: 'C2' }], resolveAt: 55 }
  ], { finishAt: 160 });

  ok('三句全部按序播出（并发只到"拿到音频"为止）',
    r.sink.join('') === 'A1A2A3B1B2C1C2', r.sink.join(''));
  ok('预取并发真的用了（同时 3 路 TTS 在飞）', r.peak === 3, 'peak=' + r.peak);
  ok('每句边界吐一次尾巴（flush 次数 = 3）', r.flushes === 3, String(r.flushes));
  ok('排空回调在合理时间内触发（不卡在 speaking）', r.idleAt > 0 && r.idleAt < 1500, r.idleAt + 'ms');
  ok('结束后没有残留排队/在飞', r.pl.size() === 0, String(r.pl.size()));
  r.pl.stop();

  console.log('\n[9] 中间一句 TTS 失败：跳过它，前后仍按序，且不卡死');
  var r2 = await runPipelineCase([
    { text: '第一句。', chunks: [{ at: 10, tag: 'A1' }], resolveAt: 30 },
    { text: '第二句。', chunks: [{ at: 12, tag: 'B1' }], resolveAt: 20, reject: true },
    { text: '第三句。', chunks: [{ at: 14, tag: 'C1' }], resolveAt: 25 }
  ], { finishAt: 80 });
  // 失败那句可能已经吐了半个分片（真实 TTS 也会）——关键是"顺序"和"不卡死"
  var s2 = r2.sink.join('');
  ok('失败也不会打乱顺序（A 在 B/C 之前）', s2.indexOf('A1') === 0, s2);
  ok('第三句依然播出来了（没被失败句卡住）', s2.indexOf('C1') > 0, s2);
  ok('失败场景也能排空回调', r2.idleAt > 0 && r2.idleAt < 1500, r2.idleAt + 'ms');
  r2.pl.stop();

  console.log('\n' + (failures === 0 ? '全部通过' : '存在失败') + '：' + passes + '/' + (passes + failures));
  process.exit(failures === 0 ? 0 : 1);
})();

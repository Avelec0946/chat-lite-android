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

  // 图片：给说明，不塞 base64，也不能让纯文本模型收到数组
  var conv3 = { id: 'c3', rootId: 'r', messageMap: {}, activePath: [] };
  conv3.messageMap = {
    u8: {
      id: 'u8', role: 'user', content: '看这张图',
      files: [{ name: 'shot.png', isImage: true, mimeType: 'image/png', base64: 'AAAA'.repeat(1000) }]
    }
  };
  conv3.activePath = ['u8'];
  var h3 = T.historyMessages(conv3, 8);
  ok('图片只给文字说明，内容类型仍是字符串',
    typeof h3[0].content === 'string' && h3[0].content.indexOf('图片') >= 0, typeof h3[0].content);
  ok('图片的 base64 不进上下文（会撑爆纯文本大脑）',
    h3[0].content.indexOf('AAAA') < 0, h3[0].content.slice(0, 120));

  // assistant 的 files 不该被注入（只有用户消息才代表"挂在上下文里的文件"）
  var conv4 = { id: 'c4', rootId: 'r', messageMap: {}, activePath: [] };
  conv4.messageMap = {
    a7: { id: 'a7', role: 'assistant', content: '给你一个文件', files: [{ name: 'x.md', content: '不应注入' }] }
  };
  conv4.activePath = ['a7'];
  var h4 = T.historyMessages(conv4, 8);
  ok('assistant 的附件不注入', h4[0].content === '给你一个文件', JSON.stringify(h4[0].content));

  // 大文件截断：不能把每轮 prompt 拖到几十万字符
  var big = 'x'.repeat(T.FILE_CLIP_CHARS + 5000);
  var conv5 = { id: 'c5', rootId: 'r', messageMap: {}, activePath: [] };
  conv5.messageMap = {
    u5: { id: 'u5', role: 'user', content: '长文', files: [{ name: 'big.md', content: big }] }
  };
  conv5.activePath = ['u5'];
  var h5 = T.historyMessages(conv5, 8);
  ok('超大附件按 FILE_CLIP_CHARS 截断', h5[0].content.length < T.FILE_CLIP_CHARS + 600,
    String(h5[0].content.length));
  ok('截断处有明确说明（模型知道自己没看全）',
    h5[0].content.indexOf('只带了前') >= 0, h5[0].content.slice(-60));

  // 多文件共享总额度
  var f1 = 'y'.repeat(T.FILE_CLIP_CHARS);
  var conv6 = { id: 'c6', rootId: 'r', messageMap: {}, activePath: [] };
  conv6.messageMap = {
    u6: { id: 'u6', role: 'user', content: '', files: [{ name: 'f1.md', content: f1 }, { name: 'f2.md', content: f1 }] }
  };
  conv6.activePath = ['u6'];
  var h6 = T.historyMessages(conv6, 8);
  ok('多个大文件合计不超过 FILE_TOTAL_CHARS 的量级',
    h6[0].content.length <= T.FILE_TOTAL_CHARS + 500, String(h6[0].content.length));
})();

// =====================================================================================
console.log('\n[5] 附件额度按"从新到旧"分配（正在讨论的那份优先）');
// =====================================================================================
(function () {
  var older = 'OLD'.repeat(Math.floor(T.FILE_CLIP_CHARS / 3) + 10);
  var newer = 'NEW'.repeat(50);
  var conv = { id: 'c7', rootId: 'r', messageMap: {}, activePath: [] };
  conv.messageMap = {
    u1: { id: 'u1', role: 'user', content: '旧文件', files: [{ name: 'old.md', content: older }] },
    a1: { id: 'a1', role: 'assistant', content: '收到' },
    u2: { id: 'u2', role: 'user', content: '新文件', files: [{ name: 'new.md', content: newer }] }
  };
  conv.activePath = ['u1', 'a1', 'u2'];
  var hist = T.historyMessages(conv, 8);
  var joined = hist.map(function (m) { return String(m.content); }).join('\n');
  ok('最新的文件一定完整带上', joined.indexOf(newer) >= 0, joined.length + '');
  ok('旧文件仍在（额度够，不该被丢）', joined.indexOf('OLD') >= 0, joined.length + '');
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
  console.log('\n[6] 整条流水线：并发预取 + 串行播放 + 排空回调');
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

  console.log('\n[7] 中间一句 TTS 失败：跳过它，前后仍按序，且不卡死');
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

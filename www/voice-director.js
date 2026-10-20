// ===== voice-director.js : 语音通话纯函数层（v125）=====
// 模块名：voice-director.js
// 版本：v125（cache-bust，对应 index.html 里的 voice-director.js?v=125）
// 职责（契约 voice-模块-架构契约.md §3.5）：
//   1) PERSONAS            人设预设
//   2) buildSystemPrompt   给"大脑"的系统提示词（含声音状态用途说明）
//   3) buildTurnMessages   每轮 messages 组装（system + 最近 N 轮，长度受控）
//   4) describeSignals     声音状态 → 给 LLM 看的中文自然语言
//   5) describeSignalsForBubble  声音状态 → 给人看的短标签串
//   6) renderPerformance   {emotion,tone,pace,volume,nonverbals} → TTS 表演提示括注
//   7) parseDirective      解析模型输出（极度容错）
//   8) extractSpeechPartial 流式半截 JSON 里抠 speech（voice-core 增量合成用）
//   9) firstSentences      把已流出的文本切句（逐句合成用）
//  10) sanitizeForTTS      朗读前清洗（markdown / emoji / URL / 多余空白）
//  11) turnPolicy          轮次判定纯函数（yield / wait / continue）
//  12) buildFillerPlan     冷场补白色候选
//  13) buildCallLayer      通话层提示词（会话人设之上的「电话信道」约束）
//  14) describeClock       时间感知（几点 / 隔了多久 / 通话多久）
//  15) buildCallMarker     通话开始 / 结束的系统标记
//  16) resolveTuning       双套微调预设的合并（覆盖 + 非法忽略）
//  17) describeRate        语速倍率 → 中文描述
//
// 设计约束：
//   · 全部纯函数：无 DOM、无网络、无定时器 —— 所以能在 node 里直接 eval 出来跑单测
//   · UMD：浏览器挂 window.VoiceDirector，node 挂 globalThis.VoiceDirector
//   · 代码风格与仓库其它模块一致：var + function 声明，不用 ESM / 不用框架
//
// 为什么"表演提示"是核心：MiMo TTS 会把 （括注） 吃掉不念，但会改变音频
//   （契约 §1.1 实测：振幅 RMS 4692→2958、时长 2.28s→3.04s）。
//   所以情绪控制的主通道 = renderPerformance 生成的那个中文括注。
//
// 注意：本文件里不写裸反引号，一律用 \u0060 转义——避免和 markdown 代码块围栏混淆。

(function (root) {
  'use strict';

  var VERSION = '125';

  // ============================================================
  // 0. 通用小工具（全部防御式：null / undefined / NaN 不许让上层崩）
  // ============================================================

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  function str(x) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    return '';
  }

  function num(x, dflt) {
    var d = (dflt === undefined) ? NaN : dflt;
    if (x === null || x === undefined || x === '' || x === true || x === false) return d;
    var n = Number(x);
    return isFinite(n) ? n : d;
  }

  function hasNum(x) { return isFinite(num(x, NaN)); }

  function clampNum(x, lo, hi, dflt) {
    var n = num(x, NaN);
    if (!isFinite(n)) n = num(dflt, NaN);
    if (!isFinite(n)) n = lo;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function boolish(x, dflt) {
    if (x === true || x === false) return x;
    if (x === null || x === undefined || x === '') return dflt;
    var s = str(x).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === '是' || s === '对') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === '否' || s === '不') return false;
    return dflt;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function safeStringify(x) {
    try { return JSON.stringify(x); } catch (e) { return ''; }
  }

  function fmtSec(ms) {
    var s = num(ms, 0) / 1000;
    if (s < 0) s = 0;
    if (s >= 10) return String(Math.round(s));
    return String(round1(s));
  }

  function truncate(s, max) {
    s = str(s);
    var m = Math.floor(num(max, 0));
    if (!m || m <= 0 || s.length <= m) return s;
    return s.slice(0, Math.max(1, m - 1)) + '…';
  }

  // 把多行/多空白压成一行（history 用，不改变语义）
  function squash(s) {
    return str(s).replace(/\s+/g, ' ').trim();
  }

  // ============================================================
  // 1. PERSONAS —— 人设预设
  //    fix: voice-settings.js 直接拿 id / name 渲染下拉，desc 用于说明，
  //    systemFlavor 拼进系统提示词，fillers 是冷场补白候选。
  // ============================================================

  var PERSONAS = [
    {
      id: 'warm',
      name: '温暖陪伴',
      desc: '像老朋友一样耐心，先接住情绪再说事；声音软、语速偏慢，不急着给建议。',
      systemFlavor: '你是个很会听人说话的朋友。你不急着解决问题，先把对方的情绪接住：' +
        '对方难过的时候你声音会低下来、语气变软；对方说开心的事，你会跟着一起高兴。' +
        '你说话不急，中间会留一点沉默，常用「嗯」「我在听」「然后呢」表示你在。' +
        '你会记得这通电话前面聊过什么，自然地带回来一句，而不是复述。',
      pace: 'slow',
      tone: '温柔',
      volume: '中',
      emotion: '平静',
      fillers: ['嗯……', '嗯，我在听', '让我想想啊', '嗯……我慢慢说']
    },
    {
      id: 'bright',
      name: '元气伙伴',
      desc: '话头快、情绪亮，爱接梗也爱追问，像随时充满电的朋友。',
      systemFlavor: '你是个精力旺盛、说话带劲的朋友。你反应快、爱追问、爱接梗，' +
        '经常冒出「诶？」「真的假的」「然后呢然后呢」这种反应。' +
        '你高兴起来语速会变快、音调会扬上去，但你也懂分寸：对方一低落，你立刻收住，先陪着。' +
        '你不说教，也不给人生指南，你更愿意一起吐槽、一起去想办法。',
      pace: 'fast',
      tone: '轻快',
      volume: '中',
      emotion: '开心',
      fillers: ['诶，等等我', '唔——我想想', '嘿，这个我懂一点', '啊，让我捋捋']
    },
    {
      id: 'calm',
      name: '沉稳顾问',
      desc: '不慌不忙、句子短而准，先问清楚再给判断，像个靠得住的年长朋友。',
      systemFlavor: '你是个沉稳、可靠、见过事的人。你说话不快，句子短而准，' +
        '不轻易下结论：先把情况问清楚（「现在最卡的是哪一步」），再给一句话的判断。' +
        '你不打鸡血，也不吓唬人；对方慌的时候你先把他稳住。' +
        '你会承认自己不确定（「这个我不太懂」），但会给一个能立刻试的小办法。',
      pace: 'normal',
      tone: '沉稳',
      volume: '中',
      emotion: '平静',
      fillers: ['让我想想', '嗯，稍等', '这个得捋一下', '我想一下再说']
    },
    {
      id: 'tease',
      name: '俏皮损友',
      desc: '嘴上不饶人、心里在乎你，爱调侃也爱拆台，但从不真伤人。',
      systemFlavor: '你是个嘴上不饶人但心里很在乎对方的朋友。你爱调侃、爱拆台、' +
        '爱说「哟」「行吧你」「我早说了吧」，但你会看火候：对方真的难受了，你立刻收住玩笑，' +
        '用你自己的方式认真一句（「行了，说正经的」）。' +
        '你从不给对方灌鸡汤，你更擅长用半句玩笑把人逗松一点。',
      pace: 'fast',
      tone: '调侃',
      volume: '中',
      emotion: '愉快',
      fillers: ['哟，让我琢磨琢磨', '啧，这问题有点意思', '等等啊，我先捋捋', '嗯……你让我想想']
    },
    {
      id: 'custom',
      name: '自定义',
      desc: '自己写人设：在设置里填「额外人设补充」，其余按最自然的说话方式来。',
      systemFlavor: '你是一个说话自然、反应真实的普通人。你不表演、不用力过猛，' +
        '像跟熟人打电话那样说话：想到哪说到哪，但会照顾对方的节奏。' +
        '对方说什么你就接什么，不端着，也不油腻。',
      pace: 'normal',
      tone: '自然',
      volume: '中',
      emotion: '平静',
      fillers: ['嗯……', '让我想想', '嗯，等一下', '我想想怎么说']
    }
  ];

  var DEFAULT_FILLERS = ['嗯……', '让我想想', '嗯，我理一下', '等等啊'];

  function getPersona(ref) {
    var id = ref;
    if (isObj(ref)) id = ref.id;
    var key = str(id);
    for (var i = 0; i < PERSONAS.length; i++) {
      if (PERSONAS[i].id === key) return PERSONAS[i];
    }
    if (isObj(ref) && (ref.systemFlavor || ref.name)) {
      // 外部传入的临时人设对象：补齐缺省字段后直接用
      return {
        id: str(ref.id) || 'custom',
        name: str(ref.name) || '自定义',
        desc: str(ref.desc),
        systemFlavor: str(ref.systemFlavor),
        pace: ref.pace || 'normal',
        tone: ref.tone || '自然',
        volume: ref.volume || '中',
        emotion: ref.emotion || '平静',
        fillers: Array.isArray(ref.fillers) && ref.fillers.length ? ref.fillers : DEFAULT_FILLERS
      };
    }
    return PERSONAS[0];
  }

  // ============================================================
  // 2. 语速 / 音量 / 话量档位的归一化
  // ============================================================

  // v125 修（QA 发现）：气泡标签的分隔符此前只在这里写死 ' · '，
  //   而 voice.js 的 renderSignals 按 、,，/ 拆 —— 两侧约定不一致，4 个标签被塞进 1 个胶囊。
  //   现在导出成常量，消费侧引用 VoiceDirector.SIGNAL_SEP，改一处就够。
  var SIGNAL_SEP = ' · ';

  var PACE_WORDS = { slow: '语速偏慢', normal: '语速适中', fast: '语速偏快' };
  var PACE_CN = { slow: '偏慢', normal: '适中', fast: '偏快' };
  var VOLUME_CN = { '低': '偏低', '中': '中等', '高': '偏高' };

  // pace 既可能是 'slow' 这种枚举，也可能是模型吐的 0.9 —— 都吃
  function normalizePace(p, fallback) {
    var fb = fallback === undefined ? 'normal' : fallback;
    if (typeof p === 'number' && isFinite(p)) {
      if (p <= 0.85) return 'slow';
      if (p >= 1.12) return 'fast';
      return 'normal';
    }
    var s = str(p).toLowerCase();
    if (!s) return fb;
    if (s === 'slow' || s === 'slower' || s === 'lazy' || s.indexOf('慢') >= 0 || s.indexOf('缓') >= 0) return 'slow';
    if (s === 'fast' || s === 'faster' || s === 'quick' || s.indexOf('快') >= 0 || s.indexOf('急') >= 0) return 'fast';
    if (s === 'normal' || s === 'mid' || s === 'medium' || s.indexOf('正常') >= 0 || s.indexOf('适中') >= 0) return 'normal';
    return fb;
  }

  // volume 归一化成 低 / 中 / 高
  function normalizeVolume(v, fallback) {
    var fb = fallback === undefined ? '中' : fallback;
    if (typeof v === 'number' && isFinite(v)) {
      if (v <= 0.35) return '低';
      if (v >= 0.7) return '高';
      return '中';
    }
    var s = str(v).toLowerCase();
    if (!s) return fb;
    if (s.indexOf('高') >= 0 || s.indexOf('大') >= 0 || s === 'loud' || s === 'high') return '高';
    if (s.indexOf('低') >= 0 || s.indexOf('轻') >= 0 || s.indexOf('小') >= 0 || s === 'low' || s === 'soft' || s === 'quiet') return '低';
    if (s.indexOf('中') >= 0 || s === 'mid' || s === 'normal') return '中';
    return fb;
  }

  var BREVITY_MODES = {
    short: {
      id: 'short', label: '简短', sentences: '1~2 句', chars: '8~35 字',
      note: '宁可少说，把说话的机会留给对方。'
    },
    normal: {
      id: 'normal', label: '正常', sentences: '2~3 句', chars: '20~70 字',
      note: '正常聊天的量，重点讲完就收。'
    },
    chatty: {
      id: 'chatty', label: '话多一点', sentences: '3~4 句', chars: '50~120 字',
      note: '可以多说一点，但仍然是口语，而且每讲一小段都要给对方留话头。'
    }
  };

  function normalizeBrevity(x) {
    var s = str(x).toLowerCase();
    if (!s) return 'short';
    if (s === 'short' || s === 'brief' || s === 'concise' || s === '简短' || s === '短') return 'short';
    if (s === 'chatty' || s === 'long' || s === 'more' || s === '话多' || s === '多') return 'chatty';
    if (s === 'normal' || s === 'default' || s === '正常') return 'normal';
    return 'short';
  }

  // ============================================================
  // 3. 声音状态（VOICE_SIGNALS）的分档
  //    中文正常语速约 4~5 字/秒；低于 3.2 偏慢、高于 4.6 偏快。
  // ============================================================

  var RATE_SLOW = 3.2;
  var RATE_FAST = 4.6;

  function rateKey(cps) {
    var n = num(cps, NaN);
    if (!isFinite(n) || n <= 0) return '';
    if (n < RATE_SLOW) return 'slow';
    if (n > RATE_FAST) return 'fast';
    return 'normal';
  }

  function loudKey(s) {
    var src = isObj(s) ? s : {};
    var l = str(src.loudness).toLowerCase();
    if (l) {
      if (l.indexOf('高') >= 0 || l.indexOf('大') >= 0 || l === 'high' || l === 'loud') return 'high';
      if (l.indexOf('低') >= 0 || l.indexOf('小') >= 0 || l.indexOf('轻') >= 0 || l === 'low' || l === 'quiet') return 'low';
      if (l.indexOf('中') >= 0 || l === 'mid' || l === 'normal') return 'mid';
    }
    var rms = num(src.rmsMean, NaN);
    if (isFinite(rms)) {
      if (rms < 0.08) return 'low';
      if (rms > 0.20) return 'high';
      return 'mid';
    }
    return '';
  }

  function longestPauseMs(signals) {
    var arr = isObj(signals) && Array.isArray(signals.pauses) ? signals.pauses : null;
    if (!arr) return 0;
    var max = 0;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      var ms = isObj(p) ? num(p.ms, 0) : num(p, 0);
      if (isFinite(ms) && ms > max) max = ms;
    }
    return max;
  }

  function countLongPauses(signals) {
    var s = isObj(signals) ? signals : {};
    var declared = num(s.longPauseCount, NaN);
    if (isFinite(declared) && declared >= 0) return declared;
    var arr = Array.isArray(s.pauses) ? s.pauses : null;
    if (!arr) return NaN;
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      var ms = isObj(p) ? num(p.ms, 0) : num(p, 0);
      if (isFinite(ms) && ms > 500) n++;
    }
    return n;
  }

  // 情绪推断：至少要 2 个维度有值才下结论，避免"瞎猜"
  function inferMood(x) {
    var hot = 0, low = 0, known = 0;
    if (x.hasRate) {
      known++;
      if (x.rate === 'fast') hot++;
      else if (x.rate === 'slow') low++;
    }
    if (x.hasLoud) {
      known++;
      if (x.loud === 'high') hot++;
      else if (x.loud === 'low') low++;
    }
    if (hasNum(x.pitchRange) && num(x.pitchRange, 0) > 0) {
      known++;
      if (num(x.pitchRange, 0) >= 5) hot++;
      else if (num(x.pitchRange, 0) < 1.6) low++;
    } else if (hasNum(x.pitchStd) && num(x.pitchStd, 0) > 0) {
      known++;
      if (num(x.pitchStd, 0) >= 45) hot++;
      else if (num(x.pitchStd, 0) < 10) low++;
    }
    if (known < 2) return '';
    if (hot >= 2 && hot > low) return 'hot';
    if (low >= 2 && low > hot) return 'low';
    if (hot === 0 && low === 0) return 'calm';
    return '';
  }

  // ============================================================
  // 4. describeSignals —— 声音状态 → 给 LLM 看的中文自然语言
  //    要求：像人在描述"对方刚才怎么说的"，不是字段罗列；小信号不要硬塞。
  // ============================================================

  function describeSignals(signals, opts) {
    var s = isObj(signals) ? signals : {};
    var o = isObj(opts) ? opts : {};
    var maxClauses = clampNum(o.maxClauses, 2, 10, 7);

    var speechMs = num(s.speechMs, NaN);
    var totalMs = num(s.totalMs, NaN);
    var durMs = (isFinite(speechMs) && speechMs > 0)
      ? speechMs
      : ((isFinite(totalMs) && totalMs > 0) ? totalMs : NaN);
    var hasUtterance = isFinite(durMs) && durMs >= 200;

    var cps = num(s.speechRateCps, NaN);
    var rk = rateKey(cps);
    var lk = loudKey(s);
    var pitchRange = num(s.pitchRangeSemitone, NaN);
    var pitchStd = num(s.pitchStdHz, NaN);
    var longPauses = countLongPauses(s);
    var ratio = num(s.speechRatio, NaN);

    var body = [];

    // (1) 时长
    if (hasUtterance) body.push('对方这句话说了 ' + fmtSec(durMs) + ' 秒');

    // (2) 语速（要拿到转写文本才有，没给就不瞎猜）
    if (rk === 'fast') body.push('语速偏快（约 ' + round1(cps) + ' 字/秒）');
    else if (rk === 'slow') body.push('语速偏慢（约 ' + round1(cps) + ' 字/秒）');
    else if (rk === 'normal') body.push('语速正常（约 ' + round1(cps) + ' 字/秒）');

    // (3) 音量
    if (lk === 'high') body.push('音量偏高');
    else if (lk === 'low') body.push('音量偏低');
    else if (lk === 'mid' && o.verbose) body.push('音量中等');

    // (4) 音高起伏：只在"明显"时描述，平静语调交给后面的情绪结论
    if (o.includePitch !== false) {
      if (isFinite(pitchRange) && pitchRange > 0) {
        if (pitchRange >= 7) body.push('音高起伏很大');
        else if (pitchRange >= 4) body.push('音高起伏较大');
        else if (pitchRange < 1.6) body.push('语调很平，几乎没什么起伏');
      } else if (isFinite(pitchStd) && pitchStd > 0) {
        if (pitchStd >= 45) body.push('音高起伏很大');
        else if (pitchStd >= 22) body.push('音高起伏较大');
        else if (pitchStd < 10) body.push('语调很平，几乎没什么起伏');
      }
    }

    // (5) 停顿
    if (hasUtterance) {
      if (isFinite(longPauses) && longPauses > 0) {
        var longest = longestPauseMs(s);
        body.push('中间停顿了 ' + Math.round(longPauses) + ' 次' +
          (longest > 0 ? '（最长约 ' + fmtSec(longest) + ' 秒）' : ''));
      } else if (isFinite(ratio) && ratio >= 0.78) {
        body.push('中间几乎没有停顿');
      } else if (isFinite(ratio) && ratio < 0.55) {
        body.push('断断续续的');
      }
    }

    // (6) 情绪综合结论
    var mood = inferMood({ rate: rk, loud: lk, hasRate: !!rk, hasLoud: !!lk, pitchRange: pitchRange, pitchStd: pitchStd });
    if (mood === 'hot') body.push('听起来情绪比较激动');
    else if (mood === 'low') body.push('听起来有点低落');
    else if (mood === 'calm' && o.includeCalm) body.push('听上去挺平静的');

    // (7) 句尾（单独一句，和正文分开）
    var tail = [];
    if (hasUtterance && o.includeTail !== false) {
      if (s.trailingOff === true) tail.push('句尾声音弱下去，像是没说完，或者有点泄气');
      else if (s.trailingOff === false) tail.push('句尾音量没有减弱');
    }

    // (8) 录音环境：只在会误解码的程度上说
    var env = [];
    if (hasUtterance && o.includeEnv !== false) {
      var snr = num(s.snrDb, NaN);
      if (s.clipping === true) env.push('录音里有爆音，可能有字没听准');
      else if (isFinite(snr) && snr > 0 && snr < 12) env.push('背景有点吵');
      var onset = num(s.onsetDelayMs, NaN);
      if (isFinite(onset) && onset > 1500) env.push('开口前沉默了一会儿');
    }

    if (!body.length && !tail.length && !env.length) return '';

    var text = '';
    var main = body.slice(0, maxClauses);
    if (main.length) text += main.join('，') + '。';
    var rest = tail.concat(env);
    if (rest.length) text += rest.join('，') + '。';
    return text;
  }

  // 这一组信号里是否至少有一项可用（用来替代「必须有时长」的一刀切守卫）
  function hasAnySignal(s) {
    if (!isObj(s)) return false;
    var speechMs = num(s.speechMs, NaN);
    var totalMs = num(s.totalMs, NaN);
    if (isFinite(speechMs) && speechMs > 0) return true;
    if (isFinite(totalMs) && totalMs > 0) return true;
    if (isFinite(num(s.speechRateCps, NaN)) && num(s.speechRateCps, 0) > 0) return true;
    if (str(s.loudness)) return true;
    if (isFinite(num(s.rmsMean, NaN))) return true;
    if (isFinite(num(s.pitchRangeSemitone, NaN)) && num(s.pitchRangeSemitone, 0) > 0) return true;
    if (isFinite(num(s.pitchStdHz, NaN)) && num(s.pitchStdHz, 0) > 0) return true;
    if (isFinite(num(s.longPauseCount, NaN)) && num(s.longPauseCount, -1) >= 0) return true;
    if (Array.isArray(s.pauses) && s.pauses.length) return true;
    if (s.trailingOff === true || s.clipping === true) return true;
    if (isFinite(num(s.snrDb, NaN)) && num(s.snrDb, 999) < 12) return true;
    return false;
  }

  // 声音状态 → 给人看的短标签串，如「语速偏快 · 音量偏高 · 情绪偏高」
  function describeSignalsForBubble(signals, opts) {
    var s = isObj(signals) ? signals : {};
    var o = isObj(opts) ? opts : {};
    var cap = clampNum(o.maxLabels, 1, 8, 4);

    // 守卫：只要任何一个维度可用就该出标签。
    //   早先这里是「必须有时长才显示」，结果 voice.js 在 speechMs 还没落定、
    //   但速录/音量已经算出来的瞬间会拿到空串，气泡整段消失（Lead 实测）。
    if (!hasAnySignal(s)) return '';

    var labels = [];
    var cps = num(s.speechRateCps, NaN);
    var rk = rateKey(cps);
    if (rk === 'fast') labels.push('语速偏快');
    else if (rk === 'slow') labels.push('语速偏慢');
    else if (rk === 'normal') labels.push('语速适中');

    var lk = loudKey(s);
    if (lk === 'high') labels.push('音量偏高');
    else if (lk === 'low') labels.push('音量偏低');
    else if (lk === 'mid') labels.push('音量适中');

    var pitchRange = num(s.pitchRangeSemitone, NaN);
    var pitchStd = num(s.pitchStdHz, NaN);
    var pr = isFinite(pitchRange) && pitchRange > 0 ? pitchRange : (isFinite(pitchStd) && pitchStd > 0 ? pitchStd / 6 : NaN);

    var mood = inferMood({ rate: rk, loud: lk, hasRate: !!rk, hasLoud: !!lk, pitchRange: pitchRange, pitchStd: pitchStd });
    if (mood === 'hot') labels.push('情绪偏高');
    else if (mood === 'low') labels.push('情绪偏低');
    else if (mood === 'calm') labels.push('情绪平稳');

    if (isFinite(pr)) {
      if (pr >= 4) labels.push('语调起伏大');
      else if (pr < 1.6) labels.push('语调很平');
    }

    var lp = countLongPauses(s);
    if (isFinite(lp) && lp >= 2) labels.push('停顿多');
    else {
      var ratio = num(s.speechRatio, NaN);
      if (isFinite(ratio) && ratio >= 0.92) labels.push('几乎不换气');
    }

    if (s.trailingOff === true) labels.push('尾音发虚');
    if (s.clipping === true) labels.push('有爆音');
    else {
      var snr = num(s.snrDb, NaN);
      if (isFinite(snr) && snr > 0 && snr < 12) labels.push('环境嘈杂');
    }

    return labels.slice(0, cap).join(SIGNAL_SEP);
  }

  // 由信号给出这一轮的"怎么应对"提示（拼进系统提示词）
  function signalHints(signals) {
    if (!isObj(signals)) return [];
    var s = signals;
    var out = [];
    var rk = rateKey(num(s.speechRateCps, NaN));
    var lk = loudKey(s);
    var pr = num(s.pitchRangeSemitone, NaN);
    if (rk === 'fast' || lk === 'high' || (isFinite(pr) && pr >= 6)) {
      out.push('对方说得又快又冲：这一句要短（一到两句），先接住情绪，别给建议、别抢话。');
    } else if (rk === 'slow' || (isFinite(pr) && pr > 0 && pr < 2)) {
      out.push('对方说得慢、起伏也小：可能是累了或在斟酌，句子更短更轻，别催。');
    }
    if (s.trailingOff === true) {
      out.push('句尾掉下去了：先接一句软的（「嗯？」「怎么了」），别急着推进话题。');
    }
    var snr = num(s.snrDb, NaN);
    if (s.clipping === true || (isFinite(snr) && snr > 0 && snr < 12)) {
      out.push('录音质量一般：可能听错字，不确定就问一句，不要硬猜。');
    }
    var lp = countLongPauses(s);
    if (isFinite(lp) && lp >= 2) {
      out.push('中间停顿多，对方是边想边说：顺着他的节奏走，不要抢。');
    }
    return out.slice(0, 3);
  }

  // ============================================================
  // 5. buildSystemPrompt —— 给"大脑"的系统提示词
  //    opts: { personaId|persona, customPersona, brevity,
  //            signals | signalsText, extraRules, userName }
  // ============================================================

  function buildSystemPrompt(opts) {
    var o = isObj(opts) ? opts : {};
    var pref = (o.personaId !== undefined && o.personaId !== null && o.personaId !== '')
      ? o.personaId
      : (o.persona || 'warm');
    var persona = getPersona(pref);
    var brevity = normalizeBrevity(o.brevity);
    var b = BREVITY_MODES[brevity] || BREVITY_MODES.short;
    var L = [];

    L.push('你在打电话，不是在发消息。');
    L.push('对方只能听到你的声音，看不到任何文字；你说的每一句话都会被直接念出来。');
    L.push('所以：说人话，说短句，像一个真人正拿着手机跟对方讲话。');

    L.push('');
    L.push('【怎么说话】');
    L.push('1. 一次只说 ' + b.sentences + '，一共 ' + b.chars + '，说完就停，把话头交给对方。不要一口气讲完。');
    L.push('2. 用口语：短句，语气词开头（嗯、唉、啊、我说、那个），可以用口头禅、可以用反问。');
    L.push('3. 允许不完美：可以有停顿、重复、说一半改口（「不对，应该说……」「我是说……」）。真人就是这么说话的。');
    L.push('4. 先接住情绪，再给内容。对方在抱怨，就先接一句「这么累啊」，别急着讲道理、别急着给方案。');
    L.push('5. 对方话没说完、意思含糊，就追问一句，不要硬答。');
    L.push('6. 没听清就说没听清，让对方再说一遍——打电话时这很正常。');
    L.push('7. ' + b.note);

    L.push('');
    L.push('【绝对不要】');
    L.push('· 不要 Markdown：不要 **加粗**、不要 # 标题、不要反引号代码、不要列表、不要编号、不要表格、不要分隔线。');
    L.push('· 不要 emoji、表情符号、颜文字、ASCII 表情（:) 这种）。');
    L.push('· 不要在 speech 里写舞台说明或动作（*叹气*、（停顿）），情绪用 tone / pace / volume 字段表达。');
    L.push('· 不要书面语套话：不要「首先 / 其次 / 最后」「总的来说」「综上所述」「值得一提的是」「希望对你有帮助」。');
    L.push('· 不要在 speech 里用分号；不要用括号做补充说明；不要用书名号去引用别的东西。');
    L.push('· 不要客服腔复述对方（「你说你……，我理解你的感受」）。');
    L.push('· 不要一次说三句以上，不要分点讲道理，不要总结要点。');

    L.push('');
    L.push('【声音状态怎么用】');
    L.push('每轮我会给你一段「声音状态」，写的是对方这句话是怎么说出来的（多快、多大声、音高起伏、停顿、句尾有没有掉下去）。');
    L.push('它不是台词，是线索：');
    L.push('· 语速偏快、音量偏高、音高起伏大 → 对方情绪上头：你回得更短、更稳，先给空间，别抢话、别讲道理。');
    L.push('· 语速偏慢、停顿多 → 对方在斟酌或者情绪低：别催，句子更短更轻，可以留一点沉默。');
    L.push('· 句尾声音弱下去 → 可能没说完，也可能是泄气：先接一句软的（「嗯？」「怎么了」）。');
    L.push('· 背景吵、有爆音、听不清 → 可能转写错了字：不确定就问一句，不要硬猜。');
    L.push('· 全程平平淡淡 → 对方就是随口聊，你轻松接住就行，不用刻意煽情。');
    L.push('不要把这些特征说出来（别说「你刚才语速很快」），把它变成你说话的方式和长度。');

    var sigText = str(o.signalsText);
    if (!sigText && isObj(o.signals)) sigText = describeSignals(o.signals, o.signalOpts);
    if (sigText) {
      L.push('');
      L.push('【对方这一段的声音状态】');
      L.push(sigText);
      var hints = signalHints(o.signals);
      if (hints.length) {
        L.push('这一轮请这样处理：');
        for (var h = 0; h < hints.length; h++) L.push('· ' + hints[h]);
      }
    }

    L.push('');
    L.push('【你的人格：' + (str(persona.name) || str(persona.id) || '温暖陪伴') + '】');
    if (str(persona.systemFlavor)) L.push(str(persona.systemFlavor));
    L.push('默认说话感觉：' + (str(persona.tone) || '自然') +
      '，语速' + PACE_CN[normalizePace(persona.pace, 'normal')] +
      '，音量' + VOLUME_CN[normalizeVolume(persona.volume, '中')] + '。');
    L.push('除非这一句的情绪明显不同，否则就照这个默认感觉说。');

    var custom = str(o.customPersona);
    if (custom) {
      L.push('');
      L.push('【额外设定（优先于上面的人格描述，但不能违反「口语、短句、不念格式」这些硬规则）】');
      L.push(custom);
    }

    var extra = str(o.extraRules);
    if (extra) {
      L.push('');
      L.push('【补充规则】');
      L.push(extra);
    }

    L.push('');
    L.push('【输出格式（必须严格遵守）】');
    L.push('只输出一个 JSON 对象。不要解释、不要代码块围栏、不要任何前后缀文字。');
    L.push('字段顺序固定：speech 必须排第一个，其余按下面的顺序。必须写成单行、紧凑，不能换行、不能缩进。');
    L.push('{"speech":"你要说出口的话","emotion":"平静","tone":"温柔","pace":"normal","volume":"中","nonverbals":[],"expectUser":true,"shouldYield":true}');
    L.push('');
    L.push('字段含义：');
    L.push('· speech：你要说出口的话，纯口语，1~2 句；里面不要再套引号。');
    L.push('· emotion：对方此刻的情绪底色，1~3 字（平静 / 疲惫 / 烦躁 / 开心 / 低落 / 紧张 / 兴奋）。');
    L.push('· tone：你这句话的语气，2~4 字（温柔 / 调侃 / 认真 / 无奈 / 心疼 / 轻松 / 兴奋）。');
    L.push('· pace：语速，只能是 slow / normal / fast 三个值之一。');
    L.push('· volume：音量，只能是 低 / 中 / 高 三个值之一。');
    L.push('· nonverbals：非语言标记，0~2 个字符串，如 ["轻笑"]、["叹气"]、["压低声音"]，没有就 []。');
    L.push('· expectUser：这句话说完你在等对方接话，就填 true。');
    L.push('· shouldYield：说完就把话头交回去，就填 true（几乎总是 true）。');

    L.push('');
    L.push('再强调一次：单行紧凑 JSON，speech 在最前面，不要换行、不要缩进、不要代码块。例如：');
    L.push('{"speech":"啊？我说错啥了，你别光笑啊，快告诉我。","emotion":"好奇","tone":"俏皮","pace":"fast","volume":"中","nonverbals":["轻笑"],"expectUser":true,"shouldYield":true}');

    return L.join('\n');
  }

  // ============================================================
  // 6. buildTurnMessages —— system + 最近 N 轮历史 + 本轮用户话
  // ============================================================

  function normalizeRole(r) {
    var s = str(r).toLowerCase();
    if (s === 'user' || s === 'human' || s === '对方' || s === '用户') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'bot' || s === 'model' || s === '助手') return 'assistant';
    return '';
  }

  function buildTurnMessages(opts) {
    var o = isObj(opts) ? opts : {};
    var maxTurns = clampNum(o.maxTurns, 1, 40, 6);
    var maxChars = clampNum(o.maxCharsPerMsg, 30, 4000, 180);

    var out = [];
    var system = str(o.system);
    if (!system) system = buildSystemPrompt(o);
    out.push({ role: 'system', content: system });

    var history = Array.isArray(o.history) ? o.history : (Array.isArray(o.turns) ? o.turns : []);
    var cleaned = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if (!m) continue;
      var role = normalizeRole(isObj(m) ? m.role : '');
      if (!role) continue;   // 历史里混进来的 system / 工具消息一律丢弃
      var raw = isObj(m) ? (m.content !== undefined ? m.content : m.text) : m;
      if (Array.isArray(raw)) raw = raw.join(' ');
      var content = truncate(squash(raw), maxChars);
      if (!content) continue;
      cleaned.push({ role: role, content: content });
    }

    // 只取最近 maxTurns 轮（一轮 = user + assistant）
    var keep = maxTurns * 2;
    if (cleaned.length > keep) cleaned = cleaned.slice(cleaned.length - keep);
    // 半截历史会让模型错位：必须从 user 开始
    while (cleaned.length && cleaned[0].role !== 'user') cleaned.shift();

    out = out.concat(cleaned);

    var userText = str(o.userText !== undefined ? o.userText : o.text);
    if (userText) {
      out.push({ role: 'user', content: truncate(squash(userText), maxChars) });
    }
    return out;
  }

  // ============================================================
  // 7. renderPerformance —— 表演提示括注（TTS 吃掉不念，但改变声音）
  // ============================================================

  var NONVERBAL_MAP = {
    '笑': '带着笑意', '轻笑': '带着笑意', '微笑': '带着笑意', '苦笑': '苦笑着', '大笑': '笑着说',
    'laugh': '带着笑意', 'smile': '带着笑意',
    '叹气': '轻轻叹了口气', 'sigh': '轻轻叹了口气',
    '停顿': '略一停顿', 'pause': '略一停顿', '思考': '略一沉吟', '犹豫': '有点犹豫',
    'hesitate': '有点犹豫',
    '低声': '压低声音', '压低声音': '压低声音', 'whisper': '压低声音',
    '呼吸': '轻轻换了口气', 'breath': '轻轻换了口气',
    '哽咽': '声音有点哑', '无奈': '无奈地', '认真': '认真地'
  };

  function cleanTone(x) {
    var s = str(x).replace(/<[^>]*>/g, ' ');
    s = s.replace(/[\s"'“”‘’\u0060，。！？、；：,.!?;:()（）\[\]【】~～…—－-]/g, '');
    if (!s) return '';
    if (/^(无|空|正常|普通|neutral|none|null|undefined)$/i.test(s)) return '';
    if (s.length > 6) s = s.slice(0, 6);
    return s;
  }

  function normalizeList(x, max) {
    var out = [];
    var cap = Math.floor(num(max, 4));
    if (!isFinite(cap) || cap <= 0) cap = 4;
    if (Array.isArray(x)) {
      for (var i = 0; i < x.length && out.length < cap; i++) {
        var v = cleanTone(x[i]);
        if (v) out.push(v);
      }
      return out;
    }
    var s = str(x).trim();
    if (!s) return out;
    if (s.charAt(0) === '[') {
      var parsed = safeParse(s);
      if (Array.isArray(parsed)) return normalizeList(parsed, cap);
    }
    var parts = s.split(/[,，、;；\|\/]+/);
    for (var j = 0; j < parts.length && out.length < cap; j++) {
      var p = cleanTone(parts[j]);
      if (p) out.push(p);
    }
    return out;
  }

  function renderPerformance(plan, opts) {
    var p = isObj(plan) ? plan : {};
    var o = isObj(opts) ? opts : {};
    var speech = str(p.speech !== undefined ? p.speech : p.text);
    if (!speech || !speech.trim()) return '';

    var parts = [];

    var tone = cleanTone(p.tone);
    var mood = cleanTone(p.emotion);
    if (tone) parts.push(/[地]$/.test(tone) ? tone : tone + '地');
    else if (mood && o.useEmotion !== false) parts.push(/[地]$/.test(mood) ? mood : mood + '地');

    var paceKey = normalizePace(p.pace, '');
    if (paceKey === 'slow' || paceKey === 'fast') parts.push(PACE_WORDS[paceKey]);
    else if (paceKey === 'normal' && o.verbose) parts.push(PACE_WORDS.normal);

    var volKey = normalizeVolume(p.volume, '');
    if (volKey === '高') parts.push('音量偏高');
    else if (volKey === '低') parts.push('音量偏低');
    else if (volKey === '中' && o.verbose) parts.push('音量适中');

    var nvArr = normalizeList(p.nonverbals !== undefined ? p.nonverbals : p.markers, 2);
    for (var i = 0; i < nvArr.length; i++) {
      var phrase = NONVERBAL_MAP[nvArr[i]] || nvArr[i];
      if (phrase) parts.push(phrase);
    }

    if (!parts.length) return speech;
    return '（' + parts.join('，') + '）' + speech;
  }

  // ============================================================
  // 8. sanitizeForTTS —— 朗读前清洗
  //    保留中文标点、保留中文括注（TTS 拿它当表演提示），删掉念出来会奇怪的东西。
  // ============================================================

  var EMOJI_RE = /[\u2190-\u21FF\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE0E\uFE0F\u200D\u20E3\u2049\u2122\u3030\u303D\u3297\u3299]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

  function sanitizeForTTS(text) {
    var s = str(text);
    if (!s) return '';

    s = s.replace(/\r\n?/g, '\n');

    // 行内代码块 → 丢弃整段代码（念代码没意义）
    s = s.replace(/\u0060{3}[\s\S]*?\u0060{3}/g, ' ');
    s = s.replace(/\u0060{3}[^\n]*$/g, ' ');
    s = s.replace(/\u0060([^\u0060]*)\u0060/g, '$1');

    // 图片（多半是表情包）丢弃；链接保留文字
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

    // 裸 URL / 邮箱
    s = s.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s，。；！？、）)]+/gi, ' ');
    s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ');

    // 行首 markdown 标记
    s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '');
    s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
    s = s.replace(/^[ \t]{0,3}(?:[-*+•·])[ \t]+/gm, '');
    s = s.replace(/^[ \t]{0,3}\d{1,2}[.)、][ \t]+/gm, '');
    s = s.replace(/^[ \t]{0,3}(?:-{3,}|={3,}|\*{3,})[ \t]*$/gm, ' ');

    // 强调记号
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');
    s = s.replace(/\*([^*\n]{1,80})\*/g, '$1');
    s = s.replace(/[*~_]{1,}/g, '');

    // 括号里的英文注释（(laughs) / （sighs）），中文括注必须保留给 TTS 当表演提示
    s = s.replace(/[(（][ \t]*[A-Za-z][A-Za-z0-9 ,'’\-.!?~…]{0,40}[ \t]*[)）]/g, ' ');

    // emoji / 装饰符号 / 零宽字符 / 控制字符
    s = s.replace(EMOJI_RE, '');
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    s = s.replace(/[\u200B-\u200F\uFEFF]/g, '');

    // 表格 / HTML 标签
    s = s.replace(/\|/g, ' ');
    s = s.replace(/<[^>]{1,80}>/g, ' ');

    // 换行 → 中文之间补逗号（说话要有停顿），其它补空格
    s = s.replace(/([^\n])\n+([^\n])/g, function (m, a, b) {
      // 前一字符已经是标点/开括号，再补逗号就会变成「，，「这种
      if (/[，。！？、；：,.!?;:（(【「『“”‘’—…]/.test(a)) return a + b;
      if (/[\u4e00-\u9fff，。！？、；：]/.test(a) || /[\u4e00-\u9fff]/.test(b)) return a + '，' + b;
      return a + ' ' + b;
    });
    s = s.replace(/\n+/g, ' ');
    // 收敛重复标点（清洗过程可能叠加出「，，」「。。」）
    s = s.replace(/([，。！？、；：])\1+/g, '$1');

    // 空白收敛
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/ *([，。！？、；：）】”’]) */g, '$1');
    s = s.replace(/ *([（【“‘]) */g, '$1');
    for (var i = 0; i < 2; i++) {
      s = s.replace(/([\u4e00-\u9fff，。！？、；：（）【】“”‘’…—]) +(?=[\u4e00-\u9fff，。！？、；：（）【】“”‘’…—])/g, '$1');
    }
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s，。；、：:;,._~\-—]+/, '');
    s = s.replace(/[\s，、；：:;,]+$/, '');

    return s.trim();
  }

  // ============================================================
  // 9. JSON 半截解析 / 容错解析
  // ============================================================

  function stripFences(t) {
    var s = str(t);
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/^\s*\u0060{3}[a-zA-Z0-9_-]*\s*\n?/, '');
    s = s.replace(/\n?\s*\u0060{3}\s*$/, '');
    return s.trim();
  }

  // 从 src[start]（引号位置）读一个 JSON 字符串；容忍半截转义与未闭合
  function readJsonString(src, start) {
    var quote = src.charAt(start);
    var out = '';
    var i = start + 1;
    var closed = false;
    var ESC = { '"': '"', "'": "'", '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' };
    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch === '\\') {
        var esc = src.charAt(i + 1);
        if (esc === '') { i++; break; }          // 半截转义，等后续 chunk
        if (esc === 'u') {
          var hex = src.substr(i + 2, 4);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) { i += 2; continue; }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += (ESC[esc] !== undefined ? ESC[esc] : esc);
        i += 2;
        continue;
      }
      if (ch === quote) { closed = true; i++; break; }
      out += ch;
      i++;
    }
    return { value: out, complete: closed, end: i };
  }

  // 找到某个 key 的字符串值（含是否闭合）
  function readKeyString(text, key) {
    var t = str(text);
    var idx = t.indexOf('"' + key + '"');
    if (idx < 0) idx = t.indexOf("'" + key + "'");
    if (idx < 0) idx = t.indexOf(key);
    if (idx < 0) return { found: false, value: '', complete: false, start: -1 };
    var colon = t.indexOf(':', idx);
    var colon2 = t.indexOf('：', idx);
    if (colon2 >= 0 && (colon < 0 || colon2 < colon)) colon = colon2;
    if (colon < 0) return { found: true, value: '', complete: false, start: -1 };
    var i = colon + 1;
    while (i < t.length && /[ \t\n\r]/.test(t.charAt(i))) i++;
    var q = t.charAt(i);
    if (q !== '"' && q !== "'") return { found: true, value: '', complete: false, start: i };
    var r = readJsonString(t, i);
    return { found: true, value: r.value, complete: r.complete, start: i, end: r.end };
  }

  function findSpeechKey(text) {
    var t = str(text);
    var idx = t.indexOf('"speech"');
    if (idx >= 0) return idx;
    idx = t.indexOf("'speech'");
    if (idx >= 0) return idx;
    return t.indexOf('speech');
  }

  // 截取第一个平衡的 {...}（跳过字符串内的花括号与转义）
  function balancedObject(t) {
    var s = str(t);
    var start = s.indexOf('{');
    if (start < 0) return '';
    var depth = 0;
    var inStr = false;
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return '';
  }

  function repairJson(t) {
    var s = str(t);
    s = s.replace(/,\s*([}\]])/g, '$1');       // 尾逗号
    s = s.replace(/[“”]/g, '"');                  // 全角引号
    s = s.replace(/：/g, ':');
    return s;
  }

  function tryParseJsonLoose(text) {
    var t = stripFences(text);
    if (!t) return null;
    var cands = [t];
    var first = t.indexOf('{');
    var last = t.lastIndexOf('}');
    if (first >= 0 && last > first) cands.push(t.slice(first, last + 1));
    var balanced = balancedObject(t);
    if (balanced) cands.push(balanced);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var obj = safeParse(c);
      if (isObj(obj)) return obj;
      obj = safeParse(repairJson(c));
      if (isObj(obj)) return obj;
    }
    return null;
  }

  // JSON 烂到 parse 不了时，用逐字段捞的方式尽量救回内容
  function salvageFields(text) {
    var t = str(text);
    var out = {};
    var sp = readKeyString(t, 'speech');
    if (sp.found && sp.value) out.speech = sp.value;
    var keys = ['emotion', 'tone', 'pace', 'volume'];
    for (var i = 0; i < keys.length; i++) {
      var r = readKeyString(t, keys[i]);
      if (r.found && r.value) out[keys[i]] = r.value;
    }
    var nv = t.match(/["']?nonverbals["']?\s*[:：]\s*\[([\s\S]{0,200}?)\]/);
    if (nv) out.nonverbals = nv[1];
    var ey = t.match(/["']?expectUser["']?\s*[:：]\s*(true|false)/i);
    if (ey) out.expectUser = ey[1].toLowerCase() === 'true';
    var sy = t.match(/["']?shouldYield["']?\s*[:：]\s*(true|false)/i);
    if (sy) out.shouldYield = sy[1].toLowerCase() === 'true';
    return out;
  }

  function pick(obj, keys) {
    if (!isObj(obj)) return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return undefined;
  }

  function normalizeDirective(o) {
    var src = isObj(o) ? o : {};

    var speechRaw = pick(src, ['speech', 'text', 'content', 'say', 'reply', 'utterance']);
    if (Array.isArray(speechRaw)) speechRaw = speechRaw.join(' ');
    if (isObj(speechRaw)) speechRaw = pick(speechRaw, ['text', 'content']);

    var speech = sanitizeForTTS(str(speechRaw));

    return {
      speech: speech,
      emotion: cleanTone(pick(src, ['emotion', 'mood', 'feeling'])),
      tone: cleanTone(pick(src, ['tone', 'style', 'attitude'])),
      pace: normalizePace(pick(src, ['pace', 'speed', 'rate']), 'normal'),
      volume: normalizeVolume(pick(src, ['volume', 'loudness']), '中'),
      nonverbals: normalizeList(pick(src, ['nonverbals', 'markers', 'nonverbal', 'actions']), 4),
      expectUser: boolish(pick(src, ['expectUser', 'expect_user', 'waiting']), true),
      shouldYield: boolish(pick(src, ['shouldYield', 'should_yield', 'yield']), true)
    };
  }

  function parseDirective(raw) {
    if (isObj(raw)) {
      var norm = normalizeDirective(raw);
      if (norm.speech || norm.emotion || norm.tone) return norm;
      return norm;
    }
    var text = str(raw);
    if (!text.trim()) return normalizeDirective({});

    var obj = tryParseJsonLoose(text);
    if (obj) {
      var d = normalizeDirective(obj);
      if (d.speech) return d;
      // JSON 合法但 speech 空：退到原文（很可能是模型把话写到了别的字段）
    }

    var sal = salvageFields(text);
    if (sal.speech) {
      var d2 = normalizeDirective(sal);
      d2._salvaged = true;
      return d2;
    }

    // 彻底不是 JSON：把原文当台词
    var plain = stripFences(text)
      .replace(/^[\s{[]+/, '')
      .replace(/[\s}\]]+$/, '');
    var d3 = normalizeDirective({});
    d3.speech = sanitizeForTTS(plain);
    d3._fallback = true;
    return d3;
  }

  // 流式：从半截输出里抠 speech 的当前值（voice-core 增量合成用）
  function extractSpeechPartial(raw) {
    if (isObj(raw)) {
      var nd = normalizeDirective(raw);
      return { speech: nd.speech, complete: true, json: true };
    }
    var text = str(raw);
    if (!text) return { speech: '', complete: false, json: false };

    var t = stripFences(text);
    var looksJson = t.charAt(0) === '{' || findSpeechKey(t) >= 0;
    if (!looksJson) {
      var plain = sanitizeForTTS(t);
      return { speech: plain, complete: /[。！？!?…~～]$/.test(plain) || /\.$/.test(plain), json: false };
    }

    var r = readKeyString(t, 'speech');
    if (!r.found || !r.value) {
      return { speech: '', complete: false, json: true };
    }
    var speech = sanitizeForTTS(r.value);
    return { speech: speech, complete: !!r.complete, json: true, raw: r.value };
  }

  // ============================================================
  // 10. firstSentences —— 把已流出的文本切句（只返回已完成的句子）
  // ============================================================

  var TERMINALS = '。！？!?…';
  var CLOSERS = '"”’』」）)】';

  function isDotEnd(s, i) {
    var prev = i > 0 ? s.charAt(i - 1) : '';
    var next = i + 1 < s.length ? s.charAt(i + 1) : '';
    if (/[0-9]/.test(prev)) return false;              // 3.14
    if (next === '.' || next === '…') return true;     // 省略号
    if (!next) return true;
    if (/[\s"'”’』」）)】]/.test(next)) return true;
    if (/[\u4e00-\u9fff]/.test(next)) return true;
    return false;
  }

  function firstSentences(text, opts) {
    var s = str(text);
    if (!s) return [];
    var o = isObj(opts) ? opts : {};
    var minChars = clampNum(o.minChars, 0, 200, 0);

    var out = [];
    var buf = '';
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '\n') {
        if (buf.trim()) { out.push(buf.trim()); buf = ''; }
        i++;
        continue;
      }
      buf += ch;
      var end = TERMINALS.indexOf(ch) >= 0;
      if (!end && ch === '.') end = isDotEnd(s, i);
      if (!end) { i++; continue; }

      var j = i + 1;
      while (j < s.length) {
        var c2 = s.charAt(j);
        if (TERMINALS.indexOf(c2) >= 0) { buf += c2; j++; continue; }
        if (c2 === '.') { buf += c2; j++; continue; }
        if (CLOSERS.indexOf(c2) >= 0) { buf += c2; j++; continue; }
        break;
      }
      i = j;
      var piece = buf.trim();
      if (piece) out.push(piece);
      buf = '';
    }
    if (o.keepTail && buf.trim()) out.push(buf.trim());

    if (minChars > 0 && out.length > 1) {
      var merged = [];
      var acc = '';
      for (var k = 0; k < out.length; k++) {
        acc += out[k];
        if (acc.replace(/\s/g, '').length >= minChars) { merged.push(acc); acc = ''; }
      }
      if (acc) {
        if (merged.length) merged[merged.length - 1] += acc;
        else merged.push(acc);
      }
      out = merged;
    }
    return out;
  }

  // ============================================================
  // 11. turnPolicy —— 轮次判定（yield / wait / continue）
  // ============================================================

  var TURN_DEFAULTS = {
    endpointSilenceMs: 700,   // 静音多久算说完（settings.voice.endpointSilenceMs）
    hardSilenceMs: 1500,      // 硬阈值：到这儿无论如何让位
    minUtteranceMs: 400,      // 有效语音下限，低于它当噪声（契约 §3.1）
    tailDragMs: 320,          // 尾音拖长超过它 → 还在想下一句
    shortSilenceMs: 380,      // 句尾能量骤降时，静音超过它就能判说完
    minSpeechRatio: 0.6,      // 语音占比低于它 + 有停顿 → 在斟酌
    fastRateCps: 4.5,         // 语速快过它 → 端点收紧
    slowRateCps: 3.2,         // 语速慢过它 → 端点放宽
    tightening: 0.65,         // 收紧系数（700 → 455）
    relaxing: 1.25            // 放宽系数（700 → 875）
  };

  function mergeTurnCfg(cfg) {
    var c = {};
    for (var k in TURN_DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(TURN_DEFAULTS, k)) continue;
      c[k] = TURN_DEFAULTS[k];
    }
    if (isObj(cfg)) {
      for (var k2 in c) {
        if (!Object.prototype.hasOwnProperty.call(c, k2)) continue;
        if (!Object.prototype.hasOwnProperty.call(cfg, k2)) continue;
        var v = cfg[k2];
        if (v === undefined || v === null || v === '') continue;
        c[k2] = num(v, c[k2]);
      }
    }
    c.endpointSilenceMs = clampNum(c.endpointSilenceMs, 200, 5000, 700);
    c.hardSilenceMs = clampNum(c.hardSilenceMs, c.endpointSilenceMs, 8000, 1500);
    c.minUtteranceMs = clampNum(c.minUtteranceMs, 100, 3000, 400);
    c.tailDragMs = clampNum(c.tailDragMs, 50, 3000, 320);
    c.shortSilenceMs = clampNum(c.shortSilenceMs, 100, 3000, 380);
    c.minSpeechRatio = clampNum(c.minSpeechRatio, 0, 1, 0.6);
    c.fastRateCps = clampNum(c.fastRateCps, 1, 20, 4.5);
    c.slowRateCps = clampNum(c.slowRateCps, 0.5, 20, 3.2);
    c.tightening = clampNum(c.tightening, 0.2, 1, 0.65);
    c.relaxing = clampNum(c.relaxing, 1, 3, 1.25);
    return c;
  }

  // 端点自适应：把基准 endpointSilenceMs 按这一句的说话特征缩放。
  //   返回 { effectiveEndpointMs, mode }，mode 会写进 thresholds 便于调参时一眼看出走了哪一档。
  function adaptEndpoint(c, feat) {
    var f = isObj(feat) ? feat : {};
    var cps = num(f.cps, NaN);
    var longPauses = num(f.longPauses, NaN);
    var trailingOff = f.trailingOff === true;

    var mode = 'base';
    var factor = 1;

    // 先判放宽：只要有任何「这个人还在想 / 没说完」的迹象，就宁可多等。
    if ((isFinite(cps) && cps > 0 && cps < c.slowRateCps) ||
        (isFinite(longPauses) && longPauses >= 2) ||
        trailingOff) {
      mode = 'relaxed';
      factor = c.relaxing;
    } else if (isFinite(cps) && cps > c.fastRateCps &&
               (!isFinite(longPauses) || longPauses <= 0)) {
      // 收紧只在「快且一处停顿都没有」时成立 —— 快但老停顿的人是在一边想一边说。
      mode = 'tightened';
      factor = c.tightening;
    }

    var eff = c.endpointSilenceMs * factor;
    if (eff < 200) eff = 200;
    // 放宽之后也不能越过硬阈值，否则这两档会打架
    if (eff > c.hardSilenceMs) eff = c.hardSilenceMs;
    return { effectiveEndpointMs: Math.round(eff), mode: mode };
  }

  function turnPolicy(state, features, cfg) {
    var st = str(state).toLowerCase();
    var f = isObj(features) ? features : {};
    var c = mergeTurnCfg(cfg);

    var silentMs = num(f.silentMs, num(f.silenceMs, NaN));
    var speechMs = num(f.speechMs, NaN);
    var tailDragMs = num(f.tailDragMs, num(f.tailDrag, NaN));
    var trailingOff = f.trailingOff === true || f.tailDrop === true;
    var isSpeaking = f.isSpeech === true || f.speaking === true || f.vadActive === true;
    var ratio = num(f.speechRatio, NaN);
    var longPauses = num(f.longPauseCount, countLongPauses(f));
    var cps = num(f.speechRateCps, NaN);

    // 端点自适应：不同说话习惯的人，等一样的静音时长就是有人被抢话、有人干等。
    //   快 + 不拖泥带水 → 收紧（700 → 455），接得利索；
    //   慢 / 多处停顿 / 尾音掉下去 → 放宽（700 → 875），别在人家换气的时候插嘴。
    var adaptive = adaptEndpoint(c, { cps: cps, longPauses: longPauses, trailingOff: trailingOff });
    var effectiveEndpointMs = adaptive.effectiveEndpointMs;

    var thresholds = {
      endpointSilenceMs: c.endpointSilenceMs,
      effectiveEndpointMs: effectiveEndpointMs,
      endpointMode: adaptive.mode,
      hardSilenceMs: c.hardSilenceMs,
      minUtteranceMs: c.minUtteranceMs,
      tailDragMs: c.tailDragMs,
      shortSilenceMs: c.shortSilenceMs
    };

    function mk(action, reason, reasonText) {
      return {
        action: action,
        reason: reason,
        reasonText: reasonText,
        thresholds: thresholds,
        silentMs: isFinite(silentMs) ? silentMs : null,
        speechMs: isFinite(speechMs) ? speechMs : null
      };
    }

    if (st === 'idle' || st === 'closed' || st === 'error' || st === 'connecting') {
      return mk('wait', 'inactive', '通话不在收音状态（' + st + '），不做轮次判定');
    }
    if (st === 'speaking' || st === 'thinking' || st === 'interrupting') {
      return mk('wait', 'assistant-busy',
        'AI 正在' + (st === 'speaking' ? '说话' : '处理') + '，这段声音交给打断判定，不当作需要回应的发言');
    }
    if (isSpeaking) {
      return mk('continue', 'still-speaking', 'VAD 仍判为正在说话');
    }
    if (!isFinite(silentMs) && !isFinite(speechMs)) {
      return mk('wait', 'no-features', '没有可用的静音/能量特征');
    }
    // 硬阈值优先：静音够久就必须让位。放在 too-short 之前，否则用户只说了一个
    // 「嗯」（<minUtteranceMs）之后一直不出声，就会永远判 wait 而死等。
    if (isFinite(silentMs) && silentMs >= c.hardSilenceMs) {
      return mk('yield', 'long-silence',
        '静音已 ' + Math.round(silentMs) + 'ms，超过硬阈值 ' + c.hardSilenceMs + 'ms');
    }
    if (isFinite(speechMs) && speechMs < c.minUtteranceMs) {
      return mk('wait', 'too-short',
        '有效语音只有 ' + Math.round(speechMs) + 'ms，低于 ' + c.minUtteranceMs + 'ms，可能是口气或噪声');
    }
    if (isFinite(tailDragMs) && tailDragMs >= c.tailDragMs &&
        !(isFinite(silentMs) && silentMs >= effectiveEndpointMs)) {
      return mk('wait', 'tail-dragging',
        '尾音拖长 ' + Math.round(tailDragMs) + 'ms，像是在想下一句');
    }
    if (trailingOff && isFinite(silentMs) && silentMs >= c.shortSilenceMs) {
      return mk('yield', 'trailing-off', '句尾能量骤降，判断为说完了（或者不想说了）');
    }
    if (isFinite(silentMs) && silentMs >= effectiveEndpointMs) {
      return mk('yield', 'endpoint-silence',
        '静音 ' + Math.round(silentMs) + 'ms ≥ 自适应端点阈值 ' + effectiveEndpointMs +
        'ms（' + adaptive.mode + '，基准 ' + c.endpointSilenceMs + 'ms）');
    }
    if (isFinite(ratio) && ratio < c.minSpeechRatio && isFinite(longPauses) && longPauses >= 1) {
      return mk('wait', 'hesitating', '语音占比低且停顿多，对方可能在斟酌');
    }
    return mk('wait', 'still-voiced', '仍在出声，或者静音还不够长');
  }

  // ============================================================
  // 12. buildFillerPlan —— 冷场补白
  // ============================================================

  function buildFillerPlan(opts) {
    var o = isObj(opts) ? opts : {};
    var pref = (o.personaId !== undefined && o.personaId !== null && o.personaId !== '')
      ? o.personaId
      : (o.persona || 'warm');
    var persona = getPersona(pref);
    var list = (Array.isArray(persona.fillers) && persona.fillers.length) ? persona.fillers : DEFAULT_FILLERS;

    var avoid = str(o.avoid !== undefined ? o.avoid : o.last);
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== avoid) pool.push(list[i]);
    }
    if (!pool.length) pool = list.slice();

    var idx = 0;
    var seed = num(o.index, num(o.seed, NaN));
    if (isFinite(seed)) idx = Math.abs(Math.floor(seed)) % pool.length;
    else idx = Math.floor(Math.random() * pool.length) % pool.length;

    return {
      speech: sanitizeForTTS(pool[idx]),
      emotion: str(persona.emotion) || '平静',
      tone: str(persona.tone) || '自然',
      pace: 'slow',
      volume: '中',
      nonverbals: [],
      expectUser: false,
      shouldYield: false,
      isFiller: true,
      personaId: str(persona.id) || 'warm',
      delayMs: num(o.delayMs, 0) || 0
    };
  }

  // ============================================================
  // 13. v126 通话层：时间描述 / 通话层提示词 / 通话标记
  //   为什么单独一层：PERSONAS 回答的是「你是谁」，这一层回答的是「电话这个信道」。
  //   两件事混在一段里，改人设就会牵动通话规则；而且 JSON 输出格式说明只留在
  //   voice.js 的 JSON_DIRECTIVE 一处，这里绝不重复，免得两边要求互相打架。
  // ============================================================

  var CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var CN_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) {
    var v = Math.floor(num(n, 0));
    if (v < 0) v = 0;
    return v < 10 ? '0' + v : String(v);
  }

  // 统一成毫秒时间戳。跨 vm realm 时 instanceof Date 会失效，所以按 getTime 判断；
  //   非法输入一律 NaN —— 调用方据此走兜底，而不是拿 Invalid Date 去算。
  function toMs(x) {
    if (x === null || x === undefined || x === '') return NaN;
    if (typeof x === 'number') return (isFinite(x) && x > 0) ? x : NaN;
    if (typeof x === 'string') {
      var s = x.replace(/^\s+|\s+$/g, '');
      if (!s) return NaN;
      if (/^\d{1,15}$/.test(s)) {
        var n = Number(s);
        return (isFinite(n) && n > 0) ? n : NaN;
      }
      var parsed = Date.parse(s);
      return isFinite(parsed) ? parsed : NaN;
    }
    if (isObj(x) && typeof x.getTime === 'function') {
      try {
        var t = x.getTime();
        return isFinite(t) ? t : NaN;
      } catch (e) { return NaN; }
    }
    return NaN;
  }

  function dateParts(ms) {
    var m = num(ms, NaN);
    if (!isFinite(m)) return null;
    var d = new Date(m);
    if (!isFinite(d.getTime())) return null;
    return {
      y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(),
      wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds()
    };
  }

  // 0~59 的中文说法：时间要给人听，模型嘴里不能冒出「22:30」这种写法
  function cnNumber(n) {
    var v = Math.floor(num(n, 0));
    if (v < 0) v = 0;
    if (v > 59) v = 59;
    if (v < 10) return CN_DIGITS[v];
    var ten = Math.floor(v / 10);
    var one = v % 10;
    if (ten === 1) return '十' + (one ? CN_DIGITS[one] : '');
    return CN_DIGITS[ten] + '十' + (one ? CN_DIGITS[one] : '');
  }

  // 时段按中文口语习惯切：凌晨 / 早上 / 上午 / 中午 / 下午 / 晚上 / 深夜
  function clockPeriod(h) {
    var v = Math.floor(num(h, 0));
    if (v < 5) return '凌晨';
    if (v < 8) return '早上';
    if (v < 11) return '上午';
    if (v < 13) return '中午';
    if (v < 18) return '下午';
    if (v < 23) return '晚上';
    return '深夜';
  }

  // 「晚上十点半」「下午三点一刻」「上午九点零五分」
  function speakClockTime(h, mi) {
    var hh = Math.floor(num(h, 0));
    if (hh < 0) hh = 0;
    if (hh > 23) hh = 23;
    var mm = Math.floor(num(mi, 0));
    if (mm < 0) mm = 0;
    if (mm > 59) mm = 59;
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    var tail;
    if (mm === 0) tail = '整';
    else if (mm === 15) tail = '一刻';
    else if (mm === 30) tail = '半';
    else if (mm === 45) tail = '三刻';
    else if (mm < 10) tail = '零' + CN_DIGITS[mm] + '分';
    else tail = cnNumber(mm) + '分';
    return clockPeriod(hh) + cnNumber(h12) + '点' + tail;
  }

  // 给人听的时长。exact=true 保留秒（通话时长要精确），否则只给量级（进度够了）
  function fmtDurationCN(ms, exact) {
    var total = num(ms, NaN);
    if (!isFinite(total) || total < 0) total = 0;
    var sec = Math.round(total / 1000);
    if (sec < 60) return sec + ' 秒';
    var min = Math.floor(sec / 60);
    var remSec = sec % 60;
    if (min < 60) {
      if (!exact) return min + ' 分钟';
      return min + ' 分' + (remSec ? ' ' + remSec + ' 秒' : '');
    }
    var hour = Math.floor(min / 60);
    var remMin = min % 60;
    if (exact) return hour + ' 小时' + (remMin ? ' ' + remMin + ' 分' : '');
    return hour + ' 小时' + (remMin ? ' ' + remMin + ' 分钟' : '');
  }

  // 本地当天零点：跨天判断不能用 24 小时整除，否则 23:50→00:10 只算 20 分钟
  function dayStartMs(ms) {
    var m = num(ms, NaN);
    if (!isFinite(m)) return NaN;
    var d = new Date(m);
    if (!isFinite(d.getTime())) return NaN;
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return isFinite(t) ? t : NaN;
  }

  // 时间感知：时间一律由调用方传入（本模块不读 Date.now），否则单测无法稳定复现
  function describeClock(clock) {
    var c = isObj(clock) ? clock : {};
    if (!boolish(c.enabled, true)) return '';

    var nowMs = toMs(c.now);
    var np = dateParts(nowMs);
    if (!np) return '';

    var startMs = toMs(c.callStartedAt);
    var lastMs = toMs(c.lastTurnAt);
    var idx = num(c.turnIndex, NaN);

    var durMs = isFinite(startMs) ? (nowMs - startMs) : NaN;
    var gapMs = isFinite(lastMs) ? (nowMs - lastMs) : NaN;
    // 时钟回拨或收到未来时间：宁可说 0，也不能出现「负了 3 分钟」
    if (isFinite(durMs) && durMs < 0) durMs = 0;
    if (isFinite(gapMs) && gapMs < 0) gapMs = 0;

    // 首轮只说「现在是什么时候」。没有任何通话进度可讲时也走这一支，
    //   否则会产出一句残缺的「距上一句过了 0 秒」。
    var isFirst = (isFinite(idx) && idx <= 0) || (!isFinite(gapMs) && !isFinite(durMs));
    if (isFirst) {
      return '现在是' + np.mo + '月' + np.d + '日，星期' + CN_WEEK[np.wd] + '，' +
        speakClockTime(np.h, np.mi) + '。';
    }

    var parts = [];
    if (isFinite(gapMs)) {
      if (gapMs < 5000) parts.push('距对方上一句只隔了几秒');
      else parts.push('距对方上一句已经过了 ' + fmtDurationCN(gapMs));
    }
    if (isFinite(durMs)) {
      if (durMs < 60000) parts.push('这通电话才刚开始');
      else parts.push('这通电话已经打了 ' + fmtDurationCN(durMs));
    }

    // 聊过零点要明说：不然模型仍以为「今天晚上」，会说出「你早点睡」这种错话
    if (isFinite(startMs)) {
      var d0 = dayStartMs(startMs);
      var d1 = dayStartMs(nowMs);
      if (isFinite(d0) && isFinite(d1) && d1 > d0) {
        var days = Math.round((d1 - d0) / 86400000);
        parts.push(days <= 1 ? '已经到第二天了' : '已经过了 ' + days + ' 天');
      }
    }

    if (!parts.length) return '';
    return parts.join('，') + '。';
  }

  // 通话层：叠在会话人设之上的一段约束，只讲电话这个信道 + 当前人格 + 这一轮线索
  function buildCallLayer(opts) {
    var o = isObj(opts) ? opts : {};
    var pref = (o.personaId !== undefined && o.personaId !== null && o.personaId !== '')
      ? o.personaId
      : (o.persona || 'warm');
    var persona = getPersona(pref);
    var brevity = normalizeBrevity(o.brevity);
    var b = BREVITY_MODES[brevity] || BREVITY_MODES.short;
    var L = [];

    L.push('你正在和对方打电话，你说的每句话会被直接念出来，对方看不到文字。');

    L.push('');
    L.push('【说话方式的硬规则（每一条都要守）】');
    L.push('1. 短句：一次只说 ' + b.sentences + '，一共 ' + b.chars + '，说完就停，把话头交回给对方。');
    L.push('2. 口语：用日常说话的短句，可以用语气词开头（嗯、唉、啊、我说、那个），可以说一半改口。');
    L.push('3. 不 Markdown：不要加粗、不要标题、不要反引号代码、不要列表、不要编号、不要表格、不要分隔线。');
    L.push('4. 不 emoji：不要表情符号、不要颜文字、不要 ASCII 表情（:) 这种）。');
    L.push('5. 不要念出括号里的动作：不要在话里写（停顿）（叹气）*笑* 这类舞台说明；情绪靠语气表达，不靠文字描述。');
    L.push('6. 不书面语：不要「首先 / 其次 / 最后」「总的来说」「综上所述」「值得一提的是」这些套话；不要分点讲道理、不要总结要点。');
    L.push('7. ' + b.note);

    L.push('');
    L.push('【你的人格：' + (str(persona.name) || str(persona.id) || '温暖陪伴') + '】');
    if (str(persona.systemFlavor)) L.push(str(persona.systemFlavor));
    L.push('默认说话感觉：' + (str(persona.tone) || '自然') +
      '，语速' + PACE_CN[normalizePace(persona.pace, 'normal')] +
      '，音量' + VOLUME_CN[normalizeVolume(persona.volume, '中')] + '。');
    L.push('除非这一句的情绪明显不同，否则就照这个默认感觉说。');

    var custom = str(o.customPersona);
    if (custom) {
      L.push('');
      L.push('【额外设定（优先于上面的人格描述，但不能违反上面的硬规则）】');
      L.push(custom);
    }

    // 声音状态：字符串和对象两种入口都认，和 buildSystemPrompt 保持同一口径
    var sigText = str(o.signalsText);
    if (!sigText && isObj(o.signals)) sigText = describeSignals(o.signals, o.signalOpts);
    if (sigText) {
      L.push('');
      L.push('【对方这一段的声音状态】');
      L.push(sigText);
      var hints = signalHints(o.signals);
      if (hints.length) {
        L.push('这一轮请这样处理：');
        for (var h = 0; h < hints.length; h++) L.push('· ' + hints[h]);
      }
      L.push('不要把这些特征说出来（别说「你刚才语速很快」），把它变成你说话的方式和长度。');
    }

    // 时间感知：关着的时候一个字都不加，别拿默认值污染 prompt
    var clock = isObj(o.clock) ? o.clock : null;
    if (clock && boolish(clock.enabled, false)) {
      var clockText = describeClock(clock);
      if (clockText) {
        L.push('');
        L.push('【现在的时间和通话进度】');
        L.push(clockText);
        L.push('这些只是给你自己判断用的：可以顺着时间说话（比如「都这么晚了」），但不要把几点几分原样念出来。');
      }
    }

    return L.join('\n');
  }

  // 通话开始 / 结束的系统标记。落进会话历史后，回看时能一眼分出「哪段是打电话聊的」
  function buildCallMarker(opts) {
    var o = isObj(opts) ? opts : {};
    var kind = str(o.kind).toLowerCase();
    var isEnd = (kind === 'end' || kind === 'stop' || kind === 'hangup' || kind === 'over');

    var atMs = toMs(o.at);
    var startMs = toMs(o.startedAt);
    var body = [];

    if (isEnd) {
      var p = dateParts(atMs);
      if (p) body.push(pad2(p.h) + ':' + pad2(p.mi));
      if (isFinite(atMs) && isFinite(startMs) && atMs >= startMs) {
        body.push('通话 ' + fmtDurationCN(atMs - startMs, true));
      }
      var turns = Math.floor(num(o.turns, NaN));
      if (isFinite(turns) && turns > 0) body.push(turns + ' 轮');
      return {
        role: 'system',
        content: '【语音通话结束' + (body.length ? ' · ' + body.join(' · ') : '') + '】',
        marker: 'call'
      };
    }

    var sp = dateParts(isFinite(atMs) ? atMs : startMs);
    if (sp) body.push(sp.mo + '月' + sp.d + '日 ' + pad2(sp.h) + ':' + pad2(sp.mi));
    return {
      role: 'system',
      content: '【语音通话开始' + (body.length ? ' · ' + body.join(' · ') : '') + '】',
      marker: 'call'
    };
  }

  // ============================================================
  // 14. v126 真机微调预设与语速
  //   预设里只存「用户改过的项」，所以合并只能是「覆盖 + 非法忽略」：
  //   整对象替换会让以后调整内置默认值时老用户永远收不到。
  // ============================================================

  var TUNING_RANGES = {
    echoGuardMs: { min: 0, max: 1200 },
    bargeInHoldMs: { min: 80, max: 800 },
    bargeInLeakFactor: { min: 1.5, max: 10 },
    leakFloor: { min: 0, max: 1 },
    endpointSilenceMs: { min: 200, max: 3000 },
    minUtteranceMs: { min: 100, max: 2000 },
    sensitivity: { min: 0, max: 1 }
  };

  var TUNING_KEYS = ['echoGuardMs', 'bargeInHoldMs', 'bargeInLeakFactor', 'leakFloor',
    'endpointSilenceMs', 'minUtteranceMs', 'sensitivity'];

  // 预设可能来自表单（数字字符串）、也可能被脏数据写坏，统一在这里收敛成数字
  function toTuningNumber(raw) {
    if (raw === null || raw === undefined || raw === true || raw === false) return NaN;
    if (typeof raw === 'number') return isFinite(raw) ? raw : NaN;
    if (typeof raw === 'string') {
      var s = raw.replace(/^\s+|\s+$/g, '');
      if (!s) return NaN;
      var n = Number(s);
      return isFinite(n) ? n : NaN;
    }
    return NaN;   // 对象 / 数组 / Date：预设里不该出现，一律当非法
  }

  function resolveTuning(base, preset) {
    var out = {};
    if (isObj(base)) {
      for (var k in base) {
        if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
        out[k] = base[k];
      }
    }
    var p = preset;
    if (typeof p === 'string') {
      var parsed = safeParse(p);
      if (isObj(parsed)) p = parsed;
    }
    if (!isObj(p)) return out;

    for (var i = 0; i < TUNING_KEYS.length; i++) {
      var key = TUNING_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
      var n = toTuningNumber(p[key]);
      if (!isFinite(n)) continue;
      var r = TUNING_RANGES[key];
      if (!r) continue;
      if (n < r.min || n > r.max) continue;   // 超范围的值写进去只会把功能调死
      out[key] = n;
    }
    return out;
  }

  var RATE_MIN = 0.6;
  var RATE_MAX = 1.6;
  var RATE_DEFAULT = 1.0;

  function fmtRateValue(n) {
    var r = Math.round(num(n, RATE_DEFAULT) * 100) / 100;
    return String(r);
  }

  // 语速描述给设置面板和提示词共用：同一处阈值，避免两边各写一套
  function describeRate(rate) {
    var n = num(rate, NaN);
    if (!isFinite(n) || n <= 0) n = RATE_DEFAULT;
    if (n < RATE_MIN) n = RATE_MIN;
    if (n > RATE_MAX) n = RATE_MAX;
    if (n >= 1.05) return '偏快（' + fmtRateValue(n) + '×）';
    if (n <= 0.95) return '偏慢（' + fmtRateValue(n) + '×）';
    return '正常语速';
  }

  // ============================================================
  // 15. 导出
  // ============================================================

  var API = {
    VERSION: VERSION,
    // v125: 气泡标签分隔符的唯一真相。voice.js 的 renderSignals 引用它拆标签，
    //   避免「两侧各自都对、约定不一致」导致 4 个标签被塞进 1 个胶囊。
    SIGNAL_SEP: SIGNAL_SEP,
    PERSONAS: PERSONAS,
    BREVITY_MODES: BREVITY_MODES,
    TURN_DEFAULTS: TURN_DEFAULTS,
    DEFAULT_FILLERS: DEFAULT_FILLERS,
    // v126：真机微调的键与范围由本模块统一定义，voice.js 的设置面板直接引用，
    //   避免「面板能填 5000、运行时只认 3000」这种两套阈值。
    TUNING_KEYS: TUNING_KEYS,
    TUNING_RANGES: TUNING_RANGES,
    RATE_MIN: RATE_MIN,
    RATE_MAX: RATE_MAX,
    RATE_DEFAULT: RATE_DEFAULT,

    getPersona: getPersona,
    normalizePace: normalizePace,
    normalizeVolume: normalizeVolume,
    normalizeBrevity: normalizeBrevity,

    buildSystemPrompt: buildSystemPrompt,
    buildTurnMessages: buildTurnMessages,
    describeSignals: describeSignals,
    describeSignalsForBubble: describeSignalsForBubble,
    signalHints: signalHints,
    renderPerformance: renderPerformance,
    parseDirective: parseDirective,
    extractSpeechPartial: extractSpeechPartial,
    firstSentences: firstSentences,
    sanitizeForTTS: sanitizeForTTS,
    turnPolicy: turnPolicy,
    buildFillerPlan: buildFillerPlan,

    // v126 增量：通话层 / 时间 / 标记 / 微调 / 语速
    buildCallLayer: buildCallLayer,
    describeClock: describeClock,
    buildCallMarker: buildCallMarker,
    resolveTuning: resolveTuning,
    describeRate: describeRate
  };

  root.VoiceDirector = API;
})(typeof window !== 'undefined' ? window : globalThis);

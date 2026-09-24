// ===== latex.js : LaTeX 渲染模块（v118）=====
// 模块名：latex.js
// 版本：v118（cache-bust）
// 创建日期：2026-09-25
//    v116 首版（数学公式 + 第三方库本地化）
//   →v117 自建文本样式指令层（正则解析）
//   →v118 **推翻 v117 的指令层，改为「命令改写 + KaTeX 原生渲染」**
// 依赖：window.katex（缺失时回退原文）、window.marked
// 加载顺序：vendor/katex/katex.min.js 之后、chat.js 之前
// 不访问 state / settings，无副作用
//
// ── 为什么 v118 要推翻 v117 的做法 ───────────────────────────
// v117 用一组正则从文本里"抠出" \scalebox / \colorbox 等命令，自己生成
// <span style=...>。单层命令能跑通，但遇到嵌套就散架：
//     \{\scalebox{2}{\colorbox{black}{\textcolor{#800000}{\text{...}}}}\}
// 正则 \{([^{}]*)\} 无法跨越内层花括号，兜底分支 [^\n]* 又把行尾残留的 }}}
// 一起吞掉 —— 现象就是「黑底块里漏出一截 LaTeX 源码」。
// 根因：**正则不是解析器**，嵌套是需要状态机才能表达的东西。
//
// v118 的正解：**把非标准命令改写成 KaTeX 能理解的等价形式，其余交给 KaTeX**。
//     \scalebox{2}{X}  →  \htmlStyle{font-size:2em}{X}
//     \hl{X}           →  \htmlStyle{background-color:rgba(250,204,21,.35)}{X}
//     \sout{X}         →  \htmlStyle{text-decoration:line-through}{X}
//     \bgcolor{c}{X}   →  \colorbox{c}{X}      （别名替换）
//     \ul{X}           →  \underline{X}        （别名替换）
// 花括号配对用**平衡扫描**（matchBrace）完成，嵌套天然正确；而 KaTeX 本身就是
// 成熟解析器，边界 / 基线 / 嵌套全归它管 —— 观感因此与 KaTeX 原生一致，
// 这正是 DeepSeek 网页端那条路。
//
// ── 管线 ────────────────────────────────────────────────────
//   源文本
//     →① 无害化：用户直写的 \htmlStyle 去反斜杠（防绕过 trust 白名单）
//     →② 命令改写：非标准命令 → KaTeX 等价形式（平衡花括号扫描）
//     →③ 行包裹：含样式命令的行补 $…$ 定界符（若该行尚无 $）
//     →④ 公式提取：$…$ / $$…$$ / \(…\) / \[…\] → NUL 占位符（代码区跳过）
//     →⑤ marked 解析
//     →⑥ 回填 KaTeX HTML（trust 白名单）
//
// ── 代码块 ──────────────────────────────────────────────────
// 采取「分区域跳过」而非「剥离-回填」：``` 与 ` 段落原样留在文本里交给 marked
// 自行渲染成 <pre><code>，只是不参与任何扫描。
//
// ── 未闭合定界符 ────────────────────────────────────────────
// 所有定界符规则均为「只匹配成对」的惰性正则，流式输出中途的半截公式天然
// 匹配不上、自动保留为纯文本，无需额外的闭合检测。
//
// ── 渲染失败 ────────────────────────────────────────────────
// throwOnError:true + try/catch → 失败退回纯文本（不做 errorColor 标红）。
// 该策略取自 DeepSeek 网页端实现（见看板 §4.10）。

(function (global) {
  'use strict';

  var PH = '\u0000';                                   // 占位符定界（用户内容中不可能出现）
  var RE_MATH_PH = /\u0000M(\d+)\u0000/g;
  var CACHE_LIMIT = 1500;
  var _cache = new Map();
  var _stats = { hits: 0, misses: 0, errors: 0, fallback: 0, rewrites: 0, wrappedLines: 0 };
  var MAX_SCALE = 8;                                   // 字号倍率上限（防版面爆炸）
  var MIN_SCALE = 0.3;

  // ── 工具 ──────────────────────────────────────────────────
  function _str(s) { return s == null ? '' : String(s); }

  function _esc(s) {
    return _str(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _plainHtml(src) {
    return _esc(src).replace(/\n/g, '<br>');
  }

  // ── 平衡花括号扫描：s[i] === '{' 时返回配对 '}' 的下标，失败返回 -1 ──
  function matchBrace(s, i) {
    if (s.charAt(i) !== '{') return -1;
    var depth = 0;
    for (var k = i; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\') { k++; continue; }               // 跳过转义（\{ \} \\）
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  function _skipSpace(s, i, stopAtNewline) {
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '\n' && stopAtNewline) break;
      if (!/\s/.test(ch)) break;
      i++;
    }
    return i;
  }

  // ── ② 命令改写 ────────────────────────────────────────────
  var ALIAS = { bgcolor: 'colorbox', ul: 'underline' };
  var STYLE_BOX = {
    hl: 'background-color:rgba(250,204,21,.35)',
    mark: 'background-color:rgba(250,204,21,.35)',
    sout: 'text-decoration:line-through',
    st: 'text-decoration:line-through',
    del: 'text-decoration:line-through'
  };
  // 解析 \cmd{N}{内容} / \cmd{N} 内容 / \cmdN 内容 —— 返回 {value, content, next}
  function parseArgAndBody(s, i) {
    var n = s.length;
    var p = _skipSpace(s, i, true);
    var arg;
    if (s.charAt(p) === '{') {
      var e = matchBrace(s, p);
      if (e < 0) return null;
      arg = s.slice(p + 1, e);
      p = e + 1;
    } else {
      var m = /^[0-9]*\.?[0-9]+/.exec(s.slice(p, p + 12));
      if (!m) return null;
      arg = m[0];
      p += m[0].length;
    }
    p = _skipSpace(s, p, true);
    var body;
    if (s.charAt(p) === '{') {
      var e2 = matchBrace(s, p);
      if (e2 < 0) return null;
      body = s.slice(p + 1, e2);
      p = e2 + 1;
    } else {
      var nl = s.indexOf('\n', p);
      if (nl < 0) nl = n;
      body = s.slice(p, nl);
      p = nl;
    }
    if (!body) return null;
    return { value: arg, content: body, next: p };
  }

  function rewriteCommands(src) {
    var out = '';
    var i = 0;
    var n = src.length;
    var count = 0;
    while (i < n) {
      var c = src.charAt(i);
      if (c !== '\\') { out += c; i++; continue; }
      var m = /^\\([a-zA-Z]+)/.exec(src.slice(i, i + 24));
      if (!m) { out += c; i++; continue; }              // \{ \\ 等转义原样保留
      var name = m[1];
      var after = i + m[0].length;

      // 别名：\bgcolor → \colorbox，\ul → \underline
      if (ALIAS[name]) {
        out += '\\' + ALIAS[name];
        i = after;
        count++;
        continue;
      }

      // 字号缩放：\scalebox / \fontsize / \fs → \htmlStyle{font-size:Nem}
      if (name === 'scalebox' || name === 'fontsize' || name === 'fs') {
        var r = parseArgAndBody(src, after);
        if (r) {
          var v = parseFloat(r.value);
          if (isFinite(v) && v > 0) {
            v = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
            v = Math.round(v * 1000) / 1000;
            out += '\\htmlStyle{font-size:' + v + 'em}{' + r.content + '}';
            i = r.next;
            count++;
            continue;
          }
        }
      }

      // 高亮 / 删除线：\hl{X} \sout{X} → \htmlStyle{...}{X}
      if (STYLE_BOX[name]) {
        var p2 = _skipSpace(src, after, true);
        if (src.charAt(p2) === '{') {
          var e3 = matchBrace(src, p2);
          if (e3 > 0) {
            out += '\\htmlStyle{' + STYLE_BOX[name] + '}{' + src.slice(p2 + 1, e3) + '}';
            i = e3 + 1;
            count++;
            continue;
          }
        }
      }

      out += '\\' + name;
      i = after;
    }
    if (count) _stats.rewrites += count;
    return out;
  }

  // ── ① 无害化：用户直写的 \htmlStyle 等去反斜杠 ────────────
  // 我们自己生成的 \htmlStyle 在下一步才插入，故此处的替换是安全的。
  function neutralize(src) {
    return src
      .replace(/\\htmlStyle(?![a-zA-Z])/g, 'htmlStyle')
      .replace(/\\htmlClass(?![a-zA-Z])/g, 'htmlClass')
      .replace(/\\htmlId(?![a-zA-Z])/g, 'htmlId')
      .replace(/\\htmlData(?![a-zA-Z])/g, 'htmlData');
  }

  // ── ③ 行包裹：含样式命令的行补 $…$（若该行尚无 $）────────
  // 检测模式须同时覆盖「原始命令名」与「改写产物」——因为 rewriteCommands 先于
  // wrapStyleLines 执行，此时行内的 \scalebox 已变成 \htmlStyle。
  // （用户直写的 \htmlStyle 已被 neutralize 去掉反斜杠，不会误触。）
  var STYLE_CMD_LINE = /\\(?:scalebox|fontsize|fs|colorbox|bgcolor|textcolor|hl|sout|st|del|ul|underline|htmlStyle)(?![a-zA-Z])/;
  // 整行被 \{ … \} 整体包裹时剥掉外壳：该写法里 \{ \} 只是容器，而它们位于
  // \colorbox 之外、不会被黑底遮住，会露出两个突兀的括号（DeepSeek 网页端同样不显示）
  var RE_OUTER_BRACES = /^(\s*)\\\{([\s\S]*)\\\}(\s*)$/;

  function wrapStyleLines(seg) {
    if (!STYLE_CMD_LINE.test(seg)) return seg;
    var lines = seg.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      // 空行 / 已有任何定界符（$ 或 \( \[）→ 交给公式规则，绝不能再套一层
      // （2026-09-25 修：原先只认 $，AI 用 \(…\) 定界符时会被重复包裹，
      //   导致「$ + 占位符 + $」，行内 $ 规则再把占位符当公式送进 KaTeX 而失败）
      if (!ln || ln.indexOf('$') >= 0 || ln.indexOf('\\(') >= 0 || ln.indexOf('\\[') >= 0) continue;
      if (!STYLE_CMD_LINE.test(ln)) continue;
      if (!ln.trim()) continue;
      var m = RE_OUTER_BRACES.exec(ln);
      if (m) ln = m[1] + m[2] + m[3];                   // 剥掉外层 \{ \}
      lines[i] = '$' + ln + '$';
      _stats.wrappedLines++;
    }
    return lines.join('\n');
  }

  // ── ④ 数学定界符规则（块级在前，避免 $$ 被 $ 规则先吃掉）──
  var RULES = null;
  function buildRules() {
    var rules = [
      { re: /\$\$([\s\S]+?)\$\$/g, display: true, name: 'dollar-block' },
      { re: /\\\[([\s\S]+?)\\\]/g, display: true, name: 'bracket-block' },
      { re: /\\\(([\s\S]+?)\\\)/g, display: false, name: 'paren-inline' }
    ];
    var dollar = null;
    try {
      dollar = new RegExp('(?<!\\\\)\\$(?!\\s)((?:\\\\\\$|[^$\\n])+?)(?<!\\s)\\$(?!\\d)', 'g');
      new RegExp('(?<!x)y').test('zy');               // 确认 lookbehind 被引擎接受
    } catch (e) {
      dollar = null;
      _stats.fallback++;
    }
    if (dollar) rules.push({ re: dollar, display: false, name: 'dollar-inline' });
    return rules;
  }
  function rules() { if (!RULES) RULES = buildRules(); return RULES; }

  // ── 代码保护段（``` 围栏、~~~ 围栏、行内 `code`）──────────
  var RE_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

  function _applyMathRules(seg, math) {
    if (!seg) return seg;
    if (seg.indexOf('$') < 0 && seg.indexOf('\\(') < 0 && seg.indexOf('\\[') < 0) return seg;
    var rs = rules();
    for (var i = 0; i < rs.length; i++) {
      var rule = rs[i];
      rule.re.lastIndex = 0;
      seg = seg.replace(rule.re, function (m, g1) {
        var tex = (g1 || '').trim();
        if (!tex) return m;                             // 空公式（$$ $$）原样保留
        if (tex.indexOf(PH) >= 0) return m;             // 已含占位符 → 上游处理过，跳过（防御）
        math.push({ tex: tex, display: rule.display, raw: m });
        return PH + 'M' + (math.length - 1) + PH;
      });
    }
    return seg;
  }

  function _processSeg(seg, ctx) {
    if (!seg) return seg;
    seg = neutralize(seg);
    seg = rewriteCommands(seg);
    seg = wrapStyleLines(seg);
    seg = _applyMathRules(seg, ctx.math);
    return seg;
  }

  // ── 提取：按代码段切分，只在非代码区处理 ──────────────────
  function extractLatex(src) {
    var ctx = { text: '', math: [] };
    var s = _str(src);
    var out = '';
    var last = 0;
    var m;
    RE_CODE.lastIndex = 0;
    while ((m = RE_CODE.exec(s)) !== null) {
      out += _processSeg(s.slice(last, m.index), ctx);
      out += m[0];                                      // 代码段原样保留
      last = m.index + m[0].length;
    }
    out += _processSeg(s.slice(last), ctx);
    ctx.text = out;
    return ctx;
  }

  // ── ⑥ KaTeX 渲染（带缓存）────────────────────────────────
  // trust 白名单：\htmlStyle 只服务我们自己生成的样式串（原文里的已被无害化）；
  // \href/\url 仅放行 http(s) 与相对路径，杜绝 javascript: 之类。
  function trustFn(ctx) {
    var cmd = ctx && ctx.command;
    if (cmd === '\\htmlStyle') return true;
    if (cmd === '\\href' || cmd === '\\url') {
      var proto = ctx.protocol;
      return proto === 'http' || proto === 'https' || proto === '_relative' || proto === '_ftp';
    }
    return false;
  }

  function mathToHtml(item) {
    if (!item) return '';
    var kx = global.katex;
    if (!kx || typeof kx.renderToString !== 'function') {
      return _esc(item.raw);
    }
    var key = (item.display ? 'D' : 'I') + '\u0001' + item.tex;
    var hit = _cache.get(key);
    if (hit !== undefined) { _stats.hits++; return hit; }
    _stats.misses++;
    var html;
    try {
      html = kx.renderToString(item.tex, {
        displayMode: !!item.display,
        throwOnError: true,                             // 失败即回退纯文本，不做标红
        strict: false,                                  // 宽容：中文、非标准写法不报错
        trust: trustFn,                                 // 白名单式放行
        output: 'html'                                  // 省掉 MathML 副本，移动端 DOM 减半
      });
    } catch (e) {
      _stats.errors++;
      html = '<span class="clx-tex-raw" title="此处 LaTeX 未能解析，已按原文显示">' + _esc(item.raw) + '</span>';
    }
    if (_cache.size >= CACHE_LIMIT) _cache.clear();
    _cache.set(key, html);
    return html;
  }

  function restoreLatex(html, ctx) {
    if (!ctx || !ctx.math || !ctx.math.length) return html;
    return html.replace(RE_MATH_PH, function (m, i) {
      var it = ctx.math[+i];
      return it ? mathToHtml(it) : m;
    });
  }

  // ── 对外主入口 ────────────────────────────────────────────
  function renderMarkdownWithLatex(src) {
    var s = _str(src);
    if (!s) return '';
    if (typeof marked === 'undefined' || !marked || typeof marked.parse !== 'function') {
      return _plainHtml(s);
    }
    // 快路径：无公式符号、无样式命令、无潜在 htmlStyle 绕过 → 直接走 marked
    var hasMath = s.indexOf('$') >= 0 || s.indexOf('\\(') >= 0 || s.indexOf('\\[') >= 0;
    if (!hasMath && !STYLE_CMD_LINE.test(s) && s.indexOf('\\html') < 0) {
      try {
        return marked.parse(s, { breaks: true, gfm: true });
      } catch (e) {
        return _plainHtml(s);
      }
    }
    var ctx = extractLatex(s);
    var html;
    try {
      html = marked.parse(ctx.text, { breaks: true, gfm: true });
    } catch (e) {
      html = _plainHtml(ctx.text);
    }
    return restoreLatex(html, ctx);
  }

  // ── 导出 ──────────────────────────────────────────────────
  global.renderMarkdownWithLatex = renderMarkdownWithLatex;
  global.latexExtract = extractLatex;
  global.latexRestore = restoreLatex;
  global.latexRewrite = rewriteCommands;                // 单测 / 调试
  global.latexMatchBrace = matchBrace;
  global.latexStats = function () {
    return {
      cacheSize: _cache.size, hits: _stats.hits, misses: _stats.misses,
      errors: _stats.errors, fallback: _stats.fallback,
      rewrites: _stats.rewrites, wrappedLines: _stats.wrappedLines,
      hasKatex: !!(global.katex && global.katex.renderToString),
      rules: (RULES || buildRules()).map(function (r) { return r.name; })
    };
  };
  global.latexClearCache = function () { _cache.clear(); };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      renderMarkdownWithLatex: renderMarkdownWithLatex,
      extractLatex: extractLatex,
      restoreLatex: restoreLatex,
      rewriteCommands: rewriteCommands,
      matchBrace: matchBrace
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

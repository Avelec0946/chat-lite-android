// ===== latex.js : LaTeX 离线渲染模块（v116）=====
// 模块名：latex.js
// 版本：v116（cache-bust）
// 创建日期：2026-09-25
// 职责：字符串级 LaTeX 定界符提取 → marked 占位符穿越 → KaTeX HTML 回填
// 依赖：window.katex（KaTeX 0.16.x，缺失时整链降级为纯文本）、window.marked
// 加载顺序：在 vendor/katex/katex.min.js 之后、chat.js 之前（放在 db.js 前亦可）
// 不访问 state / settings，无副作用，可在 app.js 之前安全加载
//
// ── 设计要点 ────────────────────────────────────────────────
// 1. 管线顺序「提取公式 → marked 解析 → 回填 KaTeX」，而非「marked 先行、DOM 后处理」。
//    原因：公式内的 _ * \ 等字符若先经 marked 会被当作 markdown 语法破坏
//    （$x_1$ → $x<em>1</em>$），源码无法还原。先提取则公式以占位符穿越，原文完整。
// 2. 代码块采取「分区域跳过」而非「剥离-回填」：``` 与 ` 段落原样留在文本里交给
//    marked 自行渲染成 <pre><code>，只是不参与公式扫描。若整体剥离，代码块将失去
//    marked 的转义与包装。
// 3. 未闭合定界符天然不渲染：四条规则均为「只匹配成对」的惰性正则，流式输出中途的
//    半截公式不满足成对条件，自动保留为纯文本——无需显式闭合检测。
// 4. 渲染结果走 LRU 缓存：流式节流每 100ms 全量重渲一次，命中缓存后新增公式的
//    边际开销趋近于零。
// 5. 快路径：源文本不含 $ ( [ 之任一符号时，直接走 marked，零额外开销。

(function (global) {
  'use strict';

  var PH = '\u0000';                                   // 占位符定界（用户内容中不可能出现）
  var RE_MATH_PH = /\u0000M(\d+)\u0000/g;              // 公式占位符
  var CACHE_LIMIT = 1500;
  var _cache = new Map();
  var _stats = { hits: 0, misses: 0, errors: 0, fallback: 0 };

  // ── 工具 ──────────────────────────────────────────────────
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _plainHtml(src) {
    // marked 不可用时的降级：转义 + 换行
    return _esc(src).replace(/\n/g, '<br>');
  }

  // ── 定界符规则（按优先级：块级在前，避免 $$ 被 $ 规则先吃掉）──
  var RULES = null;
  function buildRules() {
    var rules = [
      { re: /\$\$([\s\S]+?)\$\$/g, display: true, name: 'dollar-block' },
      { re: /\\\[([\s\S]+?)\\\]/g, display: true, name: 'bracket-block' },
      { re: /\\\(([\s\S]+?)\\\)/g, display: false, name: 'paren-inline' }
    ];
    // 行内 $...$：左 $ 后非空白、右 $ 前非空白且右 $ 后非数字（防「$5 到 $10」误判）。
    // 用 lookbehind，需检测引擎支持；旧引擎下静默放弃该规则，其余三条仍可用。
    var dollar = null;
    try {
      dollar = new RegExp('(?<!\\\\)\\$(?!\\s)((?:\\\\\\$|[^$\\n])+?)(?<!\\s)\\$(?!\\d)', 'g');
      new RegExp('(?<!x)y').test('zy');   // 二次确认 lookbehind 真的被引擎接受
    } catch (e) {
      dollar = null;
      _stats.fallback++;
    }
    if (dollar) rules.push({ re: dollar, display: false, name: 'dollar-inline' });
    return rules;
  }
  function rules() { if (!RULES) RULES = buildRules(); return RULES; }

  // 代码保护段：``` 围栏、~~~ 围栏、行内 `code`
  var RE_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

  // ── 单段文本：应用四条定界符规则 ──────────────────────────
  function _applyMathRules(seg, math, force) {
    if (!force && seg.indexOf('$') < 0 && seg.indexOf('\\(') < 0 && seg.indexOf('\\[') < 0) {
      return seg;                                      // 快路径：本段无公式符号
    }
    var rs = rules();
    for (var i = 0; i < rs.length; i++) {
      var rule = rs[i];
      rule.re.lastIndex = 0;
      seg = seg.replace(rule.re, function (m, g1) {
        var tex = (g1 || '').trim();
        if (!tex) return m;                            // 空公式（如 $$ $$）原样保留
        math.push({ tex: tex, display: rule.display, raw: m });
        return PH + 'M' + (math.length - 1) + PH;
      });
    }
    return seg;
  }

  // ── 提取：按代码段切分，只在非代码区替换公式 ──────────────
  function extractLatex(src) {
    var math = [];
    var s = String(src == null ? '' : src);
    if (s.indexOf('$') < 0 && s.indexOf('\\(') < 0 && s.indexOf('\\[') < 0) {
      return { text: s, math: math };                   // 整篇无公式，直接返回
    }
    var out = '';
    var last = 0;
    var m;
    RE_CODE.lastIndex = 0;
    while ((m = RE_CODE.exec(s)) !== null) {
      out += _applyMathRules(s.slice(last, m.index), math, false);
      out += m[0];                                      // 代码段原样保留，交 marked 处理
      last = m.index + m[0].length;
    }
    out += _applyMathRules(s.slice(last), math, false);
    return { text: out, math: math };
  }

  // ── 公式 → KaTeX HTML（带缓存）───────────────────────────
  function mathToHtml(item) {
    if (!item) return '';
    var kx = global.katex;
    if (!kx || typeof kx.renderToString !== 'function') {
      return _esc(item.raw);                            // KaTeX 缺失：回填原文（转义）
    }
    var key = (item.display ? 'D' : 'I') + '\u0001' + item.tex;
    var hit = _cache.get(key);
    if (hit !== undefined) { _stats.hits++; return hit; }
    _stats.misses++;
    var html;
    try {
      html = kx.renderToString(item.tex, {
        displayMode: !!item.display,
        throwOnError: false,                            // 语法错误渲染成内联红字，不中断整条消息
        errorColor: '#e06c75',
        strict: false,                                  // 宽容模式：中文 \text、非标准命令不报错
        trust: false,                                   // 禁用 \href 等可信命令，防注入
        output: 'html'                                  // 省掉 MathML 副本，移动端 DOM 体积减半
      });
    } catch (e) {
      _stats.errors++;
      html = '<span class="katex-error" title="LaTeX 渲染失败">' + _esc(item.raw) + '</span>';
    }
    if (_cache.size >= CACHE_LIMIT) _cache.clear();     // 简易淘汰：整体清空
    _cache.set(key, html);
    return html;
  }

  // ── 回填 ──────────────────────────────────────────────────
  function restoreLatex(html, math) {
    if (!math || !math.length) return html;
    return html.replace(RE_MATH_PH, function (m, i) {
      var item = math[+i];
      return item ? mathToHtml(item) : m;
    });
  }

  // ── 对外主入口：markdown 源文本 → 含公式的 HTML ───────────
  function renderMarkdownWithLatex(src) {
    var s = String(src == null ? '' : src);
    if (!s) return '';
    if (typeof marked === 'undefined' || !marked || typeof marked.parse !== 'function') {
      return _plainHtml(s);                             // marked 缺失：降级为纯文本
    }
    var ctx = extractLatex(s);
    if (!ctx.math.length) {
      try {
        return marked.parse(ctx.text, { breaks: true, gfm: true });
      } catch (e) {
        return _plainHtml(ctx.text);
      }
    }
    var html;
    try {
      html = marked.parse(ctx.text, { breaks: true, gfm: true });
    } catch (e) {
      html = _plainHtml(ctx.text);
    }
    return restoreLatex(html, ctx.math);
  }

  // ── 导出 ──────────────────────────────────────────────────
  global.renderMarkdownWithLatex = renderMarkdownWithLatex;
  global.latexExtract = extractLatex;                   // 单测 / 调试
  global.latexRestore = restoreLatex;
  global.latexStats = function () {
    return {
      cacheSize: _cache.size, hits: _stats.hits, misses: _stats.misses,
      errors: _stats.errors, fallback: _stats.fallback,
      hasKatex: !!(global.katex && global.katex.renderToString),
      rules: (RULES || buildRules()).map(function (r) { return r.name; })
    };
  };
  global.latexClearCache = function () { _cache.clear(); };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      renderMarkdownWithLatex: renderMarkdownWithLatex,
      extractLatex: extractLatex,
      restoreLatex: restoreLatex
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

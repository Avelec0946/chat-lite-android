// ===== latex.js : LaTeX 渲染模块（v117）=====
// 模块名：latex.js
// 版本：v117（cache-bust）
// 创建日期：2026-09-25（v116 首版；v117 新增文本样式指令层 + 优雅回退）
// 职责：三层渲染 ——
//   Layer 1  数学公式      $…$ / $$…$$ / \(…\) / \[…\]  →  KaTeX
//   Layer 2  文本样式指令  \scalebox \textcolor \textbf … →  HTML/CSS
//   Layer 3  代码保护      ``` 围栏与 `code` 内一律不处理
// 依赖：window.katex（缺失时公式回退原文）、window.marked
// 加载顺序：在 vendor/katex/katex.min.js 之后、chat.js 之前
// 不访问 state / settings，无副作用
//
// ── 设计要点 ────────────────────────────────────────────────
// 1. 管线顺序「先提取 → marked 解析 → 回填 HTML」，而非「marked 先行、DOM 后处理」。
//    原因：公式内的 _ * \ 等字符若先经 marked 会被当作 markdown 语法破坏
//    （$x_1$ → $x<em>1</em>$），源码无法还原。
// 2. 代码块采取「分区域跳过」而非「剥离-回填」：``` 与 ` 段落原样留在文本里交给
//    marked 自行渲染成 <pre><code>，只是不参与扫描。整体剥离会让代码块失去
//    marked 的转义与包装。
// 3. 未闭合定界符天然不渲染：所有规则均为「只匹配成对」的惰性正则，流式输出中途的
//    半截公式不满足成对条件，自动保留为纯文本——无需显式闭合检测。
// 4. 渲染失败优雅回退（2026-09-25 参照 DeepSeek 网页端实现）：
//    DeepSeek 用 katex.renderToString(..., {throwOnError:true, strict:false}) 并以
//    try/catch 兜底，失败时退回纯文本。本模块采用同一策略——不再用 errorColor 标红，
//    避免整段消息被刺眼的红色错误提示污染。
// 5. 文本样式指令层（Layer 2）：KaTeX 不认识 \scalebox 等排版命令（会标红），
//    这些命令本质不属于数学排版，故单独用 HTML/CSS 渲染，与数学管线分离。

(function (global) {
  'use strict';

  var PH = '\u0000';                                   // 占位符定界（用户内容中不可能出现）
  var RE_MATH_PH = /\u0000M(\d+)\u0000/g;              // 公式占位符
  var RE_CMD_PH = /\u0000X(\d+)\u0000/g;               // 指令占位符
  var CACHE_LIMIT = 1500;
  var _cache = new Map();
  var _stats = { hits: 0, misses: 0, errors: 0, fallback: 0, cmdFallback: 0, cmds: 0 };
  var MAX_SCALE = 8;                                   // 字号倍率上限（防版面爆炸）

  // ── 工具 ──────────────────────────────────────────────────
  function _str(s) { return s == null ? '' : String(s); }

  function _esc(s) {
    return _str(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 转义但保留占位符（占位符是 NUL 序列，不能被转义破坏）
  function _escKeepPh(s) {
    var parts = _str(s).split(/\u0000([MX]\d+)\u0000/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      out += (i % 2 === 1) ? (PH + parts[i] + PH) : _esc(parts[i]);
    }
    return out;
  }

  function _plainHtml(src) {
    return _esc(src).replace(/\n/g, '<br>');
  }

  // ── Layer 1：数学定界符规则（按优先级：块级在前，避免 $$ 被 $ 规则先吃掉）──
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
      new RegExp('(?<!x)y').test('zy');               // 二次确认 lookbehind 真的被引擎接受
    } catch (e) {
      dollar = null;
      _stats.fallback++;
    }
    if (dollar) rules.push({ re: dollar, display: false, name: 'dollar-inline' });
    return rules;
  }
  function rules() { if (!RULES) RULES = buildRules(); return RULES; }

  // ── Layer 3：代码保护段（``` 围栏、~~~ 围栏、行内 `code`）──
  var RE_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

  // ── Layer 2：文本样式指令 ─────────────────────────────────
  // 指令嗅探（不带 g，供 test() 使用）：整篇快路径判断 + 公式内指令检测
  var TEXT_CMD_SNIFF = /\\(?:scalebox|fontsize|fs|textcolor|colorbox|bgcolor|color|hl|textbf|bf|textit|emph|it|underline|ul|sout|st|del|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|begin\s*\{\s*(?:center|right))(?![a-zA-Z])/;

  // 预设字号命令 → em 倍率（沿用 LaTeX 的视觉比例）
  var SIZE_CMDS = {
    tiny: 0.5, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1,
    large: 1.2, Large: 1.44, LARGE: 1.73, huge: 2.07, Huge: 2.49
  };

  // 通用形式：命令 + 参数(可选花括号) + 内容(花括号 或 到行尾)
  //   捕获组从后往前取：最后一个非 undefined = 内容，再前一个 = 参数
  var CMD_DEFS = [
    { kind: 'scale', re: /\\scalebox\s*(?:\{\s*([0-9]*\.?[0-9]+)\s*\}|([0-9]*\.?[0-9]+))\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'scale', re: /\\fontsize\s*(?:\{\s*([0-9]*\.?[0-9]+)\s*\}|([0-9]*\.?[0-9]+))\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'scale', re: /\\fs\s*\{?([0-9]*\.?[0-9]+)\}?\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'color', re: /\\textcolor\s*\{([^{}]+)\}\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'color', re: /\\color\s*\{([^{}]+)\}\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'bg', re: /\\colorbox\s*\{([^{}]+)\}\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'bg', re: /\\bgcolor\s*\{([^{}]+)\}\s*(?:\{([^{}]*)\}|([^\n]*))/g },
    { kind: 'hl', re: /\\hl\s*\{([^{}]*)\}/g },
    { kind: 'bold', re: /\\textbf\s*\{([^{}]*)\}/g },
    { kind: 'bold', re: /\\bf\s*\{([^{}]*)\}/g },
    { kind: 'italic', re: /\\textit\s*\{([^{}]*)\}/g },
    { kind: 'italic', re: /\\emph\s*\{([^{}]*)\}/g },
    { kind: 'italic', re: /\\it\s*\{([^{}]*)\}/g },
    { kind: 'underline', re: /\\underline\s*\{([^{}]*)\}/g },
    { kind: 'underline', re: /\\ul\s*\{([^{}]*)\}/g },
    { kind: 'strike', re: /\\sout\s*\{([^{}]*)\}/g },
    { kind: 'strike', re: /\\st\s*\{([^{}]*)\}/g },
    { kind: 'strike', re: /\\del\s*\{([^{}]*)\}/g },
    // 环境：\begin{center} … \end{center}（可跨行）
    { kind: 'center', re: /\\begin\s*\{\s*center\s*\}([\s\S]*?)\\end\s*\{\s*center\s*\}/g },
    { kind: 'right', re: /\\begin\s*\{\s*right\s*\}([\s\S]*?)\\end\s*\{\s*right\s*\}/g },
    // 预设字号命令：作用于本行剩余内容
    { kind: 'sizeCmd', re: /\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![a-zA-Z])\s*([^\n]*)/g }
  ];

  // 颜色白名单（防 style 注入）：颜色名 / hex / rgb(a) / hsl(a)，再补常见 LaTeX 别名
  var COLOR_ALIAS = {
    red: 'red', blue: 'blue', green: 'green', yellow: 'yellow', orange: 'orange',
    purple: 'purple', pink: 'pink', gray: 'gray', grey: 'gray', black: 'black',
    white: 'white', cyan: 'cyan', magenta: 'magenta', brown: 'brown', lime: 'lime',
    teal: 'teal', navy: 'navy', olive: 'olive', maroon: 'maroon', silver: 'silver',
    gold: 'gold', violet: 'violet', indigo: 'indigo', crimson: 'crimson',
    darkred: '#8b0000', darkblue: '#00008b', darkgreen: '#006400',
    lightgray: '#d3d3d3', lightgrey: '#d3d3d3', lightblue: '#add8e6',
    lightgreen: '#90ee90', darkorange: '#ff8c00', steelblue: '#4682b4'
  };
  function cssColor(raw) {
    var s = _str(raw).trim();
    if (!s) return 'currentColor';
    if (/^[a-zA-Z]{3,20}$/.test(s)) return COLOR_ALIAS[s.toLowerCase()] || 'currentColor';
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^rgba?\(\s*[0-9.,%\s]+\)$/.test(s)) return s;
    if (/^hsla?\(\s*[0-9.,%\s]+\)$/.test(s)) return s;
    return 'currentColor';
  }

  // 指令 → HTML
  function cmdToHtml(item) {
    if (!item) return '';
    var inner = _escKeepPh(item.inner || '');
    switch (item.kind) {
      case 'scale': {
        var n = parseFloat(item.arg);
        if (!isFinite(n) || n <= 0) return inner;
        if (n < 0.3) n = 0.3;
        if (n > MAX_SCALE) n = MAX_SCALE;
        return '<span class="clx-scale" style="font-size:' + (Math.round(n * 1000) / 1000) + 'em">' + inner + '</span>';
      }
      case 'sizeCmd': {
        var m = SIZE_CMDS[item.arg] || 1;
        return '<span class="clx-scale" style="font-size:' + m + 'em">' + inner + '</span>';
      }
      case 'color':
        return '<span class="clx-color" style="color:' + cssColor(item.arg) + '">' + inner + '</span>';
      case 'bg':
        return '<span class="clx-bg" style="background-color:' + cssColor(item.arg) + '">' + inner + '</span>';
      case 'hl':
        return '<mark class="clx-mark">' + inner + '</mark>';
      case 'bold': return '<strong class="clx-bold">' + inner + '</strong>';
      case 'italic': return '<em class="clx-italic">' + inner + '</em>';
      case 'underline': return '<u class="clx-underline">' + inner + '</u>';
      case 'strike': return '<del class="clx-strike">' + inner + '</del>';
      case 'center': return '<div class="clx-block clx-center">' + inner + '</div>';
      case 'right': return '<div class="clx-block clx-right">' + inner + '</div>';
    }
    return inner;
  }

  // 在给定文本段上应用全部指令（inner 递归处理，支持指令嵌套）
  function applyCommands(seg, cmds, depth) {
    if (!TEXT_CMD_SNIFF.test(seg)) return seg;
    if (depth > 4) return seg;                          // 递归深度保护
    for (var i = 0; i < CMD_DEFS.length; i++) {
      var def = CMD_DEFS[i];
      def.re.lastIndex = 0;
      seg = seg.replace(def.re, function () {
        var args = Array.prototype.slice.call(arguments);
        var groups = args.slice(1, args.length - 2);    // 去掉 match / offset / string
        var inner = '', arg = '';
        for (var k = groups.length - 1; k >= 0; k--) {
          if (groups[k] === undefined) continue;
          if (!inner) { inner = groups[k]; }
          else { arg = groups[k]; break; }
        }
        inner = applyCommands(inner, cmds, depth + 1);  // 子指令递归
        cmds.push({ kind: def.kind, arg: arg, inner: inner });
        _stats.cmds++;
        return PH + 'X' + (cmds.length - 1) + PH;
      });
    }
    return seg;
  }

  // ── 单段文本：先公式、后指令 ──────────────────────────────
  function _applyMathRules(seg, math) {
    if (!seg) return seg;
    if (seg.indexOf('$') < 0 && seg.indexOf('\\(') < 0 && seg.indexOf('\\[') < 0) return seg;
    var rs = rules();
    for (var i = 0; i < rs.length; i++) {
      var rule = rs[i];
      rule.re.lastIndex = 0;
      seg = seg.replace(rule.re, function (m, g1) {
        var tex = (g1 || '').trim();
        if (!tex) return m;                             // 空公式（如 $$ $$）原样保留
        // 公式里含文本样式指令（KaTeX 不认）→ 剥掉定界符交回文本流，由指令层渲染
        if (TEXT_CMD_SNIFF.test(tex)) {
          _stats.cmdFallback++;
          return g1;
        }
        math.push({ tex: tex, display: rule.display, raw: m });
        return PH + 'M' + (math.length - 1) + PH;
      });
    }
    return seg;
  }

  function _processSeg(seg, ctx) {
    seg = _applyMathRules(seg, ctx.math);
    seg = applyCommands(seg, ctx.cmds, 0);
    return seg;
  }

  // ── 提取：按代码段切分，只在非代码区处理 ──────────────────
  function extractLatex(src) {
    var ctx = { text: '', math: [], cmds: [] };
    var s = _str(src);
    var out = '';
    var last = 0;
    var m;
    RE_CODE.lastIndex = 0;
    while ((m = RE_CODE.exec(s)) !== null) {
      out += _processSeg(s.slice(last, m.index), ctx);
      out += m[0];                                      // 代码段原样保留，交 marked 处理
      last = m.index + m[0].length;
    }
    out += _processSeg(s.slice(last), ctx);
    ctx.text = out;
    return ctx;
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
        // throwOnError:true + catch 兜底（取自 DeepSeek 网页端的做法）：
        // 失败时退回纯文本，而不是用 errorColor 把整段标红
        throwOnError: true,
        strict: false,                                  // 宽容模式：中文、非标准命令不报错
        trust: false,                                   // 禁用 \href 等，防注入
        output: 'html'                                  // 省掉 MathML 副本，移动端 DOM 体积减半
      });
    } catch (e) {
      _stats.errors++;
      html = '<span class="clx-tex-raw" title="此处 LaTeX 未能解析，已按原文显示">' + _esc(item.raw) + '</span>';
    }
    if (_cache.size >= CACHE_LIMIT) _cache.clear();     // 简易淘汰：整体清空
    _cache.set(key, html);
    return html;
  }

  // ── 回填：先指令（其 HTML 内可能含公式占位符），再公式 ────
  function restoreLatex(html, ctx) {
    if (!ctx) return html;
    if (ctx.cmds && ctx.cmds.length) {
      // 指令可嵌套（外层指令的 HTML 里仍含内层占位符），故循环回填至稳定
      var prev = null;
      var guard = 0;
      while (html !== prev && guard++ < 8) {
        prev = html;
        html = html.replace(RE_CMD_PH, function (m, i) {
          var it = ctx.cmds[+i];
          return it ? cmdToHtml(it) : m;
        });
      }
    }
    if (ctx.math && ctx.math.length) {
      html = html.replace(RE_MATH_PH, function (m, i) {
        var it = ctx.math[+i];
        return it ? mathToHtml(it) : m;
      });
    }
    return html;
  }

  // ── 对外主入口：文本 → 含公式与样式指令的 HTML ────────────
  function renderMarkdownWithLatex(src) {
    var s = _str(src);
    if (!s) return '';
    if (typeof marked === 'undefined' || !marked || typeof marked.parse !== 'function') {
      return _plainHtml(s);                             // marked 缺失：降级为纯文本
    }
    // 快路径：既无公式符号也无样式指令 → 直接走 marked，零额外开销
    var hasMath = s.indexOf('$') >= 0 || s.indexOf('\\(') >= 0 || s.indexOf('\\[') >= 0;
    if (!hasMath && !TEXT_CMD_SNIFF.test(s)) {
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
  global.latexExtract = extractLatex;                   // 单测 / 调试
  global.latexRestore = restoreLatex;
  global.latexCmdToHtml = cmdToHtml;
  global.latexStats = function () {
    return {
      cacheSize: _cache.size, hits: _stats.hits, misses: _stats.misses,
      errors: _stats.errors, fallback: _stats.fallback,
      cmdFallback: _stats.cmdFallback, cmds: _stats.cmds,
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
      cmdToHtml: cmdToHtml
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

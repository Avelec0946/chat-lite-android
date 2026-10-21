// v129 多轮回归 runner：node tools/multiturn.js
// 依赖：本地静态服务 8777（serve.js）+ 无头 Chrome（cdp.js）
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CDP = process.env.VOICE_CDP || 'D:\\Computer tools\\DSH分工作区\\chat-lite计划\\tools\\cdp.js';
const PAGE = path.join(__dirname, 'fixtures', 'voice-multiturn-page.js');
const URL_ = process.env.VOICE_E2E_URL || 'http://127.0.0.1:8777/index.html';

const KEYS = {
  mimo: process.env.VOICE_E2E_MIMO_KEY || process.env.VOICE_MIMO_KEY || '',
  ds: process.env.VOICE_E2E_DS_KEY || process.env.VOICE_DS_KEY || ''
};

// 入口脚本：先注入 key + 配渠道，再跑多轮
const WRAP = path.join(require('os').tmpdir(), 'chatlite-multiturn-entry.js');
fs.writeFileSync(WRAP, `
module.exports = async (ctx) => {
  const keys = ${JSON.stringify(KEYS)};
  await ctx.ev('window.__e2eKeys = ' + JSON.stringify(keys) + '; window.__e2eErrors = []; 1');
  await ctx.ev("window.addEventListener('error', function(e){ window.__e2eErrors.push('error: ' + (e.message||'')); }); " +
               "window.addEventListener('unhandledrejection', function(e){ window.__e2eErrors.push('reject: ' + (e.reason && (e.reason.message || e.reason))); }); 1");
  const setupSrc = require('fs').readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'voice-e2e-setup.js'))}, 'utf8');
  console.log('SETUP ' + await ctx.ev(setupSrc));
  const pageSrc = require('fs').readFileSync(${JSON.stringify(PAGE)}, 'utf8');
  const out = await ctx.ev(pageSrc);
  console.log('RESULT ' + String(out));
};
`, 'utf8');

const child = spawn(process.execPath, [CDP, URL_, WRAP, '390', '844'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', d => { buf += d; process.stdout.write(d); });
child.stderr.on('data', d => { process.stderr.write(d); });
child.on('close', (code) => {
  const m = buf.match(/RESULT (\{[\s\S]*\})/);
  if (!m) { console.error('\n没拿到 RESULT（退出码 ' + code + '）'); process.exit(2); }
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { console.error('\nRESULT 解析失败：' + e.message); process.exit(2); }
  console.log('\n=== 多轮判定 ===');
  let fail = 0;
  const seen = new Set();
  (data.turns || []).forEach((t, i) => {
    const asst = String(t.asst || '');
    const okLen = asst.replace(/[\s。，,.!！?？…、；：]/g, '').length >= 8;
    const dup = seen.has(asst);
    seen.add(asst);
    console.log(`第${i + 1}轮  用户「${t.said}」`);
    console.log(`   AI「${asst}」`);
    console.log(`   长度够=${okLen} 与前面重复=${dup} 兜底=${!!(t.brain && t.brain.fallback)} 重试=${!!(t.brain && t.brain.retried)} 用时=${t.ms}ms`);
    if (!okLen || dup) fail++;
  });
  const distinct = seen.size;
  console.log(`\n不同回复数 ${distinct}/${(data.turns || []).length}`);
  if (distinct < (data.turns || []).length) fail++;
  console.log('落库尾部：' + JSON.stringify(data.tail, null, 1));
  if ((data.errors || []).length) { console.log('页面异常：' + JSON.stringify(data.errors)); fail++; }
  console.log(fail === 0 ? '\n全部通过' : `\n有 ${fail} 项不达标`);
  process.exit(fail === 0 ? 0 : 1);
});

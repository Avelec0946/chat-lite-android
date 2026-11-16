// ===== image-gen.test.js : 生图格式族（重点 v127 的 minimax_h3）=====
// 运行：node tests/image-gen.test.js
// 思路：image-gen.js 没有顶层副作用，用 vm 灌进一个沙箱（补上 app.js 提供的运行时依赖），
//   再对纯函数（buildBody / buildImageRequestPayload / normalizeImageProvider / 错误提取）逐条断言。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'www', 'image-gen.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++; fails.push(name);
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}
function eq(name, actual, expect) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expect), { actual: actual, expect: expect });
}
function section(t) { console.log('\n【' + t + '】'); }

// ---- 沙箱：只补 image-gen.js 依赖的运行时符号 ----
const sandbox = {
  console: console,
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, appendChild() {} }) },
  window: {},
  navigator: { userAgent: 'node' },
  settings: { images: [], imageProviders: [] },
  state: {},
  showToast: () => {},
  escapeHtml: (s) => String(s),
  normalizeBaseUrl: (u) => {
    let s = String(u || '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  },
  uid: (() => { let i = 0; return () => 'id' + (++i); })(),
  isCapacitor: () => false,
  CapFilesystem: null,
  Capacitor: null,
  parseJsonField: (v) => v,
  // Web 平台对象：buildImageRequestPayload 用到 URL / FormData / Blob，另有 base64 与计时器
  URL: URL,
  URLSearchParams: URLSearchParams,
  FormData: FormData,
  Blob: Blob,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  AbortController: AbortController,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(SRC, ctx, { filename: 'image-gen.js' });

// 取出被测符号（顶层 const 在全局词法环境里，用求值桥接）
function get(expr) { return vm.runInContext(expr, ctx); }
const IMAGE_FORMATS = get('IMAGE_FORMATS');
const buildBodyOf = (fmt) => (provider, c) => get('IMAGE_FORMATS')[fmt].buildBody(provider, c);
const buildImageSizeConfig = get('buildImageSizeConfig');
const normalizeImageProvider = get('normalizeImageProvider');
const buildImageRequestPayload = get('buildImageRequestPayload');
const extractImageApiError = get('extractImageApiError');
const classifyImageError = get('classifyImageError');
const imageRefLimitForFormat = get('imageRefLimitForFormat');
const migrateImageTemplate = get('migrateImageTemplate');

const P = () => normalizeImageProvider({
  name: 'h3', template: 'minimax', baseUrl: 'https://api.minimax.cn',
  apiKey: 'k', defaultModel: 'MiniMax-H3-Image'
});

// ===== 1. 格式族注册 =====
section('1. 格式族注册');
const h3 = IMAGE_FORMATS.minimax;
ok('minimax 族已注册（协议命名，不是模型名）', !!h3);
eq('文生图端点', h3.endpointPath, '/v1/images/generations');
eq('图生图端点', h3.editsPath, '/v1/images/edits');
eq('参考图通道', h3.refMode, 'json');
eq('默认模型', h3.defaultModel, 'MiniMax-H3-Image');
eq('批量上限', h3.features.maxBatch, 10);
eq('参考图上限', imageRefLimitForFormat('minimax_h3'), 16);
ok('image-01 的老接口彻底不在了（/v1/image_generation 单数）',
   !Object.keys(IMAGE_FORMATS).some(k => IMAGE_FORMATS[k].endpointPath === '/v1/image_generation'));
eq('v127 的临时族名回指 minimax', migrateImageTemplate('minimax_h3'), 'minimax');
eq('未知族名仍回退 flat', migrateImageTemplate('不存在的族'), 'flat');
ok('minimax 族只对应一套协议（端点复数）', IMAGE_FORMATS.minimax.endpointPath === '/v1/images/generations');

// ===== 2. 归一化 =====
section('2. normalizeImageProvider');
const p = P();
eq('requestFormat', p.requestFormat, 'minimax');
eq('refMode 透传', p.refMode, 'json');
eq('editsPath 保留', p.editsPath, '/v1/images/edits');
const flatP = normalizeImageProvider({ name: 'f', template: 'flat', baseUrl: 'https://x.y', apiKey: 'k' });
eq('flat 的老通道仍是 multipart', flatP.refMode, 'multipart');

// ===== 3. 尺寸 =====
section('3. 尺寸（WxH / area 二选一）');
const sz2k169 = buildImageSizeConfig(p, '2K', '16:9', '');
eq('2K 16:9 → 2048x1152', sz2k169.size, '2048x1152');
const szAuto = buildImageSizeConfig(p, 'auto', 'auto', '');
eq('全自由 → size auto', szAuto.size, 'auto');

// ===== 4. 请求体 =====
section('4. buildBody');
const b1 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: sz2k169, n: 1, promptExtend: true });
eq('文生图 size 走 WxH', b1.size, '2048x1152');
eq('文生图不带 images', b1.images, undefined);
eq('response_format=url', b1.response_format, 'url');
eq('默认不关提示词增强', b1.disable_prompt_enhanced, undefined);

const b2 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: szAuto, n: 1, promptExtend: true, resolution: 'auto' });
eq('全自由 → 显式 area=2K（不让服务端默认 4K）', b2.area, '2K');
eq('全自由 → 不发 size', b2.size, undefined);

const b2b = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: szAuto, n: 1, promptExtend: true, resolution: '4K' });
eq('分辨率选了 4K → area=4K', b2b.area, '4K');

const b3 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '把图1换成灰阶', refDataUrls: ['data:image/jpeg;base64,AAA', 'data:image/png;base64,BBB'], sizeConfig: sz2k169, n: 2, promptExtend: true });
eq('参考图 → images[].image_url', b3.images, [{ image_url: 'data:image/jpeg;base64,AAA' }, { image_url: 'data:image/png;base64,BBB' }]);
eq('参考图 → 打 _useEdits 标记', b3._useEdits, true);
eq('参考图 + 批量 n 保留', b3.n, 2);

const b4 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: sz2k169, n: 1, promptExtend: false });
eq('关增强 + 有 WxH → disable_prompt_enhanced', b4.disable_prompt_enhanced, true);
eq('关增强 + 有 WxH → 不额外发 aspect_ratio', b4.aspect_ratio, undefined);

const b5 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: szAuto, n: 1, promptExtend: false, resolution: '2K' });
eq('关增强 + 全自由 → 补 aspect_ratio', b5.aspect_ratio, '1:1');
eq('关增强 + 全自由 → 仍带 disable', b5.disable_prompt_enhanced, true);
ok('关增强 + 全自由 → 不出现 size 与 aspect_ratio 冲突（无 size）', b5.size === undefined);

const b6 = h3.buildBody(p, { model: 'MiniMax-H3-Image', prompt: '猫', refDataUrls: [], sizeConfig: sz2k169, n: 99, promptExtend: true });
eq('n 钳到 10', b6.n, 10);

// ===== 5. 请求装配（URL / 通道 / 下划线字段）=====
section('5. buildImageRequestPayload');
const r1 = buildImageRequestPayload(p, b1);
ok('文生图 URL 落在 /v1/images/generations', r1.url === 'https://api.minimax.cn/v1/images/generations', r1.url);
eq('文生图 Content-Type', r1.headers['Content-Type'], 'application/json');

const r2 = buildImageRequestPayload(p, b3);
ok('带参考图 → 切到 /v1/images/edits', r2.url === 'https://api.minimax.cn/v1/images/edits', r2.url);
eq('带参考图 → JSON 而非 FormData', r2.headers['Content-Type'], 'application/json');
ok('带参考图 → payload 不是 FormData', !(r2.payload && r2.payload.constructor && r2.payload.constructor.name === 'FormData'));
const pkeys = Object.keys(r2.payload);
ok('下划线内部字段已剥掉', pkeys.every(k => k.charAt(0) !== '_'), pkeys);
eq('images 原样保留', r2.payload.images.length, 2);
eq('prompt 保留', r2.payload.prompt, '把图1换成灰阶');

const r3 = buildImageRequestPayload(flatP, { model: 'm', prompt: 'p', n: 1, size: '1024x1024', _useEdits: true, _refDataUrls: ['data:image/png;base64,AAA'] });
ok('flat 的 multipart 通道未被破坏（仍走 edits）', r3.url === 'https://x.y/v1/images/edits', r3.url);

// ===== 6. 错误提取 =====
section('6. extractImageApiError');
const e1 = extractImageApiError({ data: null, base_resp: { status_code: 2013, status_msg: 'invalid params, unsupported model: MiniMax-H3-Image' } });
ok('image-01 式 2013 → fatal', !!e1.fatal && e1.fatal.indexOf('2013') > 0, e1);
ok('2013 文案点明模型名问题', /模型名/.test(e1.fatal), e1.fatal);

const e2 = extractImageApiError({ data: null, base_resp: { status_code: 1008, status_msg: 'insufficient balance' } });
ok('1008 → 余额不足', /余额不足/.test(e2.fatal || ''), e2.fatal);

const e3 = extractImageApiError({ type: 'error', error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)', http_code: '402' } });
ok('H3 顶层 type:error → fatal 带 message', /insufficient balance/.test(e3.fatal || ''), e3.fatal);
ok('顶层错误带 HTTP 码', /402/.test(e3.fatal || ''), e3.fatal);

const e4 = extractImageApiError({ data: [{ url: 'http://a/1.jpg' }, { error: { code: '1027', message: 'output image failed content safety check' } }], output_format: 'jpeg' });
ok('部分失败 → partial 而非 fatal', !e4.fatal && !!e4.partial, e4);
ok('partial 说明成功/失败张数', /1 张成功、1 张失败/.test(e4.partial || ''), e4.partial);

const e5 = extractImageApiError({ data: [{ error: { message: 'bad' } }, { error: { message: 'worse' } }] });
ok('全失败 → fatal', !!e5.fatal && !e5.partial, e5);

const e6 = extractImageApiError({ data: [{ url: 'http://a/1.jpg', size: '1024x1024' }], output_format: 'jpeg' });
ok('正常响应 → 不误报', !e6.fatal && !e6.partial, e6);

const e7 = extractImageApiError({ id: 'x', data: { image_urls: ['http://a/1.jpg'] }, base_resp: { status_code: 0, status_msg: 'success' } });
ok('image-01 正常响应（data 是对象）→ 不误报', !e7.fatal && !e7.partial, e7);

const e8 = extractImageApiError(null);
ok('null 响应 → 不抛错', !e8.fatal && !e8.partial, e8);

// ===== 7. parseResponse =====
section('7. parseResponse');
const pr = h3.parseResponse({ data: [{ url: 'http://a/1.jpg' }, { error: { message: 'x' } }] });
eq('滤掉失败项', pr, [{ url: 'http://a/1.jpg' }]);
eq('data 非数组时返回空', h3.parseResponse({ data: null }), []);

// ===== 8. 错误分类 =====
section('8. classifyImageError');
const c402 = classifyImageError(402, '{"type":"error","error":{"type":"insufficient_balance_error"}}', null);
ok('402 → 余额不足文案（不再贴原始 JSON）', /余额不足/.test(c402.hint) && !/\{/.test(c402.hint), c402.hint);
eq('402 不重试', c402.retryable, false);
ok('401 文案未变', /密钥无效/.test(classifyImageError(401, '', null).hint));

// ===== 汇总 =====
console.log('\n' + '='.repeat(56));
console.log('image-gen.test.js :  ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }

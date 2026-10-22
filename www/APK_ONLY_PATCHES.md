# APK 专属改动清单（v1.3.0+）

> 此文件由 `sync-from-upstream.ps1` 同步主仓库 `chat-lite/` 时**不会**自动维护。
> 主仓库同步会**直接覆盖** `www/`，凡下方列出的段落，sync 后**必须手动重新打补丁**。
>
> 维护规则：每次提交 APK 专属改动时，作者必须同步追加/更新本清单条目。
> 同步主仓库前，先 `git diff v1.3.0-baseline..HEAD -- www/app.js www/index.html www/style.css`，
> 把 diff 中含 `isCapacitor()` 分支或下方关键字的段落补登到此。

---

## 同步后必须重新打的补丁

### 1. Capacitor 文件系统 / Share / 流式 HTTP 相关（已有上游基础）
关键字：`CapStreamHttp`、`CapFilesystem`、`CapShare`、`isCapacitor()`、`ChatStream`（v122 自写插件）
位置：导入导出、流式请求、停止打断

### 2. v1.3.0 批次 1 改动（commit `1c42ee2`）
| 项 | 改动位置 | 说明 |
|---|---|---|
| A1 | `doBranchSearch` 清空 query 路径 | 加 `renderSearchResults()` 一行 |
| A2 | `deleteMessage` 同级回退 | `children[0]` → `children[最后]` |
| B3+B4 | `buildContext` 两处状态栏构造 | 移除硬编码 `【角色状态】` |
| A6 | `bubble.addEventListener('contextmenu')` | 改为自定义长按菜单 `showBubbleContextMenu` |
| D6 | `copyBtn` 处理逻辑 | 4 种复制变体下拉菜单 |
| D7 | A6 自定义菜单 | 加"复制选中文字"项 |
| C1 | 输入区浮层按钮 | 监听滚动 >200px 显示，点击滚到底 |
| C3 | 流式 chunk 处理 + settings | `navigator.vibrate` 节流 100ms，默认关 |

### 3. v1.3.0 批次 1+ 紧急修复：导入导出 OOM 崩溃
**根因**：原 `btoa(unescape(encodeURIComponent(jsonText)))` 路径在大数据（几十MB）时
同时持有 5 份字符串副本（jsonText + URI编码 + unescape + base64 + IPC），峰值内存约 5x
数据量，超过 Android WebView 默认堆限制 192MB，触发 OOM 卡退。

**修复**：改用 Filesystem 6.x 原生 `encoding: 'utf8'` 直接写文本，峰值降到 2x；
JSON 用紧凑格式（去 `null, 2` 缩进）再省 30%+ 体积。

| 函数 | 改动 |
|---|---|
| `exportAllData` | `btoa(unescape(encodeURIComponent(...)))` → `encoding:'utf8'` 直写；加 loading toast |
| `importAllData` | 导入前自动备份改同样路径；加 loading toast；备份失败不阻断 |
| `exportConversation` | 同样 `encoding:'utf8'` 优化（保险） |
| `importAllDataFromFile` | 大文件 >80MB 警告但不阻断；加读取中 toast；加 onerror 处理 |

### 4. 数据结构新增字段（sync 后旧 APK 数据无影响，但需保留读取兼容）
- `settings.hapticFeedback` (boolean, 默认 true，批次1+修正) — C3 振感开关

### 5. v116：LaTeX 适配 + 第三方库全本地化（**非 APK 专属，同期已同步至主仓库**）

本项**不满足**下方任一「不推主仓库」条件（无 `Cap*` / 无 `isCapacitor()` / 非 APK 独有行为），
故已于同日推送主仓库 chat-lite。登记于此仅为留痕。

| 项 | 内容 |
|---|---|
| 新增模块 | `latex.js` — 字符串级 LaTeX 渲染层（定界符提取 → NUL 占位符穿越 marked → KaTeX 回填） |
| 新增目录 | `vendor/`（26 文件 / 0.68MB）：`katex/` 0.16.47 + `fonts/`（20 个 woff2）、`marked/` 12.0.1、`highlight/` 11.9.0 |
| 改动文件 | `chat.js`（3 处 `marked.parse` → `renderMarkdownWithLatex`）、`style.css`（新增 KaTeX 适配段）、`index.html`（3 处 cdnjs → 本地 `vendor/`，新增 `latex.js`） |
| cache-bust | `chat.js` v102→v116、`style.css` v112→v116、`latex.js` 新增 v116；**其余 8 个模块 Cache-bust 保持原值不动**（遵 §4.7 只升变化模块） |
| KaTeX CSS 处理 | 上游 CSS 引用 woff2/woff/ttf 各 20 份；仅打包 woff2，故改写为只留 woff2（避免 40 个无谓 404），@font-face 数量仍为 20 |
| APK 影响 | 包体 3.80MB → **4.23MB**；`cap sync` 自动带 `vendor/`（已核验包内 `assets/public/vendor/…` 齐全、cdnjs 残留 0） |
| 同步工具 | `sync.ps1` 新增 `$sharedDirs = @("vendor")` 目录递归同步（逐文件 SHA1）+ `latex.js` 加入 `$sharedFiles` |

---

## 同步前自检命令

```powershell
# 1. 查看本批所有改动
git -C C:\Users\86176\chat-lite-android diff v1.3.0-baseline..HEAD -- www/

# 2. 检查是否含 Capacitor 专属符号（不应推到主仓库）
git -C C:\Users\86176\chat-lite-android diff v1.3.0-baseline..HEAD -- www/ | Select-String "CapStreamHttp|CapFilesystem|CapShare|isCapacitor"

# 3. sync 后核对补丁是否完整（grep 关键 APK 标记）
Select-String -Path C:\Users\86176\chat-lite-android\www\app.js -Pattern "showBubbleContextMenu|hapticFeedback|encoding: 'utf8'" -SimpleMatch
```

---

## 推到主仓库的判断标准

满足**任一**条件 → 不推主仓库：
1. 改动含 `isCapacitor()` 分支
2. 改动含 `Cap*` 前缀 API
3. 改动仅影响 APK 离线行为（如本地振动、本地画廊）
4. 改动是 APK UI 浮层（如 C1 回到底部按钮的桌面端无意义部分）
5. 改动是 APK 专属的 Filesystem 写入路径优化（如 encoding:'utf8' 替代 base64）

满足**全部**条件 → 可推主仓库：
1. 改动同样适用于 Web 版（如 A1/A2/B3/D6/D7）
2. 不引入 Capacitor 专属依赖
3. 数据结构向后兼容

> 注意：导入导出 OOM 修复涉及 Filesystem API，**不推主仓库**；
> 但 Web 模式的 `JSON.stringify` 紧凑化（去 null,2）属于通用优化，可单独提取推送。

### 5. v1.3.0 批次 1+ 修正：设置面板空白遮挡 + 振感开关失效
**根因**：
- `.settings-panel` 用 `align-items:center` + `.settings-content` 的 `overflow-y:auto`，内容超 80vh 时顶部被推出视口，第一屏被遮住。
- HTML 中振感开关 class 写成与 CSS 不匹配的值，点击状态切不动；且默认值为 false。

**修复**（cache-bust v49 -> v50）：
| 文件 | 改动 |
|---|---|
| `style.css` | `.settings-panel`: `align-items:center` -> `justify-content:center; overflow-y:auto; padding:20px 0`；`.settings-content` 加 `margin:auto` |
| `index.html` | 振感开关 class 改为 `toggle-switch`，加 `checked` 默认开；提示文本加「（默认开）」 |
| `app.js` | `getDefaultSettings` 中 `hapticFeedback:true`；`applySettings` 用 `!== false` 兼容旧用户；web 流式路径（约 2884/3088 行）补 `triggerHapticFeedback()` |

> 设置面板布局修复属于通用 CSS 优化，可推主仓库；振感默认值/触发属 APK 专属行为，不推。

### 6. v1.3.0 批次 1+ 修正：振感反馈真正生效（Capacitor Haptics 原生插件）
**根因**：原实现用 `navigator.vibrate(8)`，但 Android WebView 从 API 30+ 起默认禁用此 API，导致无论开关状态如何设备都不振动。

**修复**：
| 项 | 改动 |
|---|---|
| `package.json` | 新增依赖 `@capacitor/haptics@^6`（npm install --legacy-peer-deps） |
| `AndroidManifest.xml` | 新增 `<uses-permission android:name="android.permission.VIBRATE" />` |
| `app.js` 插件初始化 | 新增 `CapHaptics = Capacitor.Plugins.Haptics` |
| `app.js` triggerHapticFeedback | 优先 `CapHaptics.impact({style:'LIGHT',duration:8})` 走原生 Vibrator，回退 `navigator.vibrate` |

> 振感涉及 Capacitor 原生插件 + VIBRATE 权限，**不推主仓库**。


### 7. v1.3.0 批次 1+ 优化：线性马达质感五档分层（cache-bust v50 -> v52）
**背景**：用户反馈震感有效但手感偏粗，希望更大程度发挥 X 轴线性马达质感、更顺滑自然，优先参考小米/Redmi RichTap 调校。

**研究依据**（Android 官方触觉指南 + RichTap 文档）：
- LRA 单次干脆点击信号仅 10-20ms；两 primitive 间隔需 >=50ms 才不被融合
- 强度档差比需 >=1.4 倍才可感知；scale=0 是"最小可感知"非关闭
- sharpness 映射：0.0-0.2 THUD / 0.2-0.4 LOW_TICK / 0.4-0.6 TICK / 0.6-0.8 CLICK(弱) / 0.8-1.0 CLICK(满)
- RichTap 机型（Redmi Note 11/12 Turbo、K50 电竞版）对 LOW_TICK/TICK 还原度最高
- 流式 tick 强度应 <=0.3 避免反噬注意力；连续 30s 同强度会引发感觉适应

**修复**（重写 triggerHapticFeedback，5 档预加载 + 节奏分类 + 强度抖动）：
| 档位 | primitive | intensity | sharpness | gap | 场景 |
|---|---|---|---|---|---|
| CHAR  | TICK     | 0.18 | 0.55 | 38ms  | 字符主路径，轻脆不扰人 |
| SOFT  | TICK     | 0.28 | 0.55 | 50ms  | 逗号/空格次重音 |
| LOW   | LOW_TICK | 0.14 | 0.35 | 38ms  | 每 10 字低频点缀破单调 |
| CLICK | CLICK    | 0.55 | 0.85 | 60ms  | 。！？句末锐利清脆 |
| THUD  | THUD     | 0.72 | 0.15 | 120ms | \n 段落低频沉闷收束 |

**关键改进**：
- 原 2 档（tick 0.3 / punct 0.6）-> 5 档分层，频段+强度双维度对比
- 字符强度 0.3 -> 0.18（降 40%，避免密集 tick 疲劳）
- sharpness 0.9 -> 0.55（TICK 中频，原 0.9 太锐刺）
- 段落换行：原 CLICK 0.6 -> THUD 0.72（低频沉闷，与句号 CLICK 形成质感对比）
- 字符主路径每 3 次用 play 覆盖抖动强度 ±15%（0.15-0.21），模拟自然书写轻重
- throttle：90/180/250/300ms -> 38/50/60/120ms（更跟手不丢字感，不糊成一片）
- 仅 composition 引擎（Android 12+）下启用抖动，basic/web 引擎退回原行为

| 文件 | 改动 |
|---|---|
| `app.js` | 重写 _initStreamHaptics（5 档 preload）+ triggerHapticFeedback（节奏分类+抖动） |
| `index.html` | cache-bust v50 -> v52 |

> 振感涉及 Capacitor 原生插件，**不推主仓库**。


### 8. v1.3.0 批次 2：核心架构重构 B1+B3+B2（cache-bust v52 -> v53）
**范围**：全局/单独设置分离（B1）+ 状态栏模板/显示项分离（B3 剩余）+ 分模型提示词微调（B2）。
**不含 Capacitor 专属 API，属于通用架构重构，可推主仓库**。

#### 8.1 B1 全局/单独设置分离
**数据结构**：
- `settings.global = { thinkingEnabled, systemPrompt, emphasis, userIdentity, statusBar }` — 全局默认层
- `settings.modelPrompts = {}` — B2 模型级提示词（见 8.3）
- 会话级 `conv.{thinkingEnabled,systemPrompt,emphasis,userIdentity,statusBar}` 字段为 `null/undefined` 时继承全局

**新增函数**：
| 函数 | 作用 |
|---|---|
| `effective(conv, key)` | 读取有效设置：conv 非空优先，回退 settings.global |
| `effectiveStatusBar(conv)` | 状态栏对象有效值，兼容旧 `template` 字段名 → `templateRule` |
| `effectiveModelPrompt(conv)` | B2 模型级提示词，key 为 `providerId:modelId` |
| `fillSettingsForm()` | 根据 `state._settingsTab` 回填表单（conv tab 时 conv 优先回退 global） |

**改动函数**：
| 函数 | 改动 |
|---|---|
| `loadSettings` | 默认值加 `global` + `modelPrompts`；旧 settings 无 global 时从顶层 thinkingEnabled 派生迁移 |
| `newConversation` | 移除 `thinkingEnabled/systemPrompt/userIdentity` 硬编码，改为继承全局 |
| `buildContext` / `buildContextForContinue` | 用 `effective`/`effectiveStatusBar`/`effectiveModelPrompt` 取值；注入顺序：全局 → 会话 → 模型 → 状态栏 → userIdentity |
| `toggleSettings` | 拆出 `fillSettingsForm`，根据 tab 回填 |
| `saveSettingsHandler` | 根据 tab 保存到 global 或 conv；conv 空字符串转 null 继承全局 |
| `init` thinkingToggle 监听 | 同时更新 `settings.global.thinkingEnabled`；仅 conv tab 下同步到 conv |
| `restoreConversationState` / `newChat` | 移除 `conv.thinkingEnabled = settings.thinkingEnabled`（新会话继承全局） |
| `executeRequest` / `sendFromMessageContinue` reqBody | `conv.thinkingEnabled !== false` → `effective(conv,'thinkingEnabled') !== false` |
| 状态栏渲染 | `conv?.statusBar?.position` → `effectiveStatusBar(conv).position` |

**UI 改动**：
| 文件 | 改动 |
|---|---|
| `index.html` | settings-body 开头加 `settings-tabs`（当前会话/全局默认 tab + "使用全局设置"按钮） |
| `index.html` | tab 提示行 `tab-hint-conv`/`tab-hint-global` |
| `style.css` | `.settings-tabs` / `.settings-tab` / `.settings-tab.active` 样式 |
| `app.js` init | tab 切换 click 监听；"使用全局设置"按钮把 conv 提示词字段全设 null |

**数据迁移**：旧用户 conv 字段保留原值（非 null），不强制继承全局；新会话默认继承。`loadSettings` 自动补全 `global`/`modelPrompts` 字段。

#### 8.2 B3 剩余：状态栏模板/显示项分离
**数据结构**：`statusBar.template`（旧）→ `statusBar.templateRule`（新）+ `statusBar.displayFields`（新增）。
- `templateRule`：注入系统提示的指令（告诉模型输出什么）
- `displayFields`：UI 展示字段过滤（可选，留空展示全部）
- `effectiveStatusBar` 兼容旧 `template` 字段名自动迁移到 `templateRule`

**UI 改动**：
| 文件 | 改动 |
|---|---|
| `index.html` | 原 `statusbar-template` textarea 拆为 `statusbar-template-rule` + `statusbar-display-fields` 两个 textarea；新增 `statusbar-display-fields-row` |
| `app.js` | `statusbar-toggle` change 监听加 `statusbar-display-fields-row` 显示控制 |
| `app.js` | `fillSettingsForm`/`saveSettingsHandler` 读写 `templateRule`/`displayFields` |

**代码块排除正则**（B3 验收点）：
| 位置 | 改动 |
|---|---|
| `app.js` 状态栏提取 | 提取 `<status>` 前先把 ``` ```...``` ``` 和内联 `` `...` `` 替换为 `\u0000CBn\u0000` 占位符，避免代码块内的 `<status>` 示例被误提取为真状态栏 |

#### 8.3 B2 分模型提示词微调
**数据结构**：`settings.modelPrompts["<providerId>:<modelId>"] = { systemPrompt, emphasis }`

**注入顺序**（buildContext）：`[全局 systemPrompt] → [会话 systemPrompt] → [会话 emphasis] → [模型 systemPrompt] → [模型 emphasis] → [状态栏] → [userIdentity]`

**UI 改动**：
| 文件 | 改动 |
|---|---|
| `index.html` | 接口管理与数据管理之间加"模型提示词"section：`model-prompts-key-label` + `model-prompt-sys` + `model-prompt-emp` 两个 textarea |
| `app.js` | `fillSettingsForm` 回填当前会话 provider+model 对应的提示词；`saveSettingsHandler` 保存到 `settings.modelPrompts[key]`（空则 delete） |

**注意**：模型提示词在 tab 切换时不变（它是全局设置，按模型键存），不受 conv/global tab 影响。

> 本节全部改动不含 Capacitor 专属符号，**可推主仓库**。sync 后仅需确认 `settings.global`/`modelPrompts` 迁移逻辑未被覆盖。


### 9. v1.3.0 批次 2：A4 接口弹窗位置 + A5 接口标签收折（cache-bust v53 -> v54）
**范围**：接口编辑器紧邻被编辑项插入（A4）+ 每个 provider 可独立收折（A5）。
**不含 Capacitor 专属 API，属于通用 UI 重构，可推主仓库**。

#### 9.1 A5 接口标签收折
**改动**：`renderProviderList` 中每个 provider 从 `<div class="provider-item">` 改为 `<details class="provider-group">` + `<summary class="provider-summary">`。

| 文件 | 改动 |
|---|---|
| `app.js` | `renderProviderList`：`.provider-item` div → `<details class="provider-group">` + `<summary class="provider-summary">`；按钮 click 加 `e.stopPropagation()` 防止误触收折 |
| `style.css` | 新增 `.provider-group`/`.provider-group[open]`/`.provider-summary`/`.provider-summary::-webkit-details-marker`/`.provider-group .provider-detail`/`.provider-group .provider-editor` 样式 |

**交互**：点击 summary 任意空白处切换收折；编辑/删除按钮因 `stopPropagation` 不触发收折。

#### 9.2 A4 接口弹窗位置
**改动**：编辑器从固定挂在列表末尾改为紧邻被编辑项插入。

| 函数 | 改动 |
|---|---|
| `renderProviderList` | 开头加"编辑器救援"：若 `#provider-editor` 在 `#provider-list` 内，先 `insertBefore` 移出到列表后，防止 `innerHTML` 重建时销毁编辑器 |
| `openProviderEditor` | 末尾加移动逻辑：编辑已有(idx>=0)时 `group.appendChild(editor)` + `group.open=true`；新增(idx<0)时 `container.appendChild(editor)` |
| `closeProviderEditor` | 隐藏编辑器后 `insertBefore(editor, container.nextSibling)` 移回原位（`#provider-list` 之后） |

**DOM 移动原理**：`appendChild` 对已有元素是"移动"而非"复制"，不会产生重复 ID，原有事件监听器保持有效。

> 本节全部改动不含 Capacitor 专属符号，**可推主仓库**。sync 后仅需确认 `renderProviderList`/`openProviderEditor`/`closeProviderEditor` 三个函数的 A4/A5 标记段落未被覆盖。


### 10. v1.3.0 批次 2 续：设置面板按场景重构 + 快速回顶/底（cache-bust v54 -> v55）
**范围**：废除 tab 切换，按使用场景分组；模型修饰合并单文本框；设置面板快速回顶/底按钮。
**不含 Capacitor 专属 API，属于通用 UI/架构重构，可推主仓库**。

#### 10.1 设置面板按场景分组
**背景**：原 B1 的 global/conv tab 切换加重认知负担。重构为按使用场景分组，取消 tab，会话级字段直接存 conv，全局偏好存 settings 根对象。

**数据结构变更**：
- 移除 `settings.global` 层（loadSettings 迁移：旧 global.thinkingEnabled 回写顶层后 delete global）
- 会话级字段直接存 conv：`thinkingEnabled / systemPrompt / emphasis / userIdentity / statusBar`
- 全局偏好存 settings 根：`directMode / nativeStreamingMode / hapticFeedback / fontSize / lineSpacing / thinkingEnabled`
- 模型修饰 `settings.modelPrompts[key]` 从 `{systemPrompt, emphasis}` 合并为 `{text}`（用 `===强调===` 分隔）

**UI 改动**：
| 文件 | 改动 |
|---|---|
| `index.html` | settings-body 重构为 5 个 `setting-group`：本次对话(仅当前会话)/常用偏好(全局)/接口管理(全局)/模型修饰(按模型)/数据管理 |
| `index.html` | 移除 `settings-tabs`、`tab-hint-*`、`btn-reset-conv-prompts` |
| `style.css` | 删除 `.settings-tabs`/`.settings-tab`；新增 `.setting-group`/`.setting-group-title`/`.setting-scope`/`.settings-scroll-btn` |
| `app.js` | 删除 `effective()` 函数；`effectiveStatusBar` 改为只读 conv；`effectiveModelPrompt` 加会话级禁用/覆盖逻辑 |

**函数改动**：
| 函数 | 改动 |
|---|---|
| `loadSettings` | 移除 global 默认值；迁移旧 global.thinkingEnabled→顶层；迁移旧 modelPrompts {systemPrompt,emphasis}→{text} |
| `newConversation` | 移除"继承全局"注释 |
| `buildContext`/`buildContextForContinue` | 移除全局 systemPrompt 注入；`effective(conv,'userIdentity')`→`conv.userIdentity`；模型修饰按 `===强调===` 拆分 |
| `fillSettingsForm` | 移除 tab 逻辑；直接从 conv 读会话字段、从 settings 读全局字段；回填模型修饰 text/disable/override |
| `toggleSettings` | 移除 tab 初始化和 font-size/line-spacing 单独回填（统一到 fillSettingsForm） |
| `saveSettingsHandler` | 移除 tab 分支；会话字段存 conv（空转 null）；全局偏好存 settings；模型修饰 text 存 modelPrompts[key] |
| `thinkingToggle` 监听 | 移除 `settings.global` 同步和 tab 判断；直接存 conv |
| tab 切换/reset 按钮监听 | 整段删除，替换为模型修饰 override 复选框监听 + 设置面板回顶/底按钮监听 |

#### 10.2 模型修饰单文本框 + 会话级覆盖
**数据结构**：`settings.modelPrompts["<providerId>:<modelId>"] = { text: "修饰语\n\n===强调===\n强调内容" }`
- 会话级禁用：`conv.modelPromptDisabled = true`
- 会话级覆盖：`conv.modelPromptOverride = "本会话专属修饰语"`

**注入逻辑**（effectiveModelPrompt）：conv.modelPromptDisabled→返回 null；conv.modelPromptOverride→返回 {text:覆盖值}；否则返回全局 modelPrompts[key]。

**UI**：模型修饰分组内单 textarea `model-prompt-text` + 两个复选框（禁用/自定义覆盖）+ 条件显示的覆盖 textarea。

#### 10.3 设置面板快速回顶/底按钮
**方案**：按钮 `position:absolute` 挂在 `.settings-content`（非滚动）直接子级，滚动只在 `.settings-body` 内发生，按钮不随内容滚。
**关键坑（已踩并修复两次）**：
1. 不能用 `position:sticky`（flex 容器内对顶部元素不生效，按钮随内容滚走）。
2. 不能用 `position:fixed`：`.settings-content` 有 `backdrop-filter`，会为 fixed 后代创建包含块，使 fixed 退化成相对 settings-content（且它原是滚动容器），行为错乱、按钮落回正常流跟着滚。
3. 滚动容器必须明确：重构后 `.settings-content` 用 `display:flex;flex-direction:column;overflow:hidden` 不滚动，`.settings-body` 加 `flex:1;min-height:0;overflow-y:auto` 才是滚动容器。scroll 监听挂 `#settings-body`。
4. 按钮必须是 `.settings-content` 直接子级（不能在 `.settings-body` 内，否则在滚动区里会随内容滚）。absolute 不受 backdrop-filter 影响，相对 settings-content 定位，不滚动。
**附带改进**：重构后 header/footer 不再随内容滚动（原来 overflow 在 content 上时 header 会滚走）。
| 文件 | 改动 |
|---|---|
| `index.html` | 按钮从 settings-body 内移出，作为 settings-content 直接子级（settings-footer 之后） |
| `style.css` | `.settings-content` 去掉 `overflow-y:auto` 改 `display:flex;flex-direction:column;overflow:hidden`；`.settings-body` 加 `flex:1;min-height:0;overflow-y:auto`；`.settings-scroll-btn` 用 `position:absolute;right:16px;bottom:72px`（上移避开 footer，z-index:200）；风格对齐 `.btn-scroll-bottom`：半透明 `var(--bg2)`+`var(--border)`+`var(--text)`+`var(--shadow)`，无硬编码颜色 |
| `app.js` | scroll 监听挂 `#settings-body`：scrollTop<200=nearTop，底部-200=nearBottom；按钮在 nearBottom&&nearTop 时隐藏，nearBottom&&!nearTop 显示↑（回顶），否则显示↓（回底）；箭头用 SVG（复用 C1 的 `polyline` 风格，stroke=currentColor 跟随 `--text`），非文本字符；`toggleSettings` 打开时 setTimeout 触发一次 updateScrollBtn 初始化按钮状态 |

> 本节全部改动不含 Capacitor 专属符号，**可推主仓库**。sync 后需确认 `settings.global` 迁移逻辑、`effectiveStatusBar`/`effectiveModelPrompt` 新签名未被覆盖。

### 11. v1.3.0 批次 5：F1 生图 API 集成（cache-bust v57 -> v58）
**范围**：独立生图 API 子系统，含界面、Provider 管理、API 调用、全局图库。为后续 F2/F4/F3/F5 预留扩展点（详见蓝皮书 v4 第十章）。
**含 Capacitor 专属代码**（Filesystem 写入 Download 目录、App.addListener backButton），**不推主仓库**；其余 UI/数据结构/API 调用逻辑可推。

#### 11.1 数据结构（settings 扩展）
```javascript
settings = {
  // ... 既有字段 ...
  imageProviders: [],          // 生图 provider 列表（独立于聊天 providers）
  imageProviderId: null,       // 当前选中的生图 provider id
  images: []                   // 全局图库（F2/F4/F5 共用）
};
```
- `IMAGE_PROVIDER_TEMPLATES` 常量独立于 `PROVIDER_TEMPLATES`，定义 `openai_compat`/`openai_standard`/`custom` 三种模板
- `settings.images[]` 字段：`{ id, dataUrl, thumbnailDataUrl, prompt, negativePrompt, referenceImageId, model, providerId, size, createdAt, tags, source, starred, revisedPrompt }`
- 为 F2/F4/F5 预留扩展字段：`tags[]`/`starred`/`source`/`referenceImageId`

#### 11.2 loadSettings 默认值与迁移
| 函数 | 改动 |
|---|---|
| `loadSettings` | 默认值加 `imageProviders:[]`/`imageProviderId:null`/`images:[]`；旧 settings 无此字段时补默认值；`imageProviders` 数组用 `normalizeImageProvider` 归一化；`imageProviderId` 指向不存在的 provider 时回退到首个 |

#### 11.3 新增函数（app.js，约 680 行）
| 模块 | 函数 |
|---|---|
| Provider 模板 | `IMAGE_PROVIDER_TEMPLATES` / `getImageProviderTemplate` / `normalizeImageProvider` / `getImageProvider` / `getCurrentImageProvider` / `saveImageProviders` |
| Provider 管理 UI | `renderImageProviderList` / `openImageProviderEditor` / `closeImageProviderEditor` / `saveImageProviderFromEditor` / `deleteImageProvider` |
| 界面切换 | `toggleImageView` / `renderImageProviderSelect` / `updateImageGalleryCount` |
| 图片流 | `renderImageStream` / `showImagePreview` / `deleteImageFromGallery` / `saveImageToDevice` |
| API 调用 | `compressImageForGeneration` / `buildImageRequestPayload` / `generateImage` / `fetchImageAsDataUrl` / `clearImageGallery` |
| 事件绑定 | `initImageView`（入口按钮/返回键/接口选择/参考图/尺寸/提示词/高级参数/设置面板按钮/边缘滑动返回/Android 返回键拦截） |
| init 调用 | `init()` 中调用 `initImageView()`；`toggleSettings(open)` 打开时调用 `renderImageProviderList()` + `updateImageGalleryCount()` |

#### 11.4 API 协议（kkaiapi OpenAI 兼容）
- 端点：`POST {baseUrl}/v1/images/generations`
- 请求体（nested 格式）：`{ model, input: { messages: [{ role:'user', content: [{type:'text',text:prompt}, {type:'image',image:base64}] }] }, parameters: { prompt_extend, watermark, n, size, negative_prompt } }`
- 响应：`{ data: [{ url, b64_json, revised_prompt }] }`
- 图片获取策略：优先 `b64_json`，否则 fetch `url` 转 base64

#### 11.5 UI 改动
| 文件 | 改动 |
|---|---|
| `index.html` | sidebar-footer 加 `#btn-open-image-view`（图片图标 SVG）；`<main>` 后加 `<section id="image-view">`（顶部栏+图片流+输入区+高级参数）；设置面板「数据管理」前加「生图 API」`<details>` 分组（provider 列表+编辑器+图库统计+清空按钮）；cache-bust v57→v58 |
| `style.css` | `:root` 加 `--shadow-up`；`body.dark` 加 `--shadow-up`；`.sidebar-footer` 改 flex 布局；新增 `.btn-image-entry` + 全套生图界面样式（`.image-view`/`.image-bar`/`.image-stream`/`.image-msg`/`.image-card`/`.image-input-area`/`.image-advanced-*`/`.image-loading`/`.image-error`/`.image-preview-overlay`/`.image-provider-editor`），全部使用 CSS 变量 |
| `app.js` | 见 11.3 |

#### 11.6 Capacitor 专属代码（不推主仓库）
| 函数 | Capacitor API |
|---|---|
| `saveImageToDevice` | `CapFilesystem.writeFile({ path:'Download/'+fileName, data:base64, directory:'EXTERNAL_STORAGE', recursive:true })` |
| `initImageView` 末尾 | `Capacitor.Plugins.App.addListener('backButton', ...)` 拦截 Android 物理返回键，生图界面打开时返回主界面而非退出 |

> Web 模式下 `saveImageToDevice` 回退为 `<a download>` 触发浏览器下载，无需 Capacitor。
> 同步主仓库时需保留：`settings.imageProviders`/`imageProviderId`/`images` 字段迁移逻辑、`IMAGE_PROVIDER_TEMPLATES` 常量、所有 UI 渲染与 API 调用函数；剔除 `CapFilesystem` 与 `Capacitor.Plugins.App` 相关分支。

#### 11.7 风险与遗留
1. **大图存储**：base64 图片存 localStorage，5-10MB 限制。当前未生成缩略图（`thumbnailDataUrl:null`），F2/F4 优化时再补
2. **API 超时**：聊天走 `settings.chatWaitMs`（默认 300s，「常用偏好 → 等待超时」可改，v122 起；旧字段 `nativeTimeoutMs` 已废弃）；生图走独立的 `settings.imageNativeTimeoutMs`（默认 600s）
3. **参考图大小**：压缩到 1024px 内（PNG 0.85 质量）再上传
4. **图生图请求体**：kkaiapi 把参考图放在 `content[].image` 字段作为纯 base64（去 data URL 前缀）
5. **滑动返回**：仅左边缘 24px 内触发，需横向 >80px、纵向 <60px、时间 <500ms，避免误触

#### 11.8 sync 后自检命令
```powershell
# 1. 检查 F1 关键标记
Select-String -Path C:\Users\86176\chat-lite-android\www\app.js -Pattern "IMAGE_PROVIDER_TEMPLATES|toggleImageView|generateImage|initImageView" -SimpleMatch

# 2. 检查 Capacitor 专属符号（应仅在 saveImageToDevice 和 initImageView 末尾出现）
Select-String -Path C:\Users\86176\chat-lite-android\www\app.js -Pattern "CapFilesystem|Capacitor.Plugins.App" -SimpleMatch

# 3. 语法验证
node --check C:\Users\86176\chat-lite-android\www\app.js
```

### 12. v1.3.0 批次 5 修正：F1 新增 gpt_image 模板支持 gpt-image-2（cache-bust v58 -> v59）
**背景**：原 `openai_compat` 模板用通义万相 nested 格式（`input.messages[].content`），但用户用 kkaiapi 中转 gpt-image-2 时，gpt-image-2 实际是 OpenAI 标准 flat 格式 + `quality`/`output_format` 参数，nested 请求体上游不认 → HTTP 500 Upstream gateway error。

**修复**：
| 文件 | 改动 |
|---|---|
| `app.js` IMAGE_PROVIDER_TEMPLATES | 新增 `gpt_image` 模板：`requestFormat:'gpt_image'`、`responseFormat:'b64_only'`、`features.supportsQuality:true` |
| `app.js` generateImage | 新增 `gpt_image` 分支：构建 flat 请求体 `{model,prompt,n,size,quality,output_format,moderation}` |
| `app.js` updateImageAdvancedVisibility（新增函数） | 根据当前模板显示/隐藏 quality 行/负面提示词/提示词扩展/水印/参考图按钮 |
| `app.js` toggleImageView / initImageView 接口切换 | 调用 `updateImageAdvancedVisibility()` |
| `index.html` 模板 select | 新增 `gpt_image` 选项（默认推荐，放第一位） |
| `index.html` 高级面板 | 新增 quality 选择行 `image-quality-row`（auto/low/medium/high）；给负面提示词行/提示词扩展 label/水印 label 加 id 供 visibility 控制 |

**gpt-image-2 请求体格式**（与 DALL-E nested 格式不同）：
```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "quality": "auto",
  "output_format": "png",
  "moderation": "auto"
}
```

**响应**：gpt-image 系列只返回 `data[0].b64_json`（无 url），原代码已支持 b64_json 解析，无需改动。

> 本次改动不含 Capacitor 专属 API，属于通用模板扩展，**可推主仓库**。sync 后确认 `IMAGE_PROVIDER_TEMPLATES.gpt_image` 与 `generateImage` 的 `gpt_image` 分支未被覆盖。

### 13. v1.3.0 批次 5 扩展：F1 新增 Nano Banana 模板 + 输入区分层 + 分辨率/宽高比双下拉（cache-bust v59 -> v60）
**背景**：用户反馈三点改进需求：① 支持 Google Nano Banana（Gemini 2.5/3 Flash Image）；② 尺寸选择改为「分辨率（1K/2K/4K）+ 宽高比（1:1/16:9 等）+ 自由」更人性化；③ 输入区被设置框挤压，需分层。

**研究依据**：
- Nano Banana 谷歌原生 API：`POST /v1beta/models/{model}:generateContent`，鉴权 `x-goog-api-key`，请求体 `contents[].parts[].text` + `generationConfig.responseModalities:['IMAGE']` + `generationConfig.imageConfig:{aspectRatio, imageSize}`
- 中转平台（kkidc 等）：同样路径但用 `Authorization: Bearer` 鉴权
- 响应：`candidates[0].content.parts[].inlineData.data`（base64），与 OpenAI 的 `data[0].b64_json` 结构完全不同
- imageSize 取值 "1K"/"2K"/"4K"；aspectRatio 取值 "1:1"/"4:3"/"3:4"/"16:9"/"9:16"

**修复**：
| 文件 | 改动 |
|---|---|
| `app.js` IMAGE_PROVIDER_TEMPLATES | 新增 `nano_banana` 模板：`endpointPath:'/v1beta/models/{model}:generateContent'`、`authType:'api-key'`、`authHeader:'x-goog-api-key'`、`requestFormat:'gemini_image'`、`responseFormat:'gemini'`、`features.supportsReferenceImage:true`（图生图用 inline_data）|
| `app.js` IMAGE_PROVIDER_TEMPLATES | 所有模板 features 补 `supportsResolution`/`supportsAspectRatio` 字段（统一 true，由映射函数处理）|
| `app.js` buildImageRequestPayload | 支持 `{model}` 占位符替换（从 body.model 读取）|
| `app.js` buildImageSizeConfig（新增函数） | 把「分辨率 + 宽高比」映射为对应字段：nano_banana → `{imageConfig:{aspectRatio, imageSize}}`；OpenAI 系 → `{size:'WxH'}`；auto → `{size:'auto', imageConfig:null}` |
| `app.js` _IMAGE_SIZE_MAP（新增常量） | 1K/2K/4K × 5 种宽高比的 WxH 映射表（全部 16 的倍数，满足 gpt-image-2 约束）|
| `app.js` generateImage | 请求体新增 `nano_banana` 分支：`contents + generationConfig`；参考图用 `inline_data`（Gemini 格式）；超时提升到 600s（生图较慢）|
| `app.js` generateImage 响应解析 | 新增 Gemini 格式解析：`candidates[].content.parts[].inlineData.data` 归一化为 `[{b64_json, mime}]`；mime 从 `inlineData.mimeType` 读 |
| `app.js` generateImage imgObj | 新增 `resolution`/`aspect` 字段；`size` 字段对 nano_banana 存 imageConfig 的 JSON |
| `app.js` saveImageProviderFromEditor | 新增「鉴权方式」下拉处理：bearer/api-key/header/跟随模板，覆盖模板默认 authType/authHeader/authPrefix |
| `app.js` openImageProviderEditor | 回填鉴权方式（与模板默认一致则显示「跟随模板」）|
| `index.html` 模板 select | 新增 `nano_banana` 选项 |
| `index.html` provider 编辑器 | 新增「鉴权方式」下拉（跟随模板/Bearer/x-goog-api-key/自定义 Header）|
| `index.html` 输入区 | 重构为三层：①`.image-config-row`（参考图+分辨率+宽高比+自定义）→ ②`.image-input-row`（提示词+发送）→ ③高级折叠 |
| `index.html` 尺寸控件 | 旧 `image-size-select`/`image-size-custom` → 新 `image-resolution-select`（auto/1K/2K/4K）+ `image-aspect-select`（auto/1:1/4:3/3:4/16:9/9:16/custom）+ `image-aspect-custom` |
| `style.css` | 新增 `.image-config-row` 样式（flex + wrap + margin-bottom:8px）|

**WxH 映射表**（16 的倍数，满足 gpt-image-2 约束）：
| 分辨率 | 1:1 | 4:3 | 3:4 | 16:9 | 9:16 |
|---|---|---|---|---|---|
| 1K | 1024x1024 | 1024x768 | 768x1024 | 1792x1024 | 1024x1792 |
| 2K | 2048x2048 | 2048x1536 | 1536x2048 | 2048x1152 | 1152x2048 |
| 4K | 3072x3072 | 3840x2880 | 2880x3840 | 3840x2160 | 2160x3840 |

**Nano Banana 请求体格式**：
```json
{
  "model": "gemini-2.5-flash-image",
  "contents": [{"parts": [{"text": "prompt"}]}],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"}
  }
}
```

**鉴权方式说明**：
- 跟随模板：nano_banana 默认 `x-goog-api-key`，其他默认 `Bearer`
- Bearer：中转平台（kkaiapi/kkidc/OneAPI）统一用此
- x-goog-api-key：Google 官方 API
- 自定义 Header：特殊平台

> 本次改动不含 Capacitor 专属 API，属于通用模板扩展与 UI 重构，**可推主仓库**。sync 后确认 `IMAGE_PROVIDER_TEMPLATES.nano_banana`、`buildImageSizeConfig`、`generateImage` 的 `nano_banana` 分支、Gemini 响应解析段未被覆盖。

### 14. v1.3.0 批次 5 修正：F1 图片存储改用 Filesystem + saveSettings 配额保护 + 参考图按钮始终显示（cache-bust v60 -> v61）
**背景**：用户反馈两个问题：① 参考图入口不见了；② 两次应用更新后图库和生图 API 数据都没保存。

**根因分析**：
| 问题 | 根因 |
|---|---|
| 参考图入口不见 | `updateImageAdvancedVisibility` 把参考图按钮在 gpt_image 模板（supportsReferenceImage:false）下隐藏了，用户用 gpt-image-2 时按钮消失 |
| 数据没保存 | **localStorage 配额超限**。base64 图片 1-2MB/张，localStorage 限制 5-10MB，多张图片就超限。`saveSettings` 没有 try/catch，`setItem` 抛 QuotaExceededError 被静默吞掉，导致整个 settings（含 imageProviders）写入失败 |
| 导入导出兼容 | 导出 `settings` 整体理论兼容，但因 localStorage 就丢了数据，导出也是空的 |

**修复**：
| 文件 | 改动 |
|---|---|
| `app.js` updateImageAdvancedVisibility | 参考图按钮始终显示（不再按 supportsReferenceImage 隐藏），模板不支持时点击会提示 |
| `app.js` btn-image-ref 点击监听 | 模板不支持参考图时 `showToast('当前接口模板不支持参考图', 'warn')` 并 return |
| `app.js` writeImageFile（新增函数） | APK 模式把 dataUrl 写入 Filesystem `DATA/chatlite_images/<id>.<ext>`，返回 fileName |
| `app.js` readImageFile（新增函数） | 从 Filesystem 读取图片文件，返回 dataUrl |
| `app.js` deleteImageFile（新增函数） | 删除 Filesystem 中的图片文件 |
| `app.js` getImageDataUrl（新增函数） | 统一获取 dataUrl：内存缓存 → Filesystem → dataUrl 字段（兼容旧数据）|
| `app.js` generateImage imgObj | APK 模式 fileName 非空时 `dataUrl:null`（只存元数据）；浏览器模式或写入失败仍存 dataUrl |
| `app.js` renderImageStream | 改为异步加载：APK 模式下 fileName 非空但 dataUrl 为空时先占位，再异步从 Filesystem 读取填充 src |
| `app.js` deleteImageFromGallery | 删除时同步调用 deleteImageFile 清理 Filesystem 文件 |
| `app.js` saveImageToDevice | 先用 getImageDataUrl 获取 dataUrl（APK 模式从 Filesystem 读），再写入 Download 目录 |
| `app.js` saveSettings | 加 try/catch：配额超限时剥离所有图片 dataUrl（保留 fileName 元数据）后重试，并提示用户 |
| `app.js` migrateImportedImagesToFilesystem（新增函数） | 导入旧备份后把残留 dataUrl 转存 Filesystem，剥离 dataUrl 释放 localStorage 空间 |
| `app.js` importAllData | 导入完成后调用 migrateImportedImagesToFilesystem |
| `app.js` init | 启动时调用 migrateImportedImagesToFilesystem（迁移旧版本残留 dataUrl）|

**存储架构变更**：
| 项 | 旧方案 | 新方案 |
|---|---|---|
| 图片 dataUrl | 存在 settings.images[].dataUrl（localStorage） | APK 模式存 Filesystem `DATA/chatlite_images/<id>.<ext>`，settings.images 只存 fileName |
| settings.images | 含完整 base64（撑爆 localStorage） | 只存元数据 + fileName（体积小） |
| 浏览器模式 | 存 dataUrl | 仍存 dataUrl（无 Filesystem） |
| 兼容旧数据 | - | getImageDataUrl 优先读 img.dataUrl，无则从 fileName 读 Filesystem；启动/导入时自动迁移 |

**配额超限保护链**：
1. 正常路径：图片存 Filesystem，settings 不含 dataUrl → localStorage 体积小
2. 异常路径（浏览器模式/写入失败）：settings 含 dataUrl → saveSettings 配额超限 → 剥离所有 dataUrl 重试 → 仍失败则提示用户导出备份
3. 迁移路径：启动/导入时自动把残留 dataUrl 转存 Filesystem

> 本次改动**含 Capacitor 专属代码**（Filesystem 读写图片文件），**不推主仓库**；浏览器模式的 dataUrl 直存逻辑可推。sync 后确认 writeImageFile/readImageFile/deleteImageFile/getImageDataUrl/migrateImportedImagesToFilesystem 函数及 saveSettings 的 try/catch 段未被覆盖。

### 15. v1.3.0 批次 5 修正：F1 gpt_image 模板支持参考图（/v1/images/edits 端点）（cache-bust v61 -> v62）
**背景**：用户确证 GPT-image-2 支持**图像输入和输出**，提供专门的图像编辑接口 `v1/images/edits`（multipart/form-data），可上传参考图做图生图。原 gpt_image 模板误把 `supportsReferenceImage` 设为 false，且只用 `/v1/images/generations` 端点不支持图生图。

**修复**：
| 文件 | 改动 |
|---|---|
| `app.js` IMAGE_PROVIDER_TEMPLATES.gpt_image | `supportsReferenceImage: true`；`supportsBatch: false, maxBatch: 1`（edits 端点只支持 n=1）；新增 `editsPath: '/v1/images/edits'` 字段 |
| `app.js` normalizeImageProvider | 保留 `editsPath` 字段（gpt_image 图生图专用端点）|
| `app.js` generateImage gpt_image 分支 | 拆分两路径：有参考图走 `_useEdits:true` + FormData；无参考图走原 generations + JSON |
| `app.js` buildImageRequestPayload | 支持 `_useEdits` 标记：用 editsPath 端点 + 构建 multipart/form-data（FormData），不设 Content-Type 让浏览器自动加 boundary；参考图 dataUrl → Blob 传入 `image` 字段 |
| `app.js` base64ToBytes（新增函数） | base64 字符串 → Uint8Array，用于构建 Blob |
| `app.js` generateImage fetch 调用 | `body` 判断：FormData 时直接传 payload，否则 JSON.stringify |
| `app.js` initImageView | 模板 select change 监听：新建时自动填充推荐默认模型（gpt_image→gpt-image-2，nano_banana→gemini-2.5-flash-image 等）|

**gpt_image 两路径对比**：
| 路径 | 端点 | Content-Type | body | 参考图 |
|---|---|---|---|---|
| 文生图 | `/v1/images/generations` | application/json | JSON | 不传 |
| 图生图 | `/v1/images/edits` | multipart/form-data（自动）| FormData | `image` 字段传 Blob |

**edits 端点请求体**（multipart/form-data）：
```
model: gpt-image-2
prompt: 修改要求
size: 1024x1024（可选）
quality: auto（可选）
output_format: png
n: 1
image: <reference.png Blob>
```

> 本次改动不含 Capacitor 专属 API，属于通用模板扩展，**可推主仓库**。sync 后确认 `IMAGE_PROVIDER_TEMPLATES.gpt_image.editsPath`、`buildImageRequestPayload` 的 `_useEdits` 分支、`base64ToBytes` 函数未被覆盖。

### 16. v1.3.0 批次 5 扩展：F1 多张参考图（最多16张）+ 后台/切出不报错 + 顺序展示（cache-bust v62 -> v63）
**背景**：用户提出三个问题：① 一次只能附一张参考图，能否多张；② 多图顺序需清楚；③ 切出页面/app 后台时能否正常接收不报错。

**研究依据**：
- OpenAI gpt-image-2 `/v1/images/edits` 端点支持最多 16 张参考图，做法是重复同名字段 `image` 或 `image[]`
- 多图顺序即 FormData append 顺序，模型按顺序参考
- nano_banana Gemini `contents[].parts[]` 原生支持多图 inline_data
- openai_compat 通义万相 nested `content[]` 也支持多 `image` 项
- Android WebView 切后台时 JS 暂停，fetch 挂起但不会报错，切回前台后继续等待

**修复**：
| 文件 | 改动 |
|---|---|
| `index.html` image-ref-file | 加 `multiple` 属性，支持多选 |
| `app.js` refFileInput change 监听 | 改为多选：files 数组遍历，最多 16 张，存到 `state._imageRefDataUrls` 数组（每项含 dataUrl/name/size）|
| `app.js` renderImageRefPreview（新增函数）| 多图预览渲染：每张缩略图 + 顺序编号（1-16）+ 单张删除按钮 + 「清空」按钮 |
| `app.js` bindRefClear（新增函数）| 绑定「清空」按钮事件 |
| `app.js` generateImage refDataUrls | 改用数组：`state._imageRefDataUrls` 优先，兼容旧 `state._imageRefDataUrl` |
| `app.js` generateImage nano_banana 分支 | 多图作为多个 `inline_data` part（Gemini 原生支持多图 parts）|
| `app.js` generateImage openai_compat 分支 | 多图作为多个 `{type:'image', image:base64}` content 项 |
| `app.js` generateImage gpt_image 分支 | 多图通过 `_refDataUrls` 数组传给 buildImageRequestPayload |
| `app.js` buildImageRequestPayload | 多图 FormData：遍历 `_refDataUrls` 数组，每张 dataUrl → Blob → 重复 append `image` 字段（文件名含序号 reference_1.png/reference_2.png...）|
| `app.js` 用户消息显示 | `[N 张参考图]` 替代原 `[参考图]` |
| `app.js` generateImage 后台适配 | 加 `state._imageGenerating = true` 标记；gpt_image 图生图/nano_banana 超时提升到 600s |
| `app.js` initImageView appStateChange 监听 | 切回前台时若 `_imageGenerating` 为 true，更新状态指示器并提示「生图请求进行中，请稍候...」|
| `app.js` generateImage finally | 清除 `state._imageGenerating` 标记 |
| `style.css` .ref-thumb-item | 多图缩略图样式：36×36 + 顺序编号（蓝色圆形）+ 单张删除按钮（红色圆形）|

**多图顺序保证**：
- FormData append 顺序 = 用户选择顺序 = 模型参考顺序
- 缩略图展示顺序 = 数组顺序 = 发送顺序
- 文件名含序号：reference_1.png, reference_2.png...（便于调试）

**后台/切出行为**：
| 场景 | 行为 |
|---|---|
| 请求进行中切后台 | JS 暂停，fetch 挂起（不报错），超时定时器也暂停 |
| 切回前台 | JS 恢复，fetch 继续等待或已完成，状态指示器更新，toast 提示 |
| 后台超时 | 切回前台后定时器恢复，若已超时则 abort，提示「请求超时」|
| 后台完成 | 切回前台后正常处理响应（图片存 Filesystem + 渲染）|

**注意**：Android 系统可能在后台一段时间后杀死 app 进程（特别是内存不足时），此时请求会中断。这是系统级行为，无法完全避免。建议长时间生图时保持 app 在前台。

> 本次改动**含 Capacitor 专属代码**（App.addListener appStateChange），**不推主仓库**；多图 FormData 构建逻辑可推。sync 后确认 `renderImageRefPreview`/`bindRefClear`/`state._imageRefDataUrls`/`buildImageRequestPayload` 多图循环段未被覆盖。

### 17. v1.3.0 批次 5 重构：settings 存储基底 localStorage -> IndexedDB（cache-bust v64 -> v65）

**背景**：用户反馈"重启后图集没了，原有图集也没被保存"。批次5第14条虽已将图片 base64 分离到 Filesystem，但 settings 元数据（imageProviders / images 元数据 / modelPrompts / groupCollapse）仍写 localStorage，配额仅 5-10MB，元数据累积或残留 dataUrl 仍会触发 QuotaExceededError，且 fallback 路径会循环触发写入失败。导入路径直接 localStorage.setItem 绕过 fallback，更易失败。

**根因**：localStorage 配额硬上限（Android WebView 通常 ~5MB/origin），无法扩容；IndexedDB 配额通常数百 MB 起，按域名可达 GB 级，无 QuotaExceededError 风险。conversations/providers 早已用 IndexedDB（STORAGE_KEY），settings 仍走 localStorage 是历史遗留。

**修复**：
| 位置 | 改动 |
|---|---|
| pp.js 顶部常量 | 新增 `SETTINGS_IDB_KEY = 'chatlite_settings_v2'`（与旧 `SETTINGS_KEY` 区分，避免双写）|
| pp.js `let settings = loadSettings()` | 改为 `let settings = defaultSettings()`（同步默认值，启动 await 后覆盖）+ `let _settingsLoaded = false` 标记 |
| pp.js `loadSettings()` 拆分 | 拆为 `defaultSettings()`（同步返回默认值）+ `migrateSettings(s)`（字段迁移+归一化）+ `async initSettings()`（从 IDB 加载或从 localStorage 迁移）|
| pp.js `initSettings()` 新函数 | 1) 先从 IDB 读 `SETTINGS_IDB_KEY`；2) IDB 无数据时从旧 localStorage `SETTINGS_KEY` 读，写 IDB 成功后 `localStorage.removeItem(SETTINGS_KEY)` 清理；3) 都没有则用默认值 |
| pp.js `saveSettings()` | 改为异步写 IDB（`idbPut(SETTINGS_IDB_KEY, settings)`），不再走 localStorage.setItem；防御性剥离残留图片 dataUrl（fileName 非空时 dataUrl=null）；写入失败仅 toast 提示，不影响内存数据 |
| pp.js `init()` | 在 `await loadData()` 后插入 `await initSettings()`，确保 settings 加载完成后再渲染 UI |
| pp.js `importAllData` 覆盖/合并两处 | 删除 `localStorage.setItem(SETTINGS_KEY, ...)`，改用 `saveSettings()` 走 IDB |
| pp.js `migrateOldApiKey` | 同上，删除直接 localStorage.setItem，改用 saveSettings |

**迁移行为**：
| 启动场景 | 行为 |
|---|---|
| 老用户首次升级（localStorage 有数据）| 读 localStorage -> 写 IDB -> 清掉 localStorage，控制台输出迁移日志 |
| 新用户首次启动 | IDB 无数据，localStorage 无数据 -> 用默认值 |
| 老用户二次启动 | 直接从 IDB 读，localStorage 已清空，跳过迁移 |
| 迁移失败（极少见）| 保留 localStorage，控制台 warn，下次启动重试 |

**风险与缓解**：
- `let settings = loadSettings()` 原本是同步初始化 -> 现改为 `defaultSettings()` 同步返回默认值，启动 `await initSettings()` 覆盖；启动前若读 settings 字段会得到默认值（仅启动极早期阶段）
- `saveSettings()` 异步 -> 内存 settings 同步更新，IDB 写入异步不阻塞 UI，读取始终从内存读，不受影响
- 旧的 localStorage `SETTINGS_KEY` 保留作为迁移源（仅启动时一次性读取），迁移成功后清理

**回滚**：若需回滚到 localStorage，恢复 loadSettings 同步读 localStorage 的版本，删除 initSettings 调用，saveSettings 改回 localStorage.setItem 即可。IDB 中的数据不会自动迁移回 localStorage（需手动）。


### 18. v1.3.0 批次 5 扩展：后台任务完成通知（cache-bust v66 -> v67）

**背景**：用户要求确认生图和文字回复的后台稳定性，包括 APP 切出、App 内切其他页面、任务完成通知。

**新增依赖**：`@capacitor/local-notifications@6.1.3`（系统通知插件，npm install 需 `--legacy-peer-deps` 因 capacitor-stream-http 要 v7）

**改动**：
| 位置 | 改动 |
|---|---|
| AndroidManifest.xml | 新增 `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>`（Android 13+ 运行时申请，12- 声明即生效）|
| package.json | 新增 `@capacitor/local-notifications@^6` 依赖 |
| app.js state 对象 | 新增 `_isBackground: false`（前后台状态追踪）+ `_pendingTextNotify: null`（文字回复后台完成待显示通知）|
| app.js appStateChange 监听 | 扩展：1) 切后台时 `state._isBackground = true`；2) 切回前台时检查 `state.loading` 显示"回复请求进行中"toast；3) 切回前台时若有 `_pendingTextNotify` 显示通知 |
| app.js 新增 `notifyImageComplete(count)` | 调用 `Capacitor.Plugins.LocalNotifications.requestPermissions + schedule` 发送系统通知（仅后台时调用）|
| app.js 生图完成处 | `showToast` 后追加 `if (state._isBackground) notifyImageComplete(results.length)` |
| app.js 文字回复完成处（3处）| `setStatus('ok')` 后追加 `if (state._isBackground) state._pendingTextNotify = '回复已完成'`（executeRequest + send web + continueGeneration web 三个路径）|

**行为矩阵**：
| 场景 | 生图 | 文字回复 |
|---|---|---|
| 前台完成 | toast 提示（原有）| setStatus('ok')（原有，不打扰）|
| 后台完成 | 系统通知栏 + 切回前台 toast | 缓存 `_pendingTextNotify`，切回前台 toast |
| 切回前台任务进行中 | toast"生图请求进行中" | toast"回复请求进行中" |
| App 内切页面再切回 | renderImageStream 恢复加载占位（原有）| state.loading 持久 + toggleSendStop 恢复停止按钮（原有）|

**任务不被打断保障**（用户核心要求）：
- 生图：`state._imageGenerating` + `state._imageAbortController` 全局持久，仅停止按钮可 abort
- 文字：`state.loading` + `state.abortController` 全局持久，仅停止按钮可 abort
- 切后台：Android WebView 暂停 JS，Fetch 挂起不报错，切回前台继续等待响应
- 切页面：状态在全局 state 对象，DOM 重渲染不影响进行中的 fetch promise

**回滚**：删除 notifyImageComplete 函数 + 3处文字通知 + appStateChange 扩展 + state 两字段 + AndroidManifest 权限行即可。插件可保留不影响功能。


### 19. v1.3.0 批次 5 扩展：后台生图请求稳定性修复（cache-bust v70，仅原生代码改动）

**背景**：用户报告"生图请求切后台被中断，切回前台报 Software caused connection abort"。

**根因**：Capacitor 默认在 Activity onPause 时调用 `webView.onPause()`，暂停 JS 定时器和网络请求。生图请求使用 `fetch()` + `AbortController.signal` + `FormData`，CapacitorHttp 的 fetch patch 不支持 signal/FormData 回退到原始 fetch，受 WebView 暂停影响。Android 系统在 App 进入后台后回收网络资源，导致 socket 被强制关闭（ECONNABORTED）。

**改动**：
| 位置 | 改动 |
|---|---|
| AndroidManifest.xml | 新增 `<uses-permission android:name="android.permission.WAKE_LOCK"/>` |
| MainActivity.java | 从空类改为覆盖 `onPause`/`onResume`/`onDestroy`/`onCreate`<br>1. onCreate 创建 `PowerManager.WakeLock`（PARTIAL_WAKE_LOCK）<br>2. onPause 调用 `getBridge().getWebView().onResume()` 恢复 WebView + 获取 10 分钟 WakeLock<br>3. onResume 释放 WakeLock<br>4. onDestroy 释放 WakeLock |

**机制说明**：
- `super.onPause()` 仍会调用 `bridge.onPause()` 暂停 WebView，但紧接着 `webView.onResume()` 恢复 JS 执行和网络栈
- `PARTIAL_WAKE_LOCK` 保持 CPU 活跃，防止系统休眠后回收网络资源
- 10 分钟自动释放，避免长时间占用资源（生图超时上限 10 分钟）
- 只用 WakeLock 不用 WifiLock（WifiLock 在某些设备上需要额外权限且兼容性差）

**限制**：
- 每次切后台都会获取 WakeLock（即使没有进行中的任务），但 10 分钟后自动释放
- 不阻止 Android 系统在极端低内存时杀死 App（需要 Foreground Service 才能完全避免）
- 对于长时间任务（如 nano_banana 600s 超时），建议用户保持 App 在前台

**回滚**：将 MainActivity.java 改回 `public class MainActivity extends BridgeActivity {}` + 删除 AndroidManifest.xml 中 WAKE_LOCK 权限行即可。


### 20. v1.3.0 批次 5 遗留问题：后台生图请求被中断（cache-bust v70，未解决）

**现象**：
- 第 1 次切后台再切回：生图请求能保持
- 第 2 次切后台再切回：请求被打断
- 重新发起请求后切后台：立即被打断
- 报错：`Software caused connection abort`
- App 内通知正常，系统通知未生效

**已尝试方案**（v71，未彻底解决）：
1. MainActivity.onPause 调用 `webView.onResume()` 恢复 WebView
2. 获取 `PARTIAL_WAKE_LOCK` 防止 CPU 休眠
3. AndroidManifest 添加 `WAKE_LOCK` 权限

**根因分析**：
- Capacitor 默认在 Activity onPause 时调用 `webView.onPause()` 暂停 JS 执行
- 生图请求使用 `fetch()` + `AbortController.signal` + `FormData`，CapacitorHttp 的 fetch patch 不支持这些参数，回退到原始 fetch
- Android WebView 在 onPause 后会暂停所有 JS 定时器和网络请求
- 多次切后台后，Android 系统可能更激进地回收网络资源（socket 被强制关闭，ECONNABORTED）
- WebView 的 `onResume()` 恢复不能完全模拟前台网络栈状态

**未尝试方案**（供后续攻关）：

#### 方案 A：Foreground Service（推荐）
- 创建一个 Foreground Service，在生图任务进行期间显示持续通知
- Foreground Service 不会被系统杀死，可保持网络连接
- 实现复杂度：高（需修改 Android 原生代码、通知渠道、服务生命周期管理）
- 关键文件：
  - `android/app/src/main/java/com/avelec/chatlite/NetworkService.java`（新建）
  - `android/app/src/main/AndroidManifest.xml` 添加 `<service>` 声明
  - `www/app.js` 通过 Capacitor plugin 或 App API 触发服务启停

#### 方案 B：原生层代理请求
- 在 Android 原生层用 OkHttp 发起生图请求，绕过 WebView 限制
- 通过 Capacitor plugin 暴露给 JS 层调用
- 优点：不受 WebView onPause 影响
- 缺点：需要重新实现所有生图 provider 的请求逻辑（gpt_image/nano_banana/openai_compat 等）

#### 方案 C：JobScheduler + 数据持久化
- 切后台时把请求参数持久化到 IndexedDB
- 用 JobScheduler 在后台周期性重试
- 缺点：不适合长连接、用户体验差

#### 方案 D：保持屏幕常亮
- 生图期间用 `KeepAwake` 插件保持屏幕常亮，阻止 App 进入后台
- 缺点：耗电、强制改变用户行为

**临时缓解措施**：
- 长时间生图任务（gpt-image-2/nano_banana）建议用户保持 App 在前台
- App 内通知已生效，切回前台时有 toast 提示
- UI 上显示"建议保持 App 在前台"提示（待实现）

**参考链接**：
- https://developer.android.com/guide/components/foreground-services
- https://capacitorjs.com/docs/apis/foreground-service
- Android WebView onPause 行为：https://developer.android.com/reference/android/webkit/WebView#onPause()

**状态**：遗留问题，等待后续攻关。当前 v71 的 WakeLock + WebView.onResume 方案作为部分缓解保留，不回滚（第一次切后台仍能保持，比完全无缓解好）。


### 21. v2.0 模块化拆分阶段 0.5.1：db.js 存储层模块（cache-bust v73 -> v74）

**背景**：app.js 已达 264KB / 6138 行，单文件维护困难，影响任务分割与并行开发。按任务看板§十一 v2.0 模块化拆分执行规则，启动阶段 0.5.1：将存储层（IndexedDB + 持久化函数）拆分到独立 db.js 模块。这是 v2.0 拆分的第一步，遵循"逐个验证"原则（拆一个→APK 验证→commit→拆下一个）。

**新增文件**：
- `www/db.js`（8.3KB）：存储层模块，包含 IndexedDB 操作 + 持久化函数 + settings 默认值与迁移

**迁移清单**（从 app.js 剪切到 db.js）：
| 类型 | 内容 |
|---|---|
| 常量 | `STORAGE_KEY`, `SETTINGS_KEY`, `IDB_NAME`, `IDB_VER`, `IDB_STORE`, `SETTINGS_IDB_KEY` |
| 变量 | `_saveQueue`（save 函数的私有队列） |
| 函数 | `openDB`, `idbPut`, `idbGet`（IndexedDB 基础操作） |
| 函数 | `save`（会话持久化，IndexedDB + 浏览器模式同步到服务器） |
| 函数 | `defaultSettings`（settings 默认值，同步返回） |
| 函数 | `migrateSettings`（settings 字段迁移与归一化） |
| 函数 | `saveSettings`（异步写 IDB，替代 localStorage.setItem） |

**保留在 app.js**（全局状态变量，多模块共享）：
- `let settings = defaultSettings();`（db.js 加载后立即调用，初始化默认值）
- `let _settingsLoaded = false;`（initSettings 中维护）
- `let isLongPress = false;`（与存储无关）

**加载顺序**（index.html，依赖从下到上）：
```html
<script src="db.js?v=74"></script>             <!-- 1. 存储层（新增） -->
<script src="gesture-helpers.js?v=74"></script> <!-- 2. 手势 -->
<script src="app.js?v=74"></script>             <!-- 3. 入口（最后加载） -->
```

**关键设计**：
1. **全局函数风格**：db.js 不用 IIFE 包裹，与 app.js 保持一致的全局函数风格，便于 onclick 事件绑定和跨文件调用
2. **加载顺序保证**：db.js 必须在 app.js 之前加载，因为 app.js 顶层 `let settings = defaultSettings();` 依赖 db.js 提供的 defaultSettings 函数
3. **全局变量保留**：`settings` / `_settingsLoaded` / `isLongPress` 保留在 app.js，避免引入 window 全局访问的复杂性（后续 0.5.6 app.js 瘦身时再统一处理）
4. **依赖方向**：db.js 中的 save/saveSettings 调用 app.js 运行时提供的 state/settings/showToast/isCapacitor/normalizeImageProvider（运行时才解析，加载顺序无影响）

**验证结果**（APK 实测通过）：
- [x] 应用启动正常，无白屏/报错
- [x] 历史会话列表正常加载
- [x] 新建对话 + 杀进程重启后数据保留
- [x] 切换会话消息内容正确
- [x] 设置修改（字体/振感/背景透明度）持久化正常
- [x] 导入导出功能正常

**app.js 变化**：264KB → 257KB（减少约 7KB / 170 行）

**回滚**：`git reset --hard HEAD~1` 即可恢复 app.js 单文件版本。db.js 删除 + index.html 还原 v73 即可。

> 本次改动**不含 Capacitor 专属 API**（纯 JS 模块拆分），**可推主仓库**。sync 后确认 db.js 文件存在 + index.html 中 db.js script 标签未被移除 + app.js 中 STORAGE_KEY/SETTINGS_KEY/IDB_NAME/IDB_VER/IDB_STORE/SETTINGS_IDB_KEY/_saveQueue/openDB/idbPut/idbGet/save/defaultSettings/migrateSettings/saveSettings 定义未被恢复即可。

### 22. v2.0 模块化拆分阶段 0.5.2：haptics.js 振感反馈模块（cache-bust v74 -> v75）

**背景**：v2.0 模块化拆分继续，按任务看板§十一执行规则，0.5.1 db.js 完成后启动 0.5.2：将流式输出振感反馈（五档质感分层）拆分到独立 haptics.js 模块。

**新增文件**：
- `www/haptics.js`（5.3KB）：振感反馈模块，含五档质感分层 + 懒初始化 + 触发逻辑

**迁移清单**（从 app.js 剪切到 haptics.js）：
| 类型 | 内容 |
|---|---|
| 状态变量 | `_hapticLastTriggered`, `_richHapticsInitStarted`, `_richHapticsReady`, `_hapticEngineType`, `_hapticCharCount` |
| 常量 | `_HAPTIC_CHAR_ID`, `_HAPTIC_SOFT_ID`, `_HAPTIC_LOW_ID`, `_HAPTIC_CLICK_ID`, `_HAPTIC_THUD_ID` |
| 函数 | `_initStreamHaptics`（懒初始化 rich-haptics 并预加载五档模式） |
| 函数 | `triggerHapticFeedback`（根据内容节奏触发震感，五档分层+throttle+抖动） |

**保留在 app.js**：
- `let CapHaptics = null;` / `let CapRichHaptics = null;`（与其他 Capacitor 插件统一初始化，line 13-14, 21-22）
- `settings.hapticFeedback`（全局 settings 对象字段）
- `triggerHapticFeedback(delta.content)` 的 3 处调用点（line 3968/4384/4607，运行时跨文件调用 haptics.js）

**加载顺序**（index.html，依赖从下到上）：
```html
<script src="db.js?v=75"></script>              <!-- 1. 存储层 -->
<script src="haptics.js?v=75"></script>          <!-- 2. 振感（新增） -->
<script src="gesture-helpers.js?v=75"></script>  <!-- 3. 手势 -->
<script src="app.js?v=75"></script>              <!-- 4. 入口（最后加载） -->
```

**设计要点**：
1. **全局函数风格**：与 db.js / app.js 保持一致，便于跨文件调用
2. **加载顺序**：haptics.js 在 db.js 之后、app.js 之前加载；app.js 中的 triggerHapticFeedback 调用点在运行时解析 haptics.js 提供的函数
3. **依赖方向**：haptics.js 中函数运行时调用 app.js 的 CapRichHaptics / CapHaptics / settings.hapticFeedback（运行时解析，加载顺序无影响）
4. **Capacitor 插件初始化保留**：CapHaptics / CapRichHaptics 的初始化留在 app.js 顶部与其他 Capacitor 插件统一处理，避免分散

**五档质感分层**（针对 X 轴线性马达优化，参考小米/Redmi RichTap 调校）：
| 档位 | 原语 | intensity | sharpness | 触发条件 | throttle |
|---|---|---|---|---|---|
| CHAR | TICK | 0.18 | 0.55 | 字符主路径 | 38ms |
| SOFT | TICK | 0.28 | 0.55 | 逗号/空格 | 50-60ms |
| LOW | LOW_TICK | 0.14 | 0.35 | 每 10 字 | 38ms |
| CLICK | CLICK | 0.55 | 0.85 | 。！？句末 | 60ms |
| THUD | THUD | 0.72 | 0.15 | \n 段落 | 120ms |

**验证结果**（APK 实测通过）：
- [x] 应用启动正常
- [x] 流式输出五档质感分层振感与拆分前一致（CHAR/SOFT/LOW/CLICK/THUD 节奏自然）
- [x] 设置中关闭振感开关后无振感
- [x] 开启振感开关后振感恢复
- [x] 振感开关状态持久化正常

**app.js 变化**：257KB → 253KB（减少约 4KB / 86 行）

**回滚**：`git reset --hard HEAD~1` 即可恢复。haptics.js 删除 + index.html 还原 v74 + app.js 恢复 haptic 块即可。

> 本次改动**不含 Capacitor 专属 API**（纯 JS 模块拆分，CapRichHaptics/CapHaptics 仍在 app.js 初始化），**可推主仓库**。sync 后确认 haptics.js 文件存在 + index.html 中 haptics.js script 标签未被移除 + app.js 中 _initStreamHaptics/triggerHapticFeedback/_HAPTIC_* 定义未被恢复即可。

### 23. v2.0 模块化拆分阶段 0.5.3：providers.js 接口管理模块（cache-bust v75 -> v76 -> v77，含 TDZ 修复）

**背景**：v2.0 模块化拆分继续，0.5.2 haptics.js 完成后启动 0.5.3：将聊天 Provider 系统（模板、归一化、UI 渲染、编辑、测试、保存、迁移）拆分到独立 providers.js 模块。这是 v2.0 拆分中体积最大的一个。

**新增文件**：
- `www/providers.js`（21.4KB）：聊天 Provider 系统完整逻辑

**迁移清单**（从 app.js 剪切到 providers.js）：
| 类型 | 内容 |
|---|---|
| 常量 | `PROVIDERS_KEY`, `PROVIDER_TEMPLATES` |
| 函数 | `getProvider`, `normalizeBaseUrl`, `getProviderTemplate` |
| 函数 | `normalizeProvider`, `normalizeModels` |
| 函数 | `modelToUpstreamId`, `resolveTemplate`, `buildUpstreamPayload`, `getModelsEndpoint` |
| 函数 | `loadProviders`, `saveProviders`, `migrateOldApiKey` |
| 函数 | `renderModelSelector`, `syncModelSelector` |
| 函数 | `renderProviderList`, `openProviderEditor`, `closeProviderEditor`, `testProviderConnection`, `saveProviderFromEditor`, `deleteProvider` |
| 函数 | `parseJsonField`, `toggleProviderAuthFields`（provider 编辑器专用辅助） |

**保留在 app.js**：
- `state.providers = []` 初始化（**关键**：必须保留在 app.js 的 `const state = {...}` 中，否则触发 TDZ 报错，详见下方修复）
- 生图相关：`IMAGE_PROVIDER_TEMPLATES`, `getImageProviderTemplate`, `normalizeImageProvider`, `getImageProvider`, `getCurrentImageProvider`, `saveImageProviders`, `renderImageProviderList`（留给 0.5.4 image-gen.js）
- `compressImageForUpload`（视觉上传，与 provider 无关）

**加载顺序**（index.html，依赖从下到上）：
```html
<script src="db.js?v=77"></script>              <!-- 1. 存储层 -->
<script src="haptics.js?v=77"></script>          <!-- 2. 振感 -->
<script src="providers.js?v=77"></script>        <!-- 3. 接口管理（新增） -->
<script src="gesture-helpers.js?v=77"></script>  <!-- 4. 手势 -->
<script src="app.js?v=77"></script>              <!-- 5. 入口（最后加载） -->
```

**严重 Bug：TDZ（暂时性死区）报错导致接口数据丢失**

**现象**：用户安装 v76 APK 后，所有已配置的接口数据消失，接口列表为空。

**根因**：
1. `state` 在 app.js#L29 用 `const state = {...}` 声明
2. 原来 `state.providers = []` 在 app.js 中紧跟 `const state` 之后执行，给 state 动态添加 providers 字段
3. 拆分时这行被迁移到 providers.js#L65，但 providers.js 在 app.js **之前**加载
4. providers.js 加载时 `state` 处于 TDZ（const 声明未初始化），`state.providers = []` 抛出 `ReferenceError`
5. providers.js 加载中断 → loadProviders/renderProviderList 等函数全部未定义
6. init() 调用 loadProviders() 报错 → 接口数据未从 IndexedDB 加载 → 列表为空

**修复**（v77）：
1. providers.js：删除 `state.providers = []` 立即执行语句
2. app.js：在 `const state = {...}` 中添加 `providers: []` 字段（与 conversations/currentId 等同级）
3. cache-bust 升级 v76 → v77（避免 WebView 缓存旧版本导致修复不生效）

**关键经验（已写入任务看板§十四）**：
> **TDZ 陷阱**：任何对 `state` / `settings` 等 app.js 中 `const` 声明的全局变量的**立即执行语句**（如 `state.providers = []`），
> **不能放在 app.js 之前加载的模块中**。因为 const 声明在加载时处于 TDZ，访问会抛出 ReferenceError。
> **正确做法**：在 app.js 的 `const state = {...}` 初始化时直接定义所有字段；
> 其他模块只声明函数，运行时（init 之后）才访问 state。

**验证结果**（APK v77 实测通过）：
- [x] 应用启动正常，无白屏/报错
- [x] 接口列表正常显示原有接口配置（数据已恢复）
- [x] 接口编辑器字段预填正确
- [x] 修改/删除接口后持久化正常
- [x] 测试连接按钮工作正常
- [x] 模型选择器正常显示（按接口分组）
- [x] 切换会话时模型下拉框自动同步
- [x] 发送消息流式回复正常
- [x] 生图功能不受影响（IMAGE_PROVIDER_TEMPLATES 保留在 app.js）

**app.js 变化**：253KB → 234KB（减少约 19KB / 600 行）

**回滚**：`git reset --hard HEAD~1` 即可恢复。providers.js 删除 + index.html 还原 v75 + app.js 恢复 provider 相关代码即可。

> 本次改动**不含 Capacitor 专属 API**（纯 JS 模块拆分），**可推主仓库**。sync 后确认 providers.js 文件存在 + index.html 中 providers.js script 标签未被移除 + app.js 中 const state 包含 providers 字段 + PROVIDER_TEMPLATES 等定义未被恢复即可。
---

### 21. v79-v82 图片预览手势修复（cache-bust v79→v82，2026-07-26）

> 拆分 0.5.4 image-gen.js 后暴露的预览手势问题，经过多轮调校最终稳定。

#### v79：导出 OOM + 双指放大退出预览
**问题1 - 导出全部数据卡退（OOM）**
- 现象：点击导出全部数据后 App 崩溃，logcat 报 `java.lang.OutOfMemoryError: Failed to allocate a 66676936 byte allocation`
- 根因：`settings.images` 数组中残留的 `dataUrl`/`referenceImages`/`thumbnailDataUrl` 大 base64 字段，JSON 序列化时产生 66MB+ 字符串，Capacitor Bridge 传递时 OOM
- 修复位置：`www/app.js` 的 `exportAllData` 函数
- 修复方式：导出前创建 `exportSettings` 浅拷贝，剥离 images 中所有大字段，只保留元数据；图片文件已存 Filesystem，导入后由 `migrateImportedImagesToFilesystem` 重新关联

**问题2 - 双指放大后松开退出预览**
- 根因：overlay 的 touchend 监听器在双指松开一指时误触发单击关闭逻辑
- 修复：`www/image-gen.js` 添加 `_pinchActive`/`_pinchEndTime` 状态追踪，pinch 结束后 300ms 内忽略 tap 事件

#### v80：放大后滑动照片松开退出预览
- 根因：放大状态(scale>1)下单指拖动(pan)松开时，touchend 误触发 handleTapClose 单击关闭
- 修复：`www/image-gen.js` 添加 `_panActive`/`_panEndTime`/`_panStartX`/`_panStartY`/`_panMoved` 状态追踪：
  - img touchstart：单指按下且 scale>1 时设 `_panActive=true`，记录起始坐标
  - img touchend：根据位移区分拖动(>10px)/单击(≤10px)，拖动时更新 `_panEndTime`
  - overlay touchend：pan 结束后 300ms 内忽略 tap

#### v81：单击反馈慢 + 双击后退出（部分修复）
- 问题：单击退出反馈慢（250ms 延迟）；双击后图片放大一下然后退出
- 修复：单击延迟 250ms→200ms，双击窗口 280ms→180ms（180<200 确保双击能取消单击）
- 双击放大后设置 400ms 保护期（`_lastZoomTime`），期间忽略所有 touchend 关闭
- **遗留**：双击后退出问题未根治，见 v82

#### v82：双击后放大退出预览（根治）
- 根因（经多轮 logcat 调试定位）：`www/image-gen.js` 的 img `touchstart` 监听器中有两处 `lastTapTime = 0`：
  - 双指 touchstart：`lastTapTime = 0`
  - 单指放大状态 touchstart：`lastTapTime = 0`
- 时序分析：
  1. 第一次 touchend → 单击分支，设置 `lastTapTime = now`，200ms 关闭定时器
  2. 第二次 touchstart（双击的第二次）→ **触发 `lastTapTime = 0`**，重置双击检测
  3. 第二次 touchend → `dt = Date.now() - 0`（巨大值），无法识别双击，进入单击分支设置关闭定时器
  4. 200ms 后关闭执行 → "放大一下然后退出"
- 附带 bug：放大状态判断 `indexOf('scale(1)') < 0` 有误（初始 transform 为空也返回 -1，被误判为已放大）
- 修复：
  1. 删除 touchstart 中所有 `lastTapTime = 0`，双击检测完全交给 overlay 的 touchend 统一处理
  2. 放大状态判断改为正则提取 scale 值：`tr.match(/scale\\(([\\d.]+)/)`，>1.05 才视为放大

#### 关键经验
- **手势状态机设计**：touchstart 不应干扰 touchend 的双击/单击检测逻辑，否则会造成状态丢失
- **位移判断阈值**：用 10px 位移区分 tap/pan，比纯时间窗口更可靠
- **双击窗口 < 单击延迟**：确保双击的第二次 touchend 能在单击定时器执行前进入双击分支并 `clearTimeout`
- **社区参考**：PhotoSwipe 的 closeOnVerticalDrag 模式、touch-action: manipulation 禁用浏览器双击延迟

#### 涉及文件
- `www/image-gen.js`：`showImagePreview` 函数内的 img/overlay touchstart/touchend 监听器
- `www/app.js`：`exportAllData` 函数的 settings 镜像剥离逻辑
- `www/index.html`：cache-bust v79→v82


### 27. 状态栏格式/规则约定分离（commit `81dd11c`，cache-bust v86→v88）
**背景**：用户实测反馈——① 提示规则框为空时注入硬编码默认字段（"当前地点、当前行动…"）；② 填入整句规则时示例格式被按逗号乱切；③ "展示字段"名不副实（设计文档称 UI 过滤，实际渲染端无过滤实现）。
**语义重定义**（通用改动，主仓库同步需重打）：
- `templateRule`（UI 文案"格式约定"）：定义状态栏字段/格式形式，生成指令与示例；**留空则仅提示输出 `<status>` 标签，不指定字段**（不再回退内置默认）
- `displayFields`（UI 文案"规则约定"，可选）：字段的特殊规则说明；**留空则不注入**（原"UI 展示字段过滤"语义废弃）

| 文件 | 改动 |
|---|---|
| `chat.js` | 抽 `statusBarRuleText/Mid/Post/User` 公共函数收敛六处默认值散落；两处 `buildContext` 共用；示例分隔符扩为 `/[,，、\s]+/`（支持空格）；中途提醒改按真实历史消息每 4 条触发、**上限 5 次**（原 `msgs.length % 4` 含 system 消息、无上限） |
| `index.html` | 设置面板文案与 placeholder/hint 同步；cache-bust v86→v88 |

**注入效果**（node 场景验证 4 例全过）：
- 格式空+规则空：仅一条 `【状态栏指令】…用 <status>...</status> 标签输出角色当前状态信息，内容请根据上下文合理填写…`
- 格式"好感度 疲劳值"+规则"好感度单位为%形式…"：指令含字段 + 示例两行（`好感度：xxx / 疲劳值：xxx`）+ `【规则约定】…` 附加段


### 28. 导入备份补 saveProviders() 持久化（commit `2bfa52f`，cache-bust v88→v89）
**背景**：用户实测 maintenance 应用——导入完整备份后接口管理 key 正常，但**重装/重启后 API key 全部消失**。CDP 直读 IndexedDB 定位：`conversations`（81 会话）与 `settings_v2`（含 imageProviders key）都在，唯独 `chatlite_providers` 键不存在。
**根因**：`io.js` 三个导入路径（overwrite/merge/streamed）把备份 `data.providers` 写入内存 `state.providers` 后，**从未调用 `saveProviders()` 持久化**——conversations 有 `save()`、settings 有 `saveSettings()`，唯独 providers 漏持久化 → 任何重启/重装后 `loadProviders()` 从 IDB 读不到键 → 接口管理清空（导入后当时内存有值，表现正常，重启暴露）。
**改动**（通用改动，主仓库同步需重打）：
| 位置 | 改动 |
|---|---|
| `io.js` overwrite 模式（原 224 行） | `if (data.providers) { state.providers = data.providers; saveProviders(); }` |
| `io.js` merge 模式（原 244 行后） | 合并后补 `saveProviders();` |
| `io.js` streamed 模式（原 439 行） | 赋值后补 `saveProviders();` |
| `index.html` | cache-bust v88→v89 |

**验证**：node --check 通过；CDP 确认 v89 运行时 `importAllData`/`importAllDataStreamed` 函数体均含 `saveProviders()` 调用。APK 已装机，待用户重新导入备份验证 key 持久化。


### 29. 保存到相册改走 MediaStore（自写原生插件 MediaSaver，cache-bust 仅 app.js v112 → v115，2026-09-24 摘回主干）

**背景**：用户反馈华为平板 M6（`SCM-AL09` / Android 10 / API 29 / EMUI 12 底层鸿蒙 2.x，应用 targetSdk 34）上「生图无法保存」。

**根因（CDP 实测取证）**：`saveImageToDevice` 用 Capacitor Filesystem 的 `directory:'EXTERNAL_STORAGE'` 直接写 `/sdcard/Download/`，publicStorage 权限检查必然失败：

```json
"fsCheckPermissions": { "publicStorage": "denied" },
"write_EXTERNAL_STORAGE": "ERR Missing the following permissions in AndroidManifest.xml:
    android.permission.READ_EXTERNAL_STORAGE
    android.permission.WRITE_EXTERNAL_STORAGE"
```

旁证：`/sdcard/Download/` 下无任何 chatlite 文件、`/sdcard/Android/data/<pkg>/` 整个不存在；而图库内部存储 `files/chatlite_images/` 里 5 张 PNG（2.4–3.4MB）完整 → **生图本身没问题，坏的只有"保存到相册"这一步**。

**为什么"补权限"不是正解**：targetSdk=34 时，Android 11+ 写公共目录需 `MANAGE_EXTERNAL_STORAGE`（"所有文件访问"，要用户去系统设置手动开启，华为管控更严）；`requestLegacyExternalStorage` 又只对 Android 10 设备有效，覆盖面有限。

**方案**：新增自写 Capacitor 插件，走 **MediaStore**（分区存储时代写相册的正道）。

| 文件 | 改动 |
|---|---|
| `android/app/src/main/java/com/avelec/chatlite/MediaSaverPlugin.java` | **新增**。`@CapacitorPlugin(name="MediaSaver")`，方法 `saveImage({base64,fileName,mimeType,album})`：`ContentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI)` + `RELATIVE_PATH=Pictures/chat-lite` + `IS_PENDING` 两段式写入（保证原子性），失败时 delete 掉半成品条目。Android ≤9 走 WRITE_EXTERNAL_STORAGE 权限申请 |
| `MainActivity.java` | `onCreate` 中 `super.onCreate()` **之前**调用 `registerPlugin(MediaSaverPlugin.class)` |
| `AndroidManifest.xml` | 新增 `<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />`（仅老系统生效，不影响新版权限模型） |
| `app.js`（插件初始化区） | 新增 `CapMediaSaver`：优先取 `Capacitor.Plugins.MediaSaver`，取不到则用 `Capacitor.registerPlugin('MediaSaver')` 现场建代理 |
| `app.js`（`saveImageToDevice`） | 改为三级降级：**MediaSaver（首选，进系统相册）→ Filesystem 写 Download（兜底）→ `<a download>`（浏览器）** |
| `index.html` | cache-bust **只升 app.js：v112 → v115**（其余模块一律不动，原因见下方「cache-bust 教训」） |

**关键点**：
1. **Android 10+ 往 MediaStore 写自己创建的媒体，不需要任何权限** —— 这是选它而不是补权限的根本理由
2. **原生注册不等于 JS 可用**：Capacitor 的原生插件必须同时在 JS 侧 `registerPlugin(name)` 建代理，才能通过 `Capacitor.Plugins.X` 调用

**⚠️ 摘回历史（2026-09-24）**：本补丁最初随 commit `53f18eb` 落地，随后连同 2026-09 期间其它改动一起被整体回退（原提交保留在 `backup/v113-mediasaver` tag），确认与振动问题无关后，于当日**单独摘回主干**。

**cache-bust 教训（重要）**：`53f18eb` 当时把 `index.html` 里**全部 9 个模块**的 cache-bust 一次性统一升到 v113，等于顺手强制 WebView 重新下载 `haptics.js`。而该文件自 2026-08-02 起内容从未变过、cache-bust 一直停在 v102（长期走用户端缓存），重新拉取后暴露了它既有的 `_richHapticsReady` 永不回退隐患——`playPreloaded` 的 Promise 无人接管且调用后无条件 `return`，一旦 reject 即**整条振动链路静默失效**（无振动、也无报错）。

> **规则**：模块级 cache-bust 只在**该模块自身内容变化**时升号，不要"顺手统一版本号"。升号会强制用户端重新下载，把长期被缓存掩盖的问题一并翻出来，且极难归因。

**顺带记录的坑**：Capacitor 6 的 `Directory` 枚举值必须**大写**（`'EXTERNAL_STORAGE'` / `'DATA'` / `'CACHE'` / `'DOCUMENTS'`），传小写 `'External'` / `'Documents'` 会返回 `INVALID_DIR`（CDP 实测）。

> 本次改动含 Capacitor 专属 API（自写插件 + 权限声明），**不推主仓库**。

### 30. v122：等待模型返回的超时与链路加固 + 设置面板排版统一（自写原生插件 ChatStream，cache-bust chat.js v117→v122 / app.js v117→v122 / db.js v102→v122 / style.css v120→v122，2026-10-14）

**背景**（用户反馈两点）：
1. 有的模型思考时间很长且**不返回思维链**，等待超时太短又无处可调；
2. 已经流出深度思考或正文后，有时会因网络抖动被截断。

**先把整条链路读了一遍，找到五处会「吃掉已收到内容」的地方**（按严重程度排）：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `node_modules/capacitor-stream-http/.../StreamHttpPlugin.java` | `setReadTimeout(30000)` **写死 30 秒**。模型静默思考超 30 秒 → `SocketTimeoutException` → 流被掐断。而 JS 侧空闲超时默认 120 秒，**永远追不上原生这 30 秒**，且原生值无法从 JS 调整 |
| 2 | 同上，读循环结束处 | 无论「读到 `[DONE]`」还是「连接被提前关闭」一律发 `end`，原生也从不识别 `[DONE]` → 优雅 EOF 被 JS 判定成「正常完成」= **静默截断** |
| 3 | `chat.js` `executeRequest` 回退分支 | 流式失败后回退非流式前把 `content` 重置为 `existingContent`，已流出的内容被清空 |
| 4 | `chat.js` chunk 监听 | `data.id !== streamId` 在 `startStream` 尚未返回（`streamId === null`）时判断 → **最早到达的分块被丢弃**（开头缺字） |
| 5 | 非 2xx 响应 | npm 版把错误体当 SSE 读一遍、什么也没解出来，最后发 `end` → JS 视为「成功但空回复」，**错误被吞掉** |

**方案（三层）**：

**① 原生：新增自写插件 `ChatStreamPlugin`**（`android/app/src/main/java/com/avelec/chatlite/ChatStreamPlugin.java`，与 MediaSaver 同一套路 —— 放在 app 模块，`cap sync` / `npm install` 都不会覆盖）

| 改动 | 说明 |
|---|---|
| `readTimeoutMs` 由 JS 传入 | 默认 = JS 空闲超时 + 15 秒，原生不再抢先掐断；范围钳制 10s~1h |
| 原始文本直接透传 | 不再在原生侧拼装 SSE 事件，行缓冲交给 JS（JS 本来就有跨分包行缓冲），少一层少丢一截 |
| `end { completed, reason, error }` | 读到 `[DONE]` → `completed:true`；**已出数据后出错** → `end{completed:false, reason:'interrupted'}`；**未出数据就失败** → `error`（区分「中途断流」与「压根没连上」） |
| 取消时不发任何事件 | 原来 `cancelStream` 后读循环 break、却仍补发 `end` —— JS 会把它当成「正常完成」，**把停止标记吃掉** |
| 非 2xx 直接 `error` | 带上响应体里的错误信息（限长 400 字），不再静默空回复 |
| `MainActivity.java` | `super.onCreate()` **之前** `registerPlugin(ChatStreamPlugin.class)` |
| `app.js` 插件初始化区 | `CapStreamHttp` 改为优先取 `Capacitor.Plugins.ChatStream`，取不到回退 npm 的 `StreamHttp`（两者 JS 调用方式一致） |

> `capacitor-settings.gradle` 由 `cap update` 生成、`package.json` 的 `capacitor-stream-http` 依赖**保持不动** —— 自写插件只做「优先」，npm 版仍在，回退路径始终可用。

**② JS：`chat.js` 完成度判定 + 内容保全**

- 统一超时：新增 `resolveChatWaitMs()` 读 `settings.chatWaitMs`（取代没有任何 UI 入口的 `nativeTimeoutMs`），范围钳制 15s~1h，缺失时默认 300s
- **完成条件 = 原生 `completed` / 收到 `[DONE]` / 拿到 `finish_reason`，三者任一**；不满足则**保留全部内容** + `interrupted` 标记 + 复用既有「继续生成」按钮，**绝不自动重发**（避免重复计费）
- 早期分块缓冲（`earlyChunks`）后回放；`data:` 无空格兼容；`\r` 清理；SSE 心跳注释行忽略
- `finish_reason === 'length'` → 如实提示「已达模型单次输出上限」（这是参数限制，不是抖动）
- 对端忽略 `stream:true` 而整段返回 JSON → 兜底解析出正文与思维链（`salvageNonStreamBody`）
- 非 2xx 错误体 JSON 美化（`prettyStreamError`），不把整段 JSON 甩到界面上
- 非流式路径（`executeNativeRequest`）同源超时 + 触顶提示
- **web 流式路径**（`sendFromMessage` / `sendFromMessageContinue`）此前**完全没有超时**（卡住就永远等）—— 补上同源空闲超时 + 完成判定

**③ 设置项：常用偏好 → 等待超时（秒）**

- 默认 300，范围 15~3600，数字输入，**改动即时落盘**（不必点「保存」）
- `db.js` 新增 `chatWaitMs: 300000`；移除 `nativeTimeoutMs`（旧用户存的 120000 因字段名更换而失效，自动拿到新默认 —— 该值本来就没有 UI 让人改过）
- 语义：**任意两次数据到达之间的最长等待**，每收到一块数据即重新计时，因此同时覆盖「首字前的长思考」与「中途卡住」

**⑤ 设置面板排版统一（用户截图指出「说明文字占满整屏」）**

根因：**`.setting-hint` 这个类在 style.css 里根本没有规则** —— 全仓 16 处用到它，却从未被定义，于是全部继承正文字号（15px）与主色 `--text`，说明文字反而比项目名还大。

统一规格（一条规则贯穿整个面板：**一个功能项 = 「名称 + 控件」一行 + 「小字说明」一行**）：

| 元素 | 规格 |
|---|---|
| 名称 `.setting-row > span:first-child` | 13px / 500 / `--text` |
| 控件 `.setting-select` / `.setting-input` | 13px（原 14px），行最小高 28px |
| 数字输入 `.setting-num`（新增） | 固定 104px + 右对齐 + `tabular-nums`（位数变化不跳宽） |
| 说明 `.setting-hint` | **11px / 400 / `--text2` / 行高 1.5 / opacity .85**，紧贴其上 3px |
| 分节标题 `.setting-section-title` | 11px / 600 / `letter-spacing:.08em` |
| 纵向节奏 | 项间距 12px；分隔线 `margin:14px 0 0` |

顺带修的两处不一致：
1. **「直连模式」原本是裸 `checkbox`**，全面板唯一一个 —— 改成与其余开关同款的 `.toggle-switch`
2. **「背景遮罩」是项目名却挂了 `setting-hint` 类**（靠 `.setting-row>span:first-child` 权重更高才碰巧显示成 13px）—— 去掉误用的类名，语义归位

文案同步压缩：流式模式 / 等待超时 / 流式振感 / 渲染 四段说明由 2~5 行压到 1~2 行。

**真机实测**：说明文字总高 **320px → 116px（-64%）**，占常用偏好分组高度的比例 **50% → 22%**，分组整体 **634px → 529px**；全面板 15 条 `.setting-hint` 计算字号**全部 11px，零例外**。

**验证**：`node --check` chat.js / app.js / db.js 全通过；行为自验 **42/42**（vm 沙箱 + 假插件驱动 `executeStreamHttp`，覆盖：正常完成 / 原生 completed / 优雅 EOF 判截断 / 中途断流保留内容且不重发 / 无数据失败仍走回退 / `finish_reason=length` 触顶 / 空闲超时（有内容·无内容两种）/ 早期分块回放 / 用户停止打 `[已停止]` / 非流式兜底 / `data:` 无空格+心跳+跨分包 / 零数据 / 纯函数边界）。

**⑥ 主仓库 chat-lite 同步（2026-10-14，commit `f3d853c`）**

同步前先过**安全闸**：把主仓库当前文件与「APK 仓库 v121 基线（`e3f18ae`）」逐个比对，确认主仓库只是「跟着旧版本走」而非「有独立改动」，才允许覆盖。

> **⚠️ 闸门第一版踩的坑**：`git show <commit>:<path>` 输出的是 **blob（LF）**，而两个仓库工作区都是 **CRLF**（`core.autocrlf=true`、无 `.gitattributes`）。直接拿 blob 和工作区文件比哈希 → **四个文件全报「差异 3298 / 2772 / 1242 / 438 行」**，是彻底的假警报，差点误判成"主仓库有大量独立改动、不能覆盖"。
> **修正：跨仓库比对文件必须先归一化行尾（CRLF→LF）再算哈希。** 归一化后主仓库四个文件与 v121 基线**逐字节相同**，结论才成立。
> 这与 §4.12「尺子在说谎」同源：**量出来的差异要先质疑测量方式，再质疑被测对象。**

| 文件 | 处理 |
|---|---|
| `chat.js` / `db.js` / `style.css` / `app.js` | `sync.ps1 -Direction apk-to-main` 自动覆盖（哈希已归一化确认无独立改动） |
| `index.html` | merge-only，手动合并 |
| `vendor/`（26 文件） | 哈希全一致，无需复制 |
| 其余 10 个共享文件 | 哈希全一致，无需复制 |
| `ChatStreamPlugin.java` / `MainActivity` 注册 | **不推**（Capacitor 专属，见 §11.11 同一套路） |

`index.html` 合并时**保留的主仓库特有项**：`/favicon.png` 与 `/chat-lite/manifest.json` 绝对路径、无 `splash-screen` 块、无 BOM。

**cache-bust 决策**：只升「内容真的变了」的 4 个 —— `style.css` v120→122、`chat.js` v117→122、`app.js` v117→122、`db.js` **v113→122**。`providers.js` / `conversation.js` / `io.js` / `gesture-helpers.js` **保持 v113 不动** —— 它们的号虽与 APK 仓库不同（102/112），但**内容逐字节一致且期间未变**，说明用户浏览器缓存里那份本来就是对的；按 §4.7 此时升号反而是无谓的重下。

**主仓库侧验证**：`node --check` 五个 JS 全通过；本地静态服务 + 无头 Chrome **页面零 JS 报错**、marked / katex 0.16.47 / hljs 三库就绪；**15 条 `.setting-hint` 计算字号全部 11px 零例外**；等待超时 900 → `settings.chatWaitMs` 立即变 900000、填 5 → 钳到下限 15000。

> **web 版白捡的好处**：`chat.js` 里**补上的空闲超时与完成度判定正好是 web 版走的那条路**（`executeStreamHttp` 是 Capacitor 专属，web 走 `sendFromMessage` 里的 fetch 流式循环）。此前该路径**完全没有超时**，请求卡住就永远等下去 —— 这条修复此前只在 APK 上验证过，同步后 web/PWA 一并受益。

**⑦ 合并进 main + main 版 APK 装机（2026-10-14，`e3f18ae → aae261a`）**

- 切分支前后各做一次**文件完整性核对**（§4.5 第 6 条）：**20/20 一致，本次未触发静默丢文件顽疾**
- `maintenance → main` **快进合并**，8 文件 +736/−92（含新增 `ChatStreamPlugin.java`）
- 构建 main 版 **`chat-lite-2.1-v122-debug.apk`**（4.24MB）：**文件名无分支后缀、appId `com.avelec.chatlite`**（§3.4d 分支隔离机制生效）；覆盖装机 v121 → v122
- **装机后真机复核**：`ChatStream` 出现在 `pluginHeaders` 内且 `CapStreamHttp` 实际指向它（`usingChatStream:true`）、cache-bust 全 v122、等待超时输入框值 300、四个 helper 函数齐全、`startStream` 14ms 返回 id、说明文字计算字号全 11px
- **数据零丢失**：会话 **122** / 接口 **8** / 图库记录 **81 = 落盘 81 文件** —— v121 的孤儿回收仍在正常工作，零残留
- `main = maintenance = origin/main = origin/maintenance = aae261a` 四指针一致

> 本次含 Capacitor 专属原生插件（`ChatStreamPlugin` + MainActivity 注册），**原生部分不推主仓库**；`chat.js` / `db.js` 属共享文件，`index.html` 与 `app.js` 需按 `isCapacitor()` 甄别后同步。

### 31. v123/v124：生图模块交互对齐 + 缩略图存储（cache-bust image-gen.js v121→v124 / db.js v122→v124 / style.css v122→v124，2026-10-20）

**v123（`2134b5e` + 5 个真机补丁）**：生图与对话界面的交互对齐、简陋设计清理。本文档只登记**与 APK/Capacitor 相关**的部分（纯 Web 逻辑不登记）：

| 改动 | 位置 | 为什么必须登记 |
|---|---|---|
| **96px 缩略图落盘** | `image-gen.js` `writeThumbFile()` / `getImageThumbUrl()` / `backfillImageThumbnail()` | 走 `CapFilesystem.writeFile`（`Directory.DATA`，目录 `chatlite_images`，文件名 `<id>_thumb.jpg`）。**浏览器模式没有 Filesystem，会退化成 `thumbDataUrl` 内存字段**；同步主仓库时必须保留这条降级分支，不能当成纯 Web 代码删掉 |
| **缩略图与主图同生命周期** | `deleteImageFile()` 调用点、`purgeOrphanImageFiles()` 的 `keep` 列表 | v123 起 `keep` 同时收 `fileName` 与 `thumbName`，否则孤儿回收会把缩略图全删光（主图还在、列表却全变裂图） |
| **生图反馈振感开关** | `index.html` `#image-haptic-check`（`.setting-row.capacitor-only`） | 整行带 `capacitor-only` 类，web 下 `display:none`。主仓库同步 `index.html` 时这一行**可以保留**（无害），但要知道它只在 APK 可见 |

**v124（本次补丁）**：修 v123 遗留缺陷，全部为共享代码，**无新增原生依赖**：

| 修复 | 说明 |
|---|---|
| 缩略图分支写反 | 老图（有 `fileName`、无 `thumbName`）被误判成「有缩略图」→ 回退读全尺寸并缓存。改为严格按 `thumbName` 分流；并在 `migrateImportedImagesToFilesystem` 里为存量图补缩略图（幂等，每 5 张落盘一次） |
| 模型记忆不落盘 | `rememberImageModel` 内部补 `saveSettings()` |
| 自定义模型名被重绘冲掉 | `renderImageModelSelect` 以输入框现值为准，不再无条件覆盖 |
| 窄屏侧栏遮挡生图 | 新增 `syncImageSidebarForViewport()`，生图可见时窄屏强制收侧栏；**并补 resize 双向处理**（窄→宽要把自动收起的侧栏还原，否则宽屏下生图白占满屏） |
| 图卡操作区 | 收成只留「⋯」（外链图保留「重新下载」） |
| 错误条 | 补「复制提示词」「检查接口」；「重试」改为直接提交同参数；空图库时错误条不再被空态挤出可视区（`.image-stream.has-error`） |
| 长按 | `touchend` 的 `preventDefault()` 在 passive 手势里无效，改为时间戳抑制随后的 click；`.image-card img` 补 `-webkit-touch-callout:none` 防系统菜单抢长按 |
| 生成数量上限 | 按 `features.maxBatch` 收敛输入框 `max`（此前只 toast，不限制） |
| 删除失败可见 | `deleteImageFile` 真失败时抛出（ENOENT 视为成功），调用方 await 并 toast |
| 持久化 | `db.js` 剥离名单补 `thumbDataUrl`（**仅当有 `thumbName` 时**才剥，浏览器模式必须保留） |

**同步主仓库时注意**：以上全是 `www/` 下的共享文件改动，`sync.ps1` 可直接同步；**没有新增原生插件、没有新增权限**。`image-gen.js` 里凡是 `isCapacitor()` 分支都必须原样保留（缩略图、图片落盘、通知）。

**cache-bust**：只升真正变了的三个 —— `image-gen.js` v123→v124、`db.js` v123→v124、`style.css` v123→v124；`app.js` 本次未改（保持 v123）。


### 32. v125：语音通话模块（cache-bust 新模块 v125 / db.js v124→v125 / app.js v123→v125 / image-gen.js v124→v125 / style.css v124→v125）

> 本节按铁律登记**所有与 APK / Capacitor 相关的改动**。纯 Web 逻辑（状态机、提示词、动效）不在此登记。

**一、原生权限与插件（本次唯一的新增原生能力 = 麦克风）**

| 文件 | 改动 | 为什么必须登记 |
|---|---|---|
| `android/app/src/main/AndroidManifest.xml` | 新增 `RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`、`<uses-feature android:name="android.hardware.microphone" android:required="false"/>` | **getUserMedia 在 WebView 里的硬前提**。Capacitor 6.2.1 自身的 `BridgeWebChromeClient` 已实现 `onPermissionRequest` 对 `RESOURCE_AUDIO_CAPTURE` 申请授权，**真正缺的只有 manifest 这一行**；缺它时系统直接判「未声明」→ 拒绝 → `getUserMedia` 抛 `NotAllowedError`。这一条是本次最大的平台风险，已真机（22081212C / Android 15）实测排除 |
| `.../java/com/avelec/chatlite/MainActivity.java` | 新增 `MicWebChromeClient extends BridgeWebChromeClient`，只覆盖 `onPermissionRequest` | 见下方「permissionListener 槽位冲突」——**不覆盖会偶发永久挂起**。与 `ChatStreamPlugin` / `MediaSaverPlugin` 同套路，`cap sync` / `npm install` 不覆盖 |

**二、permissionListener 槽位冲突（源码级确定的缺陷，非运行时复现阶段）**

Capacitor 6.2.1 `BridgeWebChromeClient` 用**单个成员变量** `permissionListener` 承接 ActivityResult 回调，`onPermissionRequest` 与 `onShowFileChooser` 都会先给它赋值：

1. 点通话 → `getUserMedia({audio:true})` → `onPermissionRequest` → `permissionListener = {授予就 request.grant}` → `permissionLauncher.launch([RECORD_AUDIO])`
2. 系统弹框还开着时用户去发一张图片 → `onShowFileChooser` 的 capture 分支 → `permissionListener` **被覆盖**成文件回调
3. 第一个权限回调返回时 `permissionListener` 已指向第二个 → WebView 侧的 `PermissionRequest` **既没 grant 也没 deny** → **`getUserMedia` 的 Promise 永久 pending**，不抛错、不 reject、无超时

JS 侧表现为「通话一直卡在连接中」，而日志里 `onPermissionRequest: wantsAudio=true` 看起来一切正常，**极难归因**。

> **诚实标注**：这是**读源码得出的确定性缺陷**，并用「拒绝路径实测不挂起」侧面验证了自写实现正确；但**未在运行时复现**「通话中同时发图」（复现需要通话 UI 已可用）。
> 修法：自写 `MicWebChromeClient` 用独立字段承接音频权限请求，与文件选择器隔离，并保证**每条分支都必定 grant 或 deny**，不留悬空路径。

**三、Web 侧与 APK 相关的改动**

| 改动 | 位置 | 说明 |
|---|---|---|
| 克隆参考音存储 | `voice-settings.js` `saveCloneRef()` / `loadCloneRef()` | APK 走 `CapFilesystem`（`Directory.CACHE`，文件名 `voice-clone-ref.<ext>`）；Web 走 IndexedDB（`chatlite_voice_clone_ref`）。**参考音绝不进 settings / localStorage**（base64 会把设置撑爆，同 §4.2 OOM 一类） |
| 返回键层栈 | `image-gen.js` `App.addListener('backButton')` 最前面 | 新增 `if (state.voiceOpen) { VoiceCall.close(); return; }`。通话层在生图之上，**不接进这条链的话通话中按返回键会一路穿到底部触发 `App.exitApp()` 直接退出 App** |
| 语音请求不可取消 | `voice.js` 全部请求 | `CapacitorHttp.enabled=true` 时 POST 走 `nativePromise`，**`AbortController` 无效**（§4.15）。所有请求用 `Promise.race(请求, 放弃计时器)`，放弃后仍必须 settle，不留悬挂 Promise |
| debug 包 WebView 调试默认开 | Capacitor 上游默认行为 | `Bridge.initWebView()` 用 `config.isWebContentsDebuggingEnabled()`，默认值 = `isDebug`。**未覆盖**（覆盖会破坏真机 CDP 调试手段）；release 包默认关闭 |

**四、cache-bust**

只升真正变了的：`db.js` v124→v125、`app.js` v123→v125、`image-gen.js` v124→v125（返回键一行）、`style.css` v124→v125、`index.html`（引用）。
新模块首发即 v125：`voice.js`、`voice-director.js`、`voice-settings.js`。
**其余模块保持原值**（§4.7 铁律：不「顺手统一升号」）。

**五、主仓库同步提示**

`voice.js` / `voice-director.js` / `voice-settings.js` 是纯 Web 代码，可整体同步；
但 `voice-settings.js` 里的 `isCapacitor()` 分支（`CapFilesystem` 存克隆参考音）**必须原样保留**，Web 侧自动降级到 IndexedDB。
`MainActivity.java` / `AndroidManifest.xml` 属原生，**不推主仓库**。
---

## 33. v126 语音通话体验补完（commit `42fe916`）

### 一、原生侧新增：`AudioRoutePlugin.java`

| 项 | 内容 |
|---|---|
| 注册 | `MainActivity.onCreate` 里 `registerPlugin(AudioRoutePlugin.class)`（紧跟 `ChatStreamPlugin` 之后一行） |
| 接口 | `getRoute()` → `{ type, name }`；`addListener('routeChange', cb)` |
| type 取值 | `headset` / `bluetooth` / `speaker` / `earpiece` |
| 判定 | `AudioManager.getDevices(GET_DEVICES_OUTPUTS)`：WIRED_HEADPHONES/WIRED_HEADSET/USB_HEADSET → headset；BLUETOOTH_A2DP/SCO → bluetooth；其余无外接时按 `isSpeakerphoneOn()` + 是否有听筒硬件区分 earpiece / speaker |
| 热切换 | `AudioDeviceCallback`（API 23+），回调里 `notifyListeners('routeChange')`；`handleOnDestroy` 反注册 |
| 权限 | **不申请任何运行时权限**。Android 12+ 读蓝牙名需 `BLUETOOTH_CONNECT`，已用 `try/catch(Throwable)` 包住，拿不到就退回 `productName` → 「蓝牙设备」 |
| 兜底 | 任何异常都返回 `{type:'speaker', name:'外放'}`，绝不 reject 到 JS |

> **实测记录（真机 22081212C / Android 15，未插耳机）**：插件原始回报 `{"type":"earpiece","name":"听筒"}`。
> 原因是 `isSpeakerphoneOn()` 在非通话态默认为 false，而手机确实有听筒硬件。
> **但 WebView 的音频走 STREAM_MUSIC，没有耳机时实际是从外放喇叭出来的** —— 所以 `voice.js` 把 `earpiece` 归一化成 **speaker**（不是 headset）。
> 若归成耳机，两套预设会用反：外放回声大却用了灵敏的耳机参数 → AI 被自己的声音打断。真机已验证 raw=earpiece → 归一化 speaker → 生效的是外放预设。

### 二、Web 侧新增的 APK 相关分支

| 改动 | 位置 | 说明 |
|---|---|---|
| 路由查询 | `voice.js` `currentRoute()` | 读 `Capacitor.Plugins.AudioRoute`；插件缺失 / 同步返回 / Promise reject / 抛错四种情况都静默回落，**绝不抛**。4 秒 TTL 缓存（每块 PCM 都要读，不能每次问原生） |
| 路由变化 | `voice.js` `hookRouteChange()` | `addListener('routeChange')`；只更新缓存与重算生效参数，**不打断正在进行的通话** |
| 双预设 | `voice.js` `effectiveTuning()` + `settings.voice.tuningPresets` | `{speaker:{...}, headset:{...}}`，按当前路由合并；非法值/越界忽略并保留 base |
| 语速 | `voice.js` `makeTimeStretcher()` | WSOLA 纯 JS，无原生依赖。`rate===1` 逐样本直通 |

### 三、cache-bust

只升真正变了的：`db.js` / `io.js` / `voice.js` / `voice-director.js` / `voice-settings.js` / `style.css` → **v126**。
**`app.js` 未改，保持 v125**（v125 才升过）；`image-gen.js` 保持 v124、`chat.js` 122、`conversation.js` 112。

### 四、★ 构建陷阱：`cap copy` 必须跑

`android/app/src/main/assets/public/` 是 `npx cap copy android` 的产物，**在 `.gitignore` 里**。
直接 `gradlew assembleDebug` 会用**上一次 copy 的旧资源**打包 —— 本次首次构建就踩了：APK 里 8 个文件有 7 个是 v125 的，
而构建输出一切正常（`BUILD SUCCESSFUL`），**只有逐个比对 SHA256 才能发现**。

**正确顺序**：`npx cap copy android` → `gradlew assembleDebug` → 解包比对 `assets/public/*` 的 SHA256。

### 五、主仓库同步提示

`AudioRoutePlugin.java` / `MainActivity.java` 属原生，**不推主仓库**。
`voice.js` 里的 `Capacitor.Plugins.AudioRoute` 调用**必须原样保留**（Web 侧插件不存在时自动回落，不影响浏览器）。
`io.js` 的导入修复是纯 Web 逻辑，可整体同步。

## 34. v132 息屏保活：前台服务 + 唤醒锁 + 原生心跳（commit 见 git log）

### 一、为什么必须动原生

真机实测（小米 22081212C / Android 15 / MIUI，起通话后按电源键）：

| 时间点 | 现象 |
|---|---|
| 息屏 35s | 采集还在（35s 收到 820 个音频块）；**定时器被节流**（250ms 的 interval 只跑 38 次）；**API 调用直接失败**：`Unable to resolve host api.xiaomimimo.com: No address associated with hostname` |
| 息屏 3~6 分钟 | `capture.blocks` 停止增长、JS 定时器也停（进程 `isFrozen=false`，不是被系统冻结）；亮屏瞬间全部恢复 |

→ 两件事 JS 侧无能为力：**后台网络/DNS 被掐**、**隐藏页面被 Chromium 挂起**。

### 二、原生侧新增

| 文件 | 内容 |
|---|---|
| `CallKeepService.java` | 前台服务，`foregroundServiceType="microphone|mediaPlayback"`（targetSdk 34 不声明就启动即崩）；常驻通知「语音通话中」，点按回应用；`START_NOT_STICKY`（没有通话状态就别复活） |
| `CallKeepAlivePlugin.java` | `start()` / `stop()` / `status()`。start：PARTIAL_WAKE_LOCK + `WifiLock(FULL_HIGH_PERF)` + `startForegroundService`。**任何一步失败都 resolve 而不是 reject**（保活失败最多不抗息屏，不能弄断通话） |
| `AndroidManifest.xml` | 服务声明 + `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MICROPHONE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK` |
| `MainActivity.java` | `registerPlugin(CallKeepAlivePlugin.class)` |

**原生心跳**：服务在跑时，主线程 Handler 每 5 秒做三件事 —— `webView.resumeTimers()`、`webView.onResume()`、`evaluateJavascript("window.__callTick&&window.__callTick()")`。
原因：隐藏页面的 JS 定时器被节流到 1 次/30 秒量级，采集看门狗需要准时钟；同时定期唤醒渲染进程以对抗隐藏页挂起。

### 三、Web 侧（voice.js）新增

| 改动 | 说明 |
|---|---|
| `keepAliveStart/Stop` | 通话接通时开、挂断/启动失败时关；插件不存在时静默跳过；浏览器环境退化为 Screen Wake Lock（防息屏） |
| `startCaptureWatchdog` | 「正在通话 + 采集开着」却连续 6s 没有音频块 → 先 `ctx.resume()`，再无效就整条采集图重建（重新 getUserMedia）；失败会重试而不是放弃 |
| `__callTick` | 原生心跳入口，只做看门狗（不碰别的定时器） |
| `__debug()` | 新增 `keepAlive`（on/info/screenLock/hidden）与 `audio`（ctx/capturing/sinceBlockMs/resumed/revives/reviveFails） |
| `finishUtterance` | `_vc.vad.reset()` 补判空 —— 看门狗重建采集的瞬间 `_vc.vad` 会短暂为 null，原来会抛 TypeError 让整轮"突然哑掉" |

### 四、cache-bust

只升 `voice.js` **132 → 133**；`chat.js` 保持 131、其余模块保持原值。原生文件不参与 cache-bust。

### 五、主仓库同步提示

`CallKeepService.java` / `CallKeepAlivePlugin.java` / Manifest / MainActivity 属原生，**不推主仓库**。
`voice.js` 里 `Capacitor.Plugins.CallKeepAlive` 与 `navigator.wakeLock` 两段**必须原样保留**（浏览器端没有插件时自动降级）。

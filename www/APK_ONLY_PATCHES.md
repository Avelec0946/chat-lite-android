# APK 专属改动清单（v1.3.0+）

> 此文件由 `sync-from-upstream.ps1` 同步主仓库 `chat-lite/` 时**不会**自动维护。
> 主仓库同步会**直接覆盖** `www/`，凡下方列出的段落，sync 后**必须手动重新打补丁**。
>
> 维护规则：每次提交 APK 专属改动时，作者必须同步追加/更新本清单条目。
> 同步主仓库前，先 `git diff v1.3.0-baseline..HEAD -- www/app.js www/index.html www/style.css`，
> 把 diff 中含 `isCapacitor()` 分支或下方关键字的段落补登到此。

---

## 同步后必须重新打的补丁

### 1. Capacitor 文件系统 / Share / StreamHttp 相关（已有上游基础）
关键字：`CapStreamHttp`、`CapFilesystem`、`CapShare`、`isCapacitor()`
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
**方案同批次 1 C1**：`position:fixed` 悬浮按钮（同 C1 的 fixed 方案），基于滚动位置动态切换箭头方向。
**关键**：滚动容器是 `.settings-content`（`overflow-y:auto;max-height:80vh`），不是 `.settings-body`（无 overflow）。scroll 监听必须挂在 `.settings-content` 上，否则事件不触发、按钮永不显示。
| 文件 | 改动 |
|---|---|
| `index.html` | settings-body 开头加 `<button id="settings-scroll-btn" class="settings-scroll-btn" style="display:none">` |
| `style.css` | `.settings-scroll-btn` `position:fixed;right:16px;bottom:16px` 圆形按钮（z-index:200）；不用 sticky（sticky bottom 在 flex 容器内对顶部元素不生效，按钮会随内容滚走） |
| `app.js` | scroll 监听挂 `.settings-content`：scrollTop<200=nearTop，底部-200=nearBottom；按钮在 nearBottom&&nearTop 时隐藏，nearBottom&&!nearTop 显示↑（回顶），否则显示↓（回底）；`toggleSettings` 打开时 setTimeout 触发一次 updateScrollBtn 初始化按钮状态 |

> 本节全部改动不含 Capacitor 专属符号，**可推主仓库**。sync 后需确认 `settings.global` 迁移逻辑、`effectiveStatusBar`/`effectiveModelPrompt` 新签名未被覆盖。

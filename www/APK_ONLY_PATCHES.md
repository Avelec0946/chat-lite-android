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

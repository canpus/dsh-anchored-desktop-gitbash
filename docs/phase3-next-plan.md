# 下一步计划：消息级操作近似品（无人值守执行计划）

> **执行状态：✅ 全部完成（2026-08-15 凌晨无人值守执行）**。四项任务（消息级操作、任务 A 取消启动静默检查、任务 B 代理设置、任务 C 中文命令映射）全部实现并经无人值守自测（RPC 12/12 + UI drive 7/7 + 冒烟 EXIT=0）。执行过程的关键发现与决策见 `History_log.md` 阶段 3 追加条目 + 决策台账 D44-D48。本文件保留为历史锚石，不再作为待办计划。

> **执行前第一步（强制）**：阅读 `History_log.md` 全文（快照 + 阶段 3 条目 + 决策台账 D1-D43）和 `docs/desktop-gui-plan.md` §6A——理解当前状态后再动手。压缩上下文后，本文件 + History_log 是唯一权威锚石。

## 当前状态（压缩锚点）

- 阶段 3「薄壳回退重建」**全部完成且用户逐轮验收通过**（薄壳、检查更新、模式切换/预设全接管、草稿式对话框、右键复制/引用、缩放/托盘/快捷键/导出 PDF/通知、主题跟随、ASR/TTS 过滤、MIMO 视觉通道）。
- 用户已确认下一步 = **右键菜单补两个消息级近似品**，并授权无人值守执行（用户睡觉，无人测试）。
- 上游仍无新 commit（升级主链路继续未实跑）。

## 任务内容

在 `desktop/main.js` 的 `installContextMenu`（右键菜单）中新增两个消息级操作：

1. **「重发此消息」**：走官方 `session.prompt` RPC 原样重发当前右键处的消息（旧回复保留——官方 append-only 语义）；
2. **「从此处分支」**：走官方 `session.fork` RPC，从右键处消息的历史切分点（atSeq）分叉出新会话（新会话干净重跑，旧会话保留）。

**明确不做**：编辑已发送消息 / 原地重新生成回复——官方会话日志 append-only、无对应 RPC（`updateQueue` 只认 pending 排队项），宿主级缺口超"不魔改上游"红线。调查结论见 History_log D43。

## 开工前必查证（防压缩失忆的技术细节）

1. **消息定位（最关键难点）**：现在右键菜单的 `context-menu` 事件只有 `params.selectionText`，**没有"右键处是哪条消息"的上下文**。需查证：
   - 官方消息 DOM 有无稳定标识（seq/data 属性）：看 `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`、`TurnTailNodeView.tsx`、`conversation-nodes/` 的渲染结构；
   - 候选方案 A：`main-preload.js` 注入 `mousemove` 监听，追踪最后悬停的消息元素并提取其 seq（右键时上报）；
   - 候选方案 B：右键时 `executeJavaScript` 从 `getSelection().anchorNode` 向上找消息容器；
   - 若 DOM 无 seq 标识：回退方案——仅提供"重发/分支**当前会话**"（sessionId 从 DOM 或 session.list 兜底取，不带消息级 atSeq），并在计划落盘时向用户说明降级。
2. **当前会话 id 获取**：官方页面有无暴露当前 sessionId（DOM data 属性 / 全局状态）？候选：`session.list` 兜底（updatedAt 最新且 !blank 的近似）。查证后再定。
3. **session.prompt 的 payload**：查 `packages/host/apiproxy/src/api/sessions.schema.ts` 确认字段（mode 语义、内容格式——参考 sessions.ts:347 附近注释）。
4. **session.fork 的 payload**：`{ sessionId, atSeq?, increaseTitle? }`（已查证）。fork 后新会话自动出现在主界面（官方事件流驱动）。

## 实施要点

- 全部走现有 `httpRpc`（main.js），不注入官方页面 DOM 结构以外的任何东西；右键菜单项在 `params.selectionText` 存在时显示（挂在复制/引用之后，separator 分隔）；重发/分支各带 `showShellDialog` 确认弹窗（自绘组件，danger 规则沿用）。
- **无人值守自测**（没有 GUI 测试员）：① RPC 层实测——node 脚本直接打 `session.prompt` / `session.fork` 验证 wire 行为与副作用；② 冒烟 `DSH_DESKTOP_SMOKE=15000 npm start` EXIT=0；③ 常驻窗口留给用户起床验收。
- 完成后：History_log 追加条目（变更 + 决策 D44）+ 快照更新。
- **竞态自查（D40 纪律）**：新增的事件回调/进程交互必须做闭包捕获、resolver 先行提取、防重入检查。
- **启动纪律**：启动/冒烟前 `tasklist | findstr electron` 零残留 + `netstat` 3080 无 LISTENING（残留 dsh 会造成假就绪）。

## 追加任务（2026-08-15 用户睡前补充，同等优先级）

### 任务 A：取消启动时静默检查更新
- **背景**：用户指出——没有 proxy 的电脑上，启动检查会超时/卡顿；当前 `updater.js` 的 PROXY 常量有硬编码兜底 `127.0.0.1:10809`，在无代理机器上行为不定。
- **实施**：`main.js` 移除 `silentUpdateCheck()` 调用（保留标题栏/托盘的手动「检查更新」入口）；`updater.js` 的代理来源改为读 `shell-config.json`（见任务 B），不再硬编码兜底。
- **自测**：冒烟确认启动流程无 ls-remote 动作（日志无 updater 输出、启动耗时不受网络影响）。

### 任务 B：代理设置功能
- **背景**：涉及搜索/下载国外网站（模型 API、联网搜索、更新检测）需要代理；不同机器代理不同，用户应可自行设置。
- **实施**：
  1. `shell-config.json` 新增 `"proxy"` 字段，**默认空字符串（直连）**——绿色版分发给他人时不能预填任何代理端口；本机开发调试时由用户/Agent 在「代理设置」里临时填入本机代理（如 `http://127.0.0.1:10809`）；
  2. `main.js` spawn dsh 子进程时：proxy 非空则注入子进程环境变量 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY=localhost,127.0.0.1`（官方模型 API 与联网搜索走代理）；
  3. `updater.js`：PROXY 常量改为读 `shell-config.json` 的 proxy（空 = 直连）；
  4. 新 UI：托盘菜单加「代理设置」→ 新 `proxy-dialog.html`（输入框：代理地址，留空=直连；保存按钮）→ 写 shell-config.json → 自绘弹窗提示「重启应用生效」（dsh 环境变量在启动时注入）；
  5. 主题跟随沿用现有 pushTheme 机制。
- **自测（无人值守）**：① 写入 proxy 后重启应用，验证 dsh 子进程环境注入（spawn env 构造逻辑 + 启动日志）；② 代理清空后 updater check 直连行为；③ 冒烟 EXIT=0。

### 任务 C：中文命令映射（官方优先，壳层兜底）
- **背景**：官方 Harness 斜杠命令是英文（/compact 等），用户要中文体验（输入 /压缩、提示显示中文、界面显示中文）。
- **第一步查证结论（已完成，用户实测 + 源码证据）**：
  - 官方**没有中文别名**——`/压缩` 不是注册命令名，命令本名是 `/compact`；发送 `/压缩` 不会被斜杠管道接管，而是作为纯文本发出去（压缩不触发）。命令注册源码：`packages/compaction/command-compact/src/index.ts`；本会话命令族 `['compact','echo','goal','permission','plan']`。
  - **官方斜杠菜单现状（用户亲眼实测，以此为准）**：描述**以英文为主**——仅 `model` 命令与用户自建的 SKILL 显示中文，其余命令（compact/echo/goal/permission/plan 等）描述全是英文。**菜单中文化是必做项**（V4P 曾说"菜单已中文"与实测不符，作废）。
  - **结论：官方路径不可用，壳层翻译（提交前替换 + 菜单显示中文化）为唯一方案。**
- **壳层翻译方案（确认启用）**：
  1. **命令清单与映射表**：开工时从官方源码收集**全部**命令注册名（不止上述 5 个——不同上下文可能暴露更多，如 plan mode 的 exit_plan_mode、skills 等）；**中文名由我们自定**（用户习惯用语：压缩、计划、目标、权限、回显……），不依赖官方 zh 描述（官方菜单大部分无中文）；映射表放 `desktop/command-aliases.json`。
  2. **提交前翻译**（核心）：`main-preload.js` 拦截输入提交路径——消息内容中的中文命令替换为英文命令后提交（后端收到英文、行为不变）。候选实现：Enter 键 capture 拦截 → native setter 改写输入框 → 放行；若官方提交链无法干净拦截，降级为"输入时即时替换"（输入 /压缩 后自动变 /compact，可用但显示英文）。
  3. **输入提示中文化（必做）**：输入 `/` 时官方命令菜单（DOM）的显示翻译——MutationObserver 把菜单项英文命令名/描述替换为中文（显示层，不动官方数据）；开工时查证菜单渲染结构（官方 client 命令菜单组件），如菜单渲染在 webContents 里可直接注入 CSS/JS 处理。
  4. **消息气泡显示**：官方消息记录提交内容（英文命令）——若有稳定 DOM 锚点做显示层翻译；否则放弃并如实报告。
- **自测**：输入 /压缩 提交 → 官方执行 compact 行为（会话历史折叠为 checkpoint，界面显示"已压缩 N 条历史记录"）；输入 / 菜单显示中文命令；冒烟 EXIT=0。

## 验收标准（用户睡醒后）

- 右键消息选区 → 「重发此消息」→ 确认 → 该消息原样重发、模型重答（旧回复保留）；
- 右键消息选区 → 「从此处分支」→ 确认 → 新会话出现且从该消息处开始；
- 启动过程不再有更新检查动作；托盘「代理设置」可配置并重启后生效；
- 冒烟 EXIT=0、退出零残留；
- 若消息级定位查证失败（DOM 无标识）→ 按降级方案实现（会话级重发/分支），并如实报告降级原因。

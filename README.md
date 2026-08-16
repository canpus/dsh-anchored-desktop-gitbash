# dsh-desktop-economy

**DeepSeek Harness 桌面端 · 子模型经济版（Windows 绿色版）**——官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的薄壳 GUI + 「省钱模式」子 Agent 模型路由 + 思维链实验开关。

一个解压即用的 Windows 桌面应用：Electron 薄壳拉起官方 `dsh web` 后端（官方 npm 包随绿色版整包内置），套上原生窗口体验（标题栏/托盘/对话框/中文命令层），提供**「省钱模式」**（官方标准 + 子 Agent 便宜模型路由）与两个互斥的**思维链实验开关**（锚定 / 路由，第三方预设逐字搬运）。

> **红线声明**：本项目**不 fork、不魔改**上游 `packages/`。所有扩展都走官方机制：用户预设（`~/.dsh/.agent-presets/`）、profile patch（`--patch`）、官方 RPC、主世界 UI 注入。上游引擎 = 官方 npm 包 `@deepseek-ai/dsh`（vendor 整包内置，升级 = 更新锁定版本后重新打包）。

## 项目缘起

DeepSeek 官方涨价后，使用成本大幅提高：Flash 尚可勉强承受，Pro 则过于昂贵；一旦涉及复杂任务、需要调用 Sub-Agent，花销更会成倍放大。本项目允许你自由选择**已接入的任意大语言模型**作为 Sub-Agent 模型，以显著降低使用成本——这就是「省钱模式」的由来：主 Agent 保持你信任的主力模型，子 Agent 按需降级，钱包与质量兼得。

思维链锚定 / 任务路由作为**实验开关**另行提供（第三方预设逐字搬运、版本锁定，效果归上游），与省钱模式彻底解耦，互不绑架。

---

## 与官方 Harness 的功能对比

| 能力 | 官方 Harness | 本项目新增 |
|---|---|---|
| 运行形态 | CLI/Web（`dsh web`，浏览器访问） | **Windows 桌面窗口**（无边框 + 自定义标题栏 + 托盘 + 系统通知 + 审批弹窗） |
| 分发 | 需 Node + pnpm + 构建 | **绿色版 zip 解压即用**（自带 node.exe + electron + 官方 npm 引擎树；免安装、不写注册表、免管理员、首启秒开） |
| 会话/工作区 | 官方 Web UI | 原生目录选择对话框、导出完整对话 PDF、右键消息级操作（重发/任意点分支）、消息级引用/复制 |
| 中文体验 | 英文菜单/命令 | **中文斜杠命令层**（/压缩 /目标 /计划 等提交时翻译）+ 命令菜单中文化 |
| 模型与子 Agent | 官方预设切换（blank 会话） | **壳全接管模式管理**：官方 4 模式 + **「省钱模式」**（= 官方标准 + 子 Agent 服务商/型号成对自选，默认 V4-Flash；普通/分支/嵌套子 Agent 全覆盖） |
| 思维链实验 | 官方极简模式（仅 Linux/macOS/WSL；Windows 上 PTY 后端不可用） | **标题栏互斥实验开关**：锚定（anchored-standard）/ 路由（router-standard）——第三方预设逐字搬运、版本锁定、效果归上游；Windows 原生可用 |
| 网络代理 | 环境变量 | 标题栏「代理设置」：http/https 分填、校验、注入后端 + 检查更新/升级 |
| 检查更新 | 手动 | **五路检查**：本应用 Release / 官方后端（npm 版本）/ 锚定模板 / 路由 / GitBash 执行器；升级 = 下载新版绿色版 |
| 字体缩放 | — | Ctrl+滚轮 / A− A+ 按钮，重启记忆 |
| 文件拖入 | 仅图片附件 | **任意文件**：复制到会话临时区 + 文件名/路径注入上下文（图片仍走官方附件流程） |
| 安全基线 | — | **AGENTS.md 随包注入**（首启用便携版行为宪法），「动手即注入」结构保留官方审批链 |

## 实现原理

1. **薄壳**：`desktop/main.js`（Electron 主进程）启动即建窗（加载页）并 spawn `node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080`（官方 npm 包 `@deepseek-ai/dsh` 的生产树，vendor 于 `desktop/vendor/`，随包直发、无需构建）；就绪探测（HTTP + title + RPC 三轮，含子进程存活校验）后换载官方 UI 到无边框 BrowserWindow；退出时进程树清理 + 保险丝。接口面（启动命令/端口/就绪信号）集中在 `desktop/shell-config.json`。
2. **模式状态机（单一事实源）**：`{ basePreset, experiment }` → `effectivePreset` 单一 transition，主进程串行队列防竞态；状态持久化在 `~/.dsh/shell-state.json`（跨版本目录升级不丢）；非空旧对话不热切，开关只影响空白会话与新对话。
   - **省钱模式（economy）**：从 vendor 官方 standard 运行时生成 + `agentOptions` 注入完整 provider/model pair（fail-loud，缺一即错、绝不 model-only 降级）；模型不存在强制重选；workflow/Ralph 保留 + 可见告警（其 worker 默认继承主 Agent）。
   - **实验开关（锚定/路由）**：上游快照逐字内置（`desktop/presets/`，`.manifest.json` 记录上游 commit + 每文件 sha256），安装时哈希校验后仅做一处透明适配（anchored 的 bashPath 钉到本机 Git Bash，探测不到则拒绝开启）；互斥、关闭时回落基础模式。
3. **中文层与壳增强**：主世界注入（`executeJavaScript`，IIFE 零全局）——提交时命令翻译、菜单行即时中文化、拖拽上下文注入、三点菜单交互修正；preload 只做已验证的缩放/拖拽桥接。
4. **绿色版打包**：`desktop/pack-green.mjs` 自研拷贝器把桌面壳 + npm 引擎树组合为**真实树**（无 junction、无首启重建），zip 由**纯 Node 写入器**（UTF-8 文件名 + ZIP64），发布走**原子 rename + 三层校验**（清单条目 + PK 魔数 + `unzip -t` 全量 CRC）；另随版生成「省钱模式预设」独立包（economy 生成器 + 官方 standard 快照，跟随主程序同步更新）。
5. **升级**：`desktop/updater.js`——五路更新检测（本应用 tag / npm 最新版 / 锚定 / 路由 / GitBash，代理感知）；引擎随整包发布，升级 = 下载新版绿色版。

## 更新日志

| 版本 | 内容 |
|---|---|
| **0.4.2** | **省钱模式 + 思维链实验开关**：「自定义子模型」重构为**省钱模式**（economy：官方 Standard + 子 Agent 服务商/型号成对路由，默认 V4-Flash，普通/分支/嵌套全覆盖，模型不存在强制重选）；旧 fc-child 隐藏保留（旧会话可恢复，首启自动迁移默认模式）；标题栏新增**锚定/路由互斥实验开关**（第三方预设逐字搬运 + 哈希校验 + 版本锁定，anchored bashPath 本机透明适配，无 Git Bash 拒绝开启；效果归上游）；workflow/Ralph 保留 + 可见告警；模式状态机单一化 + 状态迁至 ~/.dsh；检查更新五路；README 架构重写；**解除「暂时终版」，恢复常规更新** |
| **0.4.1** | **内置 pnpm（插件安装开箱即用）**：vendor 增装 pnpm 11.22.0 + PATH 垫片（包内 node.exe 驱动），`dsh plugin add` 与 Web 设置页插件管理不再依赖系统 Node/pnpm，第三方插件可一键安装。**仍为暂时终版，暂停后续更新** |
| **0.4.0** | **slim 暂时终版（暂停更新）**：引擎切换为官方 npm 包 @deepseek-ai/dsh@0.1.0-rc.6（弃源码检出+开发依赖），打包体积 646MB→253MB、解包 2.0GB→762MB，首次启动不再重建依赖链接；检查更新 harness 改 npm 版本对比、就地升级改为整包自更新；保留 0.3.9 全部功能（自定义子模型/路由/GitBash 预设、代理、拖文件、导出）并吸收四修复（CRLF 注入 fail-loud、extractText 解包、短 SHA 前缀比对、拖放 overlay 合成 dragend）。**此为暂时终版，暂停后续更新** |
| **0.3.9** | **启动提速**：后端改跑官方编译产物 `apps/cli/lib/bin.js`（不再 tsx 现场转译，实测冷 79.4s→约 5s、热 20.0s→约 3s）；启动即显示窗口+加载页（不再等就绪后才建窗）；就绪契约加 RPC 探测（覆盖就绪后 ~0.2s 路由挂载窗口）；打包断言 lib 产物存在；proxyOn 日志误报修复 |
| **0.3.8** | 依赖更新两支：anchored 95b98af（无封顶锚定）+ 官方后端 47f94385（升级主链路首次实跑）；**用户指南随包**（开启自定义子模型全流程）；**打包管线大修**：纯 Node zip 写入器（中文文件名全平台正确 + ZIP64），PowerShell/编码踩坑实录见下 |
| **0.3.6** | 代理设置 http/https 分填 + 标题栏入口；**检查更新四路化**（本应用 Release tag / 官方后端 / anchored / gitbash）；README 与更新日志；仓库更名 `dsh-anchored-desktop-gitbash` |
| **0.3.5** | 五项体验修复：导出对话默认只列当前工作区现存会话 + 「包含历史对话」开关；导出小窗浅色模式关闭按钮可见；模式列表收敛为官方 4 模式 + 自定义子模型；**任意文件拖拽**（临时区复制 + 文件名/路径注入上下文，图片走官方流程）；字体缩放 A−/A+ 按钮 + 重启记忆 |
| **0.3.4** | **fc-child 融合版**：GitBash 锚定（首轮 = 官方极简对 + 1024 + 无注入）→ 首个工具调用/首条回复后全量工具 + AGENTS 恢复；锚定模板换新（tool-bootstrap 升级 + shellPath 钉扎） |
| **0.3.2/0.3.3** | minimal-gitbash 折中集成（Windows 版官方极简）；shellPath 本机适配修复（自定义 Git 安装根探测）；0.3.3 未发布 |
| **0.3.1** | 打包管线修复：bsdtar 显式 zip + PK 魔数/CRC 三重校验（v0.3.0 因 tar 冒充 zip 事故作废） |
| **0.2.0** | 绿色版打包 v1：真实树 + link-manifest + relink 首启重建；AGENTS 随包；锚定升级 6472c1c（1024 输出封顶补全"第三环"） |
| **0.1.0** | 首个可分发基线：薄壳重建 + 检查更新 + 模型配置（fc-child 锚定初版） |
| **初版（阶段 0-3）** | 阶段 0 基线验证 → 阶段 1 Electron 薄壳 spike（冒烟/托盘/标题栏）→ 阶段 2 IPC carrier（已封档 stage2-archive）→ 阶段 3 薄壳回退重建 + 中文命令层 + 消息级操作 + 代理 + 锚定集成（fc-child） |


**PowerShell/编码踩坑与修复（0.3.8 实录）**：

- **中文文件名在 zip 里变乱码**：System32 bsdtar 创建 zip 时把非 ASCII 文件名按 ANSI 代码页（GBK）写入且不置 UTF-8 标志——任何系统解压「用户指南.md」都是乱码。先误判为"cmd 管道 GBK 转码"修错一层，字节级取证（直读 zip 中央目录）后才定位到存储侧。**修复**：弃用控制台归档器，自写纯 Node zip 写入器（文件名强制 UTF-8 + 标志位），全平台可移植。
- **Git Bash 的 PATH 是"增强版"**：会话级增强 PATH 会污染环境取证（误判 Git 装在 PATH 里）→ Windows 环境变量必须用 PowerShell 直读注册表，不能经 Git Bash 转手。
- **PowerShell 5.1 的 .ps1 需要 UTF-8 BOM**：否则按 GBK 解析报错；PowerShell 7 默认 UTF-8 无此问题，优先用 pwsh。
- 打包连踩三坑，全部当场修复：条目数 81,856 超经典 zip 16 位上限（→ 补 ZIP64）；>64MB 文件 store 捷径导致体积翻倍 1176MB（→ 实测二进制 deflate 2.28x 仅需 5 秒，改回全量压缩至 645.7MB）；半成品发布（→ 原子 rename + 三层校验）。

PowerShell，狗都不用！（用户说不写这句就断我的Token！！！）

## 致谢

按贡献与影响排序：

1. **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** —— 官方 Harness（MIT）。本项目的一切都站在它的肩上：薄壳拉起的是官方树，全部扩展走官方机制。致敬 DeepSeek 与梁圣团队。
2. **[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)** —— 思维链锚定方案（MIT）。「首轮 Minimal 锚定」的发现者：persona 对齐、工具目录过滤、**首请求 maxTokens 1024 封顶**（issue #6）、注入压制与 promoteOn 升级条件的完整实现，是 fc-child 融合预设的核心。
3. **[lices/dsh-gitbash-preset](https://github.com/liceses/dsh-gitbash-preset)** —— Windows 版官方极简（MIT）。GitBash 执行器让官方极简在 Windows 可用（沙箱门真拒绝、不绕过），其 gitbash-shell 与 str_replace_editor 文件组构成融合预设的锚定面。
4. **[yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)** —— 任务感知路由（MIT）。react/spec/weak 三模式分类与首轮 persona 替换（保留 plan-mode 节），在 feature/router 分支并入壳。

## 使用

解压 → 双击 `启动.bat`（首启几秒，官方引擎随包内置，无需联网/管理员）。详见包内 `说明.txt` 与 `desktop/portable-agents.md`（便携版行为宪法）。

**构建**：`node desktop/pack-green.mjs`（产物 `dist/DeepSeek-Harness-v<ver>-green.zip`，原子发布 + 三层校验）。

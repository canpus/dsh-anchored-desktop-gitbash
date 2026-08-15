# DeepSeek Harness 桌面端 GUI — 可行性分析、模块拆解与行动计划

> 状态：分析完成，待执行。上游版本基线：`deepseek-harness` @ 47f9438（2026-08-13 19:38 +0800，master）。
> 本地克隆：`C:\Users\Canpu\Desktop\DeepSeek_Harness\repo`（depth 1）。

## 0. 结论摘要

- **可行**。官方 Harness 不是"给 CLI 套 GUI"，而是插件化分层架构，UI 是官方预留的第三种客户端形态（Web 之外，官方笔记明确点名 Electron）。
- 选定路线：**Electron + IPC fetch carrier**（官方明确预留路线；Developer Preview 不承诺长期兼容），先复用官方 client runtime 与 React 组件跑通，再逐步替换渲染层。
- 总体周期估计：约 2-3 周到可用桌面版。

## 1. 证据索引（关键文件）

| 主题 | 位置 |
|---|---|
| 架构总览 / turn flow / 扩展表 | `repo/docs/architecture.md`（:53-127） |
| API Gateway / Typert 生成管线 | `repo/docs/api-gateway.md` |
| 服务与 seam 全景图（approval 等） | `repo/docs/capability-seams.md` |
| **官方预留 Electron + IPC 设计位** | `repo/.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`（:11-15、:35、:78-82、:214-221） |
| Web 前端 ↔ Host 协议（四象限 RPC） | `repo/packages/host/apiproxy/src/api/`（rpc.ts / rpc-map.ts / events.ts / sessions.ts / approvals.ts / questions.ts / host.ts） |
| 载体子类表（IPC bridge 为预留示例） | 同上笔记 :214-221；实现见 `repo/packages/host/apiproxy/src/fetch/client.ts` |
| 浏览器客户端（WebApiClient/ConnectionController） | `repo/packages/client/connection/src/client/` |
| 官方 client runtime（React-free 状态机） | `repo/packages/client/runtime/README.md` |
| 三个 bundle 分层 | `repo/packages/bundle/{base,web-app,headless}/README.md` |
| SDK（stdio JSON-RPC，功能薄） | `repo/packages/sdk/{protocol,client,server}/README.md` |
| CLI profile 机制 | `repo/apps/cli/README.md` |
| Web UI 用户指南 | `repo/docs/user/guide/index.md` |

## 2. 聊天记录论断核验

| GPT 论断 | 核验结果 |
|---|---|
| 官方仓库、Developer Preview、breaking changes | ✅ `README.md:9-11` |
| 非纯 CLI；`npx @deepseek-ai/dsh web` @ 127.0.0.1:3080 | ✅ `README.md:19-23` |
| everything is a plugin（Cordis） | ✅ |
| dsh-base 提供模型/工具/session/sandbox/审批/凭据；dsh-web-app 只加浏览器层 | ✅ |
| "Add UI or editor integration → drive `ctx.agents` and render from `session/event`" | ✅ 原文 `docs/architecture.md:121` |
| session 是 append-only event log，事件供 replay/UI 渲染 | ✅ |
| 审批属于 base 而非 WebUI 独有 | ✅ `ctx.approval` seam |
| turn flow 已文档化 | ✅ `docs/architecture.md:63-90` |

聊天记录判断全部成立；且实际情况比其预期更好：官方不仅"留缝"，还预留了完整的桌面客户端接入清单。

## 3. 关键发现（聊天记录未覆盖）

1. **官方预留 Electron 设计位**（`2026-07-19-gui-layering-and-rpc-protocol.md`）：
   - "more product clients are coming — Web (server), Electron, and others"
   - "Launching inside Electron with the same Web technologies as `dsh web`"
   - "A future Electron application reuses the same web client packages over an IPC fetch carrier"
   - 子类表中预留 "IPC bridge subclass (hypothetical example — no such shell exists)"
   - 接入新应用的官方三步清单：选 fetch 载体 → 在 apps/ 写 assembly 模块（startHost() + client 子类 + 自己的退出语义）→ 需要 HTTP 才挂 webserver（否则零端口）
2. **协议是载体无关的四象限 JSON-RPC**：上行 `POST /api/<method>`；下行两条流 `/api/events.mux` + `/api/events.host`（浏览器 WS / 非浏览器 SSE）；审批与提问经 `POST /api/respond` 应答。合同层零 Node 依赖，可直接 import。`InProcessApiClient` 证明协议不依赖网络栈。
3. **官方 client runtime 是 React-free 的对象服务**（SessionManager 一致性、重连 resync、pending 帧缓冲、projection 状态机），React 组件只是消费方 → UI 渲染层可整体替换（聊天里"拔掉 WebUI 插自己的 UI"的官方支撑）。
4. **审批/提问应答机与 `session.cancel` 均已实现**（07-19 笔记里的 "stub" 状态已过期；`api-proxy.ts:1131,3699-3712`）。
5. **SDK stdio JSON-RPC 是另一条官方缝但功能薄**：无审批、无 cancel、无会话管理、v0.0.1 无兼容承诺。适合 headless 驱动，不适合做主 UI。
6. **Windows 支持链完整**：win32 自动挂 pwsh-sandbox/tool-pwsh + Windows ACL 受限令牌沙箱（`packages/bundle/base/README.md:7`）。

## 4. 路线对比

| 路线 | 做法 | 工作量 | 官方契合度 | 风险 |
|---|---|---|---|---|
| A. 薄壳 | 壳拉起 `dsh web`，WebView 加载 localhost | 1-2 天 | 低 | UI 受官方限制 |
| **B. 官方预留路线（选定）** | Electron + IPC fetch carrier，复用官方 client runtime + UI 组件 | 1-2 周 | **高（官方明确预留，无兼容承诺）** | 跟随上游绑定发布 |
| C. 自研 UI | 复用官方 client runtime，替换整个渲染层 | 2-4 周 | 高 | 工作量最大 |
| D. SDK stdio | 只走 SDK JSON-RPC | 中 | 中 | 功能薄，近期不可做完整 UI |

选定 B 起步 → C 渐进（UI 替换可回退）。

## 5. 模块拆解（M0–M7）

### M0 上游基线与构建验证（Upstream Baseline）
- 固定上游版本（当前 47f9438），建立升级追踪（上游 commit + diff 摘要）。
- 本地跑通：`pnpm install` → `pnpm run build`（注意官方顺序 build:lib:host → build:lib:client → build:web）→ `pnpm dsh web`。
- 记录：前端 dist 产物位置、Typert 生成物位置（不提交）、启动耗时、退出行为。
- 输出：构建/启动/升级 SOP。

### M1 桌面壳（Desktop Shell，新 apps/desktop 工程）
- Electron：主进程窗口管理、单实例锁、托盘、菜单。
- 生命周期编排：启动 host → 探活就绪 → 加载 UI；退出时优雅 shutdown（无孤儿 node 进程）。
- electron-builder 打包（NSIS）。

### M2 Host 装配层（Host Assembly）
- 按官方清单写自己的 assembly 模块：`startHost()` + client 子类 + app 私有 exit 语义。
- 运行形态：Electron main 内 in-process 跑 Cordis context（`InProcessApiClient`，零端口）优先；崩溃隔离需求出现再拆 utilityProcess 子进程。
- 自定义 profile / `cordis.patch.yml`：挂 base + host 行，不挂官方前端 dist。

### M3 IPC Carrier（协议载体）
- 继承 `AbstractApiClient` 只实现 `doFetch`（官方子类表预留位置），主进程 ↔ renderer 经 contextBridge 序列化。
- 下行 mux/host 两条事件流经 IPC 通道推给 renderer。
- **这是主要兼容边界（不是唯一）**：上游改 `api/` 合同时 carrier 只碰 `doFetch`；但 client runtime、plugin assembly、UI 包导出或 Typert 合同的变动仍可能波及 M2/M4，由 M7 升级 SOP 按上游 diff 评估波及面。

### M4 Client 装配层（Client Assembly）
- 复用官方 client packages（connection/runtime/ui-*），在桌面 app 里复刻 `apps/web/main.ts` + `dsh-client-web` shell 的装配方式。
- 版本对齐：Electron 的 Node/React 版本与官方前端锁版本对齐。

### M5 UI 渲染层（先官方后自研）
- 5.1 官方 ui-* 组件原样挂载（快速闭环）。
- 5.2 主题/布局定制。
- 5.3 自研渲染器逐步替换（client runtime 是 React-free 的，任意 UI 框架可挂）。

### M6 桌面集成增强（Desktop Integration）
- 原生目录选择（Electron dialog 或 host 的 directory-picker native backend）。
- 系统通知（审批/提问/回合结束）。
- 拖放文件、最近工作区、深色模式；开机自启（可选）。

### M7 上游同步与质量防线（Upstream Follow-up & QA）
- 升级 SOP：拉新 commit → 检查 diff 触及 `api/` 合同范围 → rebuild → 冒烟。
- wire 信封快照测试 / contract test。
- 冒烟清单：起服务 / 开会话 / 流式输出 / 工具调用 / 审批弹窗 / cancel / 退出清理。
- **用户实测验收素材（2026-08-14，已通过阶段 1 实测）**：完整 P0/P1/P2 清单见用户记录《DeepSeek Harness 桌面端实测对话完整记录》第 1 节。最有信息量的五项：跨 Provider 换模型、Cancel 真取消、网络断线恢复、Workspace 越界/审批、History_log 新 Session 接班。已实测通过：第三方 API 接入/模型发现、工具链、硬 Stop、审批链、Queue/Steer 调度语义。已知黄灯：第三方 reasoning 泄露（上游）、Todo 取消不同步（模型侧）。

## 6. 行动计划（阶段 + 验收标准）

> **【阶段 3 修订 · 2026-08-14 深夜】** 用户追根溯源后决策：放弃零端口（IPC carrier）路线，回退**薄壳形态**；自研 GUI 封档。阶段表如下已被阶段 3 的实际形态取代，完整修订见下文「6A 阶段 3 修订」。

| 阶段 | 内容 | 验收标准 | 估计 |
|---|---|---|---|
| **阶段 0** 基线验证 | 构建 + `dsh web` 跑通（模型配置可选） | localhost:3080 官方 UI 可用；构建命令固化 | ✅ |
| **阶段 1** Electron 薄壳闭环 | Electron 拉起 dsh web 子进程 + 加载 localhost；探活/退出清理/单实例 | 双击 → 官方 UI 可用 → 关窗无孤儿进程 | ✅ |
| **阶段 2** IPC carrier 化（零端口） | assembly + IPC doFetch + client 图装配 | 官方 UI 跑在 Electron 里不依赖 3080 | ✅ **已封档**（`desktop/stage2-archive/`） |
| **阶段 3** 薄壳重建（修订后实际形态） | 无边框窗口 + 自定义标题栏/托盘 + 检查更新 + 模型配置（详见 6A） | 冒烟 EXIT=0 + 用户手测 | ✅ 待手测 |
| **阶段 4** 打包分发与升级实跑 | 绿色版 zip（解压即用）+ 升级脚本实跑 | 干净机器解压即用；升级一键执行 | 未开工 |

## 6A. 阶段 3 修订（2026-08-14 薄壳回退，实际实现记录）

**决策背景**：用户核算成本（熬夜 + 大量 token 反复修装配链）后追根溯源——"薄壳才是最小兼容层，零端口把官方 web server 的活全接过来了"。决策：薄壳为准、自研 GUI 封档、加检查更新与模型配置。

**实际形态（已实现）**：
- `desktop/main.js`：拉起 `node --import tsx/esm apps/cli/src/bin.ts web --patch <modelPatch> --host 127.0.0.1 --port 3080`（`windowsHide` 无 CMD 弹窗）→ 就绪探测（HTTP 200 + 标题 + 子进程存活校验）→ 无边框窗口（titleBarOverlay 保留系统按钮）+ 双层 WebContentsView（标题栏三按钮「子Agent模型/检查更新/重启」与官方页面物理隔离）+ 托盘；关窗 taskkill 进程树；单实例；冒烟 `DSH_DESKTOP_SMOKE`。
- `shell-config.json`：接口四要素（启动命令/端口/就绪判定/锁定 commit）。端口接口面已消灭（官方 CLI 支持 `--host/--port`，壳显式传参）。`--patch` 是 launcher flag，必须紧跟 `web` 模式。
- `desktop/updater.js`：check（ls-remote vs lockedCommit）/ upgrade（fetch→checkout→install→build:lib→build:web→probeSmoke→锁定更新），失败自动回滚 + `upgrade-report-*.md`；启动静默检测；进度窗口。CLI 可测（`node desktop/updater.js check|upgrade`）。`scripts/upgrade-upstream.mjs` 为薄包装。
- **模型配置**（8-17 官方涨价：V4 Pro 高峰输出 27 元/百万 token，涨约 350%）：官方机制调查结论——web 形态委派工具按 **Agent preset** 挂载（全局层被 web-app 禁用）；用户预设目录 `<dshHome>/.agent-presets/` 官方自动发现。实现：`~/.dsh/.agent-presets/fc-standard/`（standard 副本：`subagent`/`subagent_fork` 加 `agentOptions: deepseek-v4-flash` + 新增 `subagent_pro` 升级工具）；`desktop/agent-models.patch.yml`（--patch 设 agent-presets default 兜底）；`~/.dsh/settings.yaml` `agent-presets.default=fc-standard`（实测 settings 优先于 patch 的 default）。壳按钮 model-dialog 走官方 `agentPreset.select` RPC 会话级切换（仅 blank 会话，host 强制 `agent-preset-locked`）。原方案 B 自研插件取消。
- **升级后检查项**：上游改 `standard` preset 时，`fc-child` 随下次「应用模型」自动从新模板重新生成；官方 `--patch/--port` 参数变化由 updater 冒烟裁决兜底。
- **最终形态与后半程**（预设全接管、草稿式对话框、白嫖功能五件套、主题跟随、模型过滤、MIMO 视觉通道、竞态防御）：详见 History_log.md 阶段 3 条目 + 决策台账 D39–D42（权威记录）。

## 7. 风险与防线

1. **Developer Preview 无协议版本号**（client/host 绑定发布）→ 固定上游 commit；M3 carrier 是主要兼容边界，M2/M4 随上游 client runtime / assembly / UI 导出变动跟进；M7 升级 SOP 常备。
2. **Typert 生成物不提交** → 必须按官方顺序完整 lib build；升级时重跑。
3. **不 fork 核心** → 只使用 profile + cordis.patch + 自写 assembly 的官方扩展机制，不魔改 `packages/`。
4. 前端 dist 必须先 build；`dsh web` 拒绝 `--host 0.0.0.0`。
5. 阶段 0 实测模型调用需要 DeepSeek API Key（不配模型也可先验证壳与 UI 链路）。

## 8. 前置条件（需用户提供）

- DeepSeek API Key（阶段 0 实测；建议通过 settings/credentials 机制注入，桌面端不碰明文）。
- 构建环境：本机已有 git 2.52 / node 24.13 / npm 11.6；需确认 pnpm；代理已可用（socks 10808 / http 10809）。

## 9. 阶段 0 实测记录（2026-08-13，已验收 ✅）

**验收标准达成**：构建全绿 + `dsh web` 启动打印 `dsh web: http://127.0.0.1:3080`，HTTP 200，页面标题 `DeepSeek Harness`。

**验证过的命令**（本机 pnpm 未全局安装，全部经 corepack 非持久通道；`corepack` 随 node 24 自带）：

```sh
# 1) 依赖安装（代理仅对本命令生效）
cd repo
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 \
  corepack pnpm@11.7.0 install --frozen-lockfile        # 42.4s ✓

# 2) lib 构建（host → client，含 Typert 生成管线）
corepack pnpm@11.7.0 run build:lib                       # ✓

# 3) 前端构建（注意：根脚本 build:web 内部直接调 `pnpm`，corepack 下会失败，
#    需绕过包装脚本直接调用）
corepack pnpm@11.7.0 --filter @deepseek-ai/dsh-web-frontend run build   # 3.8s ✓

# 4) 启动（source 模式）
node --import tsx/esm apps/cli/src/bin.ts web
# 输出：dsh web: http://127.0.0.1:3080
```

**关键事实记录**：

- node 24.13.0 满足 engines（`^22.19.0 || >=24.0.0`）。
- 产物位置：前端 `apps/web/dist/`（含 PWA manifest）；各包 `lib/`（tsdown + Typert 生成物，不入库）。
- 首次启动自动初始化 `$USERPROFILE\.dsh`（profiles/web + storages）——桌面端打包时需处理 HOME 位置的逻辑。
- 陷阱：`build:web` 包装脚本依赖 PATH 里的 `pnpm`；后续阶段 1 Electron 子进程拉起 dsh 时，用 `node --import tsx/esm apps/cli/src/bin.ts` 或打包后的 bin，勿依赖 PATH。
- 未做：模型配置与真实对话（需 API Key，不影响 UI 链路验证）。

## 10. 工程纪律（2026-08-13 起生效）

- **每个阶段执行完毕后，必须更新项目级 `History_log.md`**（工作区根目录）：更新「当前状态快照」，新增该阶段的历史条目（阶段、时间、主要修改、影响），中途任何额外决策记入「额外决策台账」（决策内容、背景、对总目标/阶段目标的影响、是否产生新子任务）。
- 上下文压缩恢复时：先读 `History_log.md` 快照与阶段条目（恢复"到哪了"），再读本计划文档（恢复"怎么走"）。
- 阶段 1 定位为 throwaway spike：最终架构以阶段 2 零端口 IPC 为准，3080 / HTTP origin / webserver 假设不得渗入桌面层（GPT 补丁 3）。

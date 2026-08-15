# stage2-archive — 阶段 2「IPC carrier 化（零端口）」封档

**封档日期**：2026-08-14 晚
**封档原因**：用户决策回退「阶段 1 薄壳」形态（拉起官方 `dsh web` 子进程 + BrowserWindow 加载 3080），阶段 2 零端口路线挂起。封档不删除，未来若重新考虑零端口/自研 UI 可在此启封。

## 内容清单

| 路径 | 说明 |
|---|---|
| `main.js` | 阶段 2 Electron 主进程（内嵌 Host + IPC 桥 + drive 自测模式） |
| `preload.js` | IPC 流式桥（controller-enqueue 交付） |
| `host/` | 内嵌 Host 装配：`host-boot.mjs`、`desktop-host-patch.yml`、`cordis.yml`、`desktop-picker.mjs`（Electron 对话框替代 win32 worker）、`probe*.mjs`（主机侧探针） |
| `renderer/` | esbuild 打包官方 shell：`entry.js`、`build.mjs`（对齐官方 vite 装配链）、`manifest.json`、构建产物 |

## 阶段 2 已修接线（启封时的起点，不是从零开始）

- D22 CSS 装配链（shell 8 包 alias 到 src + local-css）
- D23 slot 冲突（排除 ui-directory-picker-browse）
- D24 file:// 断连重路由（fetch .href 提取 + WS 空 host 重路由）
- D25 IPC 流式 controller-enqueue
- D26 drive 断言字段修正
- D27 picker（Electron dialog.showOpenDialog 替代崩溃的 win32 worker）
- D28 Typert remote 分发三件套（api-remotes + HostConnectionService + rootConfig 迁移 profiles）
- D29 probe-rpc.mjs + pluginInventory.list 断言

## 遗留（启封时继续）

- 会话创建/消息发送链 bug（工作区"未分组"、session-uuid 命名、消息无回复——用户 2026-08-14 晚重新描述）
- session-log-export 与动态 cordis UI 未挂；IPC 大体积 body 未分块；Host 崩溃隔离未做

## 关联文档

- `docs/phase2-drive*.log`、`docs/phase2-live*.log`、`docs/phase2-probe.log`
- `History_log.md`：阶段 2 条目、决策台账 D9–D29

## 启封条件（未来再评估）

- 需要自研 UI 直连协议层时；
- 3080 本地端口/子进程形态出现真实痛点时；
- 官方 web server 形态被上游移除时。

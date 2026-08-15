# 缓存命中率不理想原因调查报告（2026-08-14 凌晨）

> 调查对象：GUI 底栏"缓存命中 {percent}%"指标 + Standard 预设请求前缀动态性。
> 方法：源码级证据链（file:line 对应 2026-08-13 master 克隆 `repo/`）。
> 背景：用户实测长会话累计命中 78%→65%→78%→81%→86%，低于其他 Harness 的 95-98%。

## 一、指标计算链（已证实）

- 组件：`packages/client/ui-conversation/src/client/chat/StatsLine.tsx`（:109-123、:197-204）；数据源 `useProjection('tokenUsage')`（:165）。
- 数据源：token-meter 投影 `packages/llm/token-meter/src/usage-projection.ts:107-140`，折叠 `assistant/chunk`（usage 块）与 `assistant/message.data.usage`（agent-loop 落盘：`core/agent-loop/src/agent.ts:349,381-390`）。
- **公式（token 加权会话累计）**：`命中率 = round(cacheRead / (uncached + cacheRead + cacheWrite) * 100)`（StatsLine.tsx:109-114）。
- **跨请求/跨模型/跨 provider 混算**：投影无任何 model/provider 分桶维度。
- **分母污染（关键缺陷，代码路径完整）**：
  - DeepSeek 适配器 `packages/llm/llm-deepseek/src/translate.ts:53-62`：仅当 `cacheRead !== undefined` 才输出 `cacheReadTokens`；缺字段时整段 prompt 全额进 uncached。
  - 投影入账 `usage-projection.ts:31-36`：`cacheReadTokens ?? 0`，**没有"未知/忽略"分支**。
  - 第三方适配器 `packages/llm/llm-pi-ai/src/stream.ts:22-29` 同样只报告 `cacheRead>0` 的情况。
  - ⇒ **MiMo 的每一轮都以 0% 命中计入会话累计**；模型切换后的首请求同样全 miss。

## 二、Standard 预设前缀动态点（机制证实，触发频率需实测）

- 装配链：每步 `ctx.systemPrompt.assemble()` + `canonicalHeader`（`core/agent-loop/src/agent.ts:225-243,407-495`）；header 变化落 `request/header` reason='change' 事件——现成诊断锚点。
- 工具 schema 键序稳定（同源深拷贝，`core/system-prompt/src/index.ts:487-503`）；工具数组顺序规范化（:164-183）——**排除**键序漂移嫌疑。
- 三大动态源：
  1. **压缩/剪枝 replace**：`compaction-tool-result-pruner` 原位替换历史中段（`src/index.ts:171`）；"从第一个被遮蔽消息起失效"（`core/session/README.md`）——Standard 挂载 compaction-basic + tool-result-pruner。
  2. **system prompt 动态 section**：plan mode 进出（order 50 起整段变化，`packages/plan/plan-mode/src/index.ts:225-233`）；AGENTS.md 被模型编辑触发 agent-instructions 重渲染（`packages/context/agent-instructions/src/render.ts:171-184`）。
  3. **尾部追加类**（runtime-context 快照、plan narration、todo）只影响尾部，代价小。
- 无每请求随机性：请求头/体字段构造顺序固定（`llm-deepseek/src/adapter.ts:283-295`、`serialize.ts:151-187`）；官方 e2e 断言"首请求后每个请求 cacheRead>0"（`request-cache.e2e.ts:71-104`）。

## 三、Minimal 预设对照

`apps/cli/config/agent-presets/minimal/agent.cordis.yml`：固定 persona（屏蔽全局 section）+ `includeRuntimeContext: false` + 仅 2 工具 + 无压缩无 plan ⇒ **前缀显著更稳**，是 A/B 对照的理想对象。

## 四、结论（按证据强度）

1. **【证实·频率待测】压缩与剪枝的中段 replace 重写**——每次压缩后紧随请求从被遮蔽点起全 miss，形成"下跌→回升"锯齿，与 78→65→78→81→86 形态吻合（65% 深谷=压缩后大请求）。
2. **【证实】跨模型混算 + 缺 cache 字段按全 miss**——MiMo 轮次与切换轮次把累计值系统性拖低；其他 Harness 通常按模型分桶或忽略缺字段 usage。
3. **【机制证实·触发待测】system 动态 section**——plan 进出/AGENTS.md 编辑即全前缀失效。
4. **【指标性质】累计从 0 爬升**——短会话/频繁重开永远达不到 95-98%，这是定义本身，不是 bug。

## 五、明日对照实验（已按优先级排序）

1. Standard vs Minimal A/B：同一 DeepSeek 模型、不切模型、同任务。Minimal 收敛到 95%+ 而 Standard 停在 ~80% ⇒ 锁定压缩/plan/instructions。
2. 事件相关性：会话日志 `request/header`（reason=change）与 `compaction/summary` 时间戳 vs 每条 usage 深谷对齐。
3. 相邻请求前缀 diff：第一个不同字节在 system 段/历史中段/tools 段/仅尾部，分别对应成因 3/1/目录变化/正常。
4. 分母污染对照：纯 DeepSeek 会话插入一轮 MiMo，看累计按该轮 prompt 等比例下跌；剔除后曲线恢复。
5. 原始 usage 抽查：确认 DeepSeek 响应是否偶发缺 `prompt_cache_hit_tokens`（若缺，成因 2 也适用纯 DeepSeek 场景）。

## 六、对本项目的影响

- 与桌面壳/阶段 2 无关（全部为上游统计与预设行为）。
- 若日后自研 UI 需要展示缓存指标：**必须按 model/provider 分桶，且缺字段时标记"未知"而非 0**——不重蹈官方口径的混算。
- 用户长会话建议：默认 Standard 下减少中途切第三方模型；需要极致缓存时切 Minimal 预设（桌面端已能开 Minimal 会话，Settings→Agent 预设）。

# Crossline 战略评估：内核可替换性、竞品、最后一米与商业化（2026-10-30 通宵）

写给本人。基于分支 `claude/strategy-1029`（自 `a49a5aec5a`）的代码和 2025–2026 年公开资料。凡是只有二手报道、没有厂商原文的，标「未核实」；代码结论附 `文件:行号`。本文只评估，不改代码。

---

## 0. 结论先行

**问题 6：把内核换成任何一个 personal agent，可行吗？**

- **换「模型 / agent SDK」可行，换「消费级 personal agent」不可行。** Crossline 的价值判断（schema、校验、修复循环、审批策略、账本）都在自己的代码里，`SkillRunOptions`（`packages/codex/src/skill-runner.ts:95`）已经是一份与引擎无关的契约。问题在它下面一层：约 40 个调用方把 Codex 的 JSON-RPC 客户端当第一个参数传进来，线程、Skill 加载、插件、额度、登录、助手沙箱都直接调 Codex app-server。抽出一层 `SkillEngine`，接 OpenAI Responses、Anthropic Messages、Gemini、Ollama，每个大约 1–1.5 周；带 shell 的助手另需 2–4 周。
- ChatGPT agent、Meta Muse、Gemini app、Siri 这类消费级 agent，没有给第三方当「执行器」用的接口：不能指定输出 schema，拿不到逐步审计，也不能按工作区隔离。方向应该反过来：Crossline 做成它们能调用的 MCP server 或 App。
- **真正换不掉的是经济结构，不是代码。** 现在每个用户在自己的 ChatGPT 额度上跑，开发者不付推理费。换成任何 API 内核，就要由开发者付钱或让用户自带 key。OpenAI 官方文档写明 app-server「experimental and aren't supported for production workloads」，这条路本身也不稳。结论是**必须抽象**，而且要尽早做。

**问题 7：大厂都做 agent，「套壳看板」还有意义吗？单独当 personal agent 好用吗？**

- **纯看板没有意义。** 「看板 + 日历 + 记忆 + 定时任务」这一层，ChatGPT（Scheduled tasks、Memory、Health、Atlas）、Gemini（Personal Intelligence、Android 跨应用代理）、Meta Muse（长期目标、WhatsApp 入口、免费档）、Claude（Cowork、跨会话记忆、Chrome）在 2026 年都已免费或包月提供，分发和系统权限 Crossline 都比不过。
- **单独当 personal agent，现在也不好用。** 证据是本人自己的数据：真实账号 16 天完成步骤 0 个、计时 0.6 分钟、待决 93 项（`docs/loop-and-scout.md`）；10-27 走查时一周计时 2 次、完成 1 件（`docs/review-2026-10-27.md`）。规划能力很强，执行闭环还没有在任何一个真人身上跑通。
- **有意义的只剩一个窄而深的位置：多主线的「承诺账本」与执行验收层。** 具体是：长期目标 → 里程碑 → 任务 → 步骤的反推，带余量的排程，按块确认，证据验收，以及对外动作一律本人的边界。大厂的 agent 擅长「替你做一件事」，不擅长「替你守住一年里几条线的承诺，并且诚实地说你没做」。这个位置也会受益于大厂：它们越强，Crossline 越可以只做账本和验收，把执行交给它们。前提是先证明这个闭环对真人有用。

**问题 8：最后 1 米和商业化。**

- **设备意义上的最后 1 米（系统权限、可穿戴、眼镜、车机），个人开发者赢不了。** 2026 年 Siri AI 靠 App Intents 读个人上下文，Gemini Intelligence 读屏幕跨应用操作，豆包手机助手拿到系统级注入权限后被微信、淘宝等风控拦下。这一层是平台的结构性优势。
- **能赢的是「承诺到行动」的最后 1 米**：块开始前推一句第一步，块结束确认做了没有，晚上收工，计时与证据。路线是做薄原生壳，接住平台的入口，而不是自己做硬件：iOS Live Activity、小组件、App Intents、Watch 复杂功能，Android Tile 和通知动作，以及 MCP / Apps SDK。
- **商业化最大的难点有两个：一是合规的模型成本来源，二是闭环未被证明导致的留存。** 获客是第三位。可行路径是：先用 10–20 人内测证明闭环，再在「研究生 / 多线并行的独立开发者」这一垂直人群里收费。模型走三条合规来源：国产模型托管（大陆按规定登记），用户自带 key 或 provider，申请 Sign in with ChatGPT 的计划额度合作。用 MCP 和 Apps 把 Crossline 挂进大厂 agent 当「个人执行层」。6–12 个月计划和验证指标见 §5.4。

---

## 1. 内核可替换性（读代码）

### 1.1 结论

可替换性比想象的好，但「好」只在结构化 Skill 这一层。分三档：

| 层 | 现状 | 换内核难度 |
|---|---|---|
| 价值层：账本、排程、校验、审批、修复策略 | 全在 Crossline 自己的包里（`packages/db`、`packages/planner`、`packages/core`），与模型无关 | 不用动 |
| 结构化 Skill（约 40 个 runner，41 个 Skill 目录） | 契约（`SkillRunOptions`）与引擎无关，实现绑死 Codex app-server | 中：抽一层 `SkillEngine`，每个新引擎约 1–1.5 周 |
| 助手（shell / tools / sandbox）、ChatGPT 连接器、生图、托管搜索、额度窗口、登录、算力节点 | 直接依赖 Codex 的原生功能和协议 | 高：要么在新引擎上重做，要么放弃这些功能 |

「任何一个 personal agent」要分开说：

- 换成 **agent SDK / 模型 API**（OpenAI Responses + Agents SDK、Claude Agent SDK / Messages、Gemini API / ADK、Ollama）可行。
- 换成 **消费级 agent**（ChatGPT agent、Muse、Gemini app、Siri）不可行，方向应反过来，见 §1.6。

### 1.2 现在怎么接入（读代码）

**1）结构化 Skill（主路径）**

- 调用方写一个 runner，交给 `runCodexSkill(client, input, options)`，入口在 `packages/codex/src/skill-runner.ts:1177`。
- `options` 是 `SkillRunOptions`（`:95`），包括：`skillName`、`developerInstructions`、`outputSchema`、`prepareInput`、`validateOutput`、`softAccept`、`keepEarly`、`tools`、`agent`、`allowWebSearch` 等。
- 它做的事：
  - 开线程：`startIsolatedThread`（`:829`），参数大量是 Codex 的 config 键，`:844–881`。
  - 首条消息以 `$crossline:<skill>` 点名，由运行时把 SKILL.md 注入（`firstPromptTexts`，`:1295`）。
  - 每轮 `turn/start` 都带 `outputSchema`（`:1014–1015`）。
  - 校验失败，就把拒绝原因作为同一线程的下一轮发回，最多两次（`runTurnsUntilValid`，`:901`）。
- 调用 `runCodexSkill` / `continueSkillTurn` 的非测试文件有 40 个，其中 38 个在 `apps/worker/src`。

**2）第三方模型**

- 不是直连，而是「Codex 线程 + 本机模型网关」（`packages/codex/src/model-gateway.ts:88`）。
- Chat Completions 型 provider 由 `chat-bridge.ts`（`responsesToChat`，`:86`）翻译成 Responses 流。
- `decideRoute`（`providers.ts:130`）按能力（`capabilityGap`，`packages/core/src/provider-conformance.ts:116`）和合规测量结果放行。
- 第三方能力固定为：无托管搜索、无生图、无 shell、无连接器、无记忆，只有函数工具（`THIRD_PARTY_CAPABILITIES`，`:113`）。

**3）动态工具**

- 一律用 `SkillTools {specs, call}`（`skill-runner.ts:228`），由 `item/tool/call` 回调（`:258`）。
- 这个形状本身是通用的 function calling。

**4）助手**

- shell 版：
  - `startAgentThread`（`:785`）设 `danger-full-access` + `approvalPolicy: untrusted`（`:807`）。
  - 每条命令的审批请求由 `AgentMode.answer` 回答（`agent-mode.ts:9`），守卫在 `packages/core/src/agent-guard.ts`。
- tools 版：
  - Crossline 自己实现的文件、邮件、网页工具箱（`apps/worker/src/agent-tools.ts:48`），走同一个线程机制。

**5）运行时管理**

- 每个工作区一个 app-server 进程，各有自己的 CODEX_HOME 与 `auth.json`（`runtime-registry.ts:88`）。
- 进程启动在 `packages/codex/src/index.ts:253`，supervisor 在 `:485`，暴露约 32 个 `/v1/*` 路由给 web。

**6）web 与模型的边界**

- web 侧只有 2 个文件直接 import `@crossline/codex`，其余都经 supervisor 的 HTTP 路由。**这条 HTTP 边界已经是一个干净的接缝。**

### 1.3 写死 Codex 的地方

| 耦合点 | 位置 | 换内核时要做什么 |
|---|---|---|
| 调用方第一个参数是 Codex RPC 客户端 | `CodexRpcBoundary`，`packages/codex/src/index.ts:301`；40 个 runner 文件 | 改成 `SkillEngine`，机械替换 |
| SKILL.md 由运行时注入，`$skill` 点名，Skill 开关写运行时配置 | `skill-runner.ts:1295`、`:463`（`holdSkill`）、`:589`（`skills/config/write`）、`:552`（`plugin/install`） | 非 Codex 引擎由 Crossline 自己读 SKILL.md 作为 system 提示。现在「SKILL.md 永不读进 baseInstructions」这条规则只对 Codex 成立 |
| 线程配置全是 Codex config 键（关记忆、关 goals、插件白名单、web_search 档位、模型 provider 定义） | `skill-runner.ts:791–813`、`:844–881` | 新引擎各自翻译，大部分可以直接删 |
| 线程生命周期 `thread/start|resume|unsubscribe|compact`、`turn/interrupt` | `:761–763`、`:1233`、`:1404`、`:1055` | 用「Crossline 自存历史 + 每轮全量或缓存前缀」替代；压缩由 Crossline 做 |
| 登录与账号：`account/read`、设备码、API key 透传 | `skill-runner.ts:736`（`requireLogin`），`runtime-registry.ts:22` | API 引擎不需要。ChatGPT 账号登录这一层（也就是「用户自己的额度」）会整体消失 |
| 额度读数来自 ChatGPT 的 rate-limit 窗口 | `packages/codex/src/cost.ts:25` | 换成「按 token 计价 × 月预算」。`model_usage` 与 `weightedTokens` 已有，可复用 |
| shell 助手的审批语义（`untrusted`、命令审批请求、Linux bubblewrap 沙箱 profile） | `skill-runner.ts:785–819`，`agent-mode.ts:26` | Claude Agent SDK 有权限回调，OpenAI Agents SDK 有沙箱容器；守卫要重新挂上 |
| ChatGPT 连接器、托管 web search、生图工具 | `skill-runner.ts:791–798` | API 引擎各有自己的托管搜索；生图改走图像 API（`portrait-illustrator` 已有 SiliconFlow 路径的设想） |
| 算力节点转发的是 Codex 原始 JSON-RPC | `apps/worker/src/node/protocol.ts:69`（`ALLOWED_METHODS`） | 节点协议要升一版，转发「引擎请求」而不是 app-server 方法 |
| 结构化输出规则按 OpenAI strict mode 写 | `packages/core/src/structured-output.ts:14` | 每个引擎一份规则集。Gemini 的 schema 子集与 strict mode 不同（未核实细节） |

### 1.4 逐一评估候选内核

工作量按一个人全职估算，包含引擎实现、跑一遍现有合规测量（`scripts/provider-conformance.ts`）和修正。前提是先完成 §1.5 的抽象（约 3–5 天）。

| 候选 | 替代什么 | 契合度 | 缺什么 / 风险 | 工作量 |
|---|---|---|---|---|
| **OpenAI Responses API + Agents SDK** | 结构化 Skill 直连；助手可用 2026-04 起的沙箱容器与 Agents SDK（未核实细节） | 最高：Codex 本来就是 Responses 协议，schema 规则一致，托管 web search / file search / computer use 都在 | 开发者付费，用户的 ChatGPT 额度用不上（除非走 Sign in with ChatGPT 的计划额度，见 §5） | 结构化 1 周；助手 2–3 周 |
| **Anthropic Messages + tool use / Claude Agent SDK** | 结构化 Skill（tool use 或 SDK 的结构化输出）；助手用 Agent SDK（权限回调对应守卫） | 高：Agent SDK 的「自带工具 + MCP + 权限回调」与 Crossline 助手的形状几乎一一对应；computer use、Chrome 已 GA（未核实细节） | 结构化输出的 schema 限制与 strict mode 不完全相同；价格偏高；大陆不可用 | 结构化 1–1.5 周；助手 2–3 周 |
| **Google Gemini API / ADK** | 结构化 Skill；ADK 有 TypeScript 版（`@google/adk`） | 中：函数调用成熟；ADK 的 Zod 工具声明与 `SkillTools` 好对接 | `responseSchema` 子集差异要做 schema 转换（未核实细节）；Project Mariner 已在 2026-05 并入 Gemini Agent / Chrome auto browse，没有独立 API | 1.5 周 |
| **Meta（Llama / Muse）** | Llama 可以经任意 OpenAI 兼容托管（现网关已支持）；Muse 是消费产品 | Llama：已可用；Muse：不可作为内核 | 没找到 Muse 面向开发者的执行接口（未核实）；Meta 2025 年底收购 Manus，正把代理能力并入自家产品 | Llama：0（现有网关）；Muse：不适用 |
| **本地模型（Ollama）** | 隐私档、离线档 | 已可用：2026-10-13 实测 qwen3:8b 合规 33/34、19 个 Skill 放行 | 质量、速度、上下文窗口；托管搜索没有，要靠 Crossline 自己的 `web_search` / `web_fetch` | 直连 3–5 天（可选；现在经网关已能跑） |
| **国产模型 API（DeepSeek、GLM、Qwen…）** | 托管版默认内核 | 已在用（sponsor 路径） | 同上，并且要按规定公示模型与备案号 | 已完成 |
| **MCP 生态** | 不是内核，是工具层：给任何引擎接日历、邮件、文件 | 高：MCP 已归 Linux Foundation 的 AAIF，ChatGPT、Gemini、Copilot 都支持（厂商自报） | 第三方 MCP server 的注入与权限风险（见 `docs/competitors.md` 中 OpenClaw 的恶意技能事故） | 作为客户端接入 1 周；作为服务端见 §1.6 |
| **消费级 agent（ChatGPT agent、Muse、Gemini app、Siri）** | — | 不适合做内核：没有 schema、没有逐步审计、ToS 不允许当执行器转售 | — | 不做；改为让它们调用 Crossline |

### 1.5 建议的抽象边界

```
Crossline 内核（不随模型变）
  账本（events / work_orders / milestones / evidence）
  排程（planner、frozen、capacity）
  校验（validators、structured-output 规则、引用核实、safeGet）
  策略（requiredApproval、agent-guard、spendAllows、model-gate 优先级）
  修复循环（runTurnsUntilValid 的语义：拒绝 → 同上下文追问 → 最多两次 → softAccept）
        │
        ▼  SkillEngine / AgentEngine 两个接口
可插拔执行器
  CodexEngine（现状）   ResponsesEngine   ClaudeEngine   GeminiEngine   ChatEngine（OpenAI 兼容 / Ollama / 国产）
```

```ts
interface SkillEngine {
  id: string;
  capabilities: ProviderCapabilities;            // 已有类型，packages/core
  /** 一轮：给定 system、消息、schema、工具，返回最终文本、工具调用记录、usage。修复循环不在这里。 */
  turn(req: EngineTurn, signal: AbortSignal): Promise<EngineTurnResult>;
  /** 引擎自己的会话句柄；没有服务端线程的引擎由 Crossline 存历史。 */
  open(skill: SkillSpec): Promise<ThreadRef>;
  cost(workspaceId: string): Promise<CostSignal>; // 窗口型（ChatGPT）或预算型（API）
}
interface AgentEngine {
  runTask(task: AgentTaskInput, toolbox: AgentToolbox, guard: GuardContext): AsyncIterable<AgentItem>;
}
```

要点：

1. **把修复循环从 Codex 代码里提出来。** `runTurnsUntilValid` 的逻辑（解析、`validateOutput`、拒绝回传、`keepEarly`、`softAccept`、停滞检测）是 Crossline 的资产，现在和 `turn/start` 的通知处理缠在一起（`skill-runner.ts:901–1112`）。提出来以后，每个引擎只需要实现「一轮」。
2. **SKILL.md 变成 Crossline 读、引擎消费的文本。** Codex 引擎继续用 `$skill` 注入，其他引擎拼进 system。提示缓存的「稳定前缀在前」规则（`cacheOrderedInput`）对所有引擎通用。
3. **合规测量按引擎记。** `SKILL_NEEDS`、`capabilityGap`、conformance 记录已经按 provider 设计，引擎只是 provider 的另一种 kind。
4. **调用方签名机械替换。** 40 个文件把 `client` 换成 `engine`，`decideRoute` 返回引擎而不是 provider 配置。
5. **先做 ResponsesEngine，不做 Claude 或 Gemini。** 协议最近，能最快验证抽象是否成立，也是 Sign in with ChatGPT 计划额度可能落地的地方。

这与 2026-10-13「第三方模型一律走 Codex 路径，不写直连适配器」的决定相反。理由：

- 那个决定的前提是 Codex 是稳定的宿主。
- 官方文档现在写明 app-server 及其 WebSocket 传输「experimental and aren't supported for production workloads」（[OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server)）。
- `beta-launch.md` §10.3 记录的托管 ToS 风险也一直没有解除。
- 现在每次 Codex 升级都要重测全部候选模型（`SPONSOR_RUNTIME_DOWN` 那一类事故）。

保留 CodexEngine，但不让它成为唯一宿主。

### 1.6 反过来：Crossline 作为 MCP server / A2A

**结论：做 MCP server，暂不做 A2A。**

- **理由。** ChatGPT（Apps SDK 基于 MCP）、Claude、Gemini、Copilot、Cursor 都能当 MCP 客户端。MCP 已交给 Linux Foundation 下的 Agentic AI Foundation 治理，OpenAI、Google、Microsoft 等支持（[Anthropic 公告](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)）。用户已经在 ChatGPT 或 Claude 里聊天时，问一句「今天我该做什么、ECE 548 还差什么」，由 Crossline 回答。这正是「个人执行层」的位置。
- **暴露什么。** 以读和「提议」为主：
  - `today`（今日块、下一步、第一步动作）
  - `tasks` / `milestones` / `forecast`（风险）
  - `capture(text)`（写 capture，与输入框同一路径）
  - `confirm_block(id, outcome, minutes)`
  - `submit_evidence(order, text|file)`
  - `propose(...)`：返回卡片链接，不直接执行
- **复用现有规则。** `requiredApproval` 与 `isCrossSiteWrite` 原样适用。对外动作永远不开放。
- **鉴权。** 复用设备令牌的 scope 机制（`issueDeviceToken(ctx, "capture")` 那一套），加一个 `mcp` scope；远程 MCP 用 OAuth。
- **A2A 为什么暂不做。** 本次检索没有找到 A2A 在消费端落地的证据，个人场景的调用方几乎都是 MCP 客户端。
- **风险。** 第一，提示注入：外部 agent 可能被网页诱导，调用 `capture` 写垃圾，所以写操作要限速并标来源。第二，一旦挂进 ChatGPT，用户的主界面就在别人家，Crossline 的界面价值下降。这是有意的取舍，见 §3。

### 1.7 风险与建议

- **风险。**
  - 抽象做到一半，两套路径并存，测试成本翻倍。
  - 直连引擎失去 ChatGPT 登录带来的「用户自付额度」，单位成本立刻显性化。
  - 国外 API 在大陆不可用。
- **建议（按顺序）。**
  1. 把修复循环提出来，CodexEngine 行为不变，全部现有测试应当通过。
  2. 实现 ResponsesEngine，跑 conformance。
  3. 做 MCP server 的只读部分。
  4. 视商业化路径再决定是否做 Claude 或 Gemini 引擎。

---

## 2. 竞品与大厂（2025–2026）

### 2.1 结论

2026 年大厂已经把「personal agent」的基本盘铺完：

- **记忆**：Claude 的跨会话记忆，Gemini Personal Intelligence，Copilot 长期记忆。
- **主动与定时**：ChatGPT Scheduled tasks 取代 Pulse；Muse 有每日简报和周期任务。
- **执行**：ChatGPT agent / Atlas，Gemini Intelligence 跨应用，Claude in Chrome，Muse 订旅行。
- **设备**：Meta Ray-Ban Display，Android XR 眼镜，Siri AI 的个人上下文，OpenAI 硬件（尚未发布）。

它们没做、或者不愿做的是：

1. 跨多条人生主线、以年为单位的承诺账本。
2. 把「做了没有」作为一等数据：逐块确认、计时、证据验收、诚实的风险预测。
3. 用户可以审计和导出的本地账本。
4. 中文的研究生 / 多线并行人群的垂直工作流，比如课程大纲、成绩线反推、TA 和论文。

纯日程 AI（Motion、Reclaim、Sunsama、Akiflow）有收费验证，价格在 $19–34/月，但同样被大厂挤压。

### 2.2 各家动向（每条附来源）

**OpenAI**

- **Pulse 下线，Scheduled tasks 接替。** Pulse 2025-09 面向 Pro 推出（[TechCrunch](https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs/)）。2026-06-18 宣布推出 Scheduled tasks 并在两周内下线 Pulse（[Gigazine](https://gigazine.net/gsc_news/en/20260619-chatgpt-scheduled-tasks/)，二手，OpenAI 原文未核实）。
- **ChatGPT Health 接入 Apple Health。** 2026-01 推出，可读活动、睡眠和部分医疗记录，独立空间，不用于训练（[9to5mac](https://9to5mac.com/?p=1034372)、[Digital Trends](https://www.digitaltrends.com/computing/chatgpt-can-now-connect-to-your-apple-health-data-to-give-more-personalized-health-answers/)）。
- **Atlas 浏览器。** 2025-10 推出，有可选的浏览记忆和 agent mode，敏感站点暂停确认（[The Journal](https://thejournal.com/articles/2025/10/27/openai-launches-ai-powered-web-browser.aspx)）。
- **Apps SDK 与 App Directory。** 2025-12 开放应用提交和目录，变现目前只允许引流到外部购买实物，数字商品和订阅暂不允许（[VentureBeat](https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches)、[PYMNTS](https://www.pymnts.com/?p=3325090)）。
- **Sign in with ChatGPT 加计划额度。** 2026-07-29 先上身份登录；之后加入「第三方工具用用户 Plus/Pro 的额度」，首批是 Notion、Vercel、Cognition、OpenClaw 等合作方。是否对任意开发者开放，未核实（[IT Brief](https://itbrief.com.au/story/openai-launches-chatgpt-sign-in-for-16-partner-tools)、[ProPakistani](https://propakistani.pk/2026/10/23/your-chatgpt-subscription-can-now-work-in-other-apps/)）。**这是 Crossline 托管版唯一可能合规使用用户 ChatGPT 额度的路径。**
- **Responses API / Agents SDK。** 2026-04 起有沙箱执行、分层记忆、MCP 集成（[二手汇总](https://expertbeacon.com/what-is-the-openai-agents-sdk-and-what-changed-in-the-april-15-2026-update/)，未核实）。
- **硬件。** 2026 年内公布，形态未知，无屏、口袋大小的报道居多；截至 10-29 没有检索到发布（[Wareable](https://www.wareable.com/wearable-tech/openai-confirms-its-debut-hardware-device-is-on-track-for-2026-reveal)、[Quartz](https://qz.com/openai-announce-physical-device-davos)）。

**Google**

- **Personal Intelligence。** 2026-01-14 美国 beta，可读 Gmail、Photos、搜索与 YouTube 历史，一键授权（[Forklog](https://forklog.com/en/google-empowers-gemini-to-analyse-personal-emails-and-photos/)、[DataCamp](https://www.datacamp.com/blog/gemini-personal-intelligence)）。
- **Gemini Intelligence（I/O 2026）。** 读屏、跨 Android 应用代办，交易前需确认，首发 Galaxy S26 / Pixel 10（[PhoneArena](https://www.phonearena.com/news/heres-everything-google-just-announced-at-the-android-show-io-edition-2026_id180281)）。
- **Chrome auto browse 上 Android。** 美国 AI Pro / Ultra 用户可用（[Google 博客](https://blog.google/products-and-platforms/products/chrome/bringing-chrome-ai-to-android/)）。
- **Project Mariner 关停。** 能力并入 Gemini Agent 与 Chrome auto browse（[Android Headlines](https://www.androidheadlines.com/2026/05/google-shuts-down-project-mariner-ai-agent.html)）。
- **Astra 并入 Gemini Live。**
- **Android XR 眼镜。** 2026 年秋先出纯音频款，可配 iPhone（[SamMobile 汇总](https://www.mysmartprice.com/personal-tech/wearables/wearables-news/google-and-samsung-showcase-android-xr-smart-glasses-powered-by-gemini-at-i-o-2026/)）。
- **ADK TypeScript。**（[Google Developers 博客](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/)）

**Meta**

- **Muse。** 2026-09-08 发布，iOS / Android / 网页 / WhatsApp 都能用，眼镜「即将」支持。能处理「一年期锻炼计划、创业」这类长期目标，运行在每用户一台专用虚拟机里，有免费档加订阅，无广告（[Axios](https://axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent)、[ABC News/AP](https://abcnews.com/Technology/wireStory/meta-launches-personal-ai-agent-muse-emphasizes-safety-136284133)）。Q3 财报称约六周内美加超 1000 万人设置了 Muse，这是自报数字（[Meta Q3 2026 Prepared Remarks](https://s21.q4cdn.com/399680738/files/content_files/META-Q3-2026-Prepared-Remarks.pdf)）。
- **收购 Manus。** 2025-12 宣布，报道估值超 20 亿美元，Manus 订阅继续（[TechRadar](https://www.techradar.com/pro/meta-buys-manus-for-usd2-billion-to-power-high-stakes-ai-agent-race)）。
- **收购 Limitless（原 Rewind）。** 2025-12 宣布，Mac 屏幕与录音捕捉停止，挂件停售（[9to5mac](https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/)）。
- **Ray-Ban Display。** $799，含 Neural Band（[eWeek](https://www.eweek.com/de/news/meta-ray-ban-display-ai-glasses-launch/)）。

**Anthropic**

- **记忆打通。** Claude chat 与 Cowork 的记忆 2026-08 合并，消费者默认开，敏感类别默认不存（[TheNextWeb](https://thenextweb.com/news/anthropic-claude-cowork-shared-memory-default)，二手）。
- **Cowork。** 2026-01 预览，04-09 GA（同上来源，未核实）。
- **Claude in Chrome。** 2026-08-26 对所有付费档 GA，默认自主执行，每步有分类器核对（[Gigazine](https://gigazine.net/gsc_news/en/20260827-claude-chrome-available/)，二手）。
- **MCP 捐给 AAIF。**（[Anthropic](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)）
- **Claude Agent SDK。** 有自定义工具、MCP、结构化输出（[官方文档](https://platform.claude.com/docs/en/agent-sdk/custom-tools)）。

**Apple**

- **Siri 换用 Gemini 底座。** 2026-01-12 与 Google 联合声明，下一代基础模型基于 Gemini（[MacRumors](https://www.macrumors.com/2026/01/12/google-gemini-next-generation-siri/)）。
- **Siri AI。** iOS 26.4 没有如期上线，WWDC 2026（06-08）以「Siri AI」随 iOS 27 发布：个人上下文、读屏、跨应用动作，第三方要通过 App Intents / Spotlight 接入，否则对 Siri「不可见」（[MacTech](https://www.mactech.com/2026/06/08/wwdc-2026-apple-introduces-siri-ai-a-major-overhaul-of-its-personal-digital-assistant/)、[TechCabal](https://techcabal.com/2026/06/08/wwdc-2026-announcements/)）。托管位置（私有云还是 Google 服务器）说法冲突，未核实。

**Microsoft**

- **Copilot 消费版。** 2025-10 加入长期记忆、Mico 形象、Actions 网页代办（[TechRadar](https://www.techradar.com/ai-platforms-assistants/copilot-is-getting-a-major-upgrade-and-microsoft-is-hoping-mico-makes-you-forget-you-ever-met-a-clippy)）。2026 年的更新本次没有检索到，未核实。

**中国**

- **豆包手机助手（努比亚 M153）。** 拿到系统级 `INJECT_EVENTS` 权限后，操作微信时被风控退出；之后不再支持微信，淘宝、拼多多等也被报道有限制（[澎湃](https://www.thepaper.cn/newsDetail_forward_32094236)、[界面](https://www.jiemian.com/article/13714546.html)）。
- **生成式 AI 服务监管。** 截至 2026-08 底，1112 款完成备案、731 款完成登记。调用已备案模型 API 的应用由地方网信办登记，并须公示模型名称和备案号（[IT之家](https://www.ithome.com/0/950/045.htm)、[光明网](https://m.gmw.cn/2026-07/10/content_1304528476.htm)）。

**垂直与初创**

- **Granola。** 2026-03 C 轮 1.25 亿美元、估值 15 亿，从会议纪要转向企业上下文平台（[TheNextWeb](https://thenextweb.com/news/granola-series-c-meeting-ai-enterprise-context)）。
- **Humane AI Pin 关停、Rabbit R1 留存极低。** 独立 AI 硬件的教训（[MacRumors](https://www.macrumors.com/2025/02/18/humane-ai-pin-discontinued/)、[Creative Bloq](https://creativebloq.com/design/product-design/its-time-to-admit-the-ai-gadget-era-was-a-flop)）。
- **日程类定价。** Motion $19–29/人·月且无免费档，Sunsama $20–25，Akiflow $19（年付）/ $34（月付），Reclaim 有免费档（[Gravity 对比，作者自家竞品，有利益关系](https://gravity.fast/blog/motion-alternatives/)、[costbench](https://costbench.com/compare/motion-vs-reclaim-ai)）。数字需以各家官网为准。
- **Lindy。** 本次没有检索到 2026 年定价，未核实。

### 2.3 能力矩阵

图例：● 强 ◐ 部分 ○ 无或弱。评分是本文作者依据上面的来源所作的判断，不是测评结果。

| 产品 | 个人上下文深度 | 跨主线长期目标 | 排程执行闭环 | 证据验收 | 设备覆盖 | 隐私 | 价格 |
|---|---|---|---|---|---|---|---|
| ChatGPT（Memory、Scheduled tasks、agent / Atlas、Health、Apps） | ●（记忆、连接器、Apple Health） | ◐（对话中能做计划，无持久目标结构） | ◐（定时任务、代办；不排日历块） | ○ | ●（网页、桌面、移动、浏览器；硬件未发布） | ◐（Health 独立空间；云端） | 免费档；Plus 约 $20（常识价，本次未复核） |
| Google Gemini（Personal Intelligence、Gemini Intelligence、Chrome auto browse） | ●（Gmail、Photos、搜索历史、读屏） | ○–◐ | ◐（跨应用代办，日历在 Workspace） | ○ | ●（Android 系统级，XR 眼镜，Siri 底座） | ◐ | 免费档；AI Pro 约 $20（未复核） |
| Meta Muse | ◐–●（社交图、WhatsApp；VM 隔离） | ◐（明确宣传「一年期计划」） | ◐（简报、周期任务、代办；对外动作经审批） | ○（有审计日志，无产出验收） | ●（应用、WhatsApp、眼镜即将） | ◐（专用 VM；Meta 数据信任问题） | 免费档 + 订阅 |
| Anthropic Claude（记忆、Cowork、Chrome、Claude Code） | ◐（记忆与连接器） | ○ | ◐（Cowork 定时 / routines） | ○（Cowork「绿色」只代表会话启动） | ◐（网页、桌面、移动、Chrome） | ●（敏感类默认不存） | 付费档才有 Chrome |
| Apple Siri AI（iOS 27） | ●（设备端个人上下文、App Intents） | ○ | ◐（跨应用动作） | ○ | ●（iPhone、Watch、Mac、车） | ●（设备端加私有云；托管位置有争议） | 随设备 |
| Microsoft Copilot 消费版 | ◐（长期记忆） | ○ | ◐（Actions） | ○ | ◐（Windows、Edge、移动） | ◐ | 免费档 |
| Motion | ○ | ◐（项目） | ●（自动排程，不排就提示风险） | ○ | ◐ | ◐ | $19–29 |
| Sunsama | ○ | ○ | ●（早晚仪式、手动时间盒） | ◐（每日回顾） | ◐ | ◐ | $20–25 |
| Reclaim | ○ | ○ | ●（习惯与任务自动排） | ○ | ◐ | ◐ | 有免费档 |
| Akiflow | ○ | ○ | ●（收件箱加时间盒） | ○ | ◐ | ◐ | $19–34 |
| Manus（Meta） | ◐ | ○ | ◐（长任务执行） | ◐（按用途预览产出） | ◐ | ◐ | 订阅 |
| Limitless / Rewind（已被收购，停售） | ●（全天录音与屏幕） | ○ | ○ | ○ | ◐（挂件） | ○–◐ | 停售 |
| Granola | ◐（会议） | ○ | ○ | ○ | ◐ | ◐ | 免费档 + $14 起 |
| **Crossline（现状）** | ●（访谈画像、文件夹、日历、邮件、录音、健康、屏幕活动，各自单独同意） | **●**（主线 → 里程碑 → 任务 → 步骤，成绩线反推，跨线产物关系） | ◐（排程强，但执行数据几乎为空：16 天完成 0 步） | **●**（门控、逐块确认、计时、证据；目前少有真实数据） | ◐（网页 PWA、推送、Siri 捷径、托盘、节点；无原生 App） | ●（本地优先账本、敏感文件拦截、对外一律本人；托管版在香港服务器） | 内测免费 |

**这张表说明两件事。**

1. Crossline 在「跨主线长期目标」和「证据验收」两列几乎独占，在「个人上下文」上并不弱。
2. 它在「排程执行闭环」上缺的不是功能，而是使用数据：功能全有，人没用起来。设备覆盖是结构性弱项。

### 2.4 风险与建议

- **风险。** Muse 已经在宣传「一年期目标 + 每日简报 + 审批」。如果 Muse 或 ChatGPT 加上「目标 → 里程碑 → 日历块」的结构化视图，Crossline 的差异会缩到「验收与诚实」这一列。
- **建议。**
  - 把差异写成产品主张：**「它记得你答应过自己的事，并且告诉你实际做了多少。」**
  - 把 `docs/competitors.md` 按本节更新：Pulse 已下线，Mariner 已关停，Limitless 已停售，Muse 与 Siri AI 已发布，Sign in with ChatGPT 计划额度。

---

## 3. 如果只当「套壳看板」，还好用、还有意义吗

### 3.1 结论

**作为「看板 + 别人的 agent」的套壳：没有意义。** 看板本身没有护城河，大厂的记忆加定时任务加日历连接器，已覆盖「帮我安排今天」的大部分需求，而且免费、有系统入口。

**作为独立 personal agent：现在不好用。** 原因不在模型，而在于输出到不了人。依据是本人的真实数据：

- 16 天完成 0 步、计时 0.6 分钟。
- 待决 93 项。
- 14 天约 1400 万 token，四成花在没开始的步骤上（`docs/loop-and-scout.md`）。

10-27 走查时仍然只有一周 2 次计时（`docs/review-2026-10-27.md`）。

**有意义的形态是「个人执行与验收层」。** 它不和大厂比谁更会聊天或代办，而是做三件大厂不做的事：

1. **持久的承诺结构。** 几条主线的长期目标、里程碑和截止，带余量反推，跨线产物关系，以年为单位存在用户自己能导出的账本里。
2. **执行的事实记录。** 每个块做了没有、花了多久、交了什么证据、验收是否通过，风险预测基于这些事实，而不是基于计划。
3. **边界。** 对外动作一律本人，其余默认生效、可撤销；本地优先；每类数据单独同意。

### 3.2 依据：哪些会被碾压，哪些反而受益

| 能力 | 被大厂碾压？ | 理由 |
|---|---|---|
| 聊天、问答、通用代办（订票、填表、发邮件） | 是 | Muse、ChatGPT agent、Gemini Intelligence、Claude in Chrome 都已上线，并且有系统权限 |
| 通用记忆 | 是 | 三家都已默认开启 |
| 每日简报、定时任务 | 是 | ChatGPT Scheduled tasks、Muse |
| 单纯的日程自动排 | 基本是 | Motion / Reclaim 已经在被挤压；Gemini 与 Workspace 日历天然一体 |
| 教程、材料、调研 | 部分 | 大厂 deep research 更强；Crossline 的优势只在「按本人课程材料、只给真正要学的步骤」 |
| 主线 → 里程碑 → 任务 → 步骤的反推与余量 | 否（短期） | 大厂没有动机做结构化、可验收的承诺模型；它们的目标是会话与代办 |
| 逐块确认、计时、证据验收、诚实风险 | 否 | 这和大厂「让用户觉得被照顾」的产品方向相反：大厂不愿意告诉用户「你没做」 |
| 多 agent 的结果汇总、按用途验收 | 受益 | 大厂 agent 越多，越需要一个中立的「谁替我做了什么、做成没有」的账本 |
| 研究生、多线并行的中文垂直工作流（大纲 → 成绩线 → 作业对） | 否 | 太窄，大厂不做 |

**受益路径。**

- 当用户在 ChatGPT、Claude、Gemini 里时，他们的 agent 通过 MCP 读 Crossline 的「今天、风险、下一步」，把代办结果作为证据写回。
- Crossline 不再需要自己做最强的执行者，而是做承诺账本和裁判。
- 这也直接解决 §1 的成本问题：执行花的是用户在大厂那边的额度。

### 3.3 单独作为 personal agent 的好坏

**好**

- 访谈画像的深度。
- 主线结构。
- 校验和引用核实（`safeGet`、逐字引用）。
- 安全边界写在代码里，而不是写在提示里。
- 多模型可插。
- 本地账本。

**坏**

- 规划过度，执行太薄。
- 决定太多：五种计数口径，待确认几十项。
- 没有原生 App：推送依赖 PWA，iPhone 只在加到主屏后才收得到。
- 模型宿主不稳：app-server 是实验接口，托管有 ToS 风险。
- 运维与复杂度对一个人来说偏高：CLAUDE.md 本身已经是一本手册。
- token 消耗与价值不成比例（见上面的 1400 万 token）。

### 3.4 风险与建议

- **风险。**
  - 继续加功能，而不先让闭环在 10 个人身上跑通，会落入「规划工具陷阱」：很满意地计划，从不执行。
  - 做成 MCP 层以后，主界面让给大厂，品牌存在感下降。
- **建议。**
  - 下一个版本只问一个问题：本人和内测者每周通过 Crossline 完成并确认了几个步骤。
  - 把「今日 + 一键确认 + 晚间收工」做到在手机上 10 秒内完成（见 §4）。
  - 其他新功能冻结到过线以后。
  - 「全部按推荐」和风险周报已经在减决定数（`docs/rituals.md`），继续往这个方向收。

---

## 4. 最后 1 米：贴身助理的路径

### 4.1 结论

「最后 1 米」应该拆成两段：

- **感知那一段**：设备到人。这是平台的主场。
- **承诺那一段**：「知道该做」到「真的做了」。这是 Crossline 能赢的地方。

个人开发者的正确策略是：**借平台的入口，守住自己的账本。**

- 每一个新设备，只做「此刻 / 第一步 / 做了没」三个动作。
- 数据流回自己的账本。
- 不做自己的硬件。
- 不做系统级注入：豆包被微信拦截是直接的反例。

### 4.2 现状盘点

| 通道 | 现状（代码已有） | 缺口 |
|---|---|---|
| 手机推送 | Web Push 到加入主屏的 PWA，桌面 Toast，夜间与忙碌静默，按 notify.level 控上限 | 不加主屏的 iPhone 收不到；没有锁屏的「当前块」；通知按钮只能打开页面，不能就地确认 |
| Siri / 快捷指令 | 「记一下」capture（设备令牌）、健康数据上传、录音分享 | 每个都要用户手工搭快捷指令；不在 iOS 27 Siri AI 的 App Intents 视野里 |
| 录音 | 手机录音上传，服务器夜间 SenseVoice 转写；说话人分离；本人声纹（单独同意）；摘要提取承诺、等待项、时间 | 不是常驻；没有「说一句话就记下」的实时入口 |
| 健康 | 睡眠、HRV、静息心率、步数、日照（快捷指令或 Health Auto Export）；能量模型；容量 | 依赖第三方导出 App；没有 Watch 端 |
| 桌面 | 托盘、小帮手悬浮、Document PiP「钉在桌面」、全局快捷键、屏幕活动（单独同意）、计时浮窗 | 只有 Windows 安装版；macOS 没有 |
| 节点 / 设备模式 | 本机做活动采集、文件夹、录音；可作算力节点 | 对普通用户不可见，是开发者向的能力 |
| 日历写入 | 写入名为 Crossline 的日历（Graph），iCal 订阅只读 | Google 日历不写；不是所有人都用 Outlook 或 Graph |
| 邮件 | IMAP 只读分拣，起草回复（不发送），记账 | Outlook 只支持 OAuth，Crossline 不支持 |
| 位置、环境 | 无 | 无「到了图书馆提醒开始」这类情境触发 |
| 眼镜、手表、车 | 无 | — |

### 4.3 分阶段路线图

| 阶段 | 做什么 | 技术前提 | 隐私 / 合规风险 | 个人开发者可行性 |
|---|---|---|---|---|
| **P0（0–2 月）承诺闭环上手机** | 把块开始推送、块结束确认和晚间收工做成通知上的按钮，就地确认（Web Push 的 action 已经部分做了「开始计时」）；首页 10 秒确认 | 现有 PWA 加 service worker | 低 | 高。纯 web 工作 |
| **P1（1–4 月）薄原生壳** | iOS：SwiftUI 或 Capacitor 壳，加 Live Activity（当前块倒计时与第一步）、锁屏 / 主屏小组件、**App Intents**（「下一步是什么」「这块做完了」「记一下」），让 iOS 27 的 Siri AI 能看到 Crossline。Apple Watch：复杂功能加一键确认。Android：Tile、通知动作、快捷设置磁贴 | Apple 开发者账号（$99/年）；App Store 审核；原生推送（APNs）替代 Web Push | 中：App Store 隐私标签；健康数据要遵守 HealthKit 规则（只读、不得用于广告）；直接读 HealthKit 后可以去掉第三方导出 App | 中高。一个原生壳加 Intents 大约 4–6 周；SwiftUI 需要学习成本 |
| **P2（3–6 月）语音** | 按住说话（Watch / 手机 / 托盘）：「我开始写论文了」「ECE 作业做完了，花了一小时」→ 结构化动作卡；每日 1 分钟语音收工；录音摘要已有的承诺抽取与它合并 | 端上或服务器 ASR（SenseVoice 已有）；concierge 动作注册表（已有） | 中高：录音的双方同意，美国部分州要求所有方同意，中国个人信息保护法把声纹列为敏感信息（Crossline 已单独同意）；语音只录本人按住时的内容 | 中。复用现有 ASR 与 concierge |
| **P3（4–9 月）挂进大厂 agent** | MCP server（§1.6）；ChatGPT App（Apps SDK）；Claude 连接器；Muse 或 Gemini 如有开放接口再接（未核实） | 远程 MCP 加 OAuth；Apps SDK 审核 | 中：外部 agent 可能被注入；写操作限速、标来源、只能提议 | 高。工作量小，分发意义大 |
| **P4（6–12 月）情境与可穿戴** | 位置或日程情境触发（iOS 区域监控，「到实验室了，下一块是…」）；Meta 眼镜、Android XR 眼镜：只做「此刻、下一步、做了没」的语音卡片，走平台的开发者接口（是否开放未核实）或经手机 App 转发；车机：CarPlay / Android Auto 只能用平台模板，适合「通勤时收工确认」 | 各平台 SDK；眼镜开发接口目前有限 | 高：位置是敏感个人信息；眼镜摄像头绝不碰（与现有相机边界一致） | 低到中。只做最小卡片；硬件平台开放度决定成败 |
| **不做** | 自研硬件、系统级注入（无障碍服务或 INJECT_EVENTS 去操作微信等）、常驻环境录音 | — | 封号（微信协议禁止自动化操控）、法律、信任 | 不可行。Humane、Rabbit、豆包是前车之鉴 |

### 4.4 风险与建议

- **风险。**
  - 原生 App 会把一个人的维护面从「一份 web 代码」变成三份。
  - Apple 审核可能对「AI 代办」类描述更严。
  - 平台随时会自己做同样的入口：Siri AI 自带的「提醒、专注」功能会覆盖一部分。
- **建议。**
  - **先做 P0 与 P1 的 App Intents 加 Live Activity。** 这是投入产出比最高的一米：Siri AI 明确说不接 App Intents 的应用「不可见」（[分析文章](https://dev.to/akaranjkar08/apple-wwdc-2026-rebuilt-siri-the-extensions-api-and-what-claude-on-14-billion-iphones-means-for-1c1l)，二手），而「下一步是什么、做完了」正是一个 Intent 的大小。
  - P3 的 MCP 和 P1 并行做。
  - 眼镜和车等平台开放以后再说。

---

## 5. 商业化

### 5.1 结论

**难点排序**

1. 合规而可持续的模型成本来源。
2. 闭环未被证明导致的留存问题。
3. 平台依赖：OpenAI ToS、Apple 与 Google 的系统权限、微信等超级应用。
4. 信任与隐私。
5. 获客。

**可行路径**

- **垂直付费 B2C。** 目标人群是中文研究生，以及多线并行的独立开发者或创作者。
- **三源模型。** 国产模型托管（大陆按规定登记）；用户自带 key 或 provider；申请 Sign in with ChatGPT 计划额度合作。
- **定价。** 创始会员预售，再到月付 ¥39–69 或 $12–15，低于 Motion 和 Sunsama。
- **生态分发。** 用 MCP、ChatGPT App 做分发和留存。
- **开源时机。** 开源核心等闭环被证明之后再定。

### 5.2 难点（批判性）

**1）模型成本与 ToS。**

- 现在的托管内测让访客的 Codex 登录跑在服务器上。官方文档把 app-server 定为实验、不支持生产负载；`beta-launch.md` §10.3 记录了「commercial or hosted services」不被允许的条款。本次没能在文档里直接检索到原句，标「未核实（以本人当时记录为准）」。
- 一旦被认定违规，受影响的是用户的 ChatGPT 账号。这是信任层面的风险，不只是停服。
- 成本测算：真实账号 14 天约 1400 万 token。按 `beta-launch.md` §10.4 的单价估算：
  - DeepSeek 级（约 $0.3/百万）：每个重度用户每月约 $9。
  - OpenAI 级（$1.5–3/百万）：每月约 $45–90。
- 这个用量本身就不合理：四成花在没开始的步骤上。**降用量比换便宜模型更重要。** token-economy 的「节省额度」、按需教程、48 小时窗口已经在做，需要用内测数据核实降到了多少。

**2）留存。**

- 规划类工具的典型失败是「第一周很爽，第三周不打开」，Crossline 的本人数据正是这种形状。
- 没有过线数据（每周完成 3 步以上、W4 留存），任何定价都没有依据。

**3）平台依赖。**

- iOS 推送要原生或加主屏。
- Siri 只认 App Intents。
- Gemini 跨应用代办属于系统特权。
- 微信禁止自动化操控（豆包事件）。
- 小红书禁止外链和二维码（`beta-launch.md` §10.3）。
- ChatGPT App Directory 不允许数字订阅变现。

**4）信任与隐私。**

- 产品要的数据极深：访谈画像、邮件、录音、健康、屏幕活动、文件夹。个人开发者没有品牌背书。
- 托管服务器在香港，大陆用户合规要备案或登记，海外用户要隐私政策和数据删除（已有 `/privacy` 和账号删除）。
- 对照：Muse 用「每用户专用 VM」做隐私承诺，Claude 默认不存敏感类别。

**5）获客。**

- 公开测评（`apps/assess`）是好的私域钩子。但微信「诱导分享外链」违规、小红书禁外链，转化链路天然断一截。
- 测评用户与「多线并行、有截止压力」的目标用户并不重合。

### 5.3 可行路径

- **定价。**
  - 对标：Motion $19–29，Sunsama $20–25，Akiflow $19–34，Reclaim 有免费档。
  - 建议：
    - 免费档：只读看板、手动排程，用户自带模型。
    - 标准档：¥39/月或 $12/月，托管国产模型，带月 token 上限。
    - 专业档：¥69/月或 $19/月，含助手和更高上限。
    - 创始会员：年付五折，前 200 人。
  - 毛利只在「国产模型 + 降用量」下成立，所以上线前先把每活跃用户月成本压到 ¥10 以内并实测。
- **B2C 还是 B2B2C。**
  - 先 B2C。
  - 第二步试 B2B2C：课题组、导师、孵化器批量开账号，由机构付费。账本对导师只读、只看本人允许的里程碑。
  - B2B2C 的风险是变成「被监督工具」，伤害用户信任。必须是用户主动共享。
- **开源核心 + 托管。**
  - 账本、排程、校验开源（AGPL 或 BSL），托管版收费。
  - 好处：信任，以及个人开发者能借社区。
  - 代价：Skill 提示词就是产品，`review-2026-10-27.md` 已指出本机安装版无法隐藏 SKILL.md。
  - 建议闭环证明之后再决定，只开源账本与排程，不开源 Skill 库。
- **垂直人群。**
  - **中文研究生（课程加科研加 TA 或求职）**：课程大纲、成绩线、作业对、期中这些现有功能最贴合。获客渠道是学校群和小红书学习博主。
  - **独立开发者 / 创作者（产品、内容、副业）**：与 Claude Code / Codex 使用记录、GitHub 证据结合。
  - 前者更窄，更好验证。
- **与大厂生态合作。**
  - 提交 ChatGPT App 和 Claude 连接器，做分发。
  - 申请 Sign in with ChatGPT 计划额度合作（本人已提交意向表）。
  - 国产模型厂商的初创扶持，如 token 额度。

### 5.4 6–12 个月计划与验证指标

| 时间 | 目标 | 关键动作 | 验证指标（过线才进下一步） |
|---|---|---|---|
| 第 1–2 月 | **证明闭环** | 冻结新功能；P0 通知就地确认，加 10 秒首页；本人连续自用 14 天；10–20 名筛选过的内测者（同时推进 2 条以上的线、有截止压力） | 第 2 周 50% 以上内测者每周确认完成 3 步以上（`beta-launch.md` 原过线标准）；每日决策用时 ≤5 分钟（系统体检已有 `seconds`）；排程块确认率 ≥40%；每活跃用户每周 token 下降 50% 以上（对比 10 月） |
| 第 2–4 月 | **降成本、去 ToS 风险** | 引擎抽象加 ResponsesEngine（§1.5）；托管默认国产模型；BYO key 或 provider；Codex 登录只保留给本机安装版 | 每活跃用户月模型成本 ≤¥10；conformance 全部关键 Skill 通过；托管版不再在服务器上跑任何人的 ChatGPT 登录 |
| 第 3–5 月 | **最后一米 P1，加分发** | iOS 薄壳：Live Activity、小组件、App Intents；MCP server 只读加 capture；ChatGPT App 提交 | W4 留存 ≥35%；30% 以上的确认来自通知或锁屏或 Intent（而不是打开网页）；MCP 周调用的活跃用户占比 |
| 第 4–6 月 | **收费验证** | 创始会员预售（年付）；大陆走地方网信办登记加主体（个体户或公司），海外用 Stripe 或 Paddle | 预售 ≥100 人；付费转化 ≥5%（占内测活跃）；首月退款率 <10% |
| 第 6–9 月 | **垂直放大** | 研究生版的模板与访谈；学习博主合作；B2B2C 试点 1–2 个课题组或孵化器 | 月活 500；付费 150；单用户毛利为正；一个机构续费意向 |
| 第 9–12 月 | **决定形态** | 依数据选：A. 做 MCP「个人执行层」，主界面让给大厂；B. 继续独立 App；C. 开源核心加托管 | 选择依据：MCP 调用占比、App 打开率、付费用户留存（M3 ≥60%） |

**停止条件。** 如果第 2 月末没过线（每周完成 3 步以上的不到 30%），就不进入收费阶段。先回到「为什么输出到不了人」：可能是排程过满（72 小时可用的问题）、决定太多，或者人群不对。

### 5.5 风险与建议

- **风险。**
  - Sign in with ChatGPT 计划额度可能只对大合作方开放（未核实）。
  - 国产模型的输出质量在规划类 Skill 上仍有差距：GLM、Qwen 的修复率和对人写出内部名字的问题，见 `docs/model-scheduling.md` 的 10-22 对比。
  - 个人开发者同时做运营、合规、原生 App，精力不够。
- **建议。**
  - 先做 §5.4 第 1–2 月，其余都等这一步的数据。
  - 把「每活跃用户每月成本」和「每周确认完成步数」放进系统体检，做成本人每天看的两个数。

---

## 6. 未核实与本次的局限

- 网络检索以二手报道为主。以下几项没有拿到厂商原文：Pulse 下线、Cowork 和 Claude in Chrome 的 GA 细节、Agents SDK 2026-04 更新、Sign in with ChatGPT 计划额度的开放范围、Muse 是否有开发者接口、Meta 与 Google 眼镜的开发接口、Siri AI 的托管位置。均已在正文标注。
- 「commercial or hosted services」条款原句本次没能在 app-server 文档前 10 万字里找到，以 `beta-launch.md` §10.3 的记录为准。文档里能确认的是「experimental… not supported for production workloads」。
- 能力矩阵的评分是判断，不是实测。
- 工作量估计假设一个人全职、复用现有 conformance 与测试，不含审核等待时间。
- 代码结论基于 `a49a5aec5a`，行号会随后续提交漂移。

---

## 来源

**OpenAI**

- OpenAI app-server 文档（实验性、不支持生产负载）：https://learn.chatgpt.com/docs/app-server
- TechCrunch，Pulse 发布：https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs/
- Gigazine，Scheduled tasks 与 Pulse 下线：https://gigazine.net/gsc_news/en/20260619-chatgpt-scheduled-tasks/
- 9to5mac，ChatGPT Health：https://9to5mac.com/?p=1034372
- Digital Trends，ChatGPT 接入 Apple Health：https://www.digitaltrends.com/computing/chatgpt-can-now-connect-to-your-apple-health-data-to-give-more-personalized-health-answers/
- The Journal，Atlas：https://thejournal.com/articles/2025/10/27/openai-launches-ai-powered-web-browser.aspx
- VentureBeat，ChatGPT 应用提交：https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches
- PYMNTS，App Directory：https://www.pymnts.com/?p=3325090
- IT Brief，Sign in with ChatGPT 合作方：https://itbrief.com.au/story/openai-launches-chatgpt-sign-in-for-16-partner-tools
- ProPakistani，订阅额度用于第三方：https://propakistani.pk/2026/10/23/your-chatgpt-subscription-can-now-work-in-other-apps/
- Daniel Vaughan，Sign in with ChatGPT 与 Codex：https://codex.danielvaughan.com/2026/08/02/sign-in-with-chatgpt-identity-platform-codex-cli-oauth-developer-authentication-strategy/
- Agents SDK 2026-04 更新（二手）：https://expertbeacon.com/what-is-the-openai-agents-sdk-and-what-changed-in-the-april-15-2026-update/
- Wareable，OpenAI 硬件：https://www.wareable.com/wearable-tech/openai-confirms-its-debut-hardware-device-is-on-track-for-2026-reveal
- Quartz，Davos 硬件表态：https://qz.com/openai-announce-physical-device-davos

**Google**

- Forklog，Personal Intelligence：https://forklog.com/en/google-empowers-gemini-to-analyse-personal-emails-and-photos/
- DataCamp，Personal Intelligence：https://www.datacamp.com/blog/gemini-personal-intelligence
- PhoneArena，Android Show I/O 2026：https://www.phonearena.com/news/heres-everything-google-just-announced-at-the-android-show-io-edition-2026_id180281
- Google 博客，Gemini in Chrome on Android：https://blog.google/products-and-platforms/products/chrome/bringing-chrome-ai-to-android/
- Android Headlines，Mariner 关停：https://www.androidheadlines.com/2026/05/google-shuts-down-project-mariner-ai-agent.html
- Android XR 眼镜：https://www.mysmartprice.com/personal-tech/wearables/wearables-news/google-and-samsung-showcase-android-xr-smart-glasses-powered-by-gemini-at-i-o-2026/
- Google Developers，ADK TypeScript：https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/

**Meta**

- Axios，Muse：https://axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent
- ABC News/AP，Muse：https://abcnews.com/Technology/wireStory/meta-launches-personal-ai-agent-muse-emphasizes-safety-136284133
- Meta Q3 2026 Prepared Remarks：https://s21.q4cdn.com/399680738/files/content_files/META-Q3-2026-Prepared-Remarks.pdf
- TechRadar，Meta 收购 Manus：https://www.techradar.com/pro/meta-buys-manus-for-usd2-billion-to-power-high-stakes-ai-agent-race
- 9to5mac，Limitless 被收购：https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/
- eWeek，Ray-Ban Display：https://www.eweek.com/de/news/meta-ray-ban-display-ai-glasses-launch/

**Anthropic**

- TheNextWeb，Claude 记忆：https://thenextweb.com/news/anthropic-claude-cowork-shared-memory-default
- Gigazine，Claude in Chrome GA：https://gigazine.net/gsc_news/en/20260827-claude-chrome-available/
- Anthropic，MCP 与 AAIF：https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation
- Claude Agent SDK 文档：https://platform.claude.com/docs/en/agent-sdk/custom-tools

**Apple**

- MacRumors，Gemini 与 Siri：https://www.macrumors.com/2026/01/12/google-gemini-next-generation-siri/
- MacTech，WWDC 2026 Siri AI：https://www.mactech.com/2026/06/08/wwdc-2026-apple-introduces-siri-ai-a-major-overhaul-of-its-personal-digital-assistant/
- TechCabal，WWDC 2026：https://techcabal.com/2026/06/08/wwdc-2026-announcements/
- App Intents 分析（二手）：https://dev.to/akaranjkar08/apple-wwdc-2026-rebuilt-siri-the-extensions-api-and-what-claude-on-14-billion-iphones-means-for-1c1l

**Microsoft**

- TechRadar，Copilot 与 Mico：https://www.techradar.com/ai-platforms-assistants/copilot-is-getting-a-major-upgrade-and-microsoft-is-hoping-mico-makes-you-forget-you-ever-met-a-clippy

**中国**

- 澎湃，豆包与微信：https://www.thepaper.cn/newsDetail_forward_32094236
- 界面，豆包手机助手：https://www.jiemian.com/article/13714546.html
- IT之家，备案与登记数量：https://www.ithome.com/0/950/045.htm
- 光明网，备案与登记：https://m.gmw.cn/2026-07/10/content_1304528476.htm

**初创、硬件与日程类**

- TheNextWeb，Granola C 轮：https://thenextweb.com/news/granola-series-c-meeting-ai-enterprise-context
- MacRumors，Humane AI Pin 停产：https://www.macrumors.com/2025/02/18/humane-ai-pin-discontinued/
- Creative Bloq，AI 硬件复盘：https://creativebloq.com/design/product-design/its-time-to-admit-the-ai-gadget-era-was-a-flop
- Gravity，Motion 替代品（作者有利益关系）：https://gravity.fast/blog/motion-alternatives/
- costbench，Motion 与 Reclaim：https://costbench.com/compare/motion-vs-reclaim-ai

**本仓库**

- `docs/loop-and-scout.md`
- `docs/review-2026-10-27.md`
- `docs/beta-launch.md` §10
- `docs/model-providers.md`
- `docs/model-scheduling.md`
- `docs/competitors.md`
- `packages/codex/src/skill-runner.ts`
- `packages/codex/src/providers.ts`
- `packages/codex/src/model-gateway.ts`
- `packages/codex/src/chat-bridge.ts`
- `packages/codex/src/cost.ts`
- `packages/codex/src/agent-mode.ts`
- `packages/codex/src/runtime-registry.ts`
- `packages/core/src/provider-conformance.ts`
- `apps/worker/src/node/protocol.ts`
- `apps/worker/src/agent-tools.ts`

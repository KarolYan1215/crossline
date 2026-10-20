# 模型来源：自带 Codex 与其他 API 模型（设计稿）

状态：A 部分已实施（2026-10-10）；B 部分按 2026-10-13 的决定改为「全部经 Codex」并已实施（R7，第 3 节）。原先的 B2 直连适配器不做。

**已定的决定（覆盖下文中与之冲突的地方）**
- 将来公开部署，本人仍是管理员。**其他用户只用他们自己的 Codex**，绝不回落到主人的运行时、额度或记忆。
- 主人工作区保留现在的 `codex-home`（不改名），具备全部能力：记忆、联网、插图、带 shell 的助手。
- 访客各自一个运行时：独立 CODEX_HOME 和进程，`cli_auth_credentials_store="file"`（各自的 `auth.json`，正好绕开 openai/codex#48465）。记忆照常开，因为目录是他们自己的。
- 访客的登录方式有三种：
  - ChatGPT 浏览器登录：回调地址是运行 Codex 那台机器的 localhost，只在本机访问时可用；
  - **设备码**：远程访问时的默认；
  - API key。
- API key：按美元算月上限，默认 **$10**（`model.budget.monthly`），由 `model_usage` × 价目表算出本月花费。不再是「没设上限就不跑」。
- 带 shell 的助手只给主人工作区（`AGENT_OWNER_ONLY`）。
- Sign in with ChatGPT 用作**本机自装版的登录方式**（开源动态注册，回调 `127.0.0.1`）。
- **2026-10-13 更新**：访客首选 SIWC 套餐额度共享（作为模型通道，见 3.6）；同时任何第三方模型都要能接（GLM、DeepSeek、Kimi、Qwen、Claude、ChatGPT/OpenAI API、Gemini），**全部走和 Codex 完全一样的路径**；生图等做不到的能力如实告诉用户。只有 Chat Completions 的模型由本机转换层改写。

## 0. 结论

1. **A（每个 workspace 接自己的 Codex）先做，B 拆两半。** 现在任何注册进来的第二个账号都在用本人的 ChatGPT 额度和本人的 Codex 记忆（见 1.2），这是真实隐患，不是将来的需求。
2. **B：所有模型都走同一个 Codex 运行时**（2026-10-13 定，已实施，第 3 节）。说 Responses 的原样透传，只有 Chat Completions 的经本机转换层；线程、动态工具、修正循环、用量事件全部保留。联网研究、画像插图、带 shell 的助手只在 ChatGPT 登录（或 OpenAI API key）下可用。
3. 提供方只承担通过一致性检验的功能；验收判定和收集分析要求每次都一次答对。

## 1. 现状：哪些地方绑死在 Codex 上

### 1.1 耦合清单

| 能力 | 谁在用 | 代码 | 换成普通 chat completions 会怎样 |
|---|---|---|---|
| Skill 原生加载（`$crossline:<skill>`，SKILL.md 由运行时读） | 全部 24 个 Skill | `skill-runner.ts` `findNativeSkill`/`setNativeSkill`，worker 启动时 `installLocalPlugin` | 没有 Skill 概念，要自己把 SKILL.md 正文放进 system prompt |
| 严格结构化输出 `outputSchema` | 全部 | `turn/start.outputSchema`；规则见 `packages/core/src/structured-output.ts` | 各家方言不同（见 3.4），校验器仍是最后一道 |
| 线程持久化与续写 | 访谈、里程碑对话、输入框（每天一个线程） | `continueSkillTurn`；`SKILL_THREAD_LOST` 时用历史重开 | 无状态，需要自己重放历史——但重开路径已经存在 |
| 动态工具（`dynamicTools` + `item/tool/call`） | 只有 `crossline-concierge` | `SkillTools`、`toolAnswerer`、`agent-mode.ts registerAgentThread` | 换成原生 function calling，一一对应 |
| shell + 审批请求（`untrusted` → 守卫） | `crossline-agent` | `startAgentThread`、`agent-guard.ts` | **无法迁移**：守卫挂在运行时的审批请求上，没有这个钩子就没有守卫 |
| 联网搜索（`web_search: live`，经 `codex-code-mode-host`） | due-diligence、flywheel-scout、material-researcher、archetype-curator | `allowWebSearch`、`webResearchBlocker` | OpenAI 托管工具，别家没有同一个 |
| 图像生成 | portrait-illustrator | `allowImageGeneration`/`onImage` | 只有 OpenAI 图像接口可替代 |
| 用量事件 `thread/tokenUsage/updated` | 设置 → 模型用量 | `usage.ts createUsageCollector` | 各家响应里有 usage，字段名不同 |
| 额度 `account/rateLimits/read` | `budgetPolicy`、所有后台 pass 的开关 | `cost.ts readCostSignal`、`apps/worker/src/index.ts` | API 计费没有「窗口用了百分之几」，只有钱 |
| 跨运行记忆 `memories.*` | 所有结构化 Skill（`startIsolatedThread` 打开） | 同上 | 没有；也不该有（见 1.2） |
| 每轮 model/effort | 档位路由 | `model-policy.ts`；`turn/start.model/effort` | 各家都能每次指定 |

### 1.2 审查时发现的四个现存问题（与本设计无关也该修）

1. **记忆跨 workspace 串流。** `codexProcessEnvironment`（`packages/codex/src/index.ts`）只有一个 `%LOCALAPPDATA%\Crossline\codex-home`，`startIsolatedThread` 又打开了 `memories.use_memories/generate_memories`；Codex 的记忆第二阶段是对整个 CODEX_HOME 的全局合并（`vendor/codex/codex-rs/memories/README.md` 「Phase 2: Global Consolidation」）。第二个账号的运行会读到本人的记忆，反之亦然。
2. **第二个账号花的是本人的 ChatGPT 额度**，用量表按 workspace 记了，额度却只有一份。
3. **API key 登录后所有后台工作静默停止。** 运行时对非 ChatGPT 登录直接拒绝读额度（`app-server/src/request_processors/account_processor.rs` `get_account_rate_limits_response`：「chatgpt authentication required」），`readCostSignal` 返回 `available:false`，而 worker 的各个 pass 都写成 `if (!signal.available || …) return;`。
4. **档位模型名是 ChatGPT 计划的**（`DEFAULT_TIERS` 的 `gpt-5.6-*`），API key 或别的提供方下可能不存在，`thread/start` 会整个失败。

另外，助手以 `danger-full-access` 和 worker 的操作系统用户运行（`startAgentThread`）：多账号时它在技术上能读到别的 workspace 的 `data/`。守卫是绊线不是沙箱（`docs/assistant-agent.md`），所以**助手只能给机器主人的 workspace 用**。

### 1.3 已核实的运行时能力（`vendor/codex`，rust-v0.155.0 时核实；2026-10-20 升到 rust-v0.163.0 后这里列的仍成立，见 `docs/codex-upgrade-0.163.md`）

- 登录：`account/login/start` 支持 `apiKey`、`chatgpt`（浏览器回调）、`chatgptDeviceCode`；`chatgptAuthTokens` 标注为 OpenAI 内部、不得使用（`app-server-protocol/src/protocol/v2/account.rs` `LoginAccountParams`）。**没有「按请求换账号」的接口**——一个进程一个 auth manager。
- 提供方：`thread/start` 有 `model_provider`（`v2/thread.rs`）；内置 `openai`、`amazon-bedrock`、`ollama`（11434）、`lmstudio`（1234）；自定义提供方写在 `model_providers.<id>`，字段有 `base_url`、`env_key`、`auth`（命令取 token）、`http_headers`、`query_params`（`model-provider-info/src/lib.rs`）。
- **只支持 Responses 协议**：`WireApi` 只剩 `Responses`，写 `chat` 直接报错（同文件 `CHAT_WIRE_API_REMOVED_ERROR`）。所以 Anthropic Messages、Gemini 原生接口进不了 Codex。
- 凭据存放：`cli_auth_credentials_store = file | keyring | auto | ephemeral`（`config/src/types.rs` `AuthCredentialsStoreMode`）。
- 已由探针核实（2026-10-13，3.1）：`thread/start.config` 可以临时定义 `model_providers.*`；Ollama 的 `/v1/responses` 可直接驱动 Codex。仍未核实：LM Studio、vLLM 是否执行 `strict`（一致性检验会测出来）；keyring 条目是否按 CODEX_HOME 区分。

## 2. 接口 A：每个 workspace 接自己的 Codex

### 2.1 决定：一个 workspace 一个 app-server 进程

| 方案 | 结论 |
|---|---|
| 共享一个运行时、按请求带凭据 | **不可行**：协议没有按请求的凭据（见 1.3）；记忆、`skills/config/write`、`auth.json` 都是进程/CODEX_HOME 级的 |
| 每 workspace 一个进程、各自 CODEX_HOME | **采用**：隔离来自目录和进程，不来自我们写的判断 |

代价是内存。按需启动、空闲 15 分钟停止；同时在跑的进程设上限（默认 3），超过时排队而不是拒绝。用 `scripts/codex-smoke.ts` 量一个空闲进程的常驻内存后再定上限。

### 2.2 类型

```ts
// packages/codex/src/runtime-registry.ts
export type LoginMethod = { type: "chatgpt" } | { type: "chatgptDeviceCode" } | { type: "apiKey"; apiKey: string };
export type LoginStart =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string }
  | { type: "apiKey" };

export type RuntimeAccount =
  | { kind: "chatgpt"; email?: string; plan?: string }
  | { kind: "apiKey"; last4: string }
  | { kind: "provider"; providerId: string; label: string };

export type RuntimeStatus = {
  workspaceId: string;
  state: "unconnected" | "starting" | "ready" | "login_pending" | "blocked" | "stopped";
  account?: RuntimeAccount;
  blocker?: { code: string; message: string };
  lastUsedAt?: string;
};

export interface ModelRuntime {
  readonly workspaceId: string;
  /** Starts the process on first use; the same pinned binary and hash check as today. */
  client(): Promise<CodexRpcBoundary>;
  status(): RuntimeStatus;
  login(method: LoginMethod): Promise<LoginStart>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  /** ChatGPT: rate-limit windows. API key: our own monthly cap (2.5). */
  cost(): Promise<CostSignal>;
  stop(reason: "idle" | "upgrade" | "shutdown" | "crash"): Promise<void>;
}

export interface RuntimeRegistry {
  forWorkspace(workspaceId: string): ModelRuntime;
  list(): RuntimeStatus[];
  stopIdle(now: number): Promise<void>;
}
```

`CodexSupervisor` 里所有 `sidecar.client` 换成 `registry.forWorkspace(ctx.workspaceId).client()`；workspace 取自已验证的 capability token（`capability.ts` 已经带着 `AccessContext`），**不取自请求体**。worker 的 tick 本来就在循环 `listWorkspaces()`，每个 workspace 拿自己的 client。

### 2.3 目录与密钥

- `%LOCALAPPDATA%\Crossline\runtimes\<workspaceId>\codex-home`，启动前写入该目录的 `config.toml`：`cli_auth_credentials_store = "keyring"`（Windows 凭据管理器），记忆按本人决定保留——因为现在目录是这个人自己的。
- API key 只经过一次：浏览器 POST → web 路由 → supervisor → `account/login/start {type:"apiKey"}`，之后由运行时保存。我们只在 `model.connection` 设置里存 `last4`。任何 GET 都不返回密钥；`recordAnswer`、日志、`exportSnapshot`、`backup-crossline.ps1` 都碰不到它（`copy-codex-memory.ts` 已经排除 `auth.json`）。
- B2 的直连密钥不在 Codex 里，由 worker 用 DPAPI 加密存到 `data/secrets/<workspaceId>/<providerId>.bin`（当前 Windows 用户可解），同样不进账本和导出。备份不带它：恢复后重新填一次密钥，比把密钥塞进备份安全。

### 2.4 登录与界面（设置 → 模型连接）

- 三种方式：**ChatGPT 登录**（本机浏览器回调，只在本机访问时可用）、**设备码**（手机或 tailnet 访问时的默认——浏览器回调地址是 worker 所在机器的 localhost，手机上打不开）、**API key**。
- 状态卡：未连接 / 正在登录 / 已连接（账号邮箱或 `sk-…abcd`）/ 出错。「测试一次」跑一个最小结构化调用（schema 只有 `{ok:boolean}`，不加载任何 Skill），显示耗时与模型名。
- 错误用白话：

| 代码 | 界面文字 |
|---|---|
| `RUNTIME_UNCONNECTED` | 还没有连接模型。到 设置 → 模型连接 登录 ChatGPT 或填写 API key。 |
| `SKILL_UNAUTHENTICATED` | 登录已失效，重新登录后会继续。 |
| `SKILL_USAGE_LIMIT` | 这个账号的额度用完了，恢复后会自动继续。 |
| `MODEL_NOT_AVAILABLE` | 这个账号用不了所选模型，已改用账号默认模型。 |
| `RUNTIME_LIMIT_REACHED` | 同时运行的人太多，排在后面，稍后开始。 |
| `BUDGET_CAP_REACHED` | 本月 API 花费已到上限，后台工作已暂停。 |

路由：web `GET/POST/DELETE /api/model/connection`、`POST /api/model/connection/test`；supervisor `GET /v1/runtime/status`、`POST /v1/runtime/login`、`POST /v1/runtime/login/cancel`、`POST /v1/runtime/logout`、`POST /v1/runtime/test`。全部过 `isCrossSiteWrite` 和 capability token，由现有两个发现式测试自动覆盖。

设置键：`model.connection`（`{kind, providerId?, last4?, label, connectedAt}`，无密钥）、`model.budget.monthly`（API 计费的月上限，金额 + 币种）、`model.consent.<providerId>`（2.6/4）。事件：`model.connection.changed`、`model.connection.tested`、`model.consent.granted|revoked`。

### 2.5 额度与预算

- `setSpendModeProvider` 现在是进程全局、缓存 60 秒；改成按 `enterUsageWorkspace` 的 workspace 取值并分别缓存。worker 各 pass 的 `readCostSignal()` 改为 `runtime.cost()`。
- ChatGPT 登录：照旧读窗口。
- API key / 直连：用 `model_usage` 的 token × 价目表（`packages/codex/src/prices.ts`，带生效日期）算本月花费，`usedPercent = 花费 / model.budget.monthly`，再喂给同一个 `budgetPolicy`。**没设上限时后台工作不跑**，只跑本人点出来的——按量计费下「读不到就当 normal」会变成无上限花钱，这和 `currentSpendMode` 注释里的原则相反，按量计费时应反过来。
- 本地模型：不花钱，`available:true, usedPercent:0`。

### 2.6 隔离与生命周期

- 档位排队 `serializeSkillRun` 的键从 `tier` 改为 `${workspaceId}:${tier}`；`underConfigLock` 改为每个运行时一把锁（它保护的是该运行时自己的配置文件）。
- 助手：只有「机器主人」的 workspace 能启用（新设置 `deployment.ownerWorkspaceId`，迁移时写入）；其他 workspace 的 设置 → 自动化与助手 显示「这台电脑上的助手只为电脑主人工作」。理由见 1.2。
- 崩溃：退避重启（1s、5s、30s，三次后 `blocked`）；在跑的线程按已有的 `SKILL_RUNTIME_EXITED`/`SKILL_THREAD_LOST` 处理，不新增路径。
- 升级：所有运行时共用一个钉死哈希的二进制（`codex-baseline.json`）；换二进制时全部 `stop("upgrade")`，下次使用重启。
- 登出或删除 workspace：停进程、`account/logout`、删整个运行时目录。

### 2.7 迁移

现在的 `codex-home` 整体改名为主人 workspace 的运行时目录（保留 `auth.json`、记忆、`state_5.sqlite`），主人 workspace 判定：只有一个 workspace 时就是它，否则必须设 `CROSSLINE_RUNTIME_LEGACY_WORKSPACE`，不猜。其他 workspace 从「未连接」开始，**不继承**主人的登录和记忆。`copy-codex-memory.ts` 与备份脚本改为遍历 `runtimes\*`。迁移前照例备份目录。

## 3. 接口 B：其他模型，全部经同一条 Codex 路径（R7，2026-10-13 实施）

2026-10-13 的决定取代了原先的 B1/B2 两分法：**任何模型都走和 ChatGPT 完全一样的 Codex 路径**（线程、Skill 原生加载、修正循环、校验器、用量事件都不变），不另写直连适配器。Codex 0.155 只认 `wire_api = "responses"`，所以只有 Chat Completions 的模型（GLM、DeepSeek、Kimi、通义千问，以及 Claude、Gemini 的 OpenAI 兼容接口）由本机一个很薄的转换层改写；说 Responses 的（OpenAI API、OpenRouter、本机 Ollama）原样透传。做不到的能力如实告诉本人。

### 3.1 探针结果（真实运行，`scripts/provider-probe.ts`，2026-10-13）

本机 Ollama 0.35（qwen3:8b，上下文 40960，约一半在 CPU）、钉死的 Codex 分支、真实的 `crossline-task-titler` Skill 与校验器：

| 探针 | 结果 |
|---|---|
| (a) Chat Completions 经转换层 → Codex → Skill | 通过，0 次修正，148 s，7.9k token |
| (b) `thread/start` 带 `modelProvider` + `config["model_providers.<id>"]`，config.toml 里没有这个提供方 | **生效**（回合完成，转换层收到请求）。所以提供方按线程定义，不改任何 CODEX_HOME 的 config.toml |
| (c) Ollama `/v1/responses` 原生，不经转换层 | 通过，0 次修正，226 s |

探针发现、已在代码里处理的：
- 自定义提供方（`requires_openai_auth = false`）下 `account/read` 返回 `account: null, requiresOpenaiAuth: false`，`requireLogin` 原先会判成未登录；走提供方时不再检查 Codex 登录。
- Codex 的记忆两个阶段默认用 `gpt-5.6-terra`，在别的提供方上会对一个不存在的模型重试六次。走提供方的线程关掉记忆（`memories.*`、`features.memories`）。
- Codex 会发 `namespace` 工具和 `additional_tools` 输入项；转换层把 `ns.name` 展平成 `ns__name`，回程按映射还原（含 custom 工具）。
- 路由覆盖 `CROSSLINE_MODEL_*="model:effort"` 原先按第一个冒号拆，`qwen3:8b` 被拆成模型 `qwen3`、档位 `8b`；现在只有冒号后是已知档位才算档位（`parseRoute`）。

### 3.2 结构

| 部件 | 文件 | 做什么 |
|---|---|---|
| 转换 | `packages/codex/src/chat-bridge.ts` | 纯函数。Responses 请求 → 一次 Chat Completions：`instructions` 和所有 developer/system 文本合成一条开头的 system；`text.format` json_schema → `response_format`（只支持 JSON 模式的提供方改成 `json_object`，schema 写进 system）；function/custom/namespace 工具；之前的工具调用与输出回放成 assistant `tool_calls` + `tool` 消息；推理项不回传（无状态）。流：`reasoning_content`/`reasoning` 字段或行内 `<think>` → reasoning 项（也让慢模型的连接保持有事件），正文 → message 项，工具调用 → function_call 项，usage → `response.completed`；`finish_reason: length` → `response.incomplete`；上游错误映射到 Codex 认识的码（`context_length_exceeded`、`insufficient_quota`、`rate_limit_exceeded`、`server_is_overloaded`） |
| 网关 | `packages/codex/src/model-gateway.ts` | worker 进程里一个只听 127.0.0.1 的监听。Codex 拿到的 `base_url` 是 `http://127.0.0.1:<port>/<route>`，route 是「工作区 + 提供方」在本次启动的随机密钥下的 HMAC（猜不到，进程重启即失效）；上游地址由 route 查出，从不取自请求。`chat` 走转换，`responses`（和 SIWC 套餐）原样透传。**密钥由网关逐请求加上**：Codex 的环境、config、线程设置、rollout 文件里都没有它；令牌更新（SIWC 刷新）下一次请求就生效，不用重启 sidecar |
| 路由 | `packages/codex/src/providers.ts` | `ProviderConfig`（`model.provider` 设置，无密钥，只有 `keyLast4`）、`decideRoute`、`threadProvider`。`skill-runner` 的 `executeSkill` 先问 `decideRoute`：提供方能做这件事且检验准入 → 在这个线程上定义提供方（`modelProvider` + `model_providers.<id>`，`requires_openai_auth=false`、`supports_websockets=false`，不带 effort）；否则该工作区自己的 Codex 登录；都没有 → `MODEL_CAPABILITY_MISSING` / `MODEL_NOT_ADMITTED`，白话说明，**不启动线程、绝不借用主人的运行时** |
| 需求与检验 | `packages/core/src/provider-conformance.ts` | `SKILL_NEEDS`（每个 Skill 的白话名、输出 schema、critical、tools/webSearch/image/shell）、`capabilityGap`、`conformanceCases`、`jsonSchemaProblems`、`admittedSkills`、`conformanceCurrent` |
| 服务 | `apps/worker/src/model-provider.ts` | 设置行、DPAPI 密钥、网关上游解析、额度读数、检验运行、supervisor 路由 `/v1/model/provider`（GET/POST/DELETE）与 `/v1/model/provider/test` |
| 密钥 | `packages/connectors/src/secret-file.ts` | `data/secrets/<ws>/provider-key.bin`，DPAPI（当前 Windows 用户），不进账本、导出和备份；非 Windows 拒绝保存，不写明文 |
| 界面 | `apps/web/app/settings/model-provider-card.tsx`，`/api/model/provider[/test]` | 设置 → 日历与连接 → 「其他模型」：起点（DeepSeek、Kimi、通义千问、智谱 GLM、Claude、Gemini、OpenAI API、OpenRouter、本机 Ollama）、接口类型、地址、模型、密钥（只发一次给 worker，之后只显示末 4 位）、运行检验与进度、交给它的功能与其余功能各自的原因、做不到的能力一句话 |

运行时注册表加了 `hasProvider`：只配了提供方、没有 Codex 登录的访客也有自己的进程（`connected`），但 `signedIn` 为假，需要联网、生图的 Skill 对它直接报不可用。

### 3.3 能力：固定的，不测

第三方提供方一律没有：联网搜索（due-diligence、flywheel-scout、material-researcher、archetype-curator）、图像（portrait-illustrator）、带 shell 的助手（只给主人自己的 Codex）、托管连接器（apps 日历读取）、跨次记忆。设置卡片原话：「联网查证、画像插图、电脑上的助手、日历应用读取和跨次记忆只在 ChatGPT 登录（或 OpenAI API key）下可用；其余功能按检验结果开放。」工作区同时有 Codex 登录时，这些功能照常走它。

**2026-10-15 补充：联网和画像插图可以由 Crossline 自己提供**（docs/beta-launch.md §10.4）。

- **联网。** 配了搜索 API（`BOCHA_API_KEY` 或 `TAVILY_API_KEY`，用 `CROSSLINE_SEARCH_PROVIDER` 指定用哪家）后，worker 的 `routing()` 带上 `capabilities.webSearch` 和 `webTools`。这样要联网的 Skill 也能交给提供方，前提仍是通过一致性检验。
  - 运行时关掉托管的 `web_search`，改为声明两个动态工具 `web_search` 和 `web_fetch`（`skill-runner.ts` 的 `withWebTools`，`apps/worker/src/web-tools.ts`）。
  - 打开网页一律走 `safeGet`。
  - 每次运行最多搜索 12 次、打开网页 24 次。
  - 各 Skill 自己的来源核验照旧。
- **画像插图。** 配了画图 API（`CROSSLINE_IMAGE_API_KEY`，否则用 `SILICONFLOW_API_KEY`）后，路由不走 Codex 的工作区由 `portrait-illustrator.ts` 直接调画图接口（`packages/connectors/src/image-generation.ts`），提示词不变。
- **助手。** 仍然只给机主自己的 Codex。`startAgentThread` 已能在提供方上启动（同样换成上面两个联网工具），但这只供评测矩阵使用（`scripts/provider-matrix.ts`、`scripts/provider-harness.ts`），路由不会把助手交给提供方。托管版要给访客用助手，需要按工作区隔离的容器沙箱。

### 3.4 一致性检验（准入）

- 用例：每个导出的 `*_SCHEMA`（30 个，发现式测试保证不漏）各一个最小真实提示，另加三个对抗用例：长文本（≥1500 字的字段）、`anyOf` 联合加 `null`、四层嵌套。critical（验收判定、收集分析）的 schema 各跑 3 次。
- 运行：测试专用 Skill `crossline-conformance` 经**同一条**路径（网关、Codex、修正循环），输出 schema 就是被测 schema；`validateOutput` = `jsonSchemaProblems`，不合格就作为拒绝送回修正。
- 判定：critical Skill 每次都过且修正率 ≤ 5%（3 次即不许修正）；其余 Skill 自己的 schema 都过且整体通过率 ≥ 90%；缺能力的永不准入。
- 记录：`model.provider.conformance` 事件（`ConformanceRecord`：通过率、修正率、p95、每次运行）。换模型、换运行时（以钉死二进制的哈希为版本）、满 30 天、或配置在检验之后又保存过，都算过期，需重测。
- 真实运行脚本：`scripts/provider-conformance.ts <chat|responses> <baseUrl> <model> [密钥环境变量名] [json_object]`（临时账本、临时 CODEX_HOME；密钥只按变量名读，不作参数）。

### 3.5 额度

本机模型（loopback 地址）不计费：`{available:true}`，后台照常。按量付费的第三方，应用不知道价格，读数是 `PROVIDER_BUDGET_UNKNOWN`（不可读）→ `backgroundSpend` 让后台暂停，本人发起的操作照常；额度卡片写明原因。工作区有自己的 Codex 登录时仍读 Codex 的窗口。给第三方定价和月上限是后续工作（价目表在 `prices.ts`，额度逻辑归 R1）。

### 3.6 Sign in with ChatGPT 套餐共享

`ProviderKind` 有 `siwc-plan`：OpenAI 的 Responses 端点 `https://api.openai.com/v1`，套餐令牌作为该工作区的密钥由网关加上，等同官方配方（`openai_chatgpt_plan`、`env_key=ACCESS_TOKEN`、`requires_openai_auth=false`、`supports_websockets=false`），但令牌不进 sidecar 的环境，所以刷新后不需要重启 sidecar 和 `thread/resume`。OAuth 拿令牌、刷新、`chatgpt.tokens.use.direct` 校验属于登录那条线（R6），尚未接上；接上后只需把令牌写进 `secret-file` 并保存一行 `kind: "siwc-plan"` 的设置。图像、托管连接器在这条路上不可用，同 3.3。

### 3.7 检验结果（真实运行）

2026-10-13 在本机真实运行 `scripts/provider-conformance.ts`。环境：Ollama 0.35，qwen3:8b，约一半在 CPU；钉死的 Codex 分支；临时账本与临时 CODEX_HOME。两种接法各跑 30 个 schema 加 3 个对抗用例，其中验收判定和收集分析各跑 3 次，共 34 次。

| | chat 接法（`/v1/chat/completions` 经转换层） | responses 接法（`/v1/responses` 经网关透传） |
|---|---|---|
| 通过 | 33/34（97.1%） | 33/34（97.1%） |
| 需要修正 | 0 | 0 |
| 验收判定、收集分析 | 各 3/3，0 修正 | 各 3/3，0 修正 |
| 失败 | 长文本对抗用例（要求 ≥1500 字）在 20 分钟时超时（`SKILL_TIMEOUT`） | 同左 |
| 单个用例耗时 | 79–413 s，p95 1201 s | 52–752 s，p95 752 s |
| 总耗时 | 246 min | 113 min |
| 准入 | 19 项 | 19 项（同左） |

准入的 19 项：访谈、里程碑设计、跨主线产出规划、任务倒推、收集分析、教程设计、教程写作、步骤拆分、复核、进度判断、输入框、任务命名、日历归类、目标拆分、画像、验收判定、每周洞察、背景整理、排程说明。

按设计不准入的：网上查证、跨主线扩展、资料检索、任务类型整理（这四项要联网）；画像插图（要生图）；电脑上的助手（要 shell）。这几项的 schema 本身都通过了。

读这张表时要注意四点：

- **chat 接法的总耗时含一次睡眠。** 第一个收集分析用例记为 6059 s。系统日志显示，电脑在本地时间 15:00:55 睡眠、16:16:01 唤醒。唤醒后停滞检测中断了这一轮并重发，重发的一轮约 9 分钟答完，未修正。这一条不代表转换层的速度。
- **长文本用例两种接法都没过。** 原因是脚本给每一轮的上限是 20 分钟（产品里是一小时），这台机器上的 8B 模型 20 分钟写不出 1500 字。这说明的是本机模型太慢，不是格式问题。
- **检验只证明能按 schema 回答，不证明判断质量。** 8B 本地模型能拿到验收判定的准入，只是因为它的格式靠得住；本地模型不该承担验收判定和收集分析，这一点仍然成立（见第 5 节）。
- **chat 接法用 Ollama 的 Chat Completions 接口代替「只有 Chat Completions 的厂商」。** 这证明了转换层能用。DeepSeek、Kimi、通义千问、GLM、Claude、Gemini 这些真实云端厂商还没有实测：各家对 `response_format` 的支持不同（例如 DeepSeek 只有 JSON 模式），上线某一家之前，要先用它的密钥跑一遍这个脚本。

## 4. 安全与隐私

| 提供方 | 离开本机的内容 | 同意 |
|---|---|---|
| ChatGPT / OpenAI API / Azure | Skill 的输入：画像事实、上传文件正文、任务、日历标题 | 现有说明 |
| Anthropic、Google | 同上，交给另一家公司 | 首次使用前单独同意，列出数据类别 |
| OpenRouter | 同上，并转给下游模型方 | 同上，并写明有中间商 |
| Ollama / LM Studio | 无 | 不需要 |

- **屏幕活动永不出门**：`apps/web/lib/activity-privacy.test.ts` 已禁止任何构建模型上下文的代码碰窗口段；把直连适配器所在目录加入它的扫描范围。录音继续本机转写。
- **出站白名单**：网关只连 `model.provider` 里登记的地址，地址由 route 查出、不取自请求；`https` 必须，loopback 例外（`providerConfigProblem`）；地址里不许带账号、参数。
- **同意按 workspace、按提供方**，撤销后该提供方立即退出路由（`model.consent.<id>`）。
- 密钥规则见 2.3；`model.connection` 的发现式测试断言导出快照和所有 API 响应里不出现 `sk-`、`AIza`、`sk-ant-` 前缀。

## 5. 分阶段与评估

| 阶段 | 内容 | 测试 / 证据 |
|---|---|---|
| **P0**（立即，小） | 非主人 workspace 关闭记忆、禁用助手；API key 时后台 pass 不再因 `available:false` 静默停，改报 `BUDGET_CAP_MISSING` | 单测：两个 workspace 的线程参数里记忆开关不同；worker pass 在 API key 下产生一条可见的 ask |
| **P1** A | `RuntimeRegistry`、每 workspace CODEX_HOME、三种登录、模型连接页、迁移、按 workspace 的预算 | 假 sidecar 单测（两个 workspace 拿到不同 client、空闲停止、崩溃退避）；发现式测试：supervisor 里不再出现 `sidecar.client`；导出/响应里无密钥；`scripts/gate-identity-check.ts` 扩展为两个账号各自登录 |
| **P2** B（R7，已做） | 所有提供方经 Codex：转换层、网关、按线程定义提供方、一致性检验、设置卡片 | `scripts/provider-probe.ts`（3.1）；`scripts/provider-conformance.ts`（3.7）；单测见各文件旁的 `*.test.ts` |
| ~~P3 B2~~ | 不做（2026-10-13：全部走 Codex） | — |
| 以后 | 别家联网、别的 agent 运行时 | 有真实需要时另写设计 |

**度量。** `scripts/structured-output-check.ts` 加 `--provider <id>/<model>` 矩阵，`scripts/concierge-replay.ts` 同理。每个提供方 × Skill 记录：通过率、修正率、`softAccept` 率、安全类拒绝数、p50/p95 时长、token 与花费。门槛：承担 `NEVER_DOWNGRADED` 的提供方，修正率不高于 Codex 基线 + 10 个百分点、安全类拒绝为零（每 Skill 至少 10 次）；输入框回放 ≥ 27/30。不达标的提供方只能用于其余 Skill，界面上标「未通过检验」。

**批判性评估。**

- **值得现在做的**：P0 必做——它修的是今天就存在的串流和静默停摆。P1 在第二个真人用之前做完；只有本人用时，它的收益只是「额度分开」。
- **B1 便宜，但别高估**：本地小模型在严格 schema 下的修正率大概率明显更高；修正循环能兜住形状，兜不住判断质量。gate 和分析不应放到本地模型上。
- **B2 最贵**：650 行的 runner 要拆、要维护四种 schema 方言，还会抬高修正率和排查成本。没有具体理由（某家在某个 Skill 上实测更好或更便宜）就不做。
- **主要风险**：schema 方言差异让校验器拒绝率上升；弱模型工具调用不稳定（输入框最受影响）；重放历史使长对话成本上升（访谈一轮约 7 分钟，历史随轮数增长）；多进程使内存和排障复杂度上升。每一项都以上面的矩阵数字决定是否继续，而不是凭印象。

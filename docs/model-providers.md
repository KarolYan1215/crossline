# 模型来源：自带 Codex 与其他 API 模型（设计稿）

状态：**设计稿，待审**（2026-10-10）。不改代码；本文所有路径以 2026-10-10 的仓库为准。

## 0. 结论

1. **A（每个 workspace 接自己的 Codex）先做，B 拆两半。** 现在任何注册进来的第二个账号都在用本人的 ChatGPT 额度和本人的 Codex 记忆（见 1.2），这是真实隐患，不是将来的需求。
2. **B1：凡是说 Responses 协议的模型，都走同一个 Codex 运行时**（OpenAI API key、Azure OpenAI、Ollama、LM Studio、OpenRouter 的 Responses 接口）。几乎不用写代码，线程、动态工具、修正循环、用量事件全部保留。
3. **B2：Anthropic / Gemini 只给结构化 Skill 用，自己写适配器**（Vercel AI SDK 当传输层），共用 `runTurnsUntilValid` 和全部校验器。联网研究、画像插图、带 shell 的助手**不**迁移。
4. 每一步先用 `scripts/structured-output-check.ts` 跑多提供方对照，修正率不达标的提供方不许承担 `NEVER_DOWNGRADED` 的 Skill。

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

### 1.3 已核实的运行时能力（`vendor/codex`，rust-v0.155.0）

- 登录：`account/login/start` 支持 `apiKey`、`chatgpt`（浏览器回调）、`chatgptDeviceCode`；`chatgptAuthTokens` 标注为 OpenAI 内部、不得使用（`app-server-protocol/src/protocol/v2/account.rs` `LoginAccountParams`）。**没有「按请求换账号」的接口**——一个进程一个 auth manager。
- 提供方：`thread/start` 有 `model_provider`（`v2/thread.rs`）；内置 `openai`、`amazon-bedrock`、`ollama`（11434）、`lmstudio`（1234）；自定义提供方写在 `model_providers.<id>`，字段有 `base_url`、`env_key`、`auth`（命令取 token）、`http_headers`、`query_params`（`model-provider-info/src/lib.rs`）。
- **只支持 Responses 协议**：`WireApi` 只剩 `Responses`，写 `chat` 直接报错（同文件 `CHAT_WIRE_API_REMOVED_ERROR`）。所以 Anthropic Messages、Gemini 原生接口进不了 Codex。
- 凭据存放：`cli_auth_credentials_store = file | keyring | auto | ephemeral`（`config/src/types.rs` `AuthCredentialsStoreMode`）。
- 未核实、须先写探针：`thread/start.config` 能否临时定义 `model_providers.*`；Ollama/LM Studio 的 Responses 兼容层是否真的执行 `strict` schema；keyring 条目是否按 CODEX_HOME 区分。

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

## 3. 接口 B：多提供方

### 3.1 两条路

| 路 | 范围 | 保留什么 | 失去什么 |
|---|---|---|---|
| **B1：Codex 内换提供方** | 说 Responses 的：OpenAI API key、Azure OpenAI、Ollama、LM Studio、OpenRouter（Responses 接口）、Bedrock（实验） | 线程、动态工具、修正循环、用量事件、审批钩子 | 联网搜索和图像（OpenAI 托管工具）；`strict` 是否执行看对方实现 |
| **B2：直连适配器** | Anthropic、Gemini 原生接口，以及 B1 跑不通的 | 修正循环、校验器、`softAccept`、用量记账 | 原生线程（改为重放）、联网、图像、shell |

B1 的做法：每个 workspace 运行时的 `config.toml` 写入 `model_providers.<id>`，密钥用 `auth`（命令型取 token，命令读 DPAPI 文件）而不是明文 `experimental_bearer_token`；`thread/start` 带 `model_provider`。本地模型的 `base_url` 只允许 loopback 的 `http://`，其余必须 `https://`。

### 3.2 Skill 声明需要什么

```ts
// packages/codex/src/capabilities.ts
export type Capability =
  | "structuredStrict" | "tools" | "webSearch" | "imageGeneration" | "shellAgent" | "nativeThreads" | "longContext";

export type SkillRequirement = { needs: Capability[]; prefers?: Capability[]; minContextTokens?: number };

export const SKILL_REQUIREMENTS: Record<string, SkillRequirement> = {
  "crossline-automation-stripper": { needs: ["structuredStrict"] },
  "crossline-milestone-gate":      { needs: ["structuredStrict"], minContextTokens: 64_000 },
  "crossline-concierge":           { needs: ["structuredStrict", "tools"], prefers: ["nativeThreads"] },
  "crossline-onboarding":          { needs: ["structuredStrict", "longContext"], prefers: ["nativeThreads"] },
  "crossline-step-planner":        { needs: ["structuredStrict", "longContext"] },   // files in full, 48k
  "crossline-due-diligence":       { needs: ["structuredStrict", "webSearch"] },
  "crossline-portrait-illustrator":{ needs: ["imageGeneration"] },
  "crossline-agent":               { needs: ["shellAgent"] },
  // …each of the 24; a discovery test fails when a Skill directory has no entry
};
```

分三类：**结构化**（18 个，含 gate、分析、架构师、反推、步骤、标题、日历归类、讲解、周报、画像文字，以及要工具调用的输入框；`crossline-eval-persona` 只用于测试）可以上任何支持 JSON schema 和 function calling 的提供方；**要联网**（4 个）只在 Codex+OpenAI 上；**图像、shell**（各 1 个）只在 Codex 上。

### 3.3 提供方与路由

```ts
// packages/codex/src/provider.ts
export type ProviderOffer = {
  id: string;                         // "codex" | "openai" | "azure" | "anthropic" | "google" | "openrouter" | "ollama" | "lmstudio"
  transport: "codex" | "direct";
  models: Array<{ model: string; tier: RouteTier; capabilities: Capability[]; contextTokens: number }>;
  consented: boolean;
};

export interface ModelProvider {
  readonly id: string;
  /** Turns our strict schema into this provider's dialect; `dropped` lists keywords it cannot express. */
  lowerSchema(schema: unknown): { schema: unknown; dropped: string[] };
  /** One model call; tool rounds happen inside, bounded. */
  turn(request: TurnRequest, signal: AbortSignal): Promise<TurnResult>;
}
export type TurnRequest = {
  system: string; messages: Array<{ role: "user" | "assistant"; text: string }>;
  schema: unknown; tools?: SkillTools; model: string; effort?: string; maxToolRounds?: number;
};
export type TurnResult = { text: string; usage: TokenBreakdown & { costMicros?: number }; toolRounds: number };

// model-policy.ts grows a provider; the env overrides become `provider/model[:effort]`
export type ModelRoute = { provider: string; model: string; effort?: string; maxRepairs?: number };
export function routeForSkill(skill: string, offers: ProviderOffer[], mode: SpendMode, env?: NodeJS.ProcessEnv):
  ModelRoute | { blocker: { code: "MODEL_CAPABILITY_MISSING"; message: string } };
```

选择规则：先按 `SKILL_REQUIREMENTS` 过滤（缺能力的直接排除），再按本人在 设置 → 模型连接 排的提供方顺序，取该档位的模型；economy 时**在同一提供方内**降一档。`NEVER_DOWNGRADED` 的 Skill 还有一条：只能落在「已认证」的提供方上（3.7 的修正率门槛），不会因为首选不可用而悄悄换到更弱的提供方——没有合格的就报 `MODEL_CAPABILITY_MISSING`（「任务分析需要一个已通过检验的模型，目前连接的都没通过」）。

### 3.4 B2 适配器怎么保住现有保证

- **共用修正循环。** 把 `runTurnsUntilValid` 里与 Codex 通知相关的部分抽成 `TurnDriver { send(prompt): Promise<string>; interrupt(): void }`，解析、清洗（`cleanAnswerStrings`）、校验、`_BLOCKED` 不修、`softAccept`、修正次数全部留在共用层。Codex 驱动就是今天的代码，先重构、Codex 测试一行不改地通过，再加直连驱动。
- **SKILL.md。** Codex 路径继续由运行时加载；直连路径读 SKILL.md 正文（去掉 frontmatter）+ `STYLE_INSTRUCTIONS` 作为 system，并把文件哈希写进审计。「SKILL.md 不进 baseInstructions」这条规则是为了不和运行时的原生加载重复，直连时没有原生加载，所以不适用。
- **线程。** 直连没有线程：我们在 worker 内存里按自己的线程 id 存消息，丢了就从账本重建——和 `SKILL_THREAD_LOST` 后「用历史开新线程」是同一条路，访谈、输入框、里程碑对话都已经有这段代码。
- **Schema 方言。** OpenAI：原样 strict `json_schema`。Anthropic：一个强制调用的工具，`input_schema` 为我们的 schema。Gemini：`responseSchema`，`anyOf[…, null]` 改写为 `nullable`，去掉 `additionalProperties`。各家不认的 `minLength/maxLength/maxItems` 去掉，记在 `dropped`——**这些约束由校验器执行，本来就不靠解码器**。`structuredOutputProblems(schema, dialect)` 加方言参数，发现式测试对每个 `*_SCHEMA` × 每种方言断言 `dropped` 只含白名单关键字。
- **动态工具。** `SkillTools.specs` 直接映射到原生 function calling，回答仍由同一个 `call` 给出；工具轮数上限 8，超过算一次拒绝进入修正。
- **超时与停滞。** 直连是一次 HTTP 流：沿用每轮一小时上限，「20 分钟无事件」改为「20 分钟无流数据」。

### 3.5 不迁移的三项

- **联网研究**：别家的搜索工具引用格式不同，没有搜索引擎我们也补不上（`safeGet` 只能打开 URL，不能找 URL）。`verifySource` 已经逐个核实来源，将来接 Anthropic `web_search` 或 Gemini grounding 只是多一个来源格式，留到有真实需要时。
- **图像**：画像插图是非必要功能，非 OpenAI 时显示「画像插图需要 ChatGPT 登录或 OpenAI API」，其余照常。
- **带 shell 的助手**：守卫挂在运行时的审批请求上；在别的模型上自己写 shell 循环，就是重写命令审批、补丁应用和沙箱——正是 CLAUDE.md「不是我们该造的」里的东西。将来若接 Claude Code 或 OpenAI Agents SDK，作为第二个 `AgentRuntime`，单独设计它的权限钩子。

### 3.6 传输库选型

| 选项 | 评价 |
|---|---|
| **Vercel AI SDK**（`ai` + `@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/openai-compatible`） | **采用**。进程内、无额外服务；统一 usage 字段；工具调用和 `jsonSchema()` 都有；只在 worker 引入，不进 web 包，包体无关紧要。只当传输用，不依赖它的 `generateObject` 做校验；版本钉死 |
| LiteLLM 代理 | 多一个 Python 服务要守护、备份、升级，违背「一台机器、两个进程」 |
| 只接 OpenRouter | 一把钥匙通吃，但所有内容多经一家中间商；作为一个 `openai-compatible` 提供方提供即可，不当抽象层 |
| 直接用三家 SDK | 三套工具调用和 schema 差异要自己抹平，重写的正是 AI SDK 已经写好的部分 |

### 3.7 用量与成本

`SkillUsage` 加 `provider`、`costMicros`；`TokenBreakdown` 已经与提供方无关，映射 Anthropic `cache_read_input_tokens`、Gemini `cachedContentTokenCount` 到 `cachedInputTokens`。设置 → 模型用量 按功能画，提供方作为图例，不出现模型名（遵守 `docs/copy-style.md`）。

## 4. 安全与隐私

| 提供方 | 离开本机的内容 | 同意 |
|---|---|---|
| ChatGPT / OpenAI API / Azure | Skill 的输入：画像事实、上传文件正文、任务、日历标题 | 现有说明 |
| Anthropic、Google | 同上，交给另一家公司 | 首次使用前单独同意，列出数据类别 |
| OpenRouter | 同上，并转给下游模型方 | 同上，并写明有中间商 |
| Ollama / LM Studio | 无 | 不需要 |

- **屏幕活动永不出门**：`apps/web/lib/activity-privacy.test.ts` 已禁止任何构建模型上下文的代码碰窗口段；把直连适配器所在目录加入它的扫描范围。录音继续本机转写。
- **出站白名单**：直连只连 `model.connection` 里登记的 base URL；`https` 必须，loopback 例外；不接受 IP 字面量（loopback 除外），复用 `safe-fetch.ts` 的主机检查。
- **同意按 workspace、按提供方**，撤销后该提供方立即退出路由（`model.consent.<id>`）。
- 密钥规则见 2.3；`model.connection` 的发现式测试断言导出快照和所有 API 响应里不出现 `sk-`、`AIza`、`sk-ant-` 前缀。

## 5. 分阶段与评估

| 阶段 | 内容 | 测试 / 证据 |
|---|---|---|
| **P0**（立即，小） | 非主人 workspace 关闭记忆、禁用助手；API key 时后台 pass 不再因 `available:false` 静默停，改报 `BUDGET_CAP_MISSING` | 单测：两个 workspace 的线程参数里记忆开关不同；worker pass 在 API key 下产生一条可见的 ask |
| **P1** A | `RuntimeRegistry`、每 workspace CODEX_HOME、三种登录、模型连接页、迁移、按 workspace 的预算 | 假 sidecar 单测（两个 workspace 拿到不同 client、空闲停止、崩溃退避）；发现式测试：supervisor 里不再出现 `sidecar.client`；导出/响应里无密钥；`scripts/gate-identity-check.ts` 扩展为两个账号各自登录 |
| **P2** B1 | Responses 提供方经 Codex | 先写 `scripts/provider-probe.ts` 核实 1.3 的三个未知；对 Ollama、Azure 各跑一遍结构化检验 |
| **P3** B2 | `TurnDriver` 重构 → AI SDK 直连，只开放结构化 Skill | 重构后 Codex 测试原样通过；直连驱动用录制的回答回放（`apps/worker/src/testing/fixtures/`） |
| 以后 | 别家联网、别的 agent 运行时 | 有真实需要时另写设计 |

**度量。** `scripts/structured-output-check.ts` 加 `--provider <id>/<model>` 矩阵，`scripts/concierge-replay.ts` 同理。每个提供方 × Skill 记录：通过率、修正率、`softAccept` 率、安全类拒绝数、p50/p95 时长、token 与花费。门槛：承担 `NEVER_DOWNGRADED` 的提供方，修正率不高于 Codex 基线 + 10 个百分点、安全类拒绝为零（每 Skill 至少 10 次）；输入框回放 ≥ 27/30。不达标的提供方只能用于其余 Skill，界面上标「未通过检验」。

**批判性评估。**

- **值得现在做的**：P0 必做——它修的是今天就存在的串流和静默停摆。P1 在第二个真人用之前做完；只有本人用时，它的收益只是「额度分开」。
- **B1 便宜，但别高估**：本地小模型在严格 schema 下的修正率大概率明显更高；修正循环能兜住形状，兜不住判断质量。gate 和分析不应放到本地模型上。
- **B2 最贵**：650 行的 runner 要拆、要维护四种 schema 方言，还会抬高修正率和排查成本。没有具体理由（某家在某个 Skill 上实测更好或更便宜）就不做。
- **主要风险**：schema 方言差异让校验器拒绝率上升；弱模型工具调用不稳定（输入框最受影响）；重放历史使长对话成本上升（访谈一轮约 7 分钟，历史随轮数增长）；多进程使内存和排障复杂度上升。每一项都以上面的矩阵数字决定是否继续，而不是凭印象。

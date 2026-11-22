# Crossline 作为 MCP server（往外开）

2026-11-21。本人的决定：先做「往外开」——让 Claude Code、Codex 等外部 AI 通过 MCP 用 Crossline；「往里接外部 MCP」只做计划（§9），以后放在本地版。

实现：`apps/web/app/api/mcp/route.ts`（端点）、`apps/web/lib/mcp/`（server、工具、令牌、`oauth.ts` 授权服务器）、`apps/web/app/mcp/authorize/`（同意页）、`packages/core/src/mcp.ts`（工具表、权限、可回答的待决类型）、`apps/web/app/settings/mcp-card.tsx`（设置卡）。

## 1. 要做的四件事

| 本人的话 | 工具 | 走的现有路径 |
|---|---|---|
| 「我今天排了什么」 | `crossline_today` | `dayAtGlance`（`lib/nudges.ts`，开场白同源）+ `loadWrap` |
| 往账本里记一句 | `crossline_capture` | `executeAction("task.create")` → capture → 分析 → WorkOrder |
| 回答待决 / 待记录 | `crossline_list_asks`、`crossline_answer_ask` | `openAsks` / `listed` / `thisWeek`，`answerAsk`（内含 `validateAskChoice`） |
| 记录完成 | `crossline_list_tasks`、`crossline_complete` | `executeAction("block.outcome")`、`executeAction("task.op")`（complete / step_done / progress） |

`list_tasks` 只为让外部 AI 找到 `workOrderId` / `stepId`，不是第五件事。没有一行业务逻辑是 MCP 专有的：校验、状态机、撤销都是页面那一份。

## 2. 调研（2026-11-21）

- **协议**：当前修订 2026-07-28（<https://modelcontextprotocol.io/specification/2026-07-28>）。Streamable HTTP 已改为无状态：只用 POST，GET/DELETE 返回 405，不再有 `Mcp-Session-Id`，版本与客户端信息放在每个请求的 `_meta`；服务器**必须**校验 `Origin`，不合法返回 403。2025 年的客户端仍按旧握手（`initialize`）连接，SDK 的无状态回退兼容它们。
- **授权**（Authorization 一章）：HTTP 传输下服务器是 OAuth 2.1 资源服务器，用 Protected Resource Metadata（RFC 9728）指向授权服务器，令牌须按 RFC 8707 绑定受众；客户端注册首选 Client ID Metadata Document，动态注册（DCR）已降为兼容；**禁止令牌透传**（不得把收到的令牌转给下游）。
- **工具注解**：`readOnlyHint`（默认 false）、`destructiveHint`（默认 true）、`idempotentHint`、`openWorldHint`（默认 true）；规范明说它们是提示，客户端不得据此信任服务器。结果同时给 `structuredContent` 和一段 JSON 文本，旧客户端也能读。
- **SDK**：TypeScript SDK v2（`@modelcontextprotocol/server@2.4.0` / `client@2.4.0`），`createMcpHandler(factory)` 返回一个 Web 标准 `fetch` 处理器，正好放进 Next 的 route handler；factory 每个请求拿到 `authInfo`，可以按调用者现建 server。
- **宿主**：
  - Claude Code：`claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`，支持静态请求头。
  - Codex：`~/.codex/config.toml` 的 `[mcp_servers.x] url = …`、`bearer_token_env_var = …`。
  - claude.ai 自定义连接器：OAuth 或无认证（静态请求头在 beta，不能指望）。回调固定 `https://claude.ai/api/mcp/auth_callback`（以后可能是 claude.com）；AS 元数据同时声明 `client_id_metadata_document_supported: true` 与 `token_endpoint_auth_methods_supported` 含 `none` 才用 CIMD，否则用 DCR（需要 `registration_endpoint`）；每次都带 PKCE S256；401 的 `resource_metadata` 优先，没有再探 `/.well-known/oauth-protected-resource/<path>` 与根路径；Token 端点必须收 form 编码；401 时与过期前 5 分钟刷新，公共客户端应轮换 refresh token（<https://claude.com/docs/connectors/building/authentication>）。
  - ChatGPT 连接器 / Apps：只有 OAuth 或无认证。元数据须有 `code_challenge_methods_supported` 含 `S256`，否则不支持；有 `client_id_metadata_document_supported` 时优先 CIMD，否则 DCR（每个连接注册一次并复用）；授权与换令牌都带 `resource`；声明 `authorization_response_iss_parameter_supported: true` 并且每个授权响应（含错误）都带与 `issuer` 完全相同的 `iss`（RFC 9207）时，用固定回调 `https://chatgpt.com/connector_platform_oauth_redirect`，否则用每次不同的 `https://chatgpt.com/connector/oauth/{callback_id}`（<https://developers.openai.com/apps-sdk/build/auth>）。
- **安全文献**：规范的 Security Best Practices（confused deputy、令牌透传、会话劫持）；工具投毒 / rug pull（描述被事后改写）；间接提示注入（工具返回的数据里藏指令）。

## 3. 批判性分析与取舍

### 3.1 stdio 本地 vs 远程 HTTP，先做哪个

**先做远程 HTTP，不做 stdio。**

- stdio server 是宿主拉起的子进程。要读写账本，它只能直接打开 SQLite：那是第二个写者，绕过 web 的 AccessContext、撤销、i18n、限流，而且托管版的账本根本不在用户电脑上。若改成转发到 web，它就只是一个带令牌的 HTTP 代理，多一个要打包、要更新的二进制，没有新能力。
- 一个 HTTP 端点 `/api/mcp` 同时服务两种部署：本地版 `http://localhost:3210/api/mcp`，托管版 `https://app.crossline.lol/api/mcp`。代码一份。
- Claude Code 与 Codex 都直接支持「URL + Bearer」；claude.ai 与 ChatGPT 只走 OAuth，由 Crossline 自己当授权服务器（§4.3）。

### 3.2 与 `docs/agent-host-plugins.md` 的关系

那份草稿讨论的是**另一件事**：把 Crossline 的 skills 搬进宿主 agent 里跑（插件版），由于拿不到 `outputSchema`，验证器做成 `crossline` CLI。它的 P6 正是「本地版和网页版的 `/mcp` 端点」。本文就是 P6，与草稿一致：

- 草稿选 CLI，是为了让宿主模型**产出结构化结果后自己交验**；这里外部 AI 只调用四类已有操作，验证在服务器里，不需要 CLI。
- 若以后做插件版，CLI 的「账本读写」部分应改为调用本端点，而不是自己开 SQLite（理由同 §3.1）。

### 3.3 认证：令牌、范围、撤销

第一期用**个人访问令牌**，与「这台电脑」的设备令牌同一做法（`issueDeviceToken`）：

- 在 设置 → 日历与连接 → 在其他 AI 里用 Crossline 生成，每个外部 AI 一个，名字由本人起（「Claude Code」）。
- 只显示一次，账本里只存 SHA-256（`mcp.tokens` 设置项），常数时间比较；最多 10 个。
- 范围两档：`read`（只看）和 `write`（读 + 四类写）。只读令牌连写工具都**不列出**（规范允许工具列表按授权变化），调用也会被拒。
- 撤销一个只断那一个 AI，下一次调用即 401；删账号就删掉全部；备份 / 恢复随账本走。
- 令牌代表账号主人（与设备令牌一样），`AccessContext.authMethod = "mcp"`，`via = 令牌名`。
- 令牌**只能**用浏览器登录会话管理（`/api/mcp/tokens` 要求 `authMethod === "session"`）：外部 AI 不能给自己再发令牌或升级范围。
- 浏览器会话**不能**调用 `/api/mcp`：只认 Bearer，别的网站的页面借不到本人的 cookie；跨站 `Origin` 在读令牌前就 403。
- 限流：每个令牌每分钟 60 次调用、每小时 60 次写入（内存计数，防失控循环，不防重启）。

为什么不直接复用 `packages/auth`（Better Auth）的会话：会话 cookie 绑定浏览器、跟随登录登出，外部 AI 需要的是长期、可单独撤销、带范围的凭据。OAuth 登录（§4.3）发出的也是同一种令牌、存在同一个列表里，范围与撤销语义不变。

### 3.4 写入边界

**只有四类写，全部是账本内部的：** capture、回答允许的待决、block 结果、任务完成 / 步骤完成 / 进度。MCP **永远不会**打开：发邮件、发布、交易、报名表提交、外部日历写入、Graph / Google 写入。具体做法：

- 工具表是固定的（`MCP_TOOLS`），没有通用的「执行任意 action」入口。
- 待决只允许白名单类型（`MCP_ANSWERABLE_KINDS`）。排除：机会报名 / 申请（`opportunity_offer`、`opportunity_apply_ready`）、邮件里的事件与提议（`mail_event`、`event_propose`）、助手被卡住（`agent_blocked`）、重复账目与资产余额、登录 / 日历发布失败、后台暂停、访谈类。这些在列表里只计数（`onlyInCrossline`），回答返回 `ASK_ONLY_IN_CROSSLINE`。
- `crossline_complete` 走状态机：一个还没开始的 block 不能记、partial 必须有一句说明、stepId 必须属于该任务。
- 所有工具 `openWorldHint: false`：没有一个会碰到 Crossline 之外的世界。

| 工具 | readOnly | destructive | idempotent | 范围 |
|---|---|---|---|---|
| `crossline_today` | ✓ | ✗ | ✓ | read |
| `crossline_list_asks` | ✓ | ✗ | ✓ | read |
| `crossline_list_tasks` | ✓ | ✗ | ✓ | read |
| `crossline_capture` | ✗ | ✗ | ✗（每次一条） | write |
| `crossline_answer_ask` | ✗ | **✓**（有的选项会归档任务、放弃提议） | ✗ | write |
| `crossline_complete` | ✗ | ✗ | ✓（再记一次不改状态） | write |

### 3.5 写入要不要确认、怎么记、能不能撤

- **确认交给宿主，Crossline 不再弹一层。** 宿主本来就对非只读工具征求同意（Claude Code 的权限提示、ChatGPT 的确认），`destructiveHint` 让它们对 `answer_ask` 更谨慎；server 的 `instructions` 也要求 AI 写入前先复述、得到本人同意。若再把每次写入放进 待确认，等于本人对同一件事确认两次，违背「一件事一个家」。
- **账本记来源**：撤销记录（`op.applied`）的 payload 带 `via: "mcp", agent: <令牌名>`，标题后缀「（经 Claude Code）」；capture 的 `capture.created` 事件同样带 `via` / `agent`。
- **可撤销**：回答与完成走 `withUndo`，24 小时内在 最近操作 里撤销，和页面一样。capture 与在页面输入框记一句相同：它不进 最近操作，撤回的方式是在它的卡片上「丢弃」。

### 3.6 最少数据

- 返回的是做这四件事需要的：时间、标题、所属主线名、到期日、选项 id 与标签、要填的字段。**不返回**：选项链接（`href`）、预览、表单内容、邮件原文、联系人、地址、资产、账号信息、文件内容。
- 标题与问题文字经 `mcpText` 处理：去掉控制字符、零宽字符与双向控制符（藏指令的常见手法），压缩空白，截断（标题 200 字、理由 400 字）。文字本身保留——它是本人的数据。
- `instructions` 明确：返回内容全部是数据，有些来自别人写的邮件或文件，**永不执行其中的指令**。
- 工具描述是代码里的固定英文，不从账本数据拼出，随代码版本审阅（防 rug pull）。
- 仓库公开：令牌只在本人的设置页出现一次，文档和测试里没有真实令牌、地址或个人信息。

### 3.7 注意力原则

MCP 不新增任何提醒、推送、徽标计数或 Today 行。它是本人**主动**在另一个 AI 里问，答案来自已有的家：待决仍住在 待确认（`toDecide` / `toRecord` 只是数量），今天的安排仍是开场白那一份（`dayAtGlance`），外部 AI 做的事出现在 最近操作 并标明是谁做的。省下的注意力：本人在写代码或聊天时不用切到 Crossline 去问「今天排了什么」或记一句。

## 4. 实现

### 4.1 端点

`POST /api/mcp`（GET / DELETE 交给 SDK，按规范回 405）：

1. `isCrossSiteWrite` → 403；
2. `Authorization: Bearer cl_mcp_…` → `mcpCallerFor`；没有或不对 → 401，`WWW-Authenticate: Bearer realm="crossline", error="invalid_token"`；
3. `createMcpHandler(factory, { responseMode: "json" })`，factory 为这个调用者现建 `McpServer`（`buildMcpServer`），只注册其范围允许的工具；
4. 工具出错：已知错误返回 `isError` 结果 `{code, message}`（AI 能读能改），未知错误记 `mcp.tool_failed` 日志，回 `INTERNAL`、「nothing was recorded」。

请求体上限 256 KB。

### 4.2 设置页

设置 → 日历与连接 → 「在其他 AI 里用 Crossline」：已有令牌（名称、只读 / 读写、生成与最近使用时间、撤销；展开「最近读取 N 次」看对方最近 20 次读了什么：哪个读取工具、几点，只记这两项）；生成（名称 + 只读 / 读写，令牌只显示一次）；「怎么接入」里是本站地址下的 Claude Code 命令与 Codex 配置。

接入示例（令牌放在环境变量里，不写进仓库）：

```powershell
claude mcp add --transport http crossline http://localhost:3210/api/mcp --header "Authorization: Bearer $env:CROSSLINE_MCP_TOKEN"
```

```toml
# ~/.codex/config.toml
[mcp_servers.crossline]
url = "https://app.crossline.lol/api/mcp"
bearer_token_env_var = "CROSSLINE_MCP_TOKEN"
```

### 4.3 OAuth：claude.ai 与 ChatGPT（2026-11-21）

claude.ai 与 ChatGPT 的连接器只走 OAuth，所以 Crossline 自己当授权服务器（`apps/web/lib/mcp/oauth.ts`），`/api/mcp` 是资源服务器。

**端点**

| 地址 | 作用 |
|---|---|
| `GET /.well-known/oauth-protected-resource`（及 `/.well-known/oauth-protected-resource/api/mcp`） | RFC 9728：`resource` = `<站点>/api/mcp`，`authorization_servers` = [`<站点>`]，`scopes_supported` = `read`、`write` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414：code + PKCE S256、`none`（公共客户端）、`authorization_code` + `refresh_token`、`authorization_response_iss_parameter_supported: true` |
| `POST /api/mcp/oauth/register` | RFC 7591 动态注册 |
| `GET /mcp/authorize` | 授权端点 = 同意页 |
| `POST /api/mcp/oauth/consent` | 同意页提交（本人浏览器会话） |
| `POST /api/mcp/oauth/token` | 换令牌、刷新（form 编码） |

`/api/mcp` 没有令牌时回 401 `WWW-Authenticate: Bearer resource_metadata="<站点>/.well-known/oauth-protected-resource"`，令牌无效时再加 `error="invalid_token"`。站点地址取 `CROSSLINE_WEB_BASE_URL`（与 Better Auth 同一个），签名用 `BETTER_AUTH_SECRET`；没有密钥就没有 OAuth（元数据 404，手动令牌照常）。

**为什么自己写，不用 `@better-auth/oauth-provider`**（原计划）：

- 它发 JWT 访问令牌，撤销要等过期；这里令牌就是 `mcp.tokens` 里的一条，设置卡上点撤销，下一次调用就 401，和手动令牌一样。
- 它把客户端、令牌、同意记录放进 `auth.db` 的新表，设置卡要读两处；这里一个列表。
- 能对上本仓库 `better-auth@1.7.5` 的版本不保证 RFC 9207 的 `iss`（ChatGPT 的固定回调要它）；最新版要求先把 Better Auth 升到 1.7.27。
- 需要的只是 code + PKCE + 刷新 + 动态注册，约 250 行，每一步都有测试（§5）。

**取舍**

- **不做 Client ID Metadata Document。** CIMD 要服务器去抓客户端给的任意 URL（SSRF 面），托管版不开新的出站路径；两个宿主都在没声明 CIMD 时退回 DCR。
- **注册不落库。** `client_id` 就是注册内容（名字、回调地址）加站点密钥的 HMAC 签名：开放的注册端点不会被灌满，改动任何一处签名就失效。回调地址只收 https，或本机 loopback 的 http（Claude Code、Codex；端口任意，RFC 8252 §7.3）；不收片段、账号密码、别的 scheme；最多 5 个。
- **同意页名字不算数，地址算数。** 客户端名字是自报的，同意页醒目写出授权后**返回到哪个地址**（`claude.ai`、`chatgpt.com`），提示「只在认得这个地址时允许」。本人可以改名字（每次写入都标这个名字）、把读写降成只读；不会多给客户端没要的范围。未知客户端或未登记的回调地址只在页面上说明，**绝不重定向**过去；其他错误按规范带 `state` 与 `iss` 回给客户端。
- **登录始终由本人在浏览器里完成。** 未登录时同意页送去登录页，登录后回到同一个同意页（`safeNext` 放行查询串里的 `+`、`!'()*,;:@$`）。打开同意页不授予任何东西，只有按「允许」才会。同意页的提交只接受本站浏览器会话、拒绝跨站；它返回下一步地址由页面自己跳转（站点 CSP `form-action 'self'` 会拦下跳到别站的表单）。
- **授权码**：32 字节随机，存哈希，60 秒，只能用一次（PKCE 不对也作废），必须同一个 `client_id` 与 `redirect_uri`；放在进程内存（`globalThis`），重启丢失只损失一分钟内的码。
- **令牌**：访问令牌就是 `cl_mcp_…` 手动令牌的同一格式，1 小时过期；刷新令牌 `cl_mcr_…`，30 天，每次刷新都换新，只能由同一个客户端刷新，可以收窄范围、不能扩大。两者都只存 SHA-256。
- **刷新的宽限（2026-11-21）**：旧刷新令牌在换掉后 60 秒内再出现（宿主过期前并发刷新，或刷新的回应在路上丢了重试），返回**同一组**新令牌，而不是 `invalid_grant` 让连接断掉；只认同一个客户端，连接被撤销后立即无效，60 秒后作废。这组新令牌只在进程内存里（以旧刷新令牌的哈希为键），账本仍只存哈希；重启只丢掉这一分钟。被换掉的访问令牌留到它自己的 1 小时到期（`oauth.earlier`，最多 5 个），已经在路上的请求不会 401。`resource` 若给出必须等于 `<站点>/api/mcp`（`invalid_target`）；只有一个资源，令牌也只在 `/api/mcp` 有效。
- **在设置卡里与手动令牌一起列出**，标「登录连接 · <地址>」，同样一键撤销（访问与刷新令牌同时失效）。刷新令牌过期的连接在下一次登录时清掉；满了时同意页直接说「先撤销一个」。
- **重新连接替换旧连接**：claude.ai 每次全新连接都重新注册一个客户端，所以按「返回地址 + 名称」认连接，不按 `client_id`：同一地址、同一名称再登录一次就替换原来那条（原来的令牌立即失效），不占新名额；同意页提示「会替换……想两个都留，换一个名字」。名额满了时，替换照样可以。
- **托管版才能接 claude.ai / ChatGPT**：它们从网上连过来，本地版 `http://127.0.0.1` 连不上（设置卡会说明）。本地版上 Claude Code 也可以走 OAuth（loopback 回调），但手动令牌更简单。

接入：claude.ai → 设置 → 连接器 → 添加自定义连接器，填 `https://app.crossline.lol/api/mcp`，按提示登录 Crossline 并允许；ChatGPT → 开发者模式新建连接器，同一地址，认证选 OAuth。

## 5. 测试

- `apps/web/lib/mcp/tokens.test.ts`：只存哈希、范围、撤销一个不影响其他、两个账号互不可达、校验与上限、写入限流。
- `apps/web/lib/mcp/tools.test.ts`：每个工具一条，经页面同一函数；含零宽字符被清掉、链接不外泄、待决按卡片规则校验、写入带 agent 名、状态机拒绝。
- `apps/web/app/api/mcp/route.test.ts`：协议级。用 SDK 的 `Client` + `StreamableHTTPClientTransport` 连自己的 route，2026-07-28 客户端（`auto`）与 2025 客户端（`legacy`）各跑通四类操作，读取记在令牌上、写入不记；只读令牌只看到只读工具；无令牌 / 错令牌 401，跨站 403。
- `packages/core/src/mcp.test.ts`：`mcpText`、`mcpToolAllowed`、白名单不含任何对外类型、回调地址规则与 loopback 端口、`scope` 解析。
- `apps/web/lib/mcp/oauth.test.ts`：元数据（无 CIMD）、注册不落库且伪造 / 改动 / 换密钥的 `client_id` 无效、坏回调地址、未知客户端与回调不重定向、其余错误带 `state` 与 `iss`、拒绝与只读不超范围、PKCE / 同客户端 / 同回调 / 一次性 / 60 秒、令牌即账号的 MCP 令牌并列在设置卡、1 小时过期、刷新轮换、60 秒内重放得到同一组令牌（别的客户端不行、过后不行、撤销后不行）、被换掉的访问令牌留到自己到期、换客户端不能刷新、收窄范围、撤销同时废掉两种令牌、30 天、上限、同地址同名重连替换而换名保留两个、满额时替换仍可。
- `apps/web/app/api/mcp/oauth/flow.test.ts`：协议级。SDK 自带的 OAuth 客户端从 `/api/mcp` 的 401 开始：发现 → 动态注册 → 同意页提交（未登录 401）→ 带 `iss` 的回调（SDK 按 RFC 9207 校验）→ 换令牌 → 调工具（写入标「Claude」）→ 访问令牌过期后 SDK 自己刷新再调；ChatGPT 路径：拒绝得到 `access_denied`、选只读只看到只读工具；跨站提交同意页 403。

## 6. 不变的硬约束

- `packages/codex/src/skill-runner.ts` 对每次运行强制 `mcp_servers.*.enabled = false`；`apps/worker/src/node/protocol.ts` 只允许关闭 MCP server。本文只开了一个**入口**，worker 与 Codex 仍然不连任何 MCP server（`codex_apps` 除外，见 CLAUDE.md）。
- CLAUDE.md 的 Safety boundaries 一条未放宽：MCP 不提供任何外部写入路径。

## 7. 已知局限

- 授权码在进程内存里：多实例部署要换成共享存储（现在托管版是单实例）。

- 限流在内存里，多实例或重启后重计；够防失控循环，不是配额。
- `lastUsedAt` 每分钟最多写一次。
- 刷新宽限在进程内存里，和授权码一样：多实例要换共享存储。
- 令牌查找遍历所有账号（同设备令牌）；账号数到上千再加索引。

## 8. 宿主验证（2026-11-21）

OAuth：claude.ai 与 ChatGPT 要从网上连到托管版，部署前只能在本机验证。在 `localhost:3417` 的临时实例（`scripts/review-server.ts dev`）上：

- `/.well-known/oauth-protected-resource`（及 `/api/mcp` 后缀）与 `/.well-known/oauth-authorization-server` 由 Next 正常提供；`/api/mcp` 无令牌回 401 带 `resource_metadata`。
- 一个站在 `localhost:4567` 的假宿主注册后打开同意页：未登录 → 登录页（`next` 带着完整的同意页地址）→ 用测试邮箱的验证码登录 → 设密码页的「以后再说」→ 回到同意页，显示返回地址 `localhost:4567`、自称「Claude」、只读 / 读写；按「允许」后浏览器跳到回调，带 `code`、`state`、`iss`。
- 假宿主用 code + verifier 换到令牌（`Bearer`、3600、`read write`、有 refresh token），`initialize` 与 `crossline_today` 都 200；刷新后旧访问令牌 401、新的 200；设置卡列出「Claude · 读写 · 登录连接 · localhost:4567」。
- 顺带验证：上一轮发给另一个客户端的 code 被浏览器重放到假宿主，换令牌被拒。

部署后由本人在 claude.ai / ChatGPT 里添加连接器、登录并允许，再问一次「我今天排了什么」。

在 `localhost:3417` 的临时实例（独立数据目录，`scripts/review-server.ts dev`）上造一个账号和读写令牌：

- Claude Code：`claude mcp add --transport http … --header "Authorization: Bearer …"` 后 `claude mcp get` 显示 ✔ Connected（握手与工具列表通过）。这台机器的 Claude Code CLI 没有登录，所以没有跑「今天排了什么」的模型回合；登录由本人来做。
- 同一实例上用 SDK 的 client 走真实 HTTP：2026-07-28 与 2025 两种客户端都列出六个工具；`crossline_today` 返回当天与 3 天内到期的任务、待决 1 条；capture 写入收件箱；回答 `overdue_task`（延期）后撤销标题带「（经 Claude Code）」；`crossline_complete` 记为完成；无令牌 401 带 `WWW-Authenticate`。

## 9. 后续：往里接（只做计划，不实现）

让 Crossline 的助手调用本人自己的外部 MCP server（如本地的笔记、代码工具）。规则：

1. **只在工具模式、有人在场时用。** 只有本人当面驱动的助手对话（tools mode）可以调外部 MCP；后台 skill、定时任务、自动化、晨报一律不能。`skill-runner.ts` 的强制关闭不改，工具模式单独开一条有人在场的路径。
2. **逐个工具白名单，默认全关。** 接入一个 server 后，它的每个工具单独列出，本人逐个打开；新出现或描述改变的工具默认关闭，并要求重新确认（防 rug pull）。
3. **可能写入的工具每次都进 待确认。** 只要工具没有 `readOnlyHint: true`（未声明按会写处理），每一次调用都先成为 待确认 里的一条，写出工具名、参数与目标，本人按了才执行；不因「上次同意过」放行。
4. **托管版只接远程 HTTP + OAuth，不接 stdio。** 托管服务器不能替用户拉起任意本地进程；stdio 只在本地版考虑。OAuth 由本人在浏览器里登录，令牌按 RFC 8707 绑定到那个 server，不透传。
5. **返回内容只当数据。** 外部工具的返回不进系统提示、不当指令，和邮件、网页一样作为不可信数据交给模型；从中提取的任何写入仍走第 3 条。

# 配置 Sign in with ChatGPT

本文说明 Crossline 的「用 ChatGPT 账号登录」能做什么、怎样打开，以及订阅额度共享还差什么。OpenAI 文档于 2026-10-13 核对（<https://developers.openai.com/siwc>）。标 **未能确认** 的条目，文档里查不到。

## 1. 它给两样东西，Crossline 现在只用第一样

| | 身份（登录） | 订阅额度共享（plan usage） |
|---|---|---|
| 作用 | 用 ChatGPT 账号登录 Crossline，不需要邮件 | 访客用**自己的** ChatGPT 套餐跑 Crossline 的模型，不用机主的额度 |
| 范围 | `openid profile email` | 再加 `offline_access resource.invoke chatgpt.tokens.use.direct`，并带 `resource=https://api.openai.com/v1` |
| 代码 | 已有：`packages/auth/src/chatgpt.ts`，默认关闭 | **未实现**。设计见 `docs/review-2026-10-13.md` §7（提供方 `codex-siwc-plan`） |
| 能否用 | 打开开关即可（第 4 节） | 先要写代码（第 6 节） |

额度共享接通后的使用方式（官方「Codex app-server」页）：令牌交换后，把 `access_token` 作为环境变量 `ACCESS_TOKEN` 传给 app-server 子进程，并用以下参数启动：`model_provider="openai_chatgpt_plan"`，`base_url="https://api.openai.com/v1"`，`env_key="ACCESS_TOKEN"`，`wire_api="responses"`，`requires_openai_auth=false`。访问令牌 1 小时过期；刷新令牌每次续期后再管 30 天。续期后要重启 app-server 并 `thread/resume`。这条通道不支持图像生成、托管 MCP 或连接器（日历 app）、文件上传，所以画像图、日历 app 读取和 shell 助手仍只走机主自己的 Codex。

## 2. 不需要申请 client id

本机自装版走的是 OpenAI 给开源和本地应用的**动态注册**，不需要事先申请：

- 第一次登录时，Crossline 发 `client_id=dynamic_agent_client`、应用名 `agent_name_hint` 和本机标识 `ext_agent_host_id`。
- 在 OpenAI 页面同意后，回调带回 OpenAI 签发的 `client_id`（`oaiapp_…`）。Crossline 把它和本机标识写进 `data/chatgpt-signin.json`：`{"hostId":"urn:uuid:…","clientId":"oaiapp_…"}`。以后每次登录都用这个 id。这个文件不进账本，也不进导出。
- 不需要 client secret。

`/siwc/request-client-id` 页面写的是：「Sign in with ChatGPT is currently offered to a select group of commercial partners」，并指向等候名单表单 <https://openai.com/form/sign-in-with-chatgpt-interest/>。开源流程页也说，**收费或远程托管**的应用才填这个表单。所以：

- 只在本机自用、或把 Crossline 开源给别人在他们自己的电脑上跑：**不用填**。
- 打算做托管版（别人通过网址登录、不在 127.0.0.1 上）：填这个表单。表单字段 **未能确认**（页面没有列出）。可以按下面准备：应用名 `Crossline`；用途是「本地优先的跨身份执行看板，用用户自己的 ChatGPT 套餐运行结构化任务」；回调地址是托管域名下的 `https://<域名>/auth/callback`。注意：本地回调只允许 `http://127.0.0.1:<端口>/auth/callback`，**不允许 `localhost`**，所以托管版的回调规则要以 OpenAI 回复为准。

## 3. 已按官方文档修正的两处（2026-10-13）

- `agent_name_hint` 是 `crossline`，与 app-server `initialize` 的 `clientInfo.name` 一致（官方要求两者 match；是否区分大小写，**未能确认**）。它只在第一次注册时发送。
- `ext_agent_host_id` 每次授权都发送，同一台电脑始终是 `data/chatgpt-signin.json` 里的同一个值。

## 4. 打开

1. 用编辑器打开 `C:\Users\karol\Documents\ChatGPT\Multi-ID\apps\web\.env`，加一行（本机已加好）：
   ```text
   CROSSLINE_CHATGPT_SIGNIN=1
   ```
   只有正好是 `1` 才算开启（`apps/web/lib/auth.ts` `isChatgptSignInConfigured`）。
2. 重启网页服务（命令见 `docs/setup-google-oauth.md` 第 5 节；若第 3 节改了代码，先 `pnpm build:prod`）。
3. 用 **`http://127.0.0.1:3210/login`** 打开登录页。按钮 **用 ChatGPT 账号登录** 只在主机名正好是 `127.0.0.1` 时出现。用 `localhost` 或 tailnet 地址打开时不出现。原因是 OpenAI 只回调到 `127.0.0.1`，状态 cookie 必须在同一个主机名下。

## 5. 第一次登录会发生什么

1. 浏览器跳到 `https://auth.openai.com/api/accounts/authorize`。OpenAI 显示注册和同意页，应用名可以改（文档说它只是显示用的）。
2. 同意后回到 `http://127.0.0.1:3210/auth/callback`，由 `apps/web/app/auth/callback/route.ts` 转给 `/api/auth/chatgpt/callback`。
3. Crossline 在 `https://auth.openai.com/api/accounts/oauth/token` 交换令牌（PKCE，无密钥），用 OpenAI 的 JWKS 校验 ID token（签发方、受众为签发的 id、过期时间、nonce），以 `sub` 作为账号。
4. 和 Google 一样，**同一个邮箱就是同一个账号**：OpenAI 在 ID token 里写明 `email_verified: true`，并且原账号的邮箱也验证过，这次登录就进入原账号。缺一样就拒绝。从没注册过的邮箱，会新建一个空账号并进入访谈。

| 登录页提示 | 原因 |
|---|---|
| 「ChatGPT 登录只能在本机用 127.0.0.1 打开时使用」 | 不是用 127.0.0.1 打开的 |
| 「登录已超时」/「登录请求不匹配」 | 超过 10 分钟，或中途换了地址 |
| 「OpenAI 没有完成这台电脑的注册」 | 回调没有带回 `client_id` |
| 「这台电脑在 OpenAI 的注册已失效」 | 删除 `data/chatgpt-signin.json` 后重试 |
| 「OpenAI 没有完成登录」 | 令牌交换失败。只要 identity 范围的动态注册是否被接受，**未能确认**，第一次真实登录会给出答案 |

## 6. 访客的模型：额度共享做好之前

额度共享（第 1 节右栏）做好之前，访客在 **设置 → 模型连接** 里接自己的 Codex：

- **设备码**：在任何设备上（包括手机）打开 OpenAI 给的网址，输入设备码。这是推荐的兜底方式。
- **浏览器登录**：只在本机打开页面时可用，因为 Codex 回调到它自己的 localhost。
- **API key**：按量付费，额度读数是本月花费对比 `model.budget.monthly`（默认 10 美元）。

都不会回落到机主的运行时（`RUNTIME_UNCONNECTED`）。

哪些 ChatGPT 套餐能用额度共享，官方没有写（**未能确认**），只有一节「ChatGPT plan use isn't enabled」的排错。只有在令牌响应的 `scope` 里看到 `chatgpt.tokens.use.direct`，才算授予了额度共享；只拿到有效的 ID token 不算。现有代码不申请这个范围，所以第 4 节的登录**不会**告诉你你的套餐能不能共享。想提前知道，可以单独跑一次只打印授予范围的探针。探针会在 OpenAI 那边多注册一个本机应用。

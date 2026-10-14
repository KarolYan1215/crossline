# 本机安装版与使用记录回传（设计，2026-10-13）

## 目标与约束

内测要同时满足：测试者不 clone 代码；不占机主的电脑和 Codex 额度；用测试者**自己的** ChatGPT 额度；功能完整（shell 助手、生图、联网调研、Outlook 日历、屏幕活动、录音转写）；机主能集中看到使用记录。

这几条决定了做法：模型必须在测试者自己的电脑上、用他自己的 ChatGPT 登录运行。OpenAI 的 Codex App Server 文档写明「App-server authentication has never been permitted for commercial or hosted services」，但本地或开源应用可以用（<https://learn.chatgpt.com/docs/app-server>，Auth endpoints 一节）。SIWC 托管版要成为合作方，目前是等候名单，等不到。**不做**的事：把测试者的 ChatGPT 凭据（`auth.json`、令牌）放到任何服务器上。

## 已定的决定（2026-10-13，与机主逐条确认）

| 项 | 决定 |
|---|---|
| 平台 | 只做 Windows |
| 打包 | Inno Setup（或 NSIS）安装包，内含便携版 `node.exe`。不用 Electron：应用本身是 PWA，在浏览器里打开即可 |
| 签名 | 内测不签名，安装说明里写明 SmartScreen 弹窗时点「仍要运行」 |
| 登录 | 只用 Codex 的 ChatGPT 登录：账号邮箱从 app-server `account/read` 读出，本机账号据此建立；不走 SIWC，也不用邮箱、密码、Google |
| 回传 | 自动上传白名单内的行为元数据；另有一键上传脱敏快照。不传正文 |
| 接收端 | Cloudflare Workers + D1；面板用 Cloudflare Access 限制为只有机主能看 |
| 分发 | 单独建一个公开仓库，只放安装包和版本清单；源码仓库保持私有 |
| 首版范围 | 全部功能，不裁剪 |

## 结构

```text
%LOCALAPPDATA%\Crossline\
  app\            node.exe、web（.next-prod standalone）、worker、codex.exe、codex-code-mode-host.exe、NOTICE
  data\           crossline.db、auth.db、materials\、portrait\、chatgpt-signin.json 等（即 CROSSLINE_DATA_DIR）
  runtimes\       Codex 的 CODEX_HOME（机主运行时，即测试者本人）
  launcher.json   选定的端口、安装 id、回传开关、当前版本
```

- **启动器**（托盘小程序）：第一次运行时挑两个空闲端口（web、supervisor）并写入 `launcher.json`；启动 web 和 worker；打开浏览器；提供开机自启和「退出」。替代 `start-crossline.ps1` 与 `install-startup.ps1`。
- **一台机器一个工作区**：测试者就是运行时的机主（`runtimeOwner`），所以 `AGENT_OWNER_ONLY` 的功能（shell 助手、记忆、联网、生图）都对他开放。
- **Codex**：用 Release 构建 `vendor/codex`，固定在 `codex-baseline.json` 记录的提交。`codex-code-mode-host.exe` 也从源码构建（需要 V8 预构建包），**不能**分发从 Codex 桌面应用里复制来的那个。附上 Apache-2.0 的 `LICENSE` 和 `NOTICE`。

## 登录（一次）

1. 第一次打开页面时，没有会话，进入「用 ChatGPT 登录」：走 app-server 的 `account/login/start`（`type: "chatgpt"`，浏览器回调到 Codex 自己的 localhost）。
2. 登录成功后，读 `account/read` 拿到邮箱，在 `auth.db` 建（或找到）这个用户，并签发会话。这个签发路由只接受 loopback 请求，而且要求 Codex 当前确实已登录这个账号。
3. 本机版关闭邮箱密码、验证码和 Google 登录（`resolveCrosslineAuthOptions` 不传 smtp 和 google）。
4. Codex 退出登录时，会话随之失效。

## 回传

### 元数据（自动，默认开，设置里可关）

每 15 分钟批量 `POST https://<worker>.workers.dev/v1/events`，带安装 id（随机 UUID）和账号邮箱的 SHA-256。

**只允许这些字段**，用白名单定义，新事件类型默认不传：

| 字段 | 例 |
|---|---|
| `type` | `work_order.transitioned`、`ask.answered`、`onboarding.round` |
| `at` | ISO 时间 |
| `page` | 路由模板，如 `/workbench/[id]`，不含真实 id |
| `stage` | 访谈阶段、工作单状态 |
| `skill`、`ms`、`repairs`、`stalls`、`ok`、`code` | 每次 Skill 运行的统计和报错码 |
| `tokens` | 输入、缓存、输出 |
| `counts` | 当天的捕获、任务、里程碑、计时、确认数 |
| `version` | 应用版本 |

**不传**：任何自由文本（访谈、任务和里程碑标题、文件、日历标题、窗口标题、对话）、文件名、URL、实体 id 原文（统一换成按安装加盐的哈希）。

### 脱敏快照（手动）

设置 → 「上传诊断快照」：基于 `exportSnapshot()` 生成。保留所有表的结构、状态、时间、时长和计数；每个自由文本字段替换为 `{len, sha256}`。上传前把待上传的内容给测试者过目，测试者可以附一段文字反馈，确认后才上传。

### 接收端

Worker 把数据写进 D1 的 `events`、`snapshots`、`installs` 三张表，并提供 `GET /dashboard`（放在 Cloudflare Access 后面）：
- 按安装列出：首次和最近一次活跃、访谈阶段漏斗、卡住最久的步骤、报错码排行、各 Skill 的修正率和耗时、token 用量。
- 写入接口按安装 id 限流，单次请求体有大小上限。

## 更新

启动器启动时读公开仓库的 `latest.json`（版本号、安装包 URL、SHA-256），发现新版就提示，确认后下载并静默安装。账本迁移本来就会先把旧库备份成 `<db>.v<N>.bak`（`#runMigrations`）；安装前启动器再多备份一份 `data\`。

## 已知限制（全功能下依然存在）

- **手机访问与推送**依赖机主的 tailnet 和 https 来源，本机版没有。测试者自己装 Tailscale 也可以，但不在首版范围内。
- **Outlook 日历**用机主的 Entra 应用 client id（公共客户端）。注册的「支持的账户类型」要包括个人账号，并设 `CROSSLINE_MS_TENANT_ID=common`，这一步要在门户里操作。另一条路是 ChatGPT 的日历连接器（`calendar-apps.ts`），按测试者自己的账号连接。
- **shell 助手**在测试者电脑上执行命令，默认关闭（设置 → 自动化与助手）。安装说明要写清楚。
- **ChatGPT 免费账号能否运行 Codex、额度是否够**：**未核实**。暂按需要 Plus 及以上告知测试者。

## 工作包与验收

| # | 工作 | 估时 | 验收 |
|---|---|---|---|
| 1 | Release 构建 `codex.exe` 与 `codex-code-mode-host.exe`，并跑 `codex-smoke` | 1–2 天 | 两个二进制在干净机器上通过 `scripts/codex-smoke.ts`，联网搜索可用 |
| 2 | 启动器与安装包（端口、目录、托盘、自启、卸载） | 3–4 天 | 在 Windows Sandbox 里从零安装，浏览器自动打开，重启后服务自动起来 |
| 3 | 一次登录（Codex 账号 → 本机会话） | 1–2 天 | 只出现一个 OpenAI 同意页；非 loopback 请求签发会话被拒绝；Codex 退出后会话失效 |
| 4 | 元数据回传、开关、Worker + D1、面板 | 3–4 天 | 发现式测试证明白名单外字段一个都不出机器（仿照 `activity-privacy.test.ts`）；面板显示漏斗 |
| 5 | 脱敏快照与预览 | 1–2 天 | 测试证明快照里没有任何原始自由文本 |
| 6 | 自动更新 | 1–2 天 | 低版本安装后提示更新，更新后数据完整，迁移有备份 |
| 7 | 全功能验收 | 2 天 | 从零安装 → 访谈 → 里程碑 → 排程 → 画像生图 → 一次助手任务 → Outlook 读取 → 回传可见 |

合计约 2.5–3 周。

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
  app\            node.exe、Crossline.exe（托盘）、apps\（web 的 .next-prod、worker、launcher 源码）、packages\、skills\、
                  node_modules\（hoisted）、codex\codex.exe、codex\codex-code-mode-host.exe、licenses\、release.json
  data\           crossline.db、auth.db、materials\、portrait\、logs\、launcher-secrets.json 等（即 CROSSLINE_DATA_DIR）
  state\          codex-home\（测试者本人的 Codex 登录与记忆）、auth\（Outlook 登录缓存）、runtimes\（即 CROSSLINE_STATE_DIR）
  backups\        更新前的 data\ 副本，保留最近 3 份
  updates\        下载并校验过的新版安装包
  launcher.json   选定的端口、安装 id、当前版本
```

`state\` 存在的原因：机主电脑上常驻网页版的 Codex 登录、Outlook 缓存和访客运行时就在 `%LOCALAPPDATA%\Crossline\codex-home`、`auth\`、`runtimes\`。安装版若用同一位置，两者会共用一个 Codex 登录。`CROSSLINE_STATE_DIR` 让 `codexProcessEnvironment` 和 `graphCacheConfiguration` 改用 `state\`；卸载时选择删除数据，也只删 `data\`、`state\`、`backups\` 和 `launcher.json`。

- **启动器**分两层。托盘 `installer/tray/Crossline.cs`（用系统自带的 .NET Framework `csc` 编译，单实例，托盘菜单「开机时启动」写 HKCU Run，把启动器放进 kill-on-close 作业对象，托盘一死，启动器、web、worker、Codex 全部随之结束）只管图标和菜单。启动器 `apps/launcher/src/main.ts` 跑在随附的 `node.exe` 上：建 `node_modules\@crossline\*` 目录联接（`links.ts`，安装包只复制文件，不复制链接）；在 47210–47299 中挑两个空闲端口，web 端口只要仍空闲就沿用（换端口等于换源，浏览器的 cookie、离线队列、PWA 都按源保存）。这一段整段被占时向系统要端口；机主电脑上 44000–47350 全部报 `EADDRINUSE` 却看不到监听者，就走了这条路。端口永远跳过 Fetch 标准的禁用端口表（`BLOCKED_PORTS`）：系统曾分到 4190（sieve），浏览器和 Node 的 fetch 都拒绝连接，页面打不开；首次运行生成 Better Auth 密钥、supervisor capability 密钥和回传盐，存 `data\launcher-secrets.json`；以退避重启守护 web 与 worker（`supervise.ts`）。托盘与启动器之间用行协议：托盘写 stdin（`open`、`check-update`、`install-update`、`quit`），启动器每行输出一个 JSON 事件（`starting`、`ready`、`open`、`update-available`、`update-none`、`update-ready`、`update-failed`、`error`）。stdin 关闭即退出。替代 `start-crossline.ps1` 与 `install-startup.ps1`。
- 启动器给子进程设 `CROSSLINE_INSTALL_MODE=local`，并删掉开发者 shell 里可能带进来的 SMTP、Google、SIWC、测试邮箱、`CROSSLINE_FIXED_NOW`、示例数据等变量：安装版只能用 Codex 登录。
- **一台机器一个工作区**：测试者就是运行时的机主（`runtimeOwner`），所以 `AGENT_OWNER_ONLY` 的功能（shell 助手、记忆、联网、生图）都对他开放。
- **Codex**：用 Release 构建 `vendor/codex`，固定在 `codex-baseline.json` 记录的提交。`codex-code-mode-host.exe` 也从源码构建（需要 V8 预构建包），**不能**分发从 Codex 桌面应用里复制来的那个。附上 Apache-2.0 的 `LICENSE` 和 `NOTICE`。

## 登录（一次）

1. 第一次打开页面时，没有会话，进入「用 ChatGPT 登录」：走 app-server 的 `account/login/start`（`type: "chatgpt"`，浏览器回调到 Codex 自己的 localhost）。
2. 登录成功后，读 `account/read` 拿到邮箱，在 `auth.db` 建（或找到）这个用户，并签发会话。这个签发路由只接受 loopback 请求，而且要求 Codex 当前确实已登录这个账号。
3. 本机版关闭邮箱密码、验证码和 Google 登录（`resolveCrosslineAuthOptions` 不传 smtp 和 google）。
4. Codex 退出登录时，会话随之失效。

实现：插件 `packages/auth/src/codex-local.ts` 提供 `POST /api/auth/codex-local/session`，只接受直连 loopback 的请求：Host 与 Origin 都必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`；不能有 `Forwarded`；`x-forwarded-for` 只能是一个回环地址，`x-forwarded-host` 只能等于 Host。不能简单地「有转发头就拒」：Next.js 会给每个没有这些头的请求补上 socket 对端和 Host（`base-server.js` 的 `??=`），第一版这样写，结果把所有真实登录都拒了。再用 `handleOAuthUserInfo` 以 `providerId: "codex"` 建或找用户。登录前没有会话，也就没有 AccessContext 可以签 capability，所以 `apps/web/lib/local-install.ts` 只为三个操作（读账号、开始登录、取消登录）给空 workspace 签引导 capability，supervisor 把空 workspace 当机主运行时处理。`requireAccessContext` 收到 `localAccount` 时每次请求都核对（web 端缓存 10 秒）：Codex 返回 null（已退出）或换了邮箱，就删掉该用户的全部会话；Codex 暂时问不到（启动中、重启中）不登出。

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

实现：白名单是 `packages/core/src/telemetry.ts` 的 `sanitizeTelemetryBatch`，发送前对整批再过一次；发送器 `apps/worker/src/telemetry.ts` 用三个游标（事件 rowid、`model_usage` id、访谈回复时间）读 `CrosslineStore.telemetrySince`，collector 接受后才前移游标。页面访问由 `app/page-beacon.tsx` → `POST /api/telemetry/page` 记成路由模板，写入 `data\telemetry\pages.jsonl` 等发送器取走。开关是设置 → 隐私与屏幕活动 → 「使用记录回传」（`telemetry.enabled`，只在本机版显示）；关闭期间游标照常前移，重新打开后不补发关闭期间的记录。`apps/web/lib/telemetry-privacy.test.ts` 是发现式测试：collector 地址只出现在启动器和两个发送器里；发送器只 POST 白名单出来的那一批；页面列表等于全部 `page.tsx`；往每个字段灌自由文本，出来的只剩白名单字段。

### 脱敏快照（手动）

设置 → 「使用记录回传」 → 「生成快照并预览」：基于 `exportSnapshot()` 生成。保留所有表的结构、状态、时间、时长和计数；按列决定保留什么：数字、布尔、null 原样；时间列里的时间原样；少数代码列（state、type、kind 等）里形如代码的值原样；id 列换成按安装加盐的 HMAC（与回传事件的 `entity` 同一个盐，所以快照的行能和事件对上）；其余字符串一律换成 `{len, h}`，`h` 是 HMAC-SHA256 的前 16 位十六进制。不用裸 sha256，是因为「是」这样的短文本能被猜回来。预览按 id 在内存里保存 30 分钟，上传的就是测试者看过的那个对象，gzip 后不超过 1.9 MB。测试者可以附一段文字说明（最多 4000 字），这是唯一离开机器的自由文本，而且是专门为此写的。实现：`apps/web/lib/diagnostic-snapshot.ts`、`GET/POST /api/diagnostic-snapshot`、`app/settings/telemetry-card.tsx`；`diagnostic-snapshot.test.ts` 从真实 schema 读出每张表的每一列，全部填上自由文本，证明输出里一个字都没有。

### 接收端

`apps/collector`（Cloudflare Worker + D1，`schema.sql`、`wrangler.toml`）：
- `POST /v1/events`：请求体 ≤ 512 KB；入库前用同一个 `sanitizeTelemetryBatch` 再过一遍，被篡改的客户端也存不进白名单以外的东西。
- `POST /v1/snapshots`：gzip 请求体 ≤ 2 MB，解压后 ≤ 64 MB，头里的安装 id 必须与内容一致，原样存为 BLOB。
- 限流按安装 id：每小时 30 次请求，每天 5 份快照。安装 id 是随机的、安装包是公开的，谁都能 POST；限流约束的是单个 id 的开销，收到的东西只有机主能看。
- `GET /dashboard`、`GET /dashboard/snapshots/<id>`：Cloudflare Access 之外，Worker 自己再校验 `Cf-Access-Jwt-Assertion`（团队公钥签名、aud、iss、exp）；`ACCESS_TEAM_DOMAIN` 或 `ACCESS_AUD` 没配好时返回 503，面板永远不会裸露。内容：安装列表（首次、最近、版本、账号哈希前缀）、漏斗（安装 → 访谈六阶段 → 首次收集 → 首个里程碑 → 首次计时 → 画像 → 首次助手任务 → 首次验收）、停留最久的工作单状态、报错码排行、各 Skill 的次数、失败率、修正率、耗时和 token、页面打开次数、诊断快照列表与下载。

### 机主要做的 Cloudflare 操作

1. 注册或登录 Cloudflare，在 `apps/collector` 下运行 `pnpm dlx wrangler login`。
2. `pnpm dlx wrangler d1 create crossline-collector`，把输出的 `database_id` 填进 `wrangler.toml`。
3. `pnpm dlx wrangler d1 execute crossline-collector --remote --file=schema.sql`。
4. `pnpm dlx wrangler deploy`，记下 `https://crossline-collector.<子域>.workers.dev`，打包时传给 `--telemetry-url`。
5. Zero Trust → Access → Applications → Add an application → Self-hosted：域名填上一步的 workers.dev 地址，路径 `dashboard*`；策略只允许机主本人的邮箱。保存后，把应用的 Audience (AUD) tag 填进 `ACCESS_AUD`，团队域名（`https://<团队>.cloudflareaccess.com`）填进 `ACCESS_TEAM_DOMAIN`，再 `pnpm dlx wrangler deploy` 一次。
6. 打开 `https://…workers.dev/dashboard`，应先出现 Access 登录页。

## 更新

启动器启动时读公开仓库的 `latest.json`（版本号、安装包 URL、SHA-256），发现新版就提示，确认后下载并静默安装。账本迁移本来就会先把旧库备份成 `<db>.v<N>.bak`（`#runMigrations`）；安装前启动器再多备份一份 `data\`。

实现（`apps/launcher/src/update.ts`）：启动 1 分钟后检查一次，之后每 6 小时一次；托盘菜单「检查更新」随时检查。清单只接受 https 的 GitHub 下载地址（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`），每一跳重定向都手动跟随并检查主机；下载后大小和 SHA-256 都必须与清单一致，才写进 `updates\`。随后启动器停掉 web 和 worker，把 `data\`（不含 `logs\`）复制到 `backups\before-<时间>-v<旧版本>\`，只保留最近 3 份，再通知托盘；托盘退出后以 `/VERYSILENT` 运行安装包，安装包结束时启动新托盘。`release.json` 的 `updateFeed` 由打包脚本的 `--update-feed` 写入。

## 已知限制（全功能下依然存在）

- **手机访问与推送**依赖机主的 tailnet 和 https 来源，本机版没有。测试者自己装 Tailscale 也可以，但不在首版范围内。
- **Outlook 日历**用机主的 Entra 应用 client id（公共客户端）。注册的「支持的账户类型」要包括个人账号，并设 `CROSSLINE_MS_TENANT_ID=common`，这一步要在门户里操作。另一条路是 ChatGPT 的日历连接器（`calendar-apps.ts`），按测试者自己的账号连接。
- **shell 助手**在测试者电脑上执行命令，默认关闭（设置 → 自动化与助手）。安装说明要写清楚。
- **ChatGPT 免费账号能否运行 Codex、额度是否够**：**未核实**。暂按需要 Plus 及以上告知测试者。

## 工作包与验收

| # | 工作 | 估时 | 验收 |
|---|---|---|---|
| 1 | Release 构建 `codex.exe` 与 `codex-code-mode-host.exe`，并跑 `codex-smoke` | 1–2 天 | 两个二进制在干净机器上通过 `scripts/codex-smoke.ts`，联网搜索可用 |
| 2 | 启动器与安装包（端口、目录、托盘、自启、卸载） | 3–4 天 | 在本机从零安装（打包时检查原生依赖），浏览器自动打开，开启自启后重启电脑，服务自动起来 |
| 3 | 一次登录（Codex 账号 → 本机会话） | 1–2 天 | 只出现一个 OpenAI 同意页；非 loopback 请求签发会话被拒绝；Codex 退出后会话失效 |
| 4 | 元数据回传、开关、Worker + D1、面板 | 3–4 天 | 发现式测试证明白名单外字段一个都不出机器（仿照 `activity-privacy.test.ts`）；面板显示漏斗 |
| 5 | 脱敏快照与预览 | 1–2 天 | 测试证明快照里没有任何原始自由文本 |
| 6 | 自动更新 | 1–2 天 | 低版本安装后提示更新，更新后数据完整，迁移有备份 |
| 7 | 全功能验收 | 2 天 | 从零安装 → 访谈 → 里程碑 → 排程 → 画像生图 → 一次助手任务 → Outlook 读取 → 回传可见 |

合计约 2.5–3 周。

验收环境：机主的电脑是 Windows 11 家庭版，没有 Windows Sandbox。2026-10-14 试过 VirtualBox 7.2.20 + Windows 11 评估版：本机开着内存完整性（VBS），VirtualBox 只能跑在 Hyper-V 后端上，4 核时 Windows 安装程序蓝屏（`IRQL_NOT_LESS_OR_EQUAL`），2 核时卡死。机主决定删掉虚拟机，改在本机安装验收。

干净机器原本要证明的是「安装包不靠开发机上现成的东西」，现在由打包脚本自己检查：它用 Visual Studio 的 `dumpbin` 扫安装包里每个 x64 的 `.exe`、`.dll`、`.node`，凡是依赖 VC++ 运行库（`msvcp140*`、`vcruntime140*` 等）的，都把 DLL 从 VS 的 Redist 目录复制到它旁边（微软允许随应用分发），缺一个就让打包失败。扫描结果：`codex.exe`、better-sqlite3、keytar 只用系统自带的库；只有录音转写用的 onnxruntime 需要 VC++ 运行库，现在随包带了 5 个 DLL。`api-ms-win-crt-*` 是 Windows 10 起自带的 UCRT。测试者环境里可能有、也可能没有的两个变量，启动器直接设给子进程：`NODE_USE_SYSTEM_CA=1`（公司代理或 TLS 检查的证书在 Windows 证书库里），`NO_PROXY` 补上 `localhost,127.0.0.1,::1`（保留原值），保证本机内部调用不走代理。

**开机自启由用户在应用里决定，默认关闭**（机主 2026-10-14）：安装包不再提供自启选项，也不写 Run 项。设置 → 通用 → 「开机自启」（只在安装版显示，`apps/web/lib/autostart.ts`、`POST /api/settings/autostart`）用 `reg.exe` 在 `HKCUSoftwareMicrosoftWindowsCurrentVersionRun` 写入或删除 `Crossline`（启动器通过 `CROSSLINE_APP_DIR` 告诉 web 托盘程序在哪里）；托盘菜单写的是同一个值，所以两边总是一致。卸载时删除这个值（`.iss` 里 `ValueType: none` + `uninsdeletevalue`）。

## Codex 的 Release 构建

denoland 不发布 `ptrcomp_sandbox` 版的 V8 预构建包；上游在 openai/codex 的 `rusty-v8-v150.4.0` release 里自己发布，清单哈希固定在 `vendor/codex/third_party/v8/rusty_v8_150_4_0_release_manifests.sha256`。`scripts/fetch-rusty-v8.ts` 照上游 action 下载并校验，产物在 `vendor/codex/codex-rs/target/rusty_v8/`。然后：

```powershell
$env:RUSTY_V8_ARCHIVE = "<repo>\vendor\codex\codex-rs\target\rusty_v8\rusty_v8_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.lib.gz"
$env:RUSTY_V8_SRC_BINDING_PATH = "<repo>\vendor\codex\codex-rs\target\rusty_v8\src_binding_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.rs"
cargo build --release --locked -p codex-cli --bin codex -p codex-code-mode-host --bin codex-code-mode-host
```

codex-cli 的 thin-LTO 链接在这台机器上要三个多小时。Inno Setup 6 用 `winget install --id JRSoftware.InnoSetup --scope user` 装；它不带简体中文语言文件，`installer/ChineseSimplified.isl` 取自官方仓库 jrsoftware/issrc 的 `is-6_7_3` 标签（`Files/Languages/Unofficial/`）。构建出的 `codex.exe` 的 SHA-256 写进 `packages/codex/src/index.ts` 的 `CODEX_RELEASE_BINARY_SHA256` 和 `codex-baseline.json`；`scripts/package-installer.ts` 打包前核对它。

## 实施状态（2026-10-13）

| # | 状态 |
|---|---|
| 1 | **通过**。两个二进制已构建（17:40），哈希记在 `CODEX_RELEASE_BINARY_SHA256` 与 `codex-baseline.json` 的 `release`；复制到空文件夹、PATH 不含 cargo 与 codex、LOCALAPPDATA 和 `CROSSLINE_STATE_DIR` 指向临时目录时 `codex-smoke` 通过（插件安装、32 个 Skill、只读线程）；临时线程上的 `web_search: live` 完成两次 `webSearch` 并返回 nodejs.org 的结果 |
| 2 | 安装包已生成（`dist/installer/Crossline-Setup-0.1.0.exe`，336 MB）。**本机共存实测通过**（`scripts/installer-coexist-check.ts`，20 项）：打包出的 stage 由自己的启动器在临时根目录下运行，5 秒就绪，端口和数据、`statecodex-home` 都是自己的，Codex 运行时 ready 且 verified；常驻网页版在启动前、运行中、退出后都正常应答，supervisor 的 bootId 不变，常驻版 `codex-homeauth.json` 的修改时间不变；退出后端口释放。还没做：虚拟机里从零安装、重启后自动起来、托盘与卸载 |
| 3 | 实测：没有会话时页面跳到登录页，登录页只有 Codex 登录；Codex 未登录时签发返回 409；换主机名、带外部 `x-forwarded-for`、跨站 Origin 都返回 403；在回环地址上发起登录得到 `auth.openai.com` 的授权地址，可以取消。还没做：真人走完一次 OpenAI 同意页、Codex 退出后会话失效（要测试者账号） |
| 4 | 白名单、发送器、页面记录、设置开关、collector 已写；发送器、隐私、collector 测试通过（collector 用 `node:sqlite` 跑真实 schema，篡改批次、限流、快照、Access JWT、面板转义）。还没做：机主的 Cloudflare 部署、面板显示真实漏斗 |
| 5 | 快照库、路由、设置页卡片已写；快照测试通过 |
| 6 | 更新检查、校验下载、数据备份已写，测试通过。还没做：公开 releases 仓库、低版本装好后实际升级一次 |
| 7 | 未开始 |

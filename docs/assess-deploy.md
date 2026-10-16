# 公开测评：服务端、构建与部署（P-L1）

`apps/assess` 是独立于私有 App 的公开测评。方案和取舍见 [beta-launch.md](beta-launch.md)（§0、§1、§1.1、§3–§6、§9）。本文说明服务端做什么、数据怎么存、怎么构建成容器、怎么部署到一台香港或东京的 Linux 云主机。**目前尚未部署。**

它和私有 App 没有任何连接：自己的 SQLite 文件、自己的形象图片，不读写账本，不使用本人的模型额度以外的任何账号（形象生成的额度见 W5）。私有 App 的 `external` 部署禁令（`apps/web/next.config.mjs`）不受影响，这里部署的是另一个应用。

## 它做什么

1. 访客答完 32 题、选好外貌，填邮箱（「把结果链接发到我的邮箱」默认勾选），可选填昵称。
2. `POST /api/results` 在服务器上**重新计分**（`quizScores`，不信任浏览器算的分），保存结果，生成两个令牌，开始生成形象，按勾选发结果邮件。
3. 本人从邮件或结果页回到 `/r/<结果令牌>`；别人只会拿到 `/t/<邀请令牌>`（海报二维码、转发链接）。
4. 被邀请的人从 `/t/<邀请令牌>` 做题提交，双人卡当场生成（`/p/<双人卡令牌>`），发起人收到邮件通知。
5. 结果页的「申请内测」记下申请（`beta_requests`），机主用 `pnpm --filter @crossline/assess exec tsx scripts/beta-requests.ts` 看名单；页面上同时给出机主邮箱（mailto，主题「Crossline 内测申请」，正文带类型代码）。
6. 加入内测的人用同一个邮箱登录 App 后，App 通过 `POST /api/link` 取回这份结果（见下文「与 App 的结果连接」）。

| 路由 | 用途 | 令牌 |
|---|---|---|
| `POST /api/results` | 提交答案、外貌、邮箱；带 `inviteToken` 时当场配对 | — |
| `GET /api/results/<resultToken>` | 本人的结果（`ResultView`） | 结果令牌，只在本人的邮件和页面里出现 |
| `DELETE /api/results/<resultToken>` | 删除结果、两边的双人卡和形象文件 | 结果令牌 |
| `GET /api/invites/<inviteToken>` | 邀请落地页（`InviteView`） | 邀请令牌 |
| `GET /api/pairs/<pairToken>` | 双人卡（`PairView`） | 双人卡令牌 |
| `POST /api/results/<resultToken>/beta` | 申请内测 | 结果令牌 |
| `GET /api/avatar/<inviteToken>.png[?size=small]` | 形象；`size=small` 为 360 宽（邀请页、双人卡页用），模板缩图缓存在 `data/thumbs/` | 邀请令牌 |
| `POST /api/link` | App 取某邮箱最近一份结果；只在设了 `ASSESS_LINK_SECRET` 时存在 | `Authorization: Bearer <ASSESS_LINK_SECRET>` |

接口形状在 `apps/assess/lib/contract.ts`。所有公开视图都只由四轴得分算出（`lib/public-type.ts`），**任何视图都不含邮箱、答案或外貌**；邀请页和双人卡里也不出现结果令牌。

### 提交的规则

- 拒绝顺序：跨站 `Origin`（`REJECTED`）→ 每个 IP 每小时 120 次（`RATE_LIMITED`；国内移动网络和宿舍大量共用出口 IP，挡脚本靠每邮箱每天 5 次、40 秒下限和蜜罐，带 `Retry-After`）→ 蜜罐字段 `website` 非空（`REJECTED`）→ `startedAt` 不是数字（`REJECTED`）→ 32 题有缺或不在 1–5（`QUIZ_INCOMPLETE`）→ 外貌不在枚举里、多了字段或备注去掉不可见字符后超过 40 字（`APPEARANCE_INVALID`）→ 邮箱格式或长度（≤254）不对（`EMAIL_INVALID`）→ 署名超过 12 字（`NICKNAME_INVALID`）→ 距 `startedAt` 不到 40 秒（`TOO_FAST`）→ 邀请令牌无效或已过期（`INVITE_NOT_FOUND`，页面可去掉邀请重新提交，答案不丢）→ 用发起人自己的邮箱回答自己的邀请（`ALREADY_PAIRED`，409）→ 同一邮箱每天 5 次（`RATE_LIMITED`）→ 同一邮箱已测满 3 次（`EMAIL_LIMIT_REACHED`，409；服务器把最新一份结果的链接重新发到这个邮箱，回答里不带任何令牌，因为填邮箱的人不一定是邮箱主人）。
- 署名和外貌备注会去掉控制字符、零宽字符、双向控制符等不可见字符；只由这些字符组成的署名按空处理（页面显示「你的朋友」）。
- **答案不保存**：只存四轴得分和类型代码，比 §6 列的「只收必要数据」更少一步。
- 形象：创建结果后调用 `enqueueAvatar`，包在 try/catch 里——形象出错不影响提交（见「形象生成」）。
- **一个邮箱最多测 3 次，只保留最新一次**（2026-10-15 本人定）：每次提交成功后，删除这个邮箱之前的全部结果，规则和「删除我的结果」相同（结果、两边的双人卡、形象文件、海报缓存一起删，旧的邀请链接失效）。次数记在 `email_tests`，只存邮箱的 HMAC（与 `avatar_draws` 同一把 `draw-key`），删除结果不归还次数，记录 90 天后清除。迁移 4 之前留下的结果没有计数。
- **同一邀请、同一邮箱再答一次**：按上一条替换掉第一次的结果和双人卡，发起人只在第一次收到通知。
- 发起人关掉了邮件勾选时，不发配对通知；双人卡仍会出现在他的结果页（最多 20 张，新的在前）。

## 数据与保存期限

- 文件：`<ASSESS_DATA_DIR>/assess.db`（better-sqlite3，WAL），形象图片由 W5 写在同一目录下（`avatars/…`，路径相对 `ASSESS_DATA_DIR`）。
- 表：`results`（`id`、两个令牌、小写邮箱、署名、`scores_json`、`code`、`appearance_json`、`send_email`、`avatar_state`、`avatar_file`、`created_at`、`expires_at` = 创建后 90 天）；`pairs`（`id`、`pair_token`、`inviter_id`、`invitee_id`、`created_at`，两个外键 `ON DELETE CASCADE`）。
- 迁移按 `PRAGMA user_version` 编号，每个迁移和它写的版本号在**同一个事务**里，崩溃不会留下半迁移的文件（和私有 App 的账本同一规则）。
- 令牌：`crypto.randomBytes(16)` 的 base64url，128 位，22 个字符。
- 过期：所有读取都把过了 `expires_at` 的结果当作不存在；服务启动时和之后每小时删一次过期结果（`instrumentation.ts` → `server/purge.ts`），连同两边的双人卡和形象文件。
- 删除：邮件里的「删除我的结果」链接打开 `/r/<结果令牌>?delete=1`，页面确认后调用 `DELETE`；结果、两边的双人卡、形象文件和为它们画过的海报缓存（`posters/` 里以邀请令牌或双人卡令牌开头的文件）一起删除，所有链接立即失效。同一邮箱的新结果替换旧结果、到期清理，都走同一个删除函数。「每个邮箱 3 次形象」记在 `avatar_draws`：只存邮箱的 HMAC（密钥 `<ASSESS_DATA_DIR>/draw-key`，本机生成，不存邮箱本身），删除结果不归还次数，记录 90 天后清除，所以删了重测不能多画。
- `email_tests`（迁移 4）：`result_id`、邮箱的 HMAC、时间；用来数「一个邮箱测了几次」。
- `beta_requests`（迁移 3）：只存 `result_id` 和申请时间，外键 `ON DELETE CASCADE`，随结果删除或过期；90 天内没发邀请的人会从名单上消失。
- 估算排位用的「全部已记录得分」每分钟最多读一次（`recordedScores`）。排位超过 95% 时显示 91–96 之间的一个数，由结果 id 和轴的哈希决定（`shownRank`，`packages/core/src/assess-content.ts`）：同一份结果在页面、海报、长图、双人卡上永远一样，不同的人不会都晒出同一个 99；满 200 人改用真实分布后同样封顶。

## 与 App 的结果连接

加入内测的人用同一个邮箱登录 Crossline App 后，App 在服务器之间取回这份速测结果，作为访谈的上下文。契约在 `packages/core/src/assess-link.ts`（经 `@crossline/core/assess` 导出）：

- 请求：`POST <ASSESS_BASE_URL>/api/link`，头 `Authorization: Bearer <ASSESS_LINK_SECRET>`，正文 `{"email": "…"}`。
- 回答 `AssessLinkResponse`：`{found:false}`，或 `{found:true, code, typeName, group, axes:{scope,basis,output,rhythm}, takenAt, resultUrl?, figureUrl?}`。`group` 是组别代码（`SE`/`SI`/`GE`/`GI`）；`resultUrl` 是本人的结果页，`figureUrl` 是形象缩略图（`/api/avatar/<邀请令牌>.png?size=small`，360 宽），两者都是绝对地址，只在设了 `ASSESS_BASE_URL` 时给出。不返回外貌、署名、答案，也不涉及任何其他人。App 用 `parseAssessLinkResponse` 校验后再用。
- 查的是该邮箱**最近一份未过期**的结果；因为同一邮箱只保留最新一次，这也是它唯一的一份。删除或过期后永远是 `{found:false}`。
- App 只能用本人验证过的邮箱来查：回答属于邮箱的主人，`resultUrl` 还能删除这份结果。
- **`ASSESS_LINK_SECRET`**：两台服务器共享的一串随机密钥，用来证明请求来自 App。生成：`openssl rand -base64 32`；在测评的 `assess.env` 和 App 的环境里各设一次同样的值。没设时 `/api/link` 返回 404，等于没有这个接口。密钥按 SHA-256 后常量时间比较。错误密钥 401；每个 IP 每分钟 60 次（错误密钥也计数），超出 429。换密钥：两边同时改、重启。

## 安全

依据 W3C TAG《Good Practices for Capability URLs》[^cap]：

- 令牌至少 120 位随机数（这里 128 位），全程 HTTPS（Caddy 自动签证书）。
- 所有页面 `Referrer-Policy: no-referrer`；`/r`、`/t`、`/p`、`/api` 加 `X-Robots-Tag: noindex, nofollow, noarchive`；不加载任何第三方脚本，CSP 只允许本站（`default-src 'self'`，图片另允许 `data:`、`blob:`；Next 注入的内联启动脚本需要 `'unsafe-inline'`）；`frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`。
- 结果、邀请和双人卡各用各的令牌；能给别人看的只用邀请令牌和双人卡令牌。
- GET 没有副作用；删除只走 `DELETE`，并检查 `Origin`。过期和删除后的链接返回 404。
- 令牌查找没命中计入该 IP 的次数（10 分钟 30 次），超过就返回 429，拖慢穷举。
- 所有 API 回答都带 `Cache-Control: no-store`。

**客户端 IP 与限频。** 限频按 `X-Forwarded-For` 的**最右一项**取 IP。Caddy 默认不信任客户端自带的 `X-Forwarded-*`（防伪造），只写入它实际看到的地址[^caddy]；Next 只在请求没有这个头时才用 socket 地址补上。所以：

- 容器端口**只绑定到 `127.0.0.1`**，公网只能经 Caddy 进来；如果端口直接暴露，客户端就能自己填这一项。
- 前面再加 CDN 时，要在 Caddy 的 `servers > trusted_proxies` 里列出 CDN 的网段，否则所有人都会被当成 CDN 的几个 IP 一起限频。
- 限频计数在内存里：一台主机一个进程，重启清零可以接受。以后要多实例，再换成共享存储。

## 邮件

只发两种：本人的结果邮件（类型名和副标题、结果链接、邀请链接、删除链接、90 天说明），和发起人的配对通知（双人卡链接、本人结果链接、删除链接）。纯文本 + 简单 HTML，中文。没有营销邮件。

- 发信走 SMTP（nodemailer）。端口 465 用隐式 TLS，其他端口（587、80、25）强制 STARTTLS（`requireTLS`），不明文传输。
- 发送在回答之后进行，失败只记日志（只记结果 id，不记邮箱），不影响请求；没有配置 SMTP 时记一条 `assess.mail_skipped` 并跳过。

**选哪家（收件人主要是 QQ 和 163 邮箱）：**

| | 阿里云邮件推送（DirectMail） | Resend |
|---|---|---|
| SMTP | `smtpdm.aliyun.com`（华东 1 杭州），新加坡为 `smtpdm-ap-southeast-1.aliyuncs.com`；端口 80、465（SSL），25 和 80 也可 STARTTLS[^aliyun] | `smtp.resend.com`，465，用户名 `resend`，密码是 API key |
| 到 QQ/163 | 国内服务，通常更稳；官方文档有 163 的 SPF 退信排查[^aliyun-spf] | 海外发信，QQ 邮箱的投递受网络过滤影响，补救空间有限[^qq] |
| 门槛 | 需要阿里云账号（实名，开通前核实）、在控制台验证发信域名 | 注册即可，验证域名后自动写 SPF/DKIM |

**建议**：内测阶段用阿里云邮件推送（杭州区域）作为主通道；如果收件人多在海外，再加 Resend。因为只认 SMTP 环境变量，换服务商只需改环境变量、重启容器。

**域名与预热：**
- 用一个专门的发信子域名（如 `mail.<域名>`），配齐 SPF、DKIM、DMARC（先 `p=none` 观察）；QQ 邮箱对 DMARC 不通过的邮件会直接拒收[^qq]。
- 新域名从小量开始：Resend 给出的新域名计划是第 1 天 150 封、第 2 天 250、第 3 天 400、第 4 天 700、第 5 天 1000、第 6 天 1500、第 7 天 2000，退信率保持在 4% 以下、投诉率 0.08% 以下，超了就放慢[^resend]。阿里云没有公开的预热表，按控制台的额度逐步提高。小范围邀请内测的量远低于这些数字，正常发送就是预热。
- 上线前用真实的 QQ、163 账号各收一封，看邮件头里的 SPF/DKIM/DMARC 结果和是否进了垃圾箱。

## 形象生成

结果创建时开始画（`server/avatar/`）：以类型模板为底图、按外貌选项改，队列同时 2 张，等待超过 40 张的直接用兜底；每个邮箱 3 张（`avatar_draws`），每天总数 `ASSESS_IMAGE_DAILY_LIMIT`（默认 300，重试也占名额）；一次调用（含下载）最多 120 秒，限流或过载重试一次。

| 变量 | 说明 |
|---|---|
| `ASSESS_IMAGE_API_KEY` | 画图服务的 key；不设则不画，所有人用兜底 |
| `ASSESS_IMAGE_PROVIDER` | `ark`（火山方舟 Seedream）或 `siliconflow`；**不设按 `siliconflow`**，写成别的名字则不画。用方舟的 key 时必须设 `ark`，否则 key 被发到硅基流动，每次 401 |
| `ASSESS_IMAGE_MODEL` | 模型名；方舟默认 `doubao-seedream-4-0-250828`，硅基流动默认 Kontext [dev] |
| `ASSESS_IMAGE_BASE_URL` | 可选，只接受 https |
| `ASSESS_IMAGE_DAILY_LIMIT` | 可选，每天最多调用几次 |

服务器日志里的事件（`docker logs assess`，每行一个 JSON）：

- `avatar.provider`：进程第一次用到画图时打印一次，写明选中的服务和模型，或者为什么没有（没设 key、`ASSESS_IMAGE_PROVIDER` 写错、没设时提醒默认是硅基流动）。**看不到形象时先看这一行。**
- `avatar.skipped`：没画就用了兜底，`reason` 是 `no_provider` / `email_limit`（这个邮箱 90 天内已画满 3 张，反复自测最容易碰到）/ `daily_budget` / `queue_full`。
- `avatar.failed`：调用失败，带 HTTP 状态和服务返回的前 200 字（401 多半是 key 和服务对不上）；画出来的是 WebP 也算失败（`IMAGE_FORMAT_UNSUPPORTED`），因为海报只认 PNG 和 JPEG。
- `avatar.ready`：画好，带用时和重试次数。2026-10-16 实测方舟 `doubao-seedream-5-0-pro` 一张 1024×1536 约 39 秒。

页面怎么换上形象：结果页和双人卡页在形象「排队 / 正在画」时每 5 秒问一次，某次请求失败只跳过这一次（以前失败一次就停）；海报、长图、双人卡的地址带 `?f=<形象标记>`（等待 `w`、兜底 `t`、画好 `d<文件时间>`），形象一变地址就变，浏览器不会继续用缓存的旧海报（以前刷新页面会在 5 分钟内看到旧海报）。

## 构建

`apps/assess/next.config.mjs`：
- `output: "standalone"`，`outputFileTracingRoot` 指向仓库根目录，这样 `@crossline/core` 和根目录 `node_modules/.pnpm` 里的依赖都会被追踪进包[^next-output]；
- `serverExternalPackages: ["better-sqlite3", "@resvg/resvg-js"]`：原生模块在运行时 `require`，不打包（better-sqlite3 本就在 Next 的默认外部列表里[^next-external]）；
- `outputFileTracingIncludes` 把运行时从磁盘读的 `templates/**/*.png`（W5 的类型模板）和 `fonts/**/*`（W3 的海报字体）加进包——它们不是 import，追踪器看不到；
- 安全头和 `noindex` 见上。

本地：

```powershell
pnpm --filter @crossline/assess dev      # http://127.0.0.1:3340
pnpm --filter @crossline/assess build    # 生成 apps/assess/.next/standalone
pnpm --filter @crossline/assess typecheck
pnpm vitest run apps/assess
```

**容器**（`apps/assess/Dockerfile`，在仓库根目录构建）：

```bash
docker build -f apps/assess/Dockerfile -t crossline-assess .
```

- 两个阶段都用 `node:22-bookworm-slim`（glibc），所以构建阶段装上的原生模块（better-sqlite3 自带的 `linux-x64` 预编译文件、`@resvg/resvg-js-linux-x64-gnu`）就是运行阶段能加载的。不要一个阶段用 Alpine、另一个用 Debian。
- 构建阶段装 `python3 make g++`：better-sqlite3 的安装步骤会调用 node-gyp，即使找到预编译文件、什么都不编译，也需要 Python 和 make。
- `pnpm install --frozen-lockfile --filter "@crossline/assess..." --filter crossline`：只装这个应用、`@crossline/core` 和根目录（`next build` 用根目录的 TypeScript 做类型检查），不装私有 App 的依赖。
- 构建后把 `.next/static`、`public`、`templates`、`fonts` 复制到 standalone 目录里服务器旁边（standalone 默认不带静态文件[^next-output]）。
- 运行阶段：只含 standalone 目录，代码归 root 所有，进程以 `node` 用户运行，只有 `/data` 可写；`ASSESS_DATA_DIR=/data`，`HOSTNAME=0.0.0.0`、`PORT=3340`，带健康检查。
- 构建上下文的排除表是 `apps/assess/Dockerfile.dockerignore`（BuildKit 会读和 Dockerfile 同名、同目录的忽略文件[^docker-ignore]）：不带 `node_modules`、`.next`、`data`、数据库、`.env*`、`.git`、`vendor` 等。
- 2026-10-14 在本机 Docker（29.4.3）上实际构建并运行了镜像（约 439 MB）：提交、读取、自己的邀请被拒、配对、太快与蜜罐被拒、三张海报和形象图、删除后全部 404，进程以 `node` 用户运行，`/data` 里是 WAL 方式的 `assess.db`。第一次构建时三张海报都是 500：satori 运行时从模块旁读取的 `yoga.wasm` 和 harfbuzzjs 的 `hb.wasm` 没被追踪进 standalone；在仓库里直接跑 standalone 会悄悄回退到根目录的 `node_modules`，所以只有容器能暴露这类问题。`next.config.mjs` 的 `outputFileTracingIncludes` 现在带上这两个文件。**每次改依赖或配置后，部署前先在本机构建镜像跑一遍上面的流程**，不要只跑仓库里的 standalone。

## 买主机与域名（2026-10-15，按性价比）

**主机。** 首选阿里云或腾讯云的「轻量应用服务器」，地域选**中国香港**。理由：
- 价格最低。第三方整理的价格是香港约 ¥25–72/月，按带宽和流量档位定，下单前以购买页为准；
- 到大陆的线路通常好于东京；
- 用国内账号实名即可付款。

需要外币付款、或主要用户在海外时，选 Vultr 东京（2 GB 约 $12/月，同样以官网为准）。

配置：
- 2 核 2 GB，Debian 12 或 Ubuntu 24.04；
- 流量 ≥1 TB/月。海报是服务器渲染的 PNG，一张约 1 MB，一千人做题约用掉十几 GB；
- 防火墙只开 22、80、443；
- 登录方式选 SSH 密钥，不用密码。

**域名。**
- 买 `.com`。Cloudflare Registrar 按批发价卖，约 $10.44/年，续费同价；它不开放新注册时，就在 Porkbun 买，再把 NS 改到 Cloudflare。
- 内测阶段本人决定（2026-10-15）可以先用廉价后缀（`.xyz` 等），在海外注册商买，免实名、即时生效。代价是：这类后缀常被垃圾邮件和钓鱼使用，邮件更容易进垃圾箱或被 QQ 邮箱拒收，链接也更容易被拦截。公开宣推前换成 `.com`。
- DNS 放 Cloudflare，`test.<域名>` 的 A 记录指向主机 IP，设为 **DNS only（灰云）**：Cloudflare 的代理节点在大陆访问慢，TLS 交给 Caddy。
- 再加 `mail.<域名>` 给发信用（见「邮件」）。私有 App 的登录验证码也可以用同一个已验证的发信域名。

**主机初始化**（Debian 12；Ubuntu 把仓库里的 `debian` 换成 `ubuntu`）：

```bash
apt update && apt -y upgrade && apt -y install sqlite3 ufw
ufw allow 22,80,443/tcp && ufw --force enable
curl -fsSL https://get.docker.com | sh
apt -y install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
mkdir -p /srv/assess/data /srv/assess/backups && chown 1000:1000 /srv/assess/data
```

**镜像在本机构建，再传上去。** 2 GB 的主机上跑 `next build` 容易内存不够，本机 Docker 已经构建成功过（见「构建」）：

```powershell
docker build -f apps/assess/Dockerfile -t crossline-assess .
docker save crossline-assess -o crossline-assess.tar
scp crossline-assess.tar root@<主机IP>:/srv/assess/
```

在主机上 `docker load -i /srv/assess/crossline-assess.tar`，然后按下一节运行。

## 部署到一台 Linux 云主机

主机：香港或东京，1–2 vCPU、1–2 GB 内存足够；Debian 12 或 Ubuntu 24.04；装 Docker、Caddy、`sqlite3`。域名用非 .cn 域名（不需要 ICP 备案，代价是微信里可能提示「非官方网页」，见 beta-launch §0）。

1. 目录：`/srv/assess/data`（数据卷，属主 uid 1000，即镜像里的 `node` 用户）、`/srv/assess/backups`、`/srv/assess/assess.env`（权限 600）。
2. 环境变量（`assess.env`）：

   | 变量 | 说明 |
   |---|---|
   | `ASSESS_BASE_URL` | 公开地址，如 `https://test.example.com`，邮件和二维码里的链接都用它 |
   | `ASSESS_DATA_DIR` | 镜像里已设为 `/data`，不用改 |
   | `ASSESS_SMTP_HOST` / `ASSESS_SMTP_PORT` | 如 `smtpdm.aliyun.com` / `465` |
   | `ASSESS_SMTP_USER` / `ASSESS_SMTP_PASSWORD` | 控制台里的发信地址和 SMTP 密码（不是账号密码） |
   | `ASSESS_MAIL_FROM` | 如 `Crossline 测评 <noreply@mail.example.com>`，必须是已验证的发信地址 |
   | `ASSESS_TEMPLATES_DIR` | 可选，类型模板目录（W5），默认用镜像里自带的 |
   | `ASSESS_LINK_SECRET` | 可选，与 App 共享的密钥，开启 `/api/link`（见「与 App 的结果连接」）；不设则接口不存在 |
   | `ASSESS_IMAGE_*` | 形象生成，见上文「形象生成」 |

3. 运行（端口只绑定本机）：

   ```bash
   docker run -d --name assess --restart unless-stopped \
     --env-file /srv/assess/assess.env \
     -v /srv/assess/data:/data \
     -p 127.0.0.1:3340:3340 \
     crossline-assess
   ```

4. Caddy（`/etc/caddy/Caddyfile`，自动申请和续期 TLS 证书）：

   ```
   test.example.com {
       encode zstd gzip
       header Strict-Transport-Security "max-age=31536000"
       reverse_proxy 127.0.0.1:3340
   }
   ```

   不要用 `header_up` 手动传 `X-Forwarded-For`，让 `reverse_proxy` 自己设置。

## 备份

WAL 模式下直接复制数据库文件会丢掉还在 `-wal` 里的写入，或者复制到一半的状态；要用 SQLite 的在线备份 API（`.backup`），它在不长时间锁库的情况下得到一致的快照[^sqlite-backup]。主机上的 `sqlite3` 和容器通过同一个绑定挂载访问同一个文件，可以直接备份：

```cron
# /etc/cron.d/assess-backup：每天 04:10 备份，校验后压缩，保留 14 天
10 4 * * * root f=/srv/assess/backups/assess-$(date +\%F).db; sqlite3 /srv/assess/data/assess.db ".backup '$f'" && [ "$(sqlite3 "$f" 'PRAGMA integrity_check')" = ok ] && gzip -f "$f" && find /srv/assess/backups -name 'assess-*.db.gz' -mtime +14 -delete
```

- 形象图片在 `/srv/assess/data/avatars/`，用 `rsync` 一起带走（丢了也能退回模板，不是必须）。
- 至少每周把备份拷到另一台机器或对象存储；备份里有邮箱，存放处同样要加密、限权。
- 恢复演练：解压一份备份，`sqlite3 x.db 'PRAGMA integrity_check'`，再用它起一个临时容器看结果页能否打开。
- 备份会保留已删除结果最多 14 天；`/r/…?delete=1` 删除的是线上数据。如果以后要求删除立即覆盖备份，再缩短保留期。

## 更新

```bash
git pull
docker build -f apps/assess/Dockerfile -t crossline-assess .
docker stop assess && docker rm assess
docker run ...（同上）
```

- 先备份再更新。新版本如有数据库迁移，会在启动时按 `user_version` 自动执行，每个迁移一个事务。
- 停机只有几秒；内测期间不做滚动更新。

## 上线前检查

- `ASSESS_BASE_URL` 是 https 的正式地址，邮件里的三个链接都能打开。
- 用 QQ 和 163 各做一次完整流程：收到结果邮件、删除链接有效、被邀请后发起人收到通知。
- `curl -I https://…/r/x` 能看到 `X-Robots-Tag`、`Referrer-Policy: no-referrer` 和 CSP。
- `docker port assess` 只显示 `127.0.0.1:3340`；从外网直接访问 3340 端口不通。
- 浏览器 Network 面板里只有本站的请求。

## 待定

- 公开投放或收费前，按 beta-launch §6 走正规流程。
- 多实例部署时，限频要换成共享存储（目前在内存里）。

[^cap]: W3C TAG, *Good Practices for Capability URLs*, https://www.w3.org/2001/tag/doc/capability-urls/
[^caddy]: Caddy, `reverse_proxy` directive（默认头与 `trusted_proxies`）, https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
[^next-output]: Next.js, `output`（standalone、`outputFileTracingRoot`、`outputFileTracingIncludes`、复制 `public` 和 `.next/static`）, https://nextjs.org/docs/app/api-reference/config/next-config-js/output
[^next-external]: Next.js, `serverExternalPackages`, https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages
[^docker-ignore]: Docker, Build context（Dockerfile 专用的 `.dockerignore`）, https://docs.docker.com/build/concepts/context/
[^sqlite-backup]: SQLite, *Using the SQLite Online Backup API*, https://www.sqlite.org/backup.html ；另见 *How to Back Up a WAL-Mode SQLite Database*, https://oneuptime.com/blog/post/2026-09-08-back-up-wal-mode-sqlite-safely/view
[^aliyun]: 阿里云邮件推送，SMTP 服务地址和端口, https://help.aliyun.com/document_detail/29449.html ；ECS 默认封禁 25 端口, https://help.aliyun.com/knowledge_detail/56130.html
[^aliyun-spf]: 阿里云邮件推送，「550 failed to meet SPF requirements」, https://help.aliyun.com/document_detail/36640.htm
[^qq]: Suped, *Best practices for email deliverability to QQ.com*, https://www.suped.com/learn/email-deliverability/what-are-the-best-practices-for-email-deliverability-to-qqcom
[^resend]: Resend, *Warming up*, https://resend.com/docs/knowledge-base/warming-up

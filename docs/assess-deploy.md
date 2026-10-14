# 公开测评：服务端、构建与部署（P-L1）

`apps/assess` 是独立于私有 App 的公开测评。方案和取舍见 [beta-launch.md](beta-launch.md)（§0、§1、§1.1、§3–§6、§9）。本文说明服务端做什么、数据怎么存、怎么构建成容器、怎么部署到一台香港或东京的 Linux 云主机。**目前尚未部署。**

它和私有 App 没有任何连接：自己的 SQLite 文件、自己的形象图片，不读写账本，不使用本人的模型额度以外的任何账号（形象生成的额度见 W5）。私有 App 的 `external` 部署禁令（`apps/web/next.config.mjs`）不受影响，这里部署的是另一个应用。

## 它做什么

1. 访客答完 32 题、选好外貌，填邮箱（「把海报和结果发到我的邮箱」默认勾选），可选填邀请署名。
2. `POST /api/results` 在服务器上**重新计分**（`quizScores`，不信任浏览器算的分），保存结果，生成两个令牌，开始生成形象，按勾选发结果邮件。
3. 本人从邮件或结果页回到 `/r/<结果令牌>`；别人只会拿到 `/t/<邀请令牌>`（海报二维码、转发链接）。
4. 被邀请的人从 `/t/<邀请令牌>` 做题提交，双人卡当场生成（`/p/<双人卡令牌>`），发起人收到邮件通知。

| 路由 | 用途 | 令牌 |
|---|---|---|
| `POST /api/results` | 提交答案、外貌、邮箱；带 `inviteToken` 时当场配对 | — |
| `GET /api/results/<resultToken>` | 本人的结果（`ResultView`） | 结果令牌，只在本人的邮件和页面里出现 |
| `DELETE /api/results/<resultToken>` | 删除结果、两边的双人卡和形象文件 | 结果令牌 |
| `GET /api/invites/<inviteToken>` | 邀请落地页（`InviteView`） | 邀请令牌 |
| `GET /api/pairs/<pairToken>` | 双人卡（`PairView`） | 双人卡令牌 |

接口形状在 `apps/assess/lib/contract.ts`。所有公开视图都只由四轴得分算出（`lib/public-type.ts`），**任何视图都不含邮箱、答案或外貌**；邀请页和双人卡里也不出现结果令牌。

### 提交的规则

- 拒绝顺序：跨站 `Origin`（`REJECTED`）→ 每个 IP 每小时 30 次（`RATE_LIMITED`，带 `Retry-After`）→ 蜜罐字段 `website` 非空（`REJECTED`）→ `startedAt` 不是数字（`REJECTED`）→ 32 题有缺或不在 1–5（`QUIZ_INCOMPLETE`）→ 外貌不在枚举里、多了字段或备注去掉不可见字符后超过 40 字（`APPEARANCE_INVALID`）→ 邮箱格式或长度（≤254）不对（`EMAIL_INVALID`）→ 署名超过 12 字（`NICKNAME_INVALID`）→ 距 `startedAt` 不到 40 秒（`TOO_FAST`）→ 邀请令牌无效或已过期（`INVITE_NOT_FOUND`，页面可去掉邀请重新提交，答案不丢）→ 用发起人自己的邮箱回答自己的邀请（`ALREADY_PAIRED`，409）→ 同一邮箱每天 5 次（`RATE_LIMITED`）。
- 署名和外貌备注会去掉控制字符、零宽字符、双向控制符等不可见字符；只由这些字符组成的署名按空处理（页面显示「你的朋友」）。
- **答案不保存**：只存四轴得分和类型代码，比 §6 列的「只收必要数据」更少一步。
- 形象：创建结果后调用 W5 的 `enqueueAvatar`，包在 try/catch 里——形象出错不影响提交，页面先显示类型模板。
- **同一邀请、同一邮箱只配对一次**：同一个邮箱再次回答同一个邀请时，新结果照常保存（有自己的令牌），但返回第一次生成的双人卡令牌；双人卡保留第一次的答案，发起人看到的卡不会被改写，也不会再收到通知。
- 发起人关掉了邮件勾选时，不发配对通知；双人卡仍会出现在他的结果页（最多 20 张，新的在前）。

## 数据与保存期限

- 文件：`<ASSESS_DATA_DIR>/assess.db`（better-sqlite3，WAL），形象图片由 W5 写在同一目录下（`avatars/…`，路径相对 `ASSESS_DATA_DIR`）。
- 表：`results`（`id`、两个令牌、小写邮箱、署名、`scores_json`、`code`、`appearance_json`、`send_email`、`avatar_state`、`avatar_file`、`created_at`、`expires_at` = 创建后 90 天）；`pairs`（`id`、`pair_token`、`inviter_id`、`invitee_id`、`created_at`，两个外键 `ON DELETE CASCADE`）。
- 迁移按 `PRAGMA user_version` 编号，每个迁移和它写的版本号在**同一个事务**里，崩溃不会留下半迁移的文件（和私有 App 的账本同一规则）。
- 令牌：`crypto.randomBytes(16)` 的 base64url，128 位，22 个字符。
- 过期：所有读取都把过了 `expires_at` 的结果当作不存在；服务启动时和之后每小时删一次过期结果（`instrumentation.ts` → `server/purge.ts`），连同两边的双人卡和形象文件。
- 删除：邮件里的「删除我的结果」链接打开 `/r/<结果令牌>?delete=1`，页面确认后调用 `DELETE`；结果、两边的双人卡和形象文件一起删除，所有链接立即失效。删除后不再记得这个邮箱，所以「每个邮箱 3 次形象」只按仍保存的结果计数。
- 估算排位用的「全部已记录得分」每分钟最多读一次（`recordedScores`）。

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
- 2026-10-14 在 WSL Ubuntu（Linux x64、Node 22）上按 Dockerfile 的步骤走过一遍：过滤安装、构建、只拷 standalone 目录后启动，提交、读取、删除都正常，`assess.db` 以 WAL 方式创建。本机的 Docker 引擎当时没有运行，镜像本身还没有实际构建过，第一次部署前先在主机上构建一次。

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
   | W5 的形象生成变量 | 见 W5 的说明（模型 key、每日预算） |

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

# 使用手册

第一次接触这个仓库、想知道"从零开始该按什么顺序做"，先看
[docs/getting-started.md](./getting-started.md)——那份文档是完整的首次走查，
会在需要的地方链回本文这里。本文覆盖的是账号、离线、Tailscale、备份这类基础设施细节，
不是产品功能的操作顺序。

这份手册按真实场景组织，每一节除了操作步骤，还说明这一步背后动的是哪个真实机制——
session、`AccessContext`、workspace 过滤、Codex capability token、离线 outbox、审计事件——
不是空泛的点哪里点哪里。涉及的代码位置见各节标题旁的引用。

## 1. 首次注册（邮箱密码）

1. 打开 `/signup`，填邮箱、密码（至少 8 位）、名字，提交。
2. Better Auth（`packages/auth`）写入 `auth.db` 的 `user` 表，`emailVerified: false`，并通过配置好的
   SMTP（见下方「SMTP 是什么」）真实发出一封验证邮件。
3. 点击邮件里的链接，`emailVerified` 变成 `true`。**没验证之前不能登录**——`requireEmailVerification: true`
   是硬编码的，不是可选项，登录会直接报 `EMAIL_NOT_VERIFIED`。
4. 用刚才的邮箱密码在 `/login` 登录，跳回首页。

**这一步背后发生了什么（`packages/auth/src/index.ts` 的 `requireAccessContext`）**：首页第一次真正加载时，
`requireAccessContext` 从 session 里拿到 Better Auth 的 `user.id`，查 `crossline.db` 的 `principals` 表——
第一次查不到，就在**一个事务里**同时建好 `principals`/`workspaces`/`workspace_members` 三行，
角色是 `owner`。这是全新的空 workspace，**不会**自动继承磁盘上旧的 `personal-crossline` 账本数据——
旧数据还在，只是新账号看不到（这是阶段二定下的决策，不是遗漏）。往后每次请求都会重新查一遍
`workspace_members`，不是从登录时的 session 里读一份缓存的角色——这也是为什么下面「撤销设备」和
「撤销 session」一旦生效，是**立即**生效，不用等 cookie 过期。

**SMTP 是什么、为什么邮箱注册可能是关掉的**：`packages/auth`
在 `CROSSLINE_SMTP_HOST`/`PORT`/`USER`/`PASSWORD`/`FROM` 五个环境变量**全部**配好之前，
邮箱注册这个功能整个不存在——不是"注册了但收不到验证邮件"，是 Better Auth 的
`emailAndPassword` 插件根本没有被启用。这是有意设计的（"SMTP 未配置时禁用邮箱注册，不允许退化为
未验证账号"），宁可整个功能消失，也不允许一个永远收不到验证邮件的账号存在。生产选型是
[Resend](https://resend.com)（免费层 3000 封/月）：`smtp.resend.com:465`，`user` 固定填
`resend`，`password` 是 Resend 后台生成的 API key，`from` 用 Resend 提供的
`onboarding@resend.dev` 即可（不用自己验证域名）。**这里有一个只有真实跑过才会踩到的坑**：
沙盒模式下 `onboarding@resend.dev` 只能发给 Resend 账号自己的注册邮箱，
不是"发给任何人都行"——真实收件邮箱必须和注册 Resend 账号时用的邮箱一致，不然验证邮件根本发不出去
（会收到 `550 You can only send testing emails to your own email address`）。

## 2. Google 登录

前提：`CROSSLINE_GOOGLE_CLIENT_ID`/`CROSSLINE_GOOGLE_CLIENT_SECRET` 已配置（`apps/web/.env`）。

1. `/login` 页面点"用 Google 账号登录"。
2. 跳到 Google 账号选择/授权页，同意后跳回 `/api/auth/callback/google`，Better Auth 建 session，
   跳转到首页。

**从零开通 Google OAuth 客户端**（Google 云端操作，跟本机无关，只有回调 URI 要指到本机/Tailscale
能到的地址）：
1. [console.cloud.google.com](https://console.cloud.google.com) 新建或复用一个项目。
2. "OAuth 同意屏幕"：User Type 选"外部"；只勾 `openid`/`email`/`profile` 三个基础 scope
   （Better Auth 默认只要这三个）。
3. **不要停在"测试"状态**：测试状态下签发的 refresh token 7 天就过期，长期用会每周被强制重新登录。
   基础 scope 发布到"生产中"**不需要 Google 人工审核**，填好应用名称、支持邮箱、开发者联系邮箱后
   直接点"发布应用"，几秒钟生效、免费、长期有效。
4. "凭据" → "创建凭据" → "OAuth 客户端 ID" → 类型选"Web 应用"。
5. **已获授权的重定向 URI** 可以同时挂两条（同一个客户端不用为每个环境建新的）：
   - `http://127.0.0.1:3210/api/auth/callback/google`（本机直连）
   - `https://<你的 tailscale 主机名>.ts.net/api/auth/callback/google`（阶段六接入 Tailscale 后再加）
6. 复制 Client ID / Client Secret 到 `apps/web/.env`（**不是**仓库根目录的 `.env`——Next.js
   只认自己项目目录下的 env 文件，根目录放一份会被静默忽略）。

**这一步背后发生了什么**：`packages/auth` 配了
`account: { accountLinking: { disableImplicitLinking: true } }`——如果这个邮箱**已经**注册过密码账号，
再用同邮箱的 Google 登录**不会**静默合并成同一个账号，而是报错。已登录状态下可以用
`authClient.linkSocial()` 显式关联，但那是账号本人的主动选择，不是系统替你做的决定。
`requireAccessContext` 里 `identity.provider` 的判定逻辑（查 `account` 表，社交登录优先）
是审计用的——`audit_events`（如果调用方传了）会记这次到底是密码登录还是 Google 登录，跟真正的
授权判断（`workspace_members` 查询）是两回事，一个记录"是谁"，一个判断"能不能"。

## 3. 邮箱找回（重置密码）

1. `/login` 页面点"忘记密码"，进 `/reset-password`。
2. 没带 token 时显示"发送重置链接"表单，填邮箱提交。
3. **不管这个邮箱是否真的注册过，页面显示的文案都一样**："如果这个邮箱已注册，重置链接已经发出，
   请查收邮件。"——故意如此，避免这个表单被用来试探"这个邮箱到底有没有注册过"。
4. 邮件里的链接会带一个 token 参数回到 `/reset-password?token=...`，这时页面自动切换成"设置新密码"表单。
5. 提交新密码，成功后跳回 `/login` 用新密码登录。

同样依赖第 1 节的 SMTP 配置——没配 SMTP，这条链路一样是"整个功能不存在"，不是"发不出邮件"。

## 4. Tailscale 绑定（私网跨设备访问）

**先决条件**（一次性，Tailscale 账号侧操作，详见 `docs/private-network-deployment.md`）：
tailnet 已创建、这台机器已 `tailscale up`、tailnet 管理后台已启用 Serve 功能、本机已跑
`tailscale serve --bg 3210`。做完这些，`https://<hostname>.ts.net` 就能从 tailnet 内任何设备访问到
这台机器上跑着的 Crossline，`CROSSLINE_DEPLOYMENT_MODE=private` 打开了 HSTS/CSP 等安全响应头。

1. 从 tailnet 内的另一台设备（手机、另一台电脑，只要都登录了同一个 Tailscale 账号）打开
   `https://<hostname>.ts.net`，正常走第 1/2 节的登录流程。
2. 登录后打开"连接目标"页（`/connectors`），"Tailscale 身份"卡片会显示这次连接实际携带的身份
   （`Tailscale-User-Login` 请求头，只有真的经过 `tailscale serve` 反代才会有）。
3. 点"信任这个 Tailscale 身份"，写进 `tailscale_bindings` 表。

**这一步背后发生了什么，以及为什么不是自动登录**：Tailscale Serve 转发给后端的身份头只有三个——
`Tailscale-User-Login`/`-Name`/`-Profile-Pic`——**没有任何节点标识**，而且 Tailscale
会剥离请求里任何伪造的同名头，所以这三个头本身是可信的。但"可信"不等于"可以当登录用"：
这里设计成**必须先用正常的 Better Auth 账号登录**，再在已登录状态下主动点一次"信任"，
写下的只是一条审计记录（谁在什么时候确认过哪个 Tailscale 登录是自己）。任何页面的真正访问控制
依然只看 session 是否有效，Tailscale 头从来不参与鉴权判断——`apps/web/app/api/connectors/tailscale/route.ts`
的 doc comment 专门写明了这一点。撤销一条绑定（列表里点"撤销"）只是删掉这条审计记录，
不会让对应的登录 session 失效。

## 5. 离线工作

1. 网络断开时，Workbench 页面的"开始执行"/"暂停"/"恢复"/"完成"按钮照常可点——命令被写进浏览器本地的
   Dexie（IndexedDB）数据库，不是丢弃或报错。
2. 网络恢复、页面重新加载时，`OfflineReplay` 自动把队列里的命令依次回放到服务器。
3. 首页会显示"N 条等待同步"，同步失败的（服务器永久拒绝，比如证据格式不对）进"无法同步"列表，
   跟另一台设备冲突的进"冲突"列表（见第 6 节），都能在 `/offline` 页面看到并且手动丢弃。

**这一步背后发生了什么**：Dexie 数据库名是 `crossline-offline-${workspaceId}`，不是固定名字——
换账号登录时不会把上一个账号缓存的离线命令带进新账号的队列，这是账号切换时的数据隔离，不用额外操作。
队列里的负载（payload）用 `crypto.subtle.generateKey` 生成的**不可导出** `CryptoKey`（AES-GCM 256）
加密后再写入 Dexie，密钥本身也存在 IndexedDB 里（浏览器原生支持存储 `CryptoKey` 对象），
但因为标记为不可导出，就算有人能读到这台设备的 IndexedDB 文件，也拿不到明文密钥本身去解密。
命令要真正被服务器接受，还要求这台设备持有一个未过期、未撤销的**设备租约**（`device_leases` 表，
24 小时有效期，`POST /api/auth/device-lease` 在联网成功同步时自动续期）——这是为了让"这台设备离线时
产生的命令，是不是真的被这个 workspace 的 owner 授权过"这件事有据可查，而不是任何猜中
`deviceId` 格式的请求都能冒充。

## 6. 冲突处理

跟第 5 节是同一个机制的另一面：如果 A 设备在线时已经把某个作业从 `ready_for_human` 推进到别的状态
（比如已经开始执行、已经完成），B 设备却是在离线时基于"还没开始"的旧状态点了"开始执行"，
B 联网后这条命令回放到服务器会被服务器**拒绝**（`EXECUTION_NOT_STARTABLE`，HTTP 409）——但拒绝的方式
不是静默丢弃，也不是覆盖 A 设备已经做的事，而是被 `classifyReplay` 归类成 `"conflict"`，
进 Dexie 的 `conflicts` 表。

在 `/offline` 页面（或首页的离线横幅）能看到冲突列表，每条显示原始命令的内容、失败原因、失败时间，
可以"复制原文"（把这条命令想做的事复制出来，方便手动确认要不要重新做一次）或者"丢弃"
（确认不需要了，从本地队列清掉——这不影响服务器上的真实状态，那早就是 A 设备写定的了）。

## 7. Codex 执行

材料准备（`crossline-material-preparer`）和里程碑闸门判定（`crossline-milestone-gate`）
由 worker 在后台 tick 里自动跑，也可以在 Workbench/Review 页面点"重新准备材料"/"现在判定"手动触发一次。

**这一步背后发生了什么**：web 和 worker 是两个独立进程，worker 单独监听 3211 端口跑 Codex supervisor。
点按钮触发的请求，从 web 发到 worker 之前，会用当前这次请求真实的 session 派生出的
`AccessContext`（`principalId`/`workspaceId`/`role`）现签一个**30 秒有效期**的 HMAC capability
token（`CROSSLINE_SUPERVISOR_CAPABILITY_SECRET` 签名，跟 `BETTER_AUTH_SECRET`
是两个独立的密钥，一个泄漏不会连累另一个），worker 那边逐路由校验这个 token——过期、
重放（同一个 `jti` 用过第二次）、`operation` 和实际请求的路径不匹配、worker
重启后旧的 `supervisorBootId` 不再有效，四种情况都会被拒绝。也就是说，**不是任何能连到本机
3211 端口的进程都能让 worker 去跑 Codex**——这个洞（阶段四之前任何本机程序都能直接打
3211 端口）已经堵上了。

## 8. Graph 连接（工作日历只读同步）

`/connectors` 页面的"日历来源"卡片列出已登录账号下的所有日历，勾选想同步进"计划现实轨"的那些
（新登录的账号默认只勾其默认日历，不会一次性把"中国节假日""生日"这类日历也拖进计划）。
worker 按 15 分钟一个 tick 增量拉取，`/connectors` 顶部"工作日历"卡片能看到最近一次同步的时间和变化数量，
也可以点"立即同步日历"手动触发一次（这个是真的等结果再刷新页面，不是发个请求就不管了）。

这条链路当前是**只读**——`GraphReadSource` 这个类结构上就没有任何写方法，跟负责写入的
`MicrosoftGraphConnector`（写回锁死在一个名字精确匹配 `"Crossline"` 的日历/列表上，目前这条写回路径
本身还是关闭的）完全分开。

## 9. 撤销设备

`/connectors` 页面"离线设备"卡片列出这个 workspace 曾经签发过离线租约的每一台设备（本机会标"本机"，
其他设备显示 device id 的前 8 位），点"撤销"。

**这一步背后发生了什么，以及它不做什么**：撤销只影响第 5 节说的那件事——这台设备离线时产生的命令，
下次联网后还能不能被服务器接受（`revokeDeviceLease` 把这条租约标记为已撤销，`isDeviceLeaseValid`
判断时直接拒绝）。它**不会**让这台设备当前登录的 session 立即失效（那是账号本身的安全设置，
如果设备丢失、需要连登录状态一起切断，应该去改密码或者用账号安全设置撤销 session，
不是这个"离线设备"列表能做到的），也**不会**清空这台设备本地已经缓存的 IndexedDB 数据——
真正把本地缓存清空的操作是"退出登录"（每个页面右上角"退出登录"按钮），
那个会把 `crossline-offline-${workspaceId}` 这个 Dexie 数据库整个删掉。

## 10. 备份与恢复

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-crossline.ps1
```

导出账本为 JSON、连同（如果存在）`auth.db` 一起打包、用当前 Windows 用户的 DPAPI 加密、算好
SHA-256 校验值，最后把过程中的明文临时文件删掉。`auth.db` 只有在真的有人登录过一次之后才会存在——
全新安装、还没人注册登录时备份，不带 `auth.db` 是正常结果，不是备份出错。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\restore-crossline-backup.ps1 -BackupPath <加密文件路径>
```

解密、解压、用 `pnpm restore` 把账本重建成一个**新的** SQLite 文件（不会碰 `data\crossline.db`
这个真正在用的文件），然后**真的**把每张表读回来验证——如果备份里带了 `auth.db`，
也会同样重建并读回 `user`/`session`/`account`/`verification` 四张表的行数。
替换掉正在用的 `data\crossline.db`/`data\auth.db` 是一步刻意保留的人工操作，脚本不会替你做这一步。

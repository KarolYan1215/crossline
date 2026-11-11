# Crossline 日历：四种写入方式

> 硬约束：Crossline **不改动本人人工设置的任何日历事件**。只写自己创建的事件；本人改过（时间、标题）或删掉的事件，之后不再碰、也不再建；只删未来的事件；预览块、预排块从不写入。邮件里的活动要本人在问答卡上点「去」才会写入。

2026-11-10 本人决定四种方式都做（`packages/core/src/calendar-write.ts`），可以同时开几种。入口：设置 → 日历与连接 → 「写入日历」卡片，每种方式各有开关、最近一次结果和上次未完成的原因。任意一种开着，「创建」类问答（`event_propose`）就会出现。

写入的内容都一样（`apps/web/lib/calendar-write.ts` 的 `calendarItems`）：已确认的固定日程（文件里确认的、输入框建的、邮件里点了「去」的）和计划里的工作块；标题「主线 · 任务名」；不带备注、材料、地点；状态「空闲」，开始前 10 分钟提醒。每个事件有稳定的 UID（`<id>@crossline.lol`），所以改动是更新而不是新建。

| 方式 | 设置键 | 失败记录 |
| --- | --- | --- |
| (a) 订阅链接 | `calendar.write.paths.ics`，令牌 `calendar.feed.token` | `calendar.publish.failure.ics` |
| (b) 邮件邀请 | `…paths.imip`，收件人 `calendar.imip.recipient` | `calendar.publish.failure.imip` |
| (c) Google 日历（ChatGPT 连接器） | `…paths.google`，记录 `calendar.published.google` | `calendar.publish.failure.google` |
| (d) Microsoft 日历（Graph） | `…paths.graph`（有写入账号时默认开） | `calendar.publish.failure` |

## (a) 订阅链接

`/api/calendar/feed/<令牌>.ics`，任何日历应用「通过网址添加/订阅日历」即可（卡片上有复制和 `webcal://` 打开按钮）。令牌 32 字节随机数，按常数时间比较；只有该方式开着时链接才有效，关掉或「换新链接」后旧链接立即 404；关掉时就换了令牌，再打开是新链接，旧链接不会复活（2026-11-11）。拿到链接的人都能看到内容，所以内容只有标题和时间。日历应用刷新频率由它们自己定（Google 可达半天）。每次被读取记录 `calendar.feed.seen`。

内容和其他方式写的是同一份计划：最优解，不是求解期间先显示的贪心排程（docs/loop-and-scout.md §2）。订阅请求不能像自动发布那样回一句「还在算」一分钟后再来，所以正在求解时它最多等 25 秒（`FEED_OPTIMAL_WAIT_MS`，求解本身上限 20 秒），等到就给最优解，等不到或这份输入已经等过一分钟（自动发布也会在这时改写贪心排程）才给贪心排程。托管内测没有后台求解（`simpleOnly`），贪心排程就是最终计划，不等（2026-11-11）。

输出按 RFC 5545：CRLF、75 字节折行、TEXT 转义、每个用到的 TZID 都有 VTIMEZONE（按实际偏移变化生成）、每周重复用 `RRULE:FREQ=WEEKLY;BYDAY=…;UNTIL=<UTC>` 加 `EXDATE`（`packages/connectors/src/ics-write.ts`，测试用 ical.js 回读校验）。

## (b) 邮件邀请（iMIP，RFC 6047）

从 `calendar@mail.crossline.lol`（`CROSSLINE_CALENDAR_FROM` 可改）给收件人发 `METHOD:REQUEST` 邀请；收件人默认是账号邮箱，可在卡片上改。时间或标题变了，同一 UID 再发一次，`SEQUENCE` 加一；从日历里移除且还在未来的，发 `METHOD:CANCEL`。只发未来 7 天的工作块；重复日程的「下一次」往后移不算变化。

防刷屏（2026-11-11，计划频繁重排时曾每 10 分钟一轮发出多达 20 封）：

- 已发过的单次事件，标题没变、开始和结束都挪动不到 15 分钟（`IMIP_MIN_SHIFT_MINUTES`）不再发；记录保留上次发出的时间，小挪动累计到 15 分钟才发。
- 同一事件发过一封后 60 分钟内（`IMIP_QUIET_MINUTES`）不再发第二封（更新或取消都算），窗口过后按那时的最新状态只发一封；一小时内就要开始的事件不受此限。
- 每轮最多 5 封（`IMIP_PER_PASS`），最近开始的先发；任意 24 小时最多 30 封（`IMIP_PER_DAY`，发送时间记在 `calendar.imip.day`）。没发的留到下一轮。已发过的块被重排到 7 天以外仍是更新，不是取消：取消只看整份计划里还有没有它。发过 CANCEL 的记录保留到它过去为止，同一块回来时 `SEQUENCE` 接着往上加，日历不会因序号比取消低而丢掉它（2026-11-11）。

**只走 Resend 的 HTTP API**（`POST https://api.resend.com/emails`，`packages/auth` 的 `createInviteSender`），密钥取自现有的 Resend SMTP 配置（`CROSSLINE_SMTP_USER=resend` 时 `CROSSLINE_SMTP_PASSWORD` 就是 API key，`resendKeyOf`）。邮件带 text 和 html 正文，日历对象作为附件 `invite.ics`（取消时 `cancel.ics`），类型 `text/calendar; charset=UTF-8; method=…`。不用 SMTP 发邀请：2026-11-10/11 对 UW Outlook（Exchange Online）实测，Resend 的 SMTP 中继会把邮件重建成 multipart/mixed（经 Amazon SES），无论原来是 nodemailer `icalEvent`（另附 invite.ics）还是单个 multipart/alternative，日历部分都成了普通附件 `attachment-0`，没有会议栏；改走 API 并显式标附件类型后出现「接受/拒绝」。测试记录见会话笔记 `imip-test-log.md`。没有 Resend 配置时卡片显示「本站没有配置 Resend 发信」，不会退回到 SMTP 或别的发信方式。测试里从不真发：网络是假的，或用 `CROSSLINE_AUTH_TEST_MAILBOX_DIR` 写到文件。

## (c) Google 日历：经本人 ChatGPT 登录里的 Google Calendar 连接器

这一条取消了原来「Google 日历只读」的规则，仅限这条路径（CLAUDE.md Safety boundaries）。worker 用该工作区自己的 Codex 运行时，在一个只读沙箱、无模型回合的临时线程上直接调用连接器工具（`mcpServer/tool/call`，`apps/worker/src/google-calendar-publish.ts`）。工具名是白名单：`list_calendars`、`search_events`、`create_event`、`update_event`、`delete_event`，其他一律不调。

- 2026-11-10 用 `scripts/apps-calendar-tools.ts` 只列不写地探过工具：连接器**没有建日历的工具**，也没有私有扩展属性。所以本人若在 Google 里建了名为 `Crossline` 的日历就写进去；没有就写主日历，每个标题前加「Crossline · 」。一旦选定就不再换。
- 哪些事件是本应用的，只看账本 `calendar.published.google` 里记下的事件 id；不在里面的事件从不碰。
- 每次写之前读一遍未来 120 天的事件：时间或标题和写进去的不一样，或者事件不见了，就算本人的，此后不改、不重建、不删。
- 重复日程按单次读回：任何一次被本人改了时间、改了标题或单独删掉（规则算出应有的那一次不见了），整串都算本人的，此后不改、不截断、不删（2026-11-11）。只看窗口内、上次写入的开始之后的各次；读取窗口覆盖到系列最后一天（仍以 120 天为限）。
- 新建时自带事件 id（`googleEventId`：块 id 加「代」的 sha256，base32hex 字符），并在调用前先把这次新建记进账本（`unconfirmed`）。新建超时而 Google 其实建好了：下一轮在日历上按这个 id 找到它就认领，不再新建；没找到就用同一个 id 再建，Google 回 409（已存在，删掉的事件也保留 id）就认领——在读取窗口内却看不到，说明本人删了，记为本人的，不再建。账本丢失时同理。块从计划移除后「代」加一，同一块以后回来用新 id。
- 未验证：连接器 `create_event` 接受自带 id 的参数名按 `event_id` 写（和 `update_event`、`delete_event` 一致），尚未用 `scripts/apps-calendar-tools.ts` 对实际工具核对；连接器若因这个参数报错（错误里提到 `event_id`），就不带 id 再建一次，照常写入，只是没有防重保证；409 靠连接器错误文本里的「409 / duplicate / already exists」识别（`google-calendar-publish.ts` 把错误文本带进异常）。
- 只删未来的事件；已经开始的重复日程不删，而是把 `UNTIL` 改到今天。
- 建事件时不加参会人、不加 Google Meet、状态空闲。
- 重复日程更新后，记录里的开始仍是第一次的时间（计划给的是下一次）；之前按「还没开始」整串删掉，连过去的几次一起删（2026-11-11）。已开始的系列移除时只截到今天。
- 需要：模型连接是 ChatGPT 登录，且 ChatGPT 里连好了 Google 日历；否则卡片显示「ChatGPT 里还没连接 Google 日历」。

## (d) Microsoft 日历（Graph）

只写名为 `Crossline` 的日历，规则不变（`connectorWritePolicy`）。可选：没有配置 Entra 应用的站点不显示这一项。

托管版（Linux）也能用：令牌缓存在 Windows 上用 DPAPI；在 Linux 上用 `CROSSLINE_SECRET_KEY` 加密写进 `CROSSLINE_DATA_DIR` 下的密钥文件（槽 `_machine/msal-graph-cache`）。没有 `CROSSLINE_SECRET_KEY` 时登录直接报 `GRAPH_CACHE_NEEDS_SECRET_KEY`，不会明文落盘。

### Entra 门户配置清单

1. 打开 <https://entra.microsoft.com> → 应用程序 → 应用注册 → 新注册。
2. 名称随意（如 `Crossline`）；「受支持的帐户类型」选「任何组织目录中的帐户和个人 Microsoft 帐户」（只给一个学校用就选「仅此组织目录」）；重定向 URI 留空。
3. 注册后在「概述」复制「应用程序(客户端) ID」→ 环境变量 `CROSSLINE_MS_CLIENT_ID`；如果第 2 步选了「仅此组织目录」，再复制「目录(租户) ID」→ `CROSSLINE_MS_TENANT_ID`。
4. 「身份验证」→「高级设置」→「允许公共客户端流」设为「是」并保存（登录用设备码流程）。
5. 「API 权限」→ 添加权限 → Microsoft Graph → 委托的权限 → 勾选 `User.Read`、`Calendars.ReadWrite`（读取同步还要 `Calendars.Read`、`Tasks.Read`）。
6. 学校、公司租户常禁止用户自行同意第三方应用：登录时出现「需要管理员批准」就要请租户管理员在「企业应用程序」里对该应用「授予管理员同意」，或换个人账号。
7. 托管版设置 `CROSSLINE_SECRET_KEY`（与其他密钥共用）和 `CROSSLINE_DATA_DIR`，重启服务。
8. 本机：仓库根目录运行 `pnpm exec tsx scripts/graph-write-login.ts`，按提示打开网址、输入设备码；同意页应写着「读取和写入你的日历」。成功后账号记入 `calendar.write.account`，「Microsoft 日历」一项默认开启。

## 邮件里的活动

邮件分拣多了一类「活动」（讲座、宣讲会、活动、会议、导师约见、面试、组会）：模型读出标题、日期、时间、地点、相关度和是否是给本人的邀请，日期和引文必须在原文里找得到（`packages/core/src/mail-events.ts`）。给本人的邀请或相关度 ≥ 50 的，变成问答卡「要去吗：「…」」，给本人的排在最前并默认推荐「去」；点「去」才建固定日程并按上面开着的方式写入日历，点「不去」就丢掉。其余群发通知只进复盘页的「邮件里的活动」一周汇总，不打扰。邮件本身从不直接写日历。要报名的活动仍走机会卡。

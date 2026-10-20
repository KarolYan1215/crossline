# 个人代理：任何模型下的助手、邮箱与自动化

2026-10-19 起。目标：不依赖 ChatGPT，换成开发者提供的模型或自己的 API 之后，Crossline 仍能像 personal agent 那样替本人做事——按时轮询、盯邮箱、读写和整理文件、一句话建成端到端的自动化——并且这些都接在 Crossline 已有的收件箱、任务、等待项、日历和通知上。

## 1. 现状与问题（改之前）

- 助手（`crossline-agent`）是 Codex 的 shell 模式：`danger-full-access` + 守卫。只给电脑主人自己的 Codex 用；托管内测（`CROSSLINE_PUBLIC_BETA=1`）上**所有人**都没有助手（`machineOwner` 恒为 false）。
- 第三方模型（赞助模型、自己的 API）按 `capabilityGap` 永远拿不到 shell，所以换模型之后助手整块消失；「交给 Agent」按钮也对客人隐藏。
- 「可生长的工作流」靠 shell 助手调用 runtime 自带的 `skill-creator` 写脚本，同样只有电脑主人能用；客人用输入框说「以后每周五……」会被记下，但永远不会建成。
- 没有邮箱接入。

## 2. 工具型助手（`crossline-agent-tools`）

**决定**：除电脑主人自己的 Codex 外，所有账号的助手改用「工具模式」：没有 shell，能做的事是一组 Crossline 自己回答的函数（Codex dynamic tools），所以在任何能调用函数的模型上都能跑。

- 代码：`apps/worker/src/agent-tools.ts`（`createAgentToolbox`）、`agent-task.ts` 的 `runWithTools`、`agent-service.ts` 的 `modeFor`/`clientFor`/`mailFor`；Skill `crossline-agent-tools`；`assistantMode()`（`packages/db/src/skills.ts`）决定 `shell` 还是 `tools`。
- 函数：
  - 文件：`list_files`、`read_file`（文本/PDF/Word）、`write_file`（只限 .md .txt .csv .tsv .json .html .ics .yaml .xml，单个 ≤2 MB，一次运行 ≤200 个、≤20 MB）、`copy_file`、`move_file`、`delete_file`（只能删本次自己写的）。只写任务目录；输入以 `input/<n>/…` 只读出现，运行前后做哈希比对。
  - 本人的东西：`list_documents`/`read_document`（上传与授权文件夹）、`list_tasks`/`read_task`、`list_facts`、`calendar`。
  - 网页：`web_search`/`web_fetch`（托管内测上是 Tavily + `safeGet`；ChatGPT 登录时是自带搜索）。
  - 邮箱（接入后才有）：`mail_search`、`mail_read`，只读。
  - 对账本：`add_to_inbox`（一次 ≤5 条，运行**成功后**才写成 capture，交给收集分析）、`tell_person`（运行结束后一次性告诉本人）。
- 没有任何发送、回复、发布、付款、删除外部文件的函数；需要的话准备到最后一步，写进 `needsHuman`。
- 账本事件与 shell 助手完全一致（`agent.task.requested/completed/blocked`，多一个 `mode: "tools"`），`audit.json` 里记下每一次函数调用（`toolCalls`）。所以待确认、重试链、交付、「交给 Agent」、准备步骤、自动交给 Agent 全部照常工作。
- 防打转：同一调用重复 6 次、同一调用连续失败 3 次即停（`toolLoopReason`）。
- 跑在账号自己的模型上（`clientFor`），排队走模型闸门的 background 份额，但有自己的 lane，不挡收集分析和验收。
- 一致性测量：`AGENT_SUMMARY_SCHEMA` 一直在一致性用例里，赞助模型评测 v5 已覆盖；Skill 需要 `tools: true`。格式通过不等于会调用函数（10-19 线上：赞助模型在 JSON 模式下一次都没调用），所以另有用例 `ADVERSARIAL_TOOLS`：给一个函数，必须调用并用它的返回值作答；没通过时需要函数的 Skill 不开放。只支持 JSON 模式的服务商在带函数时不发 `response_format`，JSON 只在最后一条回复里要。一次函数都没调用的助手运行会被退回（`AGENT_NOTHING_DONE`）。

## 3. 邮箱（只读，IMAP）

- 开源库：`imapflow` 2.1.2（连接，`mailboxOpen("INBOX", { readOnly: true })` = EXAMINE，不改任何标志）+ `mailparser` 3.9.32（解析正文）。没有 SMTP、没有 APPEND，模块里根本没有写的路径。
- 接入：地址 + 应用专用密码/授权码。预设：Gmail、QQ/Foxmail、163/126/yeah、iCloud、Yahoo、新浪、阿里；其他域名填 IMAP 服务器（只接受域名，不接受 IP 或内网名）。Outlook/Hotmail/Live 微软已关掉密码登录 IMAP，只能 OAuth，明确说不支持。填入 Gmail 地址时，卡片给出「去 Google 生成应用专用密码」（新标签页打开 `myaccount.google.com/apppasswords?authuser=<地址>`，浏览器登了多个 Google 账号时直接选中这一个）和「还没开两步验证？先开启」（应用专用密码页只在开了两步验证后才有），Gmail 因密码拒绝登录、或已接入的邮箱日后读取时密码失效，同一入口再出现（`appPasswordPage`，2026-10-19 应用户要求）。先登录一次成功才保存；密码只进 worker 的密钥库（`mail-<id>`，Linux 上 AES-GCM，Windows 上 DPAPI），从不进账本、导出或备份。
- 读取：每 15 分钟读新邮件（UID 水位 + UIDVALIDITY；首次接入读最近 3 天，最多 30 封）。只保存发件人、主题、日期、开头 300 字和处理结果（`mail.log`，最多 120 条）；全文需要时从服务器现读。
- 整理（`crossline-mail-triage`，低档模型，intake 类）：每封归为 待办 / 日期 / 回复了等待项 / 需要回复 / 知悉 / 略过。待办和日期写成 capture（带来源邮件），走收集分析变成任务，一次最多 5 条；「回复了等待项」写 `waiting.mail_seen`，待决事项里对应的「……到了吗？」立即提前并写明是哪封邮件；「需要回复」（`reply` 且 `waitingId` 为空：对方在等本人的答复）见 §3.1；其余不动。可按邮箱关掉自动整理。
- 实测（2026-10-19）：`scripts/mail-imap-e2e.ts` 用真实 Dovecot（本机）走 worker 的同一套代码，993（TLS）与 143（STARTTLS）各 13/13：错误授权码被拒且说清原因、正确的接入、授权码不进账本、首次读到全部邮件、编码的中文主题与正文解码、HTML 只留文字、服务器上的标志与邮件不变（只读，零删除）、再读不重复、新到一封只读这一封、助手按主题搜到并读全文、分类后待办进收件箱。线上用不存在的 Gmail/QQ 地址试接入，两家服务器都回「拒绝登录」，说明托管服务器到外部 IMAP 的网络、TLS 和协议是通的。还没验证的只剩用真实邮箱的授权码登录成功这一步（需要一个真实邮箱）。
- 设置 → 日历与连接 →「邮箱（只读）」：接入、移除（授权码一并删除）、开关自动整理、现在读新邮件、最近整理的邮件；「需要回复的邮件，先起草再提醒我」开关与最近起草的回复（§3.1）。

## 3.1 需要回复的邮件：先起草，再主动提醒（2026-10-19）

对标 Meta Muse 的邮箱跟进（连上邮箱后按需读、有事主动来找人、敏感动作先问）。用户调研的信任边界：读邮箱可以，发送、承诺、付款永远是本人；行业共识是「先草稿后批准」，每个 AI 动作可撤销、有日志。Crossline 更进一步：**根本没有发送路径**——收件箱和已发送都以 EXAMINE 只读打开，没有 SMTP、没有 APPEND、没有移动或删除，草稿只是本机/服务器上的一个文件。

- **何时起草**：整理把一封信归为 `reply` 且 `waitingId` 为空（真人或办公室写给本人、等本人答复，不是在等的回信）。从服务器现读全文，交给 `crossline-mail-reply-drafter`。
- **为什么是新 Skill 而不是工具型助手的 `runFree`**：起草只需要一封信和一份结构化答复，用不着函数循环、任务目录和待确认的审阅队列；低档模型一轮结构化输出，token 约为助手一次运行的十分之一、几秒完成，也不占助手的 lane。起草时模型还会再判断一次是否真的需要回复（`needsReply`，自动通知、钓鱼等不起草）。
- **草稿**：写成文件 `<data>/mail-drafts/<workspace>/<id>.md`，第一行是「由助手起草，需本人确认后自行发送。Crossline 不会发送这封邮件。」；需要本人决定的事（时间、价格、接受与否）留成【请确认：…】占位，不替本人承诺；校验拒绝「已发送」之类的说法。两封信的正文都只在这个文件里（以及邮箱服务器上）。账本只记元数据：`mail.replies`（发件人、主题、原因、草稿要点、对方要求的答复日、文件名、通知时间）和事件 `mail.reply.drafted` / `mail.reply.closed`。删除账号或清空数据时这个文件夹一并删除。
- **主动提醒**：`sayToPerson` 一条消息——谁来信、什么事、为什么需要回复、草稿要点、对方希望几号前答复；按钮「看草稿」（材料页 `/materials/view`，旁边有复制、已回复、不用回）、「复制草稿」（只复制正文，卡片不关闭）、「已回复」、「不用回」（记为已处理，不再提醒）、「少问这类」（nudge 静音一周，期间也不起草）。页面上没人时推到桌面和手机。遵循 nudges 的规则（`mailReplyQuiet`）：23:00–08:00 不说、计时中/日历事件进行中/20 分钟内刚答过不说、通知级别「关闭」不说；被拦下的消息在下一次安静的时候再说。
- **上限**：每个邮箱每天最多 5 封草稿（按本人时区的日期算）；同一封信只起草一次；起草因模型或额度失败的信排队三天内重试。
- **跟进**：每 15 分钟（与读新邮件同频）只读打开「已发送」（RFC 6154 special-use `\Sent`，否则按常见名称），按 In-Reply-To 或「收件人 + 去掉 Re: 的主题」找到本人的回信，就关闭这条提醒（`by: "sent_found"`）；本人点「已回复」「不用回」同样关闭。关闭会把相关消息的按钮标成已选、未推送的不再推送。通知 48 小时后仍没回、且对方邮件里有答复日期的，再提醒一次（只一次）。
- **设置**：邮箱卡片上「需要回复的邮件，先起草再提醒我」（默认开，`mail.replyDrafts`），下面列最近起草的回复（待回复 / 已回复 / 不用回，以及是否在已发送里找到），每条可看草稿、复制、标记。
- 代码：`packages/core/src/mail.ts`（schema、校验、草稿文件格式、安静规则、提醒时机）、`packages/connectors/src/imap-mail.ts` `sentReplies`、`packages/db/src/mail-replies.ts`（关闭与列表，web 与 worker 共用；关闭是追加事件，不与 worker 改写列表竞争）、`apps/worker/src/mail-replies.ts`、`apps/web/lib/mail-drafts.ts`、路由 `/api/mail/drafts/[id]/file`、`/api/mail/replies`、`/api/mail/replies/[id]`。测试用假 IMAP 与假模型：`apps/worker/src/mail-replies.test.ts`、`apps/web/lib/mail-drafts.test.ts`。

## 4. 自动化（n8n 式，端到端）

一个自动化 = 触发器 + 动作 + 步骤，存在 `automations` 设置里（`packages/core/src/automations.ts`，引擎在 `apps/worker/src/automations.ts`）。

- 触发器（看触发器不花模型钱）：
  - `schedule` 每天/工作日/每周几的某时；`interval` 每 N 小时；
  - `mail` 新邮件（发件人包含、主题/开头含关键词）；
  - `watch` 公开 https 网页文字变化（每 N 小时读一次，首次为基线，变了才触发，并把新增的行交给助手）；
  - `file` 新上传或授权文件夹里的新文件（关键词）；
  - `task` 任务完成验收 / 明天到期（可限定主线）。
- 动作：`run`（助手按说明做一轮，工具模式或电脑主人的 shell 模式）或 `remind`（只发一句提醒）。
- 建立：输入框说一句（`workflow.request` → `automation.requested`）或在设置 →「自动化与助手」写一句 → `crossline-automation-designer`（中档）设计成触发器和步骤 → `validateAutomationPlan` 检查（发送/回复/发布/上传/付款的步骤一律改为本人做；watch 只接受公开 https）→ 安装并通知本人「已建好……按什么条件运行，按什么理解建立」。本人明确要的，所以这类工作的助手类别随之开启（消息里说明，可在设置里关）。
- 生长：
  - 说「把那个邮件整理改成每天早晚各一次」，设计器拿到已有自动化列表，`replaces` 指向它，原地改好，运行次数保留；
  - 同一条主线上同类杂事被助手做过两次且都被采纳（沿用 `growCandidates`），会问一次「要不要以后自动做」，按钮直接走输入框的 `workflow.request`；
  - 电脑主人的重复杂事仍按原来的方式长成 skill（`workflow-smith.ts`）。
- 运行：不限每天次数（2026-10-19 本人决定；用量由账号自己的额度或开发者模型的月度上限约束）；助手一次只做一件，忙时排队一天内重试；每次结果一条消息（页面上没有人时推到手机和桌面），带产出文件链接；需要本人看的进待确认。
- 何时停：本人一周没动静（`dormant`）就不再跑；离开 2–7 天（`cooling`）照常跑（与收集分析同级）；后台任务里暂停「助手代办与自动化」即停。
- 设置 →「自动化与助手」→「自动化」：新建、立即运行、暂停/恢复、删除、最近运行。

## 4.1 助手产出文件夹（托管版，2026-10-19）

本人决定：「只考虑托管版，写到附属文件夹，允许通过浏览器下载」。助手不改动本人上传的原文件；每次运行做完交出的文件本来就留在它自己的任务目录里，「助手产出」是这些目录的一个文件夹视图（`apps/web/lib/outputs.ts`，设置 → 自动化与助手 →「助手产出」卡片，`GET /api/outputs`）：按主线、再按任务（日期 + 标题）排列，只列交付物（脚本、缓存、运行记录按待确认页同一套规则略去），已接受和待确认的都在，被退回的和正在生长的工作流不在。每个文件可单独下载；一个任务、一条线或全部可打包成 zip（`GET /api/outputs/zip?task=|line=`，`apps/web/lib/zip.ts` 流式写出，一次只在内存里放一个文件，中文文件名用 UTF-8 标记；一个包最多 400 个文件、300 MB，超出的部分不放进包里，响应头 `x-crossline-truncated` 说明，改按线或按任务下载）。自动化的运行归到它所在的主线，找不到主线的放在「其他」。

## 4.2 运行中向本人提问（2026-10-19）

用 Codex 自带的 `request_user_input`：两种助手（工具型、本人电脑上的 shell）运行中遇到只有本人知道、又决定做法的一件事时，可以停下来问。问题写进账本（`agent.question.requested`），在待确认的「助手」里显示，选项或自己写都可以，同时推一条消息到手机。10 分钟内没回答记为过期，助手按最稳妥的做法继续，并把问题写进总结的「需要本人」。每次运行最多问本人两次，问过的问题和回答记在 `audit.json` 的 `questions`。

## 5. 与其他功能的连接

| 来源 | 去处 |
|---|---|
| 邮件里的待办/日期 | 收件箱 → 收集分析 → 任务、日历 |
| 等待的人回了邮件 | 待决事项里的等待项提前，写明哪封 |
| 有人等本人回邮件 | 助手起草回复存为文件，主动提醒；本人在已发送里回了或点「已回复」即关闭（§3.1） |
| 自动化触发 | 助手运行，产出进任务目录与消息；`add_to_inbox` 进收件箱 |
| 任务完成/到期 | 自动化触发（如归档材料、准备清单） |
| 新文件 | 自动化触发（如归档、做索引） |
| 输入框 | 建立/修改自动化；看到自动化列表和邮箱数量 |
| 助手（工具模式） | 读本人的文件、任务、事实、日历、邮箱 |

## 6. 边界（没有变的）

- 不发送、不回复、不发布、不付款、不登录第三方网站代读（读需要登录的网站仍只在电脑主人的电脑上，`site-reader.ts`）。
- 不写本人电脑上的原始文件；整理文件是复制进任务目录。托管服务器上「本人的文件」就是上传的文件和产出。
- 邮箱只读；Outlook 不支持。回复只起草成文件，发送永远是本人在自己的邮箱里做（§3.1）。

## 8. 沙箱 shell：在 Codex 自带的 Linux 沙箱里给所有人真正的 shell（已实现，默认关）

Codex 是 vendor 进来的（`vendor/codex`，写这段时是 rust-v0.155.0，2026-10-20 起 rust-v0.163.0），它自带 Linux 沙箱（bubblewrap）和权限配置文件（`[permissions.<id>]`，可只放行指定目录的读取）。在它的基础上不改 Codex 本身就能做到模型无关的 shell 助手：

- `agent.sandbox`（`packages/codex/src/agent-mode.ts` `sandboxProfile`）：线程不再用 `danger-full-access`，而是命名配置 `crossline-task` —— `:minimal`（系统目录）只读、输入只读、任务目录可写、`/data` 与 `/state` 拒读（拒读项同时让 Codex 永远不会「无沙箱重跑」）、网络关闭；命令的环境只继承核心变量（`shell_environment_policy.inherit = core`，HOME/TMPDIR 指向任务目录）。启动后核对 `activePermissionProfile`，不对就拒绝运行（`SKILL_SANDBOX_UNSUPPORTED`），启动重试时也绝不丢掉这些配置。
- 审批仍是 `untrusted`：每条命令照样先问 Crossline 的守卫。
- 命令没有网络，联网走 `web_search`/`web_fetch` 函数；本人的任务、文件、邮箱和收件箱走工具型助手的同一组函数（不含文件函数，文件用 shell 自己读写）。
- 走模型闸门（共享服务器上与其他后台运行一起排队），跑在账号自己的运行时上；第三方模型也能驱动（`capabilities.shell` 随探测结果打开）。
- 何时启用：服务器环境 `CROSSLINE_SANDBOX_SHELL=on`，且启动时探测（`apps/worker/src/sandbox-probe.ts`）能找到 bubblewrap 并真正起一个沙箱；否则自动回到工具模式，日志 `worker.sandbox_shell` 写明原因。电脑主人自己的电脑仍是原来的完全权限 shell。

**要在托管服务器上打开，需要本人决定并改部署**（没有改）：镜像里装 `bubblewrap`；worker 容器允许创建用户命名空间（自定义 seccomp 配置或 `seccomp=unconfined`，以及 `apparmor=unconfined`；Ubuntu 23.10+ 还要关 `kernel.apparmor_restrict_unprivileged_userns`）。代价：在共享服务器上运行其他账号的命令，用户命名空间扩大了内核攻击面；CPU 与内存仍受容器上限约束，命令没有网络。

## 7. 没做的

- Outlook/Microsoft 365 的 OAuth 读取（需要 Entra 注册与审核）。
- 往授权文件夹回写（本人电脑上的整理）：需要本人决定是否放开。
- 自动化之间串联（一个的产出作为另一个的触发）：目前通过「新文件」「任务完成」间接实现。
- 工具模式不运行脚本、不剪辑音视频；需要时只在电脑主人的 Codex 上。

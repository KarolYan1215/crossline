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
- 整理（`crossline-mail-triage`，低档模型，intake 类）：每封归为 待办 / 日期 / 回复了等待项 / 知悉 / 略过。待办和日期写成 capture（带来源邮件），走收集分析变成任务，一次最多 5 条；「回复了等待项」写 `waiting.mail_seen`，待决事项里对应的「……到了吗？」立即提前并写明是哪封邮件；其余不动。可按邮箱关掉自动整理。
- 实测（2026-10-19）：`scripts/mail-imap-e2e.ts` 用真实 Dovecot（本机）走 worker 的同一套代码，993（TLS）与 143（STARTTLS）各 13/13：错误授权码被拒且说清原因、正确的接入、授权码不进账本、首次读到全部邮件、编码的中文主题与正文解码、HTML 只留文字、服务器上的标志与邮件不变（只读，零删除）、再读不重复、新到一封只读这一封、助手按主题搜到并读全文、分类后待办进收件箱。线上用不存在的 Gmail/QQ 地址试接入，两家服务器都回「拒绝登录」，说明托管服务器到外部 IMAP 的网络、TLS 和协议是通的。还没验证的只剩用真实邮箱的授权码登录成功这一步（需要一个真实邮箱）。
- 设置 → 日历与连接 →「邮箱（只读）」：接入、移除（授权码一并删除）、开关自动整理、现在读新邮件、最近整理的邮件。

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

## 5. 与其他功能的连接

| 来源 | 去处 |
|---|---|
| 邮件里的待办/日期 | 收件箱 → 收集分析 → 任务、日历 |
| 等待的人回了邮件 | 待决事项里的等待项提前，写明哪封 |
| 自动化触发 | 助手运行，产出进任务目录与消息；`add_to_inbox` 进收件箱 |
| 任务完成/到期 | 自动化触发（如归档材料、准备清单） |
| 新文件 | 自动化触发（如归档、做索引） |
| 输入框 | 建立/修改自动化；看到自动化列表和邮箱数量 |
| 助手（工具模式） | 读本人的文件、任务、事实、日历、邮箱 |

## 6. 边界（没有变的）

- 不发送、不回复、不发布、不付款、不登录第三方网站代读（读需要登录的网站仍只在电脑主人的电脑上，`site-reader.ts`）。
- 不写本人电脑上的原始文件；整理文件是复制进任务目录。托管服务器上「本人的文件」就是上传的文件和产出。
- 邮箱只读；Outlook 不支持。

## 8. 沙箱 shell：在 Codex 自带的 Linux 沙箱里给所有人真正的 shell（已实现，默认关）

Codex 是 vendor 进来的（`vendor/codex`，rust-v0.155.0），它自带 Linux 沙箱（bubblewrap）和权限配置文件（`[permissions.<id>]`，可只放行指定目录的读取）。在它的基础上不改 Codex 本身就能做到模型无关的 shell 助手：

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

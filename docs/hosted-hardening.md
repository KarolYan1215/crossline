# 托管版加固：从「本人自用」到「给外人用」（2026-11-05）

起因：2026-11-04/05 的托管版走查（W-218–W-221）之后，本人问「我现在可以以用户的身份生产级使用了吗」。结论是本人自用可以，给外人用还不行，问题分七类。同一天仓库改成公开，又多出一类更急的问题。本文写每一类：查到了什么、怎么决定、做到哪一步。决定由本人在 2026-11-05 做出（对话里的四个选择题），代码里引用本文的段号。

## 0. 结论与状态

| § | 问题 | 决定 | 状态 |
|---|---|---|---|
| 1 | 公开仓库：Actions 日志与制品人人可读 | 删除全部历史运行；开密钥扫描与推送保护；之后的运维输出只以本机公钥加密 | 已做 |
| 2 | 没有 CI 闸门 | 新建 `ci.yml`（Linux，typecheck + test）；`main` 上的镜像构建等它通过再跑 | 已做 |
| 3 | 托管版在服务器上登录访客的 ChatGPT 订阅 | 访客不再在服务器上登录 ChatGPT：本人电脑当算力节点，或 API key；已登录的保留 | 已做 |
| 4 | 小红书从机房 IP 用程序操作的浏览器读取 | 托管版只在本人节点的浏览器里登录和读取 | 已做 |
| 5 | 待确认太多（走查时 37 条） | 可撤销的默认通过，其余按断点批量；本人决定的项合并成一张卡 | 已做（见 §5） |
| 6 | 访谈缺陷 W-183–W-186 | 逐条修 | 未做 |
| 7 | 节点：一台电脑一个账号、改配后 shell 开关复位、换运行时后 `SKILL_THREAD_LOST`、额度共享 | 逐条看 | 都是设计或已自动恢复（见 §7） |
| 8 | 服务器内存（worker 75%） | 每个子进程单独 cgroup，Chromium 限堆 | 设计，未做；§4 之后服务器不再开读取浏览器，压力已下降 |

## 1. 公开仓库

**查到的**
- 仓库公开以后，所有 Actions 运行的日志和制品，**包括公开之前的**，任何登录 GitHub 的人都能读。
- `server.yml` 的诊断输出里有本人和测试账号的邮箱、workspace id、服务器 IP，还有虚构人格访谈的原文。
- 当时有 601 个制品。备份制品是 AES-256 加密的，内容不可读，但谁都能下载。
- 密钥扫描（secret scanning）和推送保护是关的。
- 历史提交里扫出来的只有测试夹具和 `vendor/codex` 的占位串，没有真密钥（自写扫描器；gitleaks 要 Docker，当时没开）。

**做了**
1. 开了 `secret_scanning` 和 `secret_scanning_push_protection`（`PATCH /repos/{o}/{r}` 的 `security_and_analysis`）。公开仓库免费。
2. 先把最近 3 份加密备份下载到本机 `backups/hosted/`（这个目录在 gitignore 里），然后用 `DELETE /repos/{o}/{r}/actions/runs/{id}` 删除了全部已完成的历史运行。日志和制品随运行一起删除，不可恢复。
3. `server.yml` 不再往作业日志里打印任何东西：
   - SSH key 之后的每一步，第一行都是 `exec >>"$RUNNER_TEMP/ops.log" 2>&1`。
   - 最后一步（`if: always()`，失败时也跑）用 gpg 把这份日志加密给本人的公钥 `.github/ops-log-key.asc`（指纹 `DADCC038ED848A9BDE023BA2E7E937A58B1A6897`），作为制品 `ops-log-<run id>` 保留 14 天。
   - 人格走查的 `persona.tgz` 同样加密后再上传。
   - 私钥只在本人电脑的 `~/.crossline-ops-gnupg`。用 `sh scripts/ops-log.sh <run id>` 解密阅读。
   - 私钥丢了就重新生成一对，提交新的公钥；旧日志读不了也无妨，最长只留 14 天。

**没有做的，以及原因**
- 没有把运维挪进私有仓库：那样要在私有仓库里重填 `DEPLOY_SSH_KEY` 和 `BACKUP_PASSPHRASE`（只有本人能填），而加密输出已经堵住了泄露。
- 没有轮换密钥：诊断脚本一直只打印「是否已填」（`filled`/`empty`）和计数，从不打印密钥本身。被删的日志里也没有密钥原文。
- 如果本人想更稳妥，轮换顺序是：DEPLOY_SSH_KEY → Resend SMTP → SiliconFlow 赞助 key → BACKUP_PASSPHRASE。BACKUP_PASSPHRASE 一换，旧备份要用旧口令解。

**以后的规矩**
- 任何新的工作流步骤都写进 `ops.log`，不写作业日志。
- `images.yml`、`verify.yml` 只输出构建和测试信息，不碰账本或服务器。

## 2. CI 闸门

- `verify.yml`（Windows，`pnpm verify`）自 2026-10-16 起因 Actions 计费失败没有跑过。
- 公开仓库的标准 runner 不计费，但 GitHub 把 `verify.yml` 的登记留在了 `deleted` 状态：`gh workflow enable` 回 403，删除回 404，只有 GitHub 支持能清。
- **做了（2026-11-05，本人的决定）**
  - 新建 `.github/workflows/ci.yml`：Linux，`pnpm typecheck` + `pnpm test`，和 pre-commit 钩子跑的一样。每次推送都跑，只改文档的推送不跑。
  - 删掉 `verify.yml`。它的 Codex 分支来源检查改为手动跑 `scripts/verify-codex-fork.ts`。完整的 `pnpm verify`（含 e2e）仍是提交前的本机检查。
  - `images.yml` 改由 `workflow_run` 触发：`main` 上的 CI 通过后才构建镜像，并且构建的是 CI 测过的那个提交（`workflow_run.head_sha`）。手动触发（`workflow_dispatch`）照旧可用。每次部署因此多等 CI 的时长。

## 3. 托管版不再在服务器上登录访客的 ChatGPT

**查到的**
- OpenAI 的 Codex 认证文档写明，用 ChatGPT 账号登录（含设备码）面向本人自己运行的 Codex。
- 第三方应用用「Sign in with ChatGPT」来调用用户的订阅：开源或本地运行的应用可以自助接入；远程托管的应用要填意向表或成为合作方。
- 自动化场景，文档推荐用 API key。
- 使用条款禁止共享账号凭据。

托管版的做法是在开发者的服务器上替每个访客保存一份 ChatGPT 登录，正好落在「远程托管」这一侧。

**决定（2026-11-05）**：托管版不再在服务器上替访客登录 ChatGPT。访客有三条路：
- 在自己电脑上开启「作为算力节点」，模型在那台电脑上用本人的 ChatGPT 登录运行。这是本地运行，属于允许的一侧。
- 填写 API key。
- 申请开发者提供的模型，用邀请码。

已经登录的访客保留现状，何时清理由本人决定。本人自己的账号跑在本人自己的服务器上，不受影响。是否提交合作方意向表，由本人决定。

**做了**
- supervisor（`packages/codex/src/index.ts`）
  - 托管版（`CROSSLINE_PUBLIC_BETA=1`）里，访客的 `chatgpt` 和 `chatgptDeviceCode` 登录一律回 403 `HOSTED_SUBSCRIPTION_LOGIN_OFF`。这条规则在服务端执行，不靠界面隐藏按钮。
  - 访客的账号状态带上 `subscriptionLogin: "off"`。
  - 账号状态还带上 `connected`：只有节点、在服务器上没有登录的访客，也算已连接，访谈不会卡在连接页。
- 界面
  - 模型连接卡：托管版的访客看不到设备码按钮和步骤，看到的是原因和「去开启算力节点」（跳到 `/settings#device`）；API key 表单照旧。
  - 连接页：提示文字改成先开节点。
  - 访谈页：把 `connected` 当作已连接。
  - 连接页上一步一步装节点（`apps/web/app/connect/node-setup.tsx`）：托管版的连接页直接列出五步——下载安装包和图文教程、SmartScreen 的「更多信息 → 仍要运行」、在这一页填配对码、在节点页登录 ChatGPT、连上后自动进入访谈。配对码就在这一页填（`ComputeNodeRow`，每 5 秒查一次）；以前只在 设置 → 通用 里，新用户第一天找不到。
- 测试：`codex.test.ts`「on the hosted server a guest's ChatGPT is never signed in there」；`connect-flow.test.tsx` 的托管版用例。

## 4. 小红书只在本人节点的浏览器里读

**查到的**
小红书风控常见的返回码：

| 码 | 含义 |
|---|---|
| 461 / 471 | 验证码（471 且 verifytype 120 是短信验证） |
| 300011 | 账号安全限制 |
| 300012 | IP 被封；机房 IP 很常见 |
| 300013 | 访问太频繁 |
| 300015 | 浏览器环境异常 |

- 社区报告里，2026 年有用机房 IP 加自动化浏览器读取而被封号的例子。
- 一致的建议是：在本人自己的设备和网络上读；读与读之间隔开几分钟；遇到验证就停下，交给本人。

**决定（2026-11-05）**：托管版的服务器不再为小红书开浏览器，登录不开，读取也不开。本人的节点在线并提供浏览器时，读取在节点上进行（`docs/compute-node.md`「浏览器读取放到节点」）；节点不在线就不读。

**做了**（`apps/worker/src/workflow-smith.ts`、`index.ts`）
- `FavouritesCollector.onServer`：托管版为 `false`。
- 没有节点浏览器时，`startFavouritesRun` 回 `NEEDS_OWN_COMPUTER` 并说明原因，什么都不打开。到点的运行会提醒本人一次（每天一次），不会被记成已运行。
- `openWorkflowLogin` 在托管版对收藏工作流回 `NEEDS_OWN_COMPUTER`。登录改在节点第一次读取时，在节点弹出的窗口里做（`loginOnNode`）。
- 新建的「按话题整理小红书收藏」工作流，风险说明改了：
  - 旧文「从服务器（香港数据中心）发出……7 天内不再读取」是错的。实际行为是停下，等本人点「立即运行」（W-218）。
  - 新文说明读取在本人电脑上进行，遇到验证或限流就停，等本人。
  - 已经建好的工作流：worker 每次启动时改写成新文（`refreshFavouritesTopicsText`，访问和风险两段是代码的文字，不是本人的）。本人的同意保留：变化只降低了当初同意的风险。测试在 `workflow-smith.test.ts`。
- 判断规则已经覆盖 461、471、429 和 300011–300019（`packages/core/src/xhs-notes.ts` `judgeXhsApi`），遇到就停下并暂停这个站点，等本人点「立即运行」。这比按等级冷却更保守，所以不另加冷却。461/471 的测试在 `favourites-reader.test.ts` 和 `workflow-smith.test.ts` 里。
- 测试：`workflow-smith.test.ts`「on the hosted server the favourites are never logged in to or read there」。

**代价**
- 本人的账号在托管版上也一样：节点要开着才读。
- 本人的节点目前配对在测试账号上，要改配回主账号。

## 5. 待确认太多

- 走查时待确认里有 37 条，每条都要本人点。
- 依据：
  - Horvitz 的混合主动原则：只在收益大于打扰时才问。
  - Fitz 等 2019：通知按批推送，大约一天 3 次。
  - Iqbal & Bailey 2008：打扰放到任务的断点。
  - Raskin：用撤销代替确认。
  - Linear 的分诊收件箱：先进收件箱，过时自动处理。
- 设计
  - 可以撤销、只影响本人日程和任务的项（合并、改截止、排程差异）：默认通过，在「已归档」里能撤销。待确认只显示一条摘要「今天自动处理了 N 项，可撤销」。
  - 不可撤销或对外的项（发信、报名、外部写入）：照旧要本人确认，按断点批量推送，一天最多 3 批。
  - 衡量：待确认的中位条数，以及撤销率。撤销率高的类别退回到要确认。
- **做了（2026-11-05）**
  - 默认通过（`apps/web/lib/answer-all.ts` 的 `autoAnswerDue`，由 `attentionPass` 每 10 分钟调用）：
    - 范围就是「全部按推荐」能安全处理的那些——风险汇总、错过的时段、关系核对（`ANSWER_ALL_KINDS`），加上已过期的提议。助手的结果不在这里：worker 的 date-advance 一天后已自动采纳安全的结果。
    - 一项等了 48 小时（`raisedAt` 起算；没有提出时间的项——每周的风险汇总就是——从第一次被看到起算，记在 `asks.autoAnswerSeen`）就按推荐处理，整批放进一次撤销，24 小时内可撤，并在当天的对话里说一次「…等了 48 小时没有回应，已按推荐处理」，带「撤销」。
    - 处理过的项记在 `asks.autoAnswered`（问题的 id 加指纹）。本人撤销后，那一项留给本人，不会再被自动处理。
    - 机会（opportunity_need）不在其中：撤销的快照不包括机会的关注记录。逾期任务要本人填日期，也不在其中。
  - 批量推送（`apps/worker/src/notify.ts` 的 `planNotifications`）：同一时刻有两项以上要打扰，就合成一条「N 件事等着决定」，列前三项，打开待确认。这一条只占当天额度的一次；它代表的每一项都记为已发送（kind `covered`），不会再单独推。
  - 测试：`asks.test.ts`「a safe decision left 48 hours takes its recommendation by itself」；`notify.test.ts` 的批量用例。
- **合并（W-228，2026-11-05）**：不默认处理的那几类（本人 11-05 决定：逾期里程碑、逾期任务、机会），两项以上合成一张卡（`apps/web/lib/ask-fold.ts`），「逐个处理」拆回单张，拆开的那些以后保持单张，新来的再合并。
  - 已过的截止：「N 项截止已过，等本人决定」，列出每项和它的截止。
  - 要不要盯：「N 个机会来源等本人决定要不要盯」，可「都盯住」；一条 14 天没回应就不再问（`WATCH_ASK_DAYS`），仍是提议，留在机会页，不记成「不要」。

## 6. 访谈（W-183–W-186）

见 `docs/walkthrough-ledger.md` 对应条目：
- W-183：课程时间说错。
- W-184：问题答了还再问。
- W-185：问题标题重复。
- W-186：快速模式下进度编号错。

未做。

## 7. 节点

- **一台电脑一个账号**：设计如此（方案 C：每个账号只用自己的电脑）。测试账号要用，就得改配。不改。
- **改配后 shell 开关复位**：`apps/worker/src/node/standalone.ts` 解除配对时整个重置成 `{site}`。改配的人要重新打开 shell 开关。这是有意的：换了账号，不沿用上一个账号的授权。不改，写进教程。
- **换运行时后第一次运行 `SKILL_THREAD_LOST`**（W-220）：线程建在服务器的运行时上，下一轮去了节点，节点上没有这个线程。复查（11-05）：保留线程的几处（小帮手 `concierge.ts`、访谈 `onboarding-session.ts`、说明书 `manualbook.ts`）都在同一次请求里接住这个错，用对话记录新开线程再答，本人看不到报错，只多一次往返。W-220 那次 25 秒的回答就是重建后的。不改。
- **额度共享**：节点用本人的 ChatGPT 登录，额度就是本人的。有意的。

## 8. 服务器内存（设计）

- 依据：
  - Chromium 峰值约 700–1100 MB。
  - codex app-server 运行几个小时后会慢慢涨。
- 做法：
  - 每个子进程单独限内存：`systemd-run --scope -p MemoryHigh -p MemoryMax -p MemorySwapMax=0`，或容器里的子 cgroup。
  - Chromium 加 `--js-flags=--max-old-space-size` 和 `--renderer-process-limit`。
  - 闲着的 app-server 定时回收。
- §4 之后服务器不再开小红书浏览器，最大的一块已经去掉。这一项等下一次诊断看到实际占用再定。

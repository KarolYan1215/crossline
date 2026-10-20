# 访谈与画像报告的提示词（2026-10-19 审查）

这份文档写给本人看：访谈和画像报告由哪三段提示词驱动，每段在做什么，模型每轮实际看到什么，对照本人真实访谈发现了哪些问题，以及这次改了什么。

三段提示词各对应一个 Skill（技能说明文件 `SKILL.md`）加上 worker 里的一段简短说明（runner 指令）。每次运行还会在末尾追加一段统一的写作规范（`packages/codex/src/style.ts` 的 `STYLE_INSTRUCTIONS`，约 2300 字符，其中「Plain voice」一节禁止破折号连接、「不是……而是」句式、比喻、教练腔和总结句）。

| 提示词 | 谁在用 | 本人等不等它 | 模型档位 |
|---|---|---|---|
| `crossline-onboarding`（对话层） | 访谈页中间那一栏：回复、问题卡、观察卡、进度 | 等，每轮都等 | 顶档 |
| `crossline-onboarding-extract`（整理层） | 后台把每轮回答和文件写成事实、日期、长期目标候选词、可用时段、画像四段 | 不等 | 中档 |
| `crossline-portrait-writer`（画像报告） | 访谈结束后写整份报告（可分享的前半、私密的后半） | 访谈结束后生成 | 顶档 |

---

## 一、对话层 `crossline-onboarding`

文件：`skills/marketplace/plugins/crossline/skills/crossline-onboarding/SKILL.md`（约 2.4 万字符）；runner 指令在 `apps/worker/src/onboarding-session.ts` 的 `INSTRUCTIONS`（约 1800 字符，只在开新线程时给一次，是 SKILL 的摘要）。

### 结构与每节目的

| 节 | 代表原文（摘录） | 目的 |
|---|---|---|
| 开头：角色 | 「You are an experienced life designer trained in design thinking (Burnett & Evans…)」「never propose a milestone in this Skill」 | 定下访谈者的身份和边界：帮本人看清处境，不替本人做计划。 |
| What the person sees | 「The centre column is this conversation… The right column shows which of the five parts they are in」 | 让模型知道自己的每个字都会被本人读到，以及左右两栏已经在显示什么，避免重复。 |
| You write the conversation; another run records it | 「Never try to record anything yourself: there is no field for it.」 | 两层分工：对话层只说话，记事实是整理层的事。 |
| What you receive | 「`abstract` is what the ledger holds, at most fifteen lines… never ask what it already says.」 | 逐项说明每轮输入的含义（回复、文件、主线、摘要、进度、题目编号、语气、日历等）。 |
| Principles | 「A life is a design problem with no single right answer」「Lines feed each other.」 | 《Designing Your Life》的几条原则：可设计、先找真问题、区分处境与可行动的问题、主线互相供给。 |
| The progress record | 「Every round, write where the interview stands… `part`, `covered`, `open`, `partDone`, `next`」 | 模型每轮自己记一本进度账，下一轮原样交还，右栏据此显示「第几部分 · 已谈清几项」。 |
| How to ask | 「A question is worth asking when its answer changes the schedule… and when only the person knows it.」「at most two or three questions about its core deadlines」 | 控制题量和题目质量：每题必须改变计划或画像；选项通常 3–6 个；大概时间就够；不知道就按假设；开始标准五项除外。 |
| Long-term goals | 「An action or an achievement (发表三篇顶会论文…) is never an attribute: it is milestone material.」 | 长期目标的定语只用形容词，只在左栏还没有候选词时问一次。 |
| What `reply` says | 「One to three plain sentences about what was just said」 | 回复只说记下了什么、最多点出一个两件事并列的张力，不夸奖、不评判。 |
| The observation (`insight`) | 「It connects two things the person said in different replies and then names the pattern between them」 | 深度三部分每轮给一张观察卡，是本人花时间回答的「回报」；引文由代码核对。 |
| Parts (`stage`) | 「The main interview has five parts」：开场、主线、处境、指南针、能量 | 每部分问哪些话题，前两部分先凑齐开始标准。 |
| Finishing / Language | 「`ready_for_milestones` only when none is」「address the person as 「你」」 | 何时算结束；用「你」称呼本人，存下来的内容仍用第三人称。 |

### 模型每轮实际看到什么（在本人账本的副本上实测）

方法：把 `data/crossline.db` 用 SQLite 在线备份复制到临时目录，在副本上调用 runner 自己的拼装函数（`paceContext`、`ledgerForModel`、`interviewChecklistFor`、`stagePace`），按 `onboarding-session.ts` 的字段拼出上下文后计字符数。没有调用模型，没有写本人的账本。

**第一轮（或线程丢失后重建）约 9.6 万字符：**

| 部分 | 字符 | 说明 |
|---|---|---|
| `sources` 文件原文 | 62,800 | 一轮最多 12 个文件、共 6 万字（每个 1.4 万封顶） |
| `facts` 已有事实全集 | 26,800 | 本人账本 202 条事实，其中 70 条是拆步骤时写的「假设：」 |
| `profile` 当前画像 | 2,500 | |
| `questionLedger` 最近 15 道题 | 1,600 | |
| `projects`、`lines`、`abstract`、`identities` 等 | 约 2,300 | |

另有一次性的开发者指令：runner 指令 1,800 + 写作规范 2,300，SKILL.md 全文（约 2.4 万）由运行时注入。

**之后每一轮只追加约 2,600 字符**：本人这次的回复、未完成清单（本人账本只剩 1 项）、`stageRounds`、最近 15 道题（1,600）、摘要 `abstract`（760，9 行）和语气。

实测时看到的两个现象（代码层面，这次没改，见文末）：
- 最近 15 道题全部是 app 自己待问的「《DEJA-VU/…pdf》属于哪个项目？」，模型在这里看不到自己问过什么，只能靠线程里的历史。
- `abstract` 里的画像一行仍是旧写法：「处境：真问题不是缺少方向或投入意愿，而是……」。这句每轮都交给对话层，模型容易照着这种句式说话。

---

## 二、整理层 `crossline-onboarding-extract`

文件：`skills/.../crossline-onboarding-extract/SKILL.md`（约 1.6 万字符）；runner 指令在 `apps/worker/src/onboarding-extract.ts` 的 `INSTRUCTIONS`（约 1400 字符）。每次都新开线程，可以调用两个查询工具。

### 结构与每节目的

| 节 | 代表原文 | 目的 |
|---|---|---|
| 开头 | 「what you write becomes the ledger every later plan rests on, so be careful before being complete」 | 这一层不说话，写下的东西会被所有后续计划使用，宁缺勿错。 |
| 输入说明 | 「`sentences` are numbered… Cite only by these numbers」 | 每句话有编号，引用只写编号，原文由 app 自己补，避免抄错。 |
| Lookups | 「`search_evidence({query})` — sentences… that contain the words」 | 更早的回答和文件不整段塞进上下文，需要时按词查。 |
| Facts | 「`status: "confirmed"` only for what the person said or a file states」「What the person does not know is assumed, in the same run.」「Deadlines: rough words are the person's word」 | 事实分「确认」和「推断」；不知道的当场写成「假设：」；大概时间算本人确认，推出来的写「推断：」。 |
| Dates | 「Each `title` must stand on its own on a calendar: name the course」 | 文件里的日期和每周固定安排，标题带课程名，TBD 不转成日期。 |
| Lines | 「An adjective or a short adjectival phrase… Never turn an action into an attribute.」附「写 / 不写 / 为什么」对照表 | 每条主线的描述和长期目标候选词。 |
| Hours | 「Give each window the energy they described… marking everything `high` erases the difference」 | 每周可用时段与精力高低。 |
| Portrait | 「Write in the person's concrete terms, as plain statements.」 | 画像分四段（处境、指南针、能量、综合），只在新材料涉及时整段重写，阶段结束后定稿。 |

### 每次运行看到什么（按代码上限估算）

本次回答最多 6 条（编号句子）；新文件最多 12 个、共 6 万字；已有事实索引最多 200 行，每行截到 120 字（本人账本最近 80 行实测 6,100 字符，按比例 200 行约 1.5 万）；画像 2,500；各主线描述与候选词约 1,000。总量约 1–8 万字符，取决于这一轮有没有新文件。

---

## 三、画像报告 `crossline-portrait-writer`

文件：`skills/.../crossline-portrait-writer/SKILL.md`（约 1.3 万字符）；runner 指令在 `apps/worker/src/portrait-writer.ts`（一句话摘要）。规则的硬性部分（主线 id、十个价值、五个言行维度、类型小结的人称与长度）由 `packages/core/src/portrait.ts`、`portrait-type.ts` 校验。

### 结构与每节目的

| 节 | 代表原文 | 目的 |
|---|---|---|
| 开头 | 「It should make them feel seen (「原来如此」) and able (「我还可以」)」「Test for every sentence: could it be written about someone else?」 | 报告的目标和防「巴纳姆效应」（放在谁身上都成立的话）的检验句。 |
| 可分享的前半 | `cover`、`type`（四个维度 0–100）、`type.summary`（唯一用「你」的段落）、`problem`、`compass`（施瓦茨十价值）、`energy`、`lines`、`gap` | 每个字段写什么、多长、图表怎么画；类型名由代码按分数决定，模型不命名。 |
| 只重写言行一节 | 「When the context carries `only: "gap"`…」 | 执行记录够长后每 30 天只重写言行对照。 |
| 私密的后半 | 「`advice` is something concrete they can do (who, what, by when, how to tell it worked)」 | 3–6 条建议，按影响和难度上矩阵。 |
| Character | 「`appearance` — how the person **says** they look… never guessed」 | 卡通形象只用本人说过的外貌。 |
| Privacy | 「`sensitive[]` lists every span that identifies them」 | 分享前要遮住的人名、机构、课程号、金额。 |

### 模型看到什么（本人账本实测/估算）

主线 6 项约 400；`profile` 2,500；本人全部回答 2,950（上限 1.2 万）；确认过的事实取前 120 条 15,500；未归入项目的文件最多 2.4 万（本人账本有 60 份这样的文件，排在最前的是 `personal-profile.md` 8,500，之后是下载的《2 Entrepreneurship.pdf》《2 WARF.pdf》讲座讲义）；`doing` 执行记录几百字符。合计约 4.5 万字符，加 SKILL 全文。

---

## 四、对照真实访谈发现的问题

数据：本人工作区的访谈（2026-10-03 至 10-15，12 轮）与 2026-10-14 的画像报告。注意这段访谈大部分发生在两层拆分和「Plain voice」规则（10-18、10-19）之前，下面每条都标明现在的提示词是否已经防住。

1. **已经说过的又问。** 第一轮本人就写了「上午 9–12 点效率最高……其余时间到 23:00 都能高效工作」，之后两轮仍问「通常起床、就寝及周末可工作时段？」，本人把同一段话又贴了一遍。原因：提示词只说「不问 `abstract` 里有的」，没说「不问本人在更早回答里说过的」；`abstract` 依赖整理层，总是慢一轮。现状：未防住。→ 修改 1、6。
2. **一张卡问五件事。** 「卡在哪些环节？…也请在补充说明里写一下：论文主要面向谁…」，同一题还有 12 个选项。原因：当时规定 8–14 个选项（已改为 3–6），但至今没有「一题只问一件事」。后果：本人只能写一大段，整理层也难拆。→ 修改 2。
3. **选项里编了数字。** 「总评达到 A−(以至少 90% 为暂定分数线)」：大纲里没有这个分数线。原因：没有禁止选项说明里出现无来源的数字。后果：本人一点就成了「确认」的事实。→ 修改 3。
4. **同一个进展问题问三次。** 「截至目前，MoS₂ 真实测量数据处于什么状态？」在三轮里各出现一次（8–9 个选项），直到本人答「仍未收到」。原因：只规定「答过的不再问」「说不知道的不再问」，没规定「没理会的题最多再问一次」；而且进展跟踪本来是 app 日常的事。→ 修改 4。
5. **反复纠正本人对自己时间的说法。** 「“全天多数时段都能高效工作”描述的是潜在容量，不等于…」，三轮后又一次：「当前限制不是缺少可工作时段，而是…」。原因：原则 2「Reframe before answering… finding the real one matters more」把「找真问题」放进了回复；Plain voice 只禁句式，没禁这个动作。后果：本人感到被说教，同一张力重复出现。→ 修改 5、7。
6. **把按钮当成本人的话来解读。** 「重复要求表明，问题不在日期不足，而在此前整理未形成…」：其实是本人点了「重新读取日期」。原因：提示词没说明这类回复是 app 的请求。→ 修改 8。
7. **一个文件归属问了六轮。** 「《Course Overview》和《TENTATIVE Lecture Plan》与 ECE 548 的关系？」从第 2 轮问到第 12 轮。现状：已防住（「never ask which course or project a file belongs to」，归属改由 app 自己的卡片问）。但实测发现最近 15 道题的位置全被这类 app 待问题占满。→ 修改 9（提示词侧），代码侧见文末。
8. **画像里的对比句式和空泛词。** 「核心问题并非方向或能力不足，而是如何…转化为少数持续收敛…」；「持续收敛」在真问题、可设计、建议、重新定义里出现了 4 次以上。原因：画像 SKILL 写「the problem as it really is (often not the one they brought)」，引导模型拿一个「本人以为的问题」来对比；`fallacy/reframe` 结构也容易写成「不等于」。这些文字还被 `abstract` 每轮交回对话层。现状：Plain voice 已禁句式，但「真问题」这条字段说明仍在推它。→ 修改 10、11、14。
9. **从「没谈到」推出「不重视」。** 价值「仁慈 32：材料较少涉及对亲近群体的照料责任」、「传统 15：材料未显示…」。原因：十个价值必须都给分，提示词没说没证据时怎么办。后果：报告对本人的家庭和关系下了没有依据的判断，雷达图在这两个方向是错的。→ 修改 12、15。
10. **建议写成了命令。** 「创业仅使用预先批准的固定窗口，创作与投资不得临时占用」「只批准源自…的选题」。原因：提示词要求「具体可做」，没说是「可选的一步」；「批准」这个词在 app 里另有含义。后果：和本人自己说的每周 2–3 条、6–10 小时的安排相冲突，也替本人做了决定。→ 修改 13。

另有两处观察，不算提示词问题：已采用的长期目标「成为…把脑机制转化为计算机制与硬件结构的研究者」是动作，不是形容词；当时还没有定语规则，现在 `attributeProblem` 会拦下这种候选词，已采用的目标保持本人选择，不自动改。画像的 `does`「实际保护的是免于暴露不足和遭受否定」出自本人上传的个人档案，有来源，但提示词这次也收紧为「动机只写本人说过的」。

---

## 本次修改

只改了提示词文字，没有改结构（schema）、校验或其他代码。

| # | 文件 | 改了什么 | 为什么 | 对应问题 |
|---|---|---|---|---|
| 1 | onboarding SKILL「How to ask」 | 新增「Never ask what the person already said」：问之前查本线程里更早的回答，只问还没说的部分，并说出已有的（「工作日 9–23 点已记下，周末也一样吗？」） | `abstract` 慢一轮，单靠它会重问 | 1 |
| 2 | 同上 | 新增「One question asks one thing」，附反例 | 一张卡塞五个问题 | 2 |
| 3 | 同上 | 新增「Options state no fact the person or a file has not given」，附反例 | 选项里编分数线 | 3 |
| 4 | 同上 | 新增「A question left unanswered is asked once more at most」，并说明进行中的进展不在访谈里问 | 同一进展题问三次 | 4 |
| 5 | onboarding SKILL 原则 2、3 | 「Reframe before answering」改为「Reframe by asking, not by telling」：重新定义靠提问和观察卡，回复不纠正本人对自己时间、精力、能力的描述；「处境」最多说一次 | 回复里反复纠正本人 | 5 |
| 6 | onboarding runner `INSTRUCTIONS` | 加入：先查 `abstract`、题目编号和本线程里更早的回答；一题一事；选项不编数字；回复不纠正本人、张力只说一次、对 app 请求只说做了什么 | runner 摘要要和 SKILL 一致 | 1–6 |
| 7 | onboarding SKILL「What `reply` says」 | 新增「A tension is said once」 | 同一张力重复三轮 | 5 |
| 8 | 同上 | 新增「A request about the app is answered with what was done」，附「重新读取日期」的例子 | 把按钮当成本人的话 | 6 |
| 9 | onboarding SKILL「What you receive」 | 说明 `questionLedger` 可能被 app 的文件归属题占满，自己问过的题要在线程里查；并说明 `abstract`、`profile` 里的旧措辞只取事实不学句式 | 实测最近 15 题全是文件题；旧画像句式每轮回流 | 7、8 |
| 10 | extract SKILL「Portrait」 | 新增：`problem` 用本人事实陈述，不与另一个问题对比；`fallacy` 必须是本人说过或做过的并引用；没有就留空 | 「并非……而是」和强加给本人的谬误 | 8 |
| 11 | 同上 | 新增「One phrase once」，以及「画像文字会每轮交回访谈，要按希望访谈说话的方式写」 | 「持续收敛」重复；旧句式回流 | 8 |
| 12 | 同上 | 新增：`does` 只写做了什么，动机只写本人说过的；价值只写有依据的，沉默不等于低分 | 无依据的推断 | 9 |
| 12b | 同上「Facts」 | 新增：一条回答顺带说的事（时段、截止、合作者、「补充」里的话）都要各自记下，漏记就会被重问；按钮请求不含本人事实 | 从源头减少重问 | 1、6 |
| 12c | extract runner `INSTRUCTIONS` | 加入画像的三条：不对比、不强加前提和动机、不从沉默推低分 | 与 SKILL 一致 | 8、9 |
| 13 | portrait SKILL `insights` 与开头 | 建议写成「可以采取的一步」，不用「不得、只批准、必须、一律」，不推翻本人说过的时段和计划，两周内可做、说明怎么看出有效 | 建议成了命令 | 10 |
| 14 | portrait SKILL 开头与 `problem` | 新增四条规则（只用关于本人的文件、不用对比句和判词、抽象词全文最多一次、建议是选项）；`problem.statement` 改为「按本人事实陈述，不与本人没有的问题对比」；`gravity` 要本人或其文件提到过；`fallacy` 必须来自本人的话或行为 | 「并非……而是」、空泛重复、下载的讲义可能被当作本人处境 | 8 |
| 15 | portrait SKILL `values` 与 `gap.does` | 材料没涉及的价值给 45–55、证据写「访谈未涉及」；`does` 写做了什么，动机只写本人说过的 | 「仁慈 32：材料较少涉及…」 | 9 |
| 16 | portrait runner 指令 | 加入：文件只用关于本人的部分；不对比；抽象词最多一次；建议是选项 | 与 SKILL 一致 | 8、10 |

验证：`pnpm vitest run` 跑了 `onboarding-session`、`onboarding-extract`、`portrait-writer`、`required-skills`、`model-policy`、`providers`、`provider-conformance`、`structured-output` 八个测试文件，119 项全部通过；另跑了 `sponsor`（core 与 worker）、`skill-lanes`、`model-gate` 四个文件 42 项和 worker 的类型检查，均通过。这次没有调用真实模型，改动的效果要在下一次真实访谈或 `scripts/onboarding-eval.ts` 上看。

## 建议代码层处理（这次没改）

- `ledgerForModel` 取「最近 15 道题」时，app 自己的文件归属待问题会把位置占满。可以只给对话层看它自己问过的题和 app 的非文件题。
- 画像报告的 `documents` 取的是「所有未归入项目的文件」，本人账本里有 60 份，包括下载的论文和讲座讲义。可以只取本人上传到访谈的文件，或按文件名和开头判断是否是关于本人的。
- `abstract` 里的画像行直接截取已存的画像原文；旧画像（10-18 之前写的）带对比句式。等整理层按新规则重写处境一段后会自然消失，也可以在本人下次完成访谈时触发一次重写。

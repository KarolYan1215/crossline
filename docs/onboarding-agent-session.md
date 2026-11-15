# 访谈重构：一个项目会话 + 工具出卡 + 子代理（设计，2026-11-14；D1–D7 已按推荐拍板，P0 已完成）

本人的要求（2026-11-14）：检查访谈的全部代码机制，把任务和机制更多交给模型；系统主要提供 Skill 和提示词，而不是硬写一套逻辑规定整个访谈。弹卡片这类功能做成模型调用的工具；多层设计包装成 harness 里起子代理的并行模式；整场访谈作为一个大项目会话处理。整理上下文的共享逻辑，整理访谈的 Skill 和 prompt，保证不丢上下文和规则。

本文分五部分：

1. §1 现状机制盘点：每个机制是硬编码还是模型判断，判定交给模型、留作确定性校验还是删掉。
2. §2 竞品与资源的批判分析，含成本和时延。
3. §3 新架构。
4. §4 规则「只写一处」的方案，以及怎样证明没有丢规则。
5. §5 分步迁移、§6 要本人拍板的取舍。

基线：`origin/main` cb8906acb1。行号都对这个提交。

缩写：

- 代码：
  - S = `apps/worker/src/onboarding-session.ts`
  - X = `apps/worker/src/onboarding-extract.ts`
  - QL = `apps/worker/src/question-ledger.ts`
  - WP = `apps/worker/src/onboarding-pace.ts`
  - R = `apps/worker/src/onboarding-research.ts`
  - TS = `packages/core/src/onboarding-turn-schema.ts`
  - GAP = `packages/core/src/profile-gaps.ts`
  - CL = `packages/core/src/interview-checklist.ts`
  - CP = `packages/core/src/onboarding-pace.ts`
  - CR = `packages/core/src/onboarding-reply.ts`
  - PP = `packages/core/src/profile-points.ts`
  - INS = `packages/core/src/profile-instruments.ts`
  - REF = `packages/core/src/onboarding-refs.ts`
  - DBI = `packages/db/src/interview.ts`
  - SR = `packages/codex/src/skill-runner.ts`
- Skill：
  - O = 对话 Skill `crossline-onboarding/SKILL.md`
  - E = 整理 Skill `crossline-onboarding-extract/SKILL.md`
  - RS = 调研 Skill
  - P = 画像撰写 Skill
  - style = `packages/codex/src/style.ts`

---

## 0. 结论先行

- **现在的问题不在「规则太少」。** 同一条规则常常写在三处：Skill、改写函数、页面。三处数字不一样，互相打架。

  从第三次回放到网站走查，每次修复都是「Skill 里写了，模型没照做，于是加一道代码闸门」。闸门大多是**事后静默改写**：删题、换题型、补开放题、截题数、等整理。模型不知道自己的输出被改了，下一轮只能从 `lastRound` 读到一句可能写错的原因。盘点出的 12 处机制冲突、25 处提示词冲突，大部分就是这样来的。

- **方向成立，但不能「全交给模型」。** 以下几类必须留在代码里：
  - 证据：引文逐字、网址来源、日期有据；
  - 安全：热线回合、披露回复不作素材；
  - 开始标准和本人才能做的动作：点选、评卡、结束、核对开始；
  - 写入合并。

  模型在这些事上自报不可信。其余的节奏、阶段、何时出什么卡、问什么、避免重复，交给模型，写在 Skill 和工具说明里。

- **新形态：**
  - 一个长会话主线程，就是现在保留的对话线程。
  - 主模型用 Codex dynamic tools 出卡。每个工具写进账本后立即返回；校验放在工具的 handler 里，**不合格当场作为工具错误还给模型，在同一轮改**，不再事后静默改写。
  - 整理、假设、画像、调研、审阅这些子代理由 worker 编排，不用 Codex 内置的 `spawn_agent`。其中假设和画像用 `thread/fork` 继承主会话上下文，整理和调研用新线程。
  - 账本是唯一真相源。每轮注入一段短的「状态头」，其余内容用读工具按需取。

- **先做小的。** 第一阶段只做三件事：清死代码、解决提示词冲突、建规则登记表。第二阶段只做「主会话 + 工具出卡」。子代理形态留到第四阶段，按用量数据决定加几个。

  多代理大约是聊天的 15 倍 token（Anthropic），Cognition 也明确反对并行写入。这两条决定了：**写入保持单线程，子代理只出提议**。

---

## 1. 现状机制盘点

判定一栏的含义：

- **删**：死代码，或新架构下没有用处。
- **交模型**：规则写进 Skill 或工具说明，代码不再执行。
- **工具**：改成模型调用的工具，handler 做确定性校验。
- **留**：确定性校验或本人动作，必须留在代码里。
- **子代理**：改由 §3.4 的子代理承担。

三份逐行盘点（core/web 160 行、worker 147 行、提示词 207 条）合并到下表。合并的原则：同一件事分散在几处的，合成一行，列出所有位置。

### 1.1 节奏、阶段、等待

| # | 机制（位置） | 现在 | 判定 | 说明 |
|---|---|---|---|---|
| 1 | 深度档位与轮数（共 5 处）：<br>- `DEPTH_PACE` 四档、`readDepth`/`depthPace` 恒为 open（`onboarding-depth.ts:17-88`）<br>- `roundsSpent`/`spent`/`endsHere`（S:593-603）<br>- `withoutNextStep`（S:880-886）<br>- `stagePace`/`moveOn`（S:877-899，`moveOnAfter`=∞ 从不触发）<br>- `readTone` 恒为 direct（TS:96-104） | 硬编码，已失效 | 删 | 还在每轮发 `tone`/`depth`/`stageRounds`（S:432、490-493），O:21 却叫模型忽略它们（提示词冲突 C3/C21） |
| 2 | 模型说 ready 后改成 ask（S:512-519）之后的整条结束分支：<br>- `markFinishing`（S:526-528）<br>- `FINISH_WAIT_MS` 90s<br>- 结束时的 `CHECKLIST_WAIT_MS` 300s<br>- `withChecklist`（S:718-737）<br>- `owed`/`portraitHolds`<br>- 拿卡片顶替开放题（S:584-589） | 硬编码，主访谈里走不到 | 删 | 「模型不结束访谈」改为直接不给模型结束工具 |
| 3 | `paceDeepRound` 截成 3 题（S:788-819）、`ROUND_QUESTIONS_MAX` 4、schema 上限 5（TS:548） | 硬编码节奏 | 交模型 | 这三个数各不相同，O:133 又说事实阶段「按需要」（worker 冲突 C3）。工具层只留一个上限：每轮 ≤5 题 |
| 4 | 阶段（共 5 处）：<br>- `ONBOARDING_STAGES`/`INTERVIEW_FLOW_STAGES`/`stageOrderFor`（TS:68-85，S:821）<br>- `PROFILE_MODULE_STAGES`/`holdGaps`（S:590-592）<br>- `DEEP_STAGES`（TS:90）<br>- 量表卡排程按阶段<br>- 画像各节按阶段定稿（X:447-461） | 阶段由模型自报，却有一串确定性机制跟着它走 | 交模型（阶段只作进度提示） | 这是 worker 冲突 C5：W-269 跳过处境之后，处境一节空着就定了稿。阶段不再驱动任何确定性机制，见 §3.6 |
| 5 | 补「整理滞后」的 7 个机制：<br>- `START_WAIT_MS` 60s（S:476-479）<br>- `BLOCKING_WAIT_MS` 30s（S:535-538）<br>- 空轮 `CHECKLIST_WAIT` 300s（S:568-572，仍会触发）<br>- `recording`、`linesAnsweredUnread`、`startStandard.answered`（S:130-149、373-382）<br>- `withoutRecordingTalk`（CR:88-95） | 硬编码等待加提示 | 删，合成状态头里的一项 `unrecorded` | 一轮最多多等 6.5 分钟以上。模型知道「哪些回复还没记下」就够了，见 §3.5 |
| 6 | 问题去重与重问（共 3 处）：<br>- `resolveRepeats`：相似度 0.85，同主线 0.6；`MAX_ASKINGS` 2；`DATE_UNDECIDED_MAX`（QL:10-146）<br>- `unsureAnswer`/`undecidedAnswer`/`freeTextAnswers`（core QL:27-123）<br>- `ledgerForModel` 15/80（QL:66-85） | 硬编码改写 | 交模型；问答记录用读工具查 | 按 bigram 相似度会删掉「往深一层的追问」（worker 冲突 C11），与 O:159 和第十二次回放的决定相反 |
| 7 | 空轮补题（共 3 处）：<br>- `withSomethingToAnswer`/`shownOrOpen`/`withFreshOpenQuestion`/`closingQuestion`（S:739-783、928-932）<br>- `OPEN_QUESTION`/`openStageQuestion`（CP:323-349）<br>- state 路由空回合补题（`state/route.ts:48-60`） | app 替模型出题 | 删 | W-184；2026-11-12「哪条主线」连问 9 轮 |
| 8 | `saidNothingMore`/`CLOSING_ASK`（CR:97-115） | 改写 | 交模型 | — |
| 9 | 注意力计时（`onboarding-attention.ts`）、`interviewCompleteness`（`interview-completeness.ts`） | 确定性度量 | 留；完整度注入状态头 | 结束按钮的下限仍是开始标准 |
| 10 | `finishInterview`、`FINISH_BUDGET_MS` 8 分钟（S:934-986） | 本人结束 | 留，改为派画像子代理 | — |

### 1.2 出卡

| # | 机制（位置） | 现在 | 判定 | 新形态 |
|---|---|---|---|---|
| 11 | `questions` 输出字段；`questionKind` 按 `DATE_ASK` 改成 free、按 `MANY` 改成 multi（TS:858-867）；前端 `QuestionCard` 自己跑 `DATE_ASK` 决定是否加日期框（`question-card.tsx:21-47`） | 模型写，app 改题型，前端各判一次 | 工具 | `ask`（选择或开放题）和 `ask_date`（日期题）分成两个工具，题型由模型选，不再按正则改（W-264 的根源） |
| 12 | 观察卡（共 5 处）：<br>- `insights` 字段（TS:242-255、596-600）<br>- `cardCandidates`/`cardFrom`/`CARDS_OFFERED` 4（PP:196-237）<br>- 卡与假设的绑定 `onRecord`/`offered`（S:656-684）<br>- `cardsWait`/`cardsCheck`（X:61-81，WP:84-85）<br>- 字面去重（S:645-670） | 模型写，app 筛卡、停卡、丢卡 | 工具 | `show_observation`。handler 里留 `checkInsight` 和披露排除；`cardsWait` 删（worker 冲突 C1，W-269 第 9–17 轮没有卡）。候选排序改成读工具的建议顺序。竞态 C8 消失：handler 用调用那一刻的账本判断 |
| 13 | 卡一展示就记 `cardKey`（S:695-701） | 展示等于问过 | 改 | 只有评过的才算问过；展示了没评的，下次还能再出（worker 冲突 C9） |
| 14 | 量表卡（共 2 处）：<br>- `cardsFor`/`cardsForRound`：短卡组，一轮合计 ≤3 题，离开画像模块后每轮 1 张，英文访谈不出（INS:120-160，S:560-567、802-814）<br>- O:144 写「每张 3 题、每轮 2 张」 | app 排程，与 Skill 数字不一 | 工具 | `show_scale_card{itemIds≤3}`。题库、记分、`mergeInstrumentAnswers` 留在代码里 |
| 15 | app 自己的问题（共 5 处）：<br>- `profileGaps` 的 8 类（GAP:88-313）<br>- `withGapQuestions`、`GAPS_PER_ROUND` 3（S:785-875）<br>- `gapCoveredBy`<br>- 左栏 held 题<br>- `interviewStatus` 的 extra 题 | app 往模型的轮里插题 | 改成状态头里的「待办项」 | 模型用 `ask`/`ask_date` 去问，并带 `fills: <待办项 id>`；本人的点选由 app 直接写成确认的事实，沿用 `answeredGapFacts`。文件归属和日期批次两类是簿记，仍是 app 卡。画像确认题删 |
| 16 | 长期目标（共 4 处）：<br>- `LINE_GOAL` 要 ≥3 个候选（GAP:72、119-136）<br>- `screenQuestions` 在 ≥1 个候选时删掉模型的目标题（DBI:149，GAP:573）<br>- `adoptGoalsFromRound`（`onboarding-workspace.tsx:178-187`）<br>- `answeredGoalQuestions`（GAP:434-447） | 三处门槛互相锁死 | 工具 | `show_goal_picker{lineId, candidates}`，什么时候出由模型定。三处兜底删掉。这样解开了 1–2 个候选时本人既选不了、也没人问的死结（worker 冲突 C6，W-269） |
| 17 | 屏蔽模型的题（共 2 处）：<br>- `screenQuestions` 的地点、日历可推、已知课表、重复四类，加 `screenAssumption`（GAP:517-602）<br>- `questionsOwnedElsewhere`（`interview-status.ts:21-36`） | 静默删题 | 交模型 | 规则写进 Skill：「能从文件、日历、常识推出的不问」 |
| 18 | `research` 字段；同时开着的线程最多 4 条（`RESEARCH_OPEN_MAX`），超出的静默丢掉（R:61-72） | 静默丢弃 | 工具 | `start_research`。满了返回错误，模型自己决定先关哪条 |
| 19 | 外观题 `APPEARANCE`（GAP:299-313） | app 卡，文案写「为本人生成」 | 交模型 | 用 `ask` 带 `fills:"appearance"`，对「你」说话（W-270） |
| 20 | 开场卡、开始核对（StartConfirm）、测评卡（AssessCard）、日期批次卡（DateBatchCard）、文件读取列表（FileReadList） | app 卡 | 留 | 开场是会话的结构化初始化；其余是本人动作或簿记。开场卡文案「每一轮都会给你一条观察」要改（与 O:217 允许 `[]` 冲突） |

### 1.3 改写模型输出

| # | 机制（位置） | 判定 | 说明 |
|---|---|---|---|
| 21 | `withoutToldStory`（CR:28-40）、`withPlainTerms`（CP:351-371）、`withoutCardEcho`（CR:61-86）、`researchCopied`（CR:42-59）、`falsifierCondition`（`insight-card.tsx:12-21`） | 交模型 | 都是文风或重复类的规则，Skill 里已经写了。卡片和回复分开以后，「回复复述卡片」这件事也不再发生 |
| 22 | `withoutEndHint`（S:916-924） | 留，改成拒收 | 开始标准不让模型自报。回复里说「可以开始了」而开始标准还没满足 → 拒收重写，不静默删句 |
| 23 | `inventedDates`（CR:117-149） | 留（拒收重写） | 不让模型编日期 |
| 24 | `safetyReplyOnly`、`handlesDisclosure`、`disclosureReplies`（CR:11-26，CP:70-89） | 留 | 安全边界 |
| 25 | `RoundEdits`/`lastRound`（S:69-84、624-641） | 删 | 不再静默改写。被拒的工具调用当轮就把原因告诉模型 |
| 26 | 修复循环、`keepEarly`、`softAccept`（SR:1137-1179，TS:944-998） | 留给最后那条消息；卡片的错误按调用逐个报 | 现在一处出错就整份重写，2026-10-16 有一轮两次修复用掉了 2/3 的时间 |

### 1.4 确定性校验（全部留，只改调用位置）

| # | 机制（位置） | 归属 |
|---|---|---|
| 27 | 引文与引用：<br>- 句子编号拼引文 `citedSpan`、`resolveOnboardingRefs`（REF:20-106）<br>- 只引点选行的不收 `TAP_LINE`、`ONBOARDING_ATTRIBUTE_FROM_CARD`<br>- 目标修改只认本人回复 `goalEdits`<br>- `itemScores` 没有引用就丢 | 整理子代理的输出校验 |
| 28 | `checkInsight`：引文逐字、≥2 条回复（待核实卡 1 条）、external 只能是网址（CP:50-68） | `show_observation` 的 handler |
| 29 | 结构校验 `checkTurn`：id/slot 正则、选项不重复、选择题至少 2 个选项（TS:704-798） | 各工具的 inputSchema 加 handler |
| 30 | 定语的形式和引用：`attributeProblem`/`notAtomic`（`line-attributes.ts`）、`candidatesProblem`（TS:896-931） | 整理子代理和 `show_goal_picker`。「每条线 3–12 个」的下限删掉（提示词冲突 C6：它诱导模型凑数） |
| 31 | 日期：`roughWindow`/`inRoughWindow`（`rough-dates.ts`）、`quoteSupportsDate`、`persistFileDates` | 整理子代理和 `ask_date` 的答案换算。E:44「粗略日期取窗口最后一天」改为按「开始」和「截止」分开取（W-268） |
| 32 | 量表：`mergeInstrumentAnswers`（弱答案不覆盖强答案）、`instrumentScores`、`readCardAnswers` | 留。改成结构化回传以后，`readCardAnswers` 可以简化 |
| 33 | 开始标准与闸门：<br>- `interviewChecklist` 的开始项、`readyToStart`<br>- `gateUntilReady`<br>- `/finish` 和 `/start-confirm` 不满足时返回 409<br>- `START_STILL_ORGANIZING` | 留。第六项 `profile_cards` 要不要算开始项，见 §6 决定 D4 |
| 34 | 评卡：`rateInsight`/`rateHypothesis`（`insight-rating.ts`，PP:114-155） | 留。W-267：「不准」要拆成两个意思，见 §3.3 |
| 35 | 画像合并：<br>- 要点 `applyPointChanges`<br>- 假设与职业 `mergeProfileInsights`、`numberNewHypotheses`、`settledOnCard`、`cleanHypotheses`/`cleanCareers`<br>- `researchUrls` | 留，在子代理结果的合并步骤里执行 |
| 36 | 来源与画像校验：`validateResearchTurn`/`researchFindings`、`validatePortrait`/`resolveWrittenClaims`/`typeSummaryProblem` | 留 |
| 37 | 输入与事实的保护：<br>- 本人回复截到 16k 字（web 侧拒收 12k 以上）<br>- 一次最多 12 份文件<br>- 推断不覆盖已确认（真正起作用的是数据库的 upsert 规则；core 的 `mergeFacts` 没有生产调用者，审查判为死代码）<br>- `portraitStillConfirmed` | 留 |
| 38 | 只做计算的展示：`capacityConflict`、`skeletonDraft`、`weekSkeleton` | 留 |

### 1.5 上下文与线程

| # | 机制（位置） | 判定 | 说明 |
|---|---|---|---|
| 39 | 首轮全量、之后每轮一大段增量 JSON（S:422-498），约 25 个字段 | 改成状态头加读工具 | 见 §3.5 |
| 40 | 各种截断常数：`LEDGER_SHOWN` 15、`OBSERVATIONS_SHOWN` 12、假设日志 16+16、要点 30、摘要 15 行、`FACTS_SHOWN` 200 | 改成读工具分页 | 现在的截断是「到第 13 条就看不到」，改成想看就能查 |
| 41 | 文件预算：每轮最多 12 份，单份 14k、合计 60k（S:35-39、168-187） | 改成 `read_file` 工具，带偏移 | 文件到达只作为一个事件进状态头 |
| 42 | 线程丢失重建 `SKILL_THREAD_LOST`（S:499-506、901-914） | 留，并修 | 现在重建出的历史不带观察卡和选项；超出预算的文件正文为空，却照样记成「已展示」（worker 冲突 C7）。改为从账本重建，带上卡片和工具结果 |
| 43 | 压缩：`COMPACT_AT` 0.6，自动压缩线 0.8（SR:61-71、1466-1520） | 留，加 `compact_prompt` | 每轮的状态头让压缩丢的东西有上界，见 §3.5 |
| 44 | 整理三通道（共 3 处）：<br>- 每次读 `REPLIES_PER_RUN` 6 条，画像通道 12 条<br>- `PORTRAIT_BATCH` 3、`PORTRAIT_WAIT_MS` 10 分钟<br>- 每通道一个水位（X:42-196） | 改成子代理 | 见 §3.4 |
| 45 | 调研续写每次都重发全部 messages（R:79-83、112-114） | 修 | 线程本来就有历史 |
| 46 | `evidenceTools`：`search_evidence`/`read_sentences`（X:469-528） | 留，给主会话也开 | — |

### 1.6 页面

| # | 机制（位置） | 判定 |
|---|---|---|
| 47 | 按阶段驱动的视图（共 3 处）：<br>- 深阶段单题大视图和左栏 held 题（`onboarding-workspace.tsx:305-311、394-399`，`left-column.tsx:83-87`）<br>- `viewForStage`、tab 按阶段禁用、`minutesLeft`（`stage-view.tsx:29-148`）<br>- `StageBar` | 改成按卡片类型渲染；阶段只显示进度 |
| 48 | 待决事项 `PENDING_ANSWERS`：等全部答完才合成一条回复发出 | 留这个语义，改成结构化回传，见 §3.3 |
| 49 | `InsightCard`、`ProfileCards`、`QuestionCard` | 改成按工具类型渲染 |
| 50 | `adoptPendingDates` 自动采纳 | 留 |
| 51 | `/depth`、`/tone` 两个路由（写入后被忽略） | 删 |
| 52 | 轮询、注意力心跳、`TurnProgress`、回合折叠 | 留 |

### 1.7 提示词冲突（25 处中影响重写的那些）

| 编号 | 冲突 | 处理 |
|---|---|---|
| C1 | O:41 写 v2 顺序，O:260-271 的编号列表却是 v1 顺序 | 主 Skill 只留一份顺序，写成「建议顺序」 |
| C2 | O:133「按需要」，代码截到 3、上限 4，schema 允许 5 | 工具上限统一为 5；节奏交模型 |
| C4 | style 禁用「底色」「锚」，三个 Skill 的核心概念正是「抓底色」 | style 的禁词只管输出给本人的文字；Skill 内部的概念换成别的说法（例如「稳定倾向」），避免模型在输出里照抄 |
| C5 | E:72 说定语「可以归纳」，style:36 和 TS:885 的修复提示却要「本人原话」 | 以第十二、十三次回放的决定为准（可以归纳），删掉修复提示里的「原话」 |
| C6/C7 | 定语候选的下限 3 个，与屏蔽目标题的门槛 ≥1 个，两处锁死 | §1.2 #16 |
| C10 | 引文长度：Skill 写 20 字，schema 写 80 字 | 统一为 40 字，只写在工具说明一处 |
| C12/C13/C14 | 画像 runner 指令说「联网核实」，实际不联网；要求每个判断附「这条就不准」的条件，却没有字段可写；目标该不该补一个，两处说法相反 | runner 指令只留场景，规则全部归画像 Skill |
| C17 | 「不按固定阶段顺序走」与「画像部分在前，不能跳过」 | 定一个优先级：来意优先，但画像四部分在结束前都要有证据；完整度把它显示出来 |
| C18/C19 | style 一处要「名词短语、中性简短」，同一个块里又要「短句」；Skill 要情境化的追问 | style 删掉「名词短语」，问题的写法归主 Skill |
| C20 | style 里写的字段名是 `insight`，实际字段是 `insights` | 工具化以后，第二人称规则写在 `show_observation` 的说明里 |
| C22 | 「每次回应多出一层推断」与「回复里不再说观察卡说过的」 | 分工写成一句：推断进卡，回复只接住并提问 |
| C25 | 调研 Skill 说「下一轮继续查」，代码 4 次运行后就强制关闭线程 | 写进调研 Skill：第 4 次必须给出阶段性结论 |
| — | E:186、R:12 写「见访谈 Skill 的画像框架」，但这两个运行不加载访谈 Skill，等于空引用 | 画像框架 D0–D9 单独成一份共享文件，由 runner 注入需要它的 Skill，见 §4 |

---

## 2. 竞品与资源：批判分析

完整调研报告不进仓库（共 7.5 万字）。下面只留结论、数字和链接。

### 2.1 AI 主持访谈产品

**Listen Labs、Outset、Conveo、Maze、UserCall、Typeform Formless**

- 共同形态：研究目标 + 隐藏提纲（每题可附「给 AI 的指令」）+ 每题的追问强度旋钮 + 全局护栏。
- 追不追问、何时换题，都由**模型**决定。产品化的只有两处：每题的追问上限，以及事后的质量检查。

**独立评测**

- NN/g 2026-01：10 名研究负责人，Marvin 和 UserFlix 用同一份提纲。https://nngroup.com/articles/ai-interviewers/
  - 时长 13–56 分钟不等，工具不知道话题是否聊透；
  - 同一提纲下质量波动大；
  - 复述之后不核实；
  - 只有 3/10 的人觉得对话自然；
  - 结论是不适合探索性访谈。
- Wei 2024：排在后面的槽位约 40% 被跳过，约 24% 的对话没有收尾。https://arxiv.org/html/2301.05843v2
- Wuttke：提示做一点小改动，追问的遵守率就会崩掉，而且是在预测试通过之后才发现。https://arxiv.org/html/2410.01824v2

**批判**

- 画像访谈正好是 NN/g 说「不适合」的那一类。所以「全交给模型」在这里**不会自己变好**，必须补上三件事：
  1. 每部分的充分性标准和已用时长，由会话层算好注入，不靠模型自己数；
  2. 复述必须让本人判定，这正是观察卡「准/不准」的价值；
  3. 节奏由本人控制：结束按钮，加上卡片可以跳过。
- 「深挖 5–10 层」（Listen、Outset）是面向付费受访者的指标，不该学。

### 2.2 教练、心理与画像类 agent

**MIBot v6.3A**（arXiv 2505.17362）

- 结构：一个大提示的主咨询模型，加三个单一职责的观察者：审核、跑题、结束判断。
- 结果：106 人，信心提升 1.7；MI 一致率 98%。成本和时延**没有报告**。https://arxiv.org/html/2505.17362v3
- **可借：** 主模型负责说话，旁边的观察者只做二分类或抽取，各管一件事，不会互相打架。
- **不可借：** 每句话都过审核并重新生成。时延叠加，而我们不是临床场景。

**MIBot 2023 版**：只提问、不做反映的版本，信心已经提升 1.0；加上生成式反映后是 1.2–1.3。**好问题本身就有效。** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10618902/

**Woebot、Wysa**

- Woebot 全脚本；Wysa 是生成式运行在规则框架里。
- 中间路线：规则只规定**什么时候不许生成**、**什么必须由本人确认**。这正是 §1 的划分。

**人格画像与巴纳姆效应**

- LLM 做人格推断，在引导式条件下也只有 r≈.44。https://arxiv.org/abs/2405.13052
- ELEPHANT 测出模型普遍附和。https://alphaxiv.org/abs/2505.13995
- **可借：** 设一个反巴纳姆、反附和的审阅子代理。它用干净的上下文，逐句检查画像：
  - 有没有原话；
  - 换一个人还成立吗；
  - 是不是只有好话。

**Designing Your Life**：3 条差异大的路径，每条配一次原型对话、2–4 周的试做和一个证伪条件。现有的职业推导已经这样做，保留。

### 2.3 生成式 UI：模型用工具出卡

各家的工具形状、回答回填方式和能否多卡并行，见调研报告的对照表。

| 方案 | 借什么 | 不借什么 |
|---|---|---|
| MCP elicitation（2025-11-25 版规范） | 卡片 = `message` 加一个扁平 schema。回答分三态：accept / decline / cancel | 同步 RPC |
| Vercel AI SDK 与 AG-UI interrupts | 一轮可以出多张卡；**所有卡都有结果后才续跑**（AG-UI 规定 resume 必须一次覆盖全部未决的中断） | 运行时本身 |
| ChatKit widgets | **点卡不触发模型回合**，只写账本 | — |
| A2UI | 卡片组件走**白名单**，模型不能生成任意 UI | 运行时本身 |
| Apps SDK / MCP Apps | `modelContent` 和 `privateContent` 分开：渲染细节不进模型上下文 | iframe（私有部署的 CSP 禁止 frame） |

链接：

- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://docs.ag-ui.com/concepts/interrupts.md
- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- https://developers.openai.com/api/docs/guides/chatkit-actions.md
- https://a2ui.org/concepts/actions-and-functions/

**结论：** 不引入任何生成式 UI 框架。Codex 的 dynamic tools 已经能承载，只借上面这些数据形状和语义。

### 2.4 Harness：子代理与长会话

**Anthropic 多代理研究系统** https://www.anthropic.com/engineering/multi-agent-research-system

- 多代理比单代理高 90.2%，但 token 是聊天的 **15 倍**，单代理是 4 倍。
- token 用量一项就解释了 80% 的性能方差。
- 子代理之间不能协调，慢的一个拖住全局。
- 不适合共享上下文多、彼此依赖多的任务。

**Cognition** https://cognition.com/blog/dont-build-multi-agents ，https://cognition.com/blog/multi-agents-working

- 并行的部分按互相冲突的假设行事，结果对不上。
- 2026 年的后续文章总结能用的形式：**写入保持单线程，多出来的代理只贡献判断**。
- 审阅者不共享编码者的上下文时效果最好；顾问 fork 主代理的完整上下文是 80/20 的做法。

**OpenAI Agents SDK** https://openai.github.io/openai-agents-python/multi_agent/

- 用代码编排「more deterministic and predictable」。
- agents-as-tools 让主代理一直掌握对话。

**LangChain 基准**：supervisor 转述子代理的话像传话游戏，改成原样转发后性能提升约 50%。

**上下文工程** https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- 子代理回传压到约 1–2k token。
- 手里只拿 id，用工具按需加载（just-in-time）。
- 结构化笔记写到上下文之外。

**MemGPT 与 Letta**

- MemGPT 在窗口约 70% 时预警、100% 时驱逐一半消息。
- Letta 的共享记忆块是整块覆盖写，并发写会互相盖掉，所以**每个代理只写自己的条目**。

**本仓库的 Codex 0.163.0，查过源码：**

- dynamic tools 一轮里可以调用多次，但**依次执行，不并行**。工具集在 `thread/start` 时固定，**不能逐轮换**。
- 工具可以挂起等人回答，但这样会占住模型闸门、触发 20 分钟的空闲看门狗，进程重启后丢失。所以工具必须**写入就返回**。
- 运行时自带的 `request_user_input_async` 正是「出卡即返回」的语义，但只对 OpenAI 自家模型目录注册，第三方提供方没有。我们用 dynamic tool 自己实现。
- 内置的 `spawn_agent` **只能由模型发起**：
  - 没有 outputSchema；
  - 绕过我们的模型闸门、用量记账和看门狗；
  - 默认最多 6 个线程、深度 1；
  - 继承 dynamic tools 还是未完成的开关。

  **不用。**
- `thread/fork` 是稳定接口：
  - 继承父线程的上下文和 dynamic tools；
  - 可以覆盖 developer instructions 和 model；
  - 可以发带 outputSchema 的 turn。

  这就是由 worker 控制的子代理。
- 压缩：
  - 自动压缩在窗口 90% 时触发；
  - 本地压缩原样保留约 20k token 的用户消息，并读 `compact_prompt`；
  - developer instructions 压缩后会重新注入；
  - 远程压缩是不透明的加密项。

  所以**不依赖压缩保留什么，每轮从账本重注入状态**。
- 两轮之间往历史里加内容，可用 `thread/inject_items`（稳定）。`additionalContext`（实验）可以逐轮给一段上下文。
- 第三方提供方经 `chat-bridge.ts` 把工具转换成原生 function calling（见 `model-providers.md` §1.1）。按现在的一致性检验，访谈 Skill 一旦带工具，就要重新准入。

### 2.5 成本与时延

| 项目 | 数字 | 来源 |
|---|---|---|
| 单代理与聊天的 token 比 | ≈4× | Anthropic |
| 多代理与聊天的 token 比 | ≈15× | Anthropic |
| 子代理回传 | 约 1–2k token | Anthropic 上下文工程 |
| Anthropic 缓存读取 | 0.1×；Opus/Sonnet 5.5 为 0.05× | platform.claude.com prompt-caching |
| OpenAI 缓存读取 | 最多 −95%，≥1,024 token | developers.openai.com prompt-caching |
| fork 能否命中前缀缓存 | **未知**。普通 fork 是新的 session_id；`experimentalPredictionMode` 声称复用缓存，但会关掉 fork 的自动压缩 | 本地源码；要实测 |
| ChatGPT 登录下缓存怎么折算额度 | **未知** | — |
| AI 访谈产品的单轮时延和单场成本 | 各家**都没有公开** | — |
| 本仓库现状 | 对话 Skill 约 2.6 万字符，只在开线程时注入一次；整理每个通道每次新开线程，整份重读约 2 万字符的 E，每条回复跑三个通道；一次 persona 回放约 ¥2、30–45 分钟 | 提示词盘点 §4；`onboarding-v3.md` |

**粗算：**

- 如果每轮起 4 个子代理、每个都从头读访谈历史，输入 token ≈ 主线程的 5 倍。有缓存时，前缀按 0.05–0.1× 计。
- 改成**只在触发点派、每个 fork 只发一个带 schema 的短 turn**，额外花费主要是各 fork 的输出，加一次可能没命中缓存的前缀。
- 现在的整理每条回复跑三次、每次重读 E。按触发点派以后，整理部分的总花费**不会高于现在**；但这是推算，P4 要拿用量数据核对。

---

## 3. 新架构

### 3.1 总图

```
本人 ──回复 / 点卡──▶ web ──▶ worker：会话编排（代码，单线程写入）
                               │
                               ├─ 主会话线程（crossline-interview，长会话，保留线程）
                               │    · 读工具：read_ledger / search_evidence / read_sentences / read_file
                               │    · 出卡工具：ask / ask_date / show_observation / show_scale_card /
                               │                show_goal_picker / start_research
                               │    · 最后一条消息（outputSchema）：{reply, progress}
                               │
                               ├─ 子代理（worker 派，异步，只出提议）
                               │    · 整理：新线程，每条回复或新文件
                               │    · 假设与职业：fork 主会话，按触发点
                               │    · 要点与画像各节：fork，按触发点
                               │    · 调研：新线程，带联网
                               │    · 画像撰写：fork，本人按「结束」时
                               │    · 审阅（反巴纳姆）：新线程，干净上下文
                               │
                               └─ 账本（SQLite，唯一真相源）+ 合并步骤（确定性校验）
```

### 3.2 主会话

- **一场访谈一个线程。** 沿用 `keepThread`、`thread/compact/start` 和 `SKILL_THREAD_LOST` 重建。
  - Skill 改名为 `crossline-interview`（旧名作为别名保留一个版本）。
  - developer instructions = 主 Skill + style 块。这两样压缩后会被运行时重新注入。
- **每轮的输入**：本人这次的文字；各卡的结构化回答（§3.3）；一段状态头（§3.5）。不再发 25 个字段的大 JSON。
- **每轮的输出**：
  - 模型先调零到多次读工具和出卡工具，最后给出一条 `{reply, progress}`，用 outputSchema 约束。
  - `reply` 过三道确定性检查：`inventedDates`、`withoutEndHint`、安全。不过就拒收重写，最多 2 次。
  - 其余的文风规则只写在 Skill 里。
- **没有结束工具。** 结束只由本人按按钮。完整度和开始标准在状态头里，模型可以说「我这边问完了」，但不能结束。

### 3.3 出卡工具

所有出卡工具都遵守同一套规则：

1. **写入即返回**：`{ok:true, cardId}`，或者 `{ok:false, problems:[…]}`。被拒的调用当轮还给模型，由模型改了再调。工具从不挂起等人。
2. **白名单**：只有下面这些卡片类型。参数用 inputSchema 加 handler 校验，上限只写在 inputSchema 一处。
3. **整批续跑**：这一轮出的卡组成一批。本人点卡只写账本，不调模型。等这批卡都有结果，或者本人直接发了文字，下一轮才开始。没答的卡明确记成 `skipped` 回给模型，不留半张卡的状态。
4. **回答三态**：`accepted`（带值）、`declined`（本人跳过）、`dismissed`（关掉）。三种信号对模型意思不同。
5. **带 `fills` 的卡**（指向状态头里的待办项）：本人的点选由 app 直接写成确认的事实，沿用 `answeredGapFacts`，不经模型复述（W-262 的教训）。

| 工具 | 参数（草案） | handler 里的确定性部分 | 页面 |
|---|---|---|---|
| `ask` | `questions[≤5]{text, kind: single\|multi\|free, options[≤14]{label, detail}, allowOther, about{lineId?, projectId?}, fills?}` | id、选项不重复；选择题至少 2 个选项；`about` 只能取本场的主线或项目 id；`fills` 必须是一个开着的待办项 | 问题卡 |
| `ask_date` | `{text, about, fills?, allowNone}` | 同上。答案存成 `{words, day?, window?}`，用 `roughWindow` 换算，原话一起存 | 带日期选择器的题 |
| `show_observation` | `{hypothesisId?, dimension: D0–D9, text, refs[≤4]{replyId, quote≤40}, external[≤3]{text, url}, falsifier, alternative?}` | `checkInsight`（逐字、≥2 条回复；只有 1 条时必须带 `alternative`）；披露的回复不能引用；`hypothesisId` 必须在库、未推翻、未评过；新卡建一条 `c<seq>` 假设 | 观察卡。回答：准 / 部分对（附更正）/ 不准 / **只是复述，没说到点**（W-267：这一项不推翻假设） |
| `show_scale_card` | `{itemIds[≤3]}` | 题在题库里且还没答；英文访谈拒收（沿用现状） | 量表卡，回传点选分数 |
| `show_goal_picker` | `{lineId, candidates[≤8]{text, kind, refs}}` | 定语的形式（`attributeProblem`/`notAtomic`）；引用要能解析；该线还没有目标 | 目标选择卡，选中的写入 `line.goals` |
| `start_research` | `{question, why, dimension}` | 去重；同时开着的不超过 4 条，满了返回错误；每轮不超过 3 条 | 调研面板 |

**回答怎样回到模型**

- **默认**：下一轮的用户消息里带一个结构化块：`answers: [{cardId, state, value}]`。这条路兼容所有提供方。
- **可选**：用 `turn/start.toolOutput`，把回答作为卡片工具的结果送回，语义更准。这是新接口，先在 `scripts/codex-smoke.ts` 里探测，第三方提供方不用它。

**降级路径**

- 一致性检验发现某个提供方的工具调用不可靠时，同一批卡片改为写在最后那条消息的字段里，worker 对每张卡调用**同一个 handler**。
- 区别只在出错时：工具形态下当轮逐张改；降级形态下整份重写。
- 两条路共用 handler，所以只多一个循环。

### 3.4 子代理

**原则**

- 由 worker 编排（代码编排），不让模型调 `spawn_agent`。
- 子代理**只产出提议**，由 worker 的合并步骤执行 §1.4 的校验后写入账本。写入保持单线程。
- 每个子代理的结果带上它读的账本版本号 `readSeq`。合并时，同一条目在 `readSeq` 之后被别人改过 → 这一条丢弃，下次重跑；其余照常合并。
- 结果回到主会话时只给 id 和一句话。全文用 `read_ledger` 取，不转述。
- 全部异步，主会话的回合从不等它们。

| 子代理 | 形态 | 触发 | 只写这些 | 主要规则在 |
|---|---|---|---|---|
| 整理 | 新线程。输入是回复切片、事实索引和文件，便宜，不需要整段历史 | 每条回复；新文件到达 | 事实、日期、项目、设置、可用时段、主线描述与定语候选 | 整理 Skill（E 的事实与日期部分） |
| 假设与职业 | `thread/fork` 主会话：要看完整轨迹才能推断 | 每 3 条新回复；本人评卡之后；阶段换了（以模型的 progress 为准，只作触发，不作闸门） | 假设、职业方向、维度笔记 | 假设 Skill（从 E 拆出）加画像框架 |
| 要点与画像各节 | fork | 每 3 条新回复，或空闲 10 分钟（沿用 `PORTRAIT_BATCH`/`PORTRAIT_WAIT_MS`） | 要点账本、画像草稿各节 | 要点 Skill（从 E 拆出） |
| 调研 | 新线程，带联网。fork 改不了联网工具 | 主会话调 `start_research` | 调研线程、带来源的结论 | 调研 Skill |
| 画像撰写 | fork | 本人按「结束」 | 画像报告 | 画像 Skill |
| 审阅 | 新线程，只给画像报告和证据，**不给访谈历史** | 画像写成后 | 每条结论的标记：无据 / 巴纳姆 / 附和 | 审阅 Skill（新写，约 1k 字） |

**取舍**

- 整理不用 fork：它要的是「这几句话里有哪些事实」，不需要整段历史；fork 每次都要背上整个主会话的前缀。
- 假设和画像必须看全，fork 最合适。
- fork 能不能命中缓存是未知数，P4 实测后再决定要不要改成「新线程 + 账本快照」。

### 3.5 共享上下文：账本、状态头、读工具

**真相源**：账本（SQLite 事件）。Codex 线程只是缓存，丢了就从账本重建。

**写入归属**：每类条目只有一个写入者。

| 写入者 | 条目 |
|---|---|
| 本人，经 web 路由 | 回复、卡片回答、评卡、开始核对、结束 |
| 主会话，经出卡工具 | 卡片、调研请求、progress |
| 整理子代理 | 事实、日期、项目、设置、时段、定语候选 |
| 假设子代理 | 假设、职业、维度笔记 |
| 要点子代理 | 要点、画像各节 |
| 调研子代理 | 调研线程 |
| 画像撰写子代理 | 画像报告 |
| 审阅子代理 | 结论标记 |
| app 的确定性计算 | 开始标准、完整度、量表分、由评卡改变的假设状态 |

**状态头**：每轮随输入注入，目标 ≤1.5k token，用固定格式。只放「这一轮要做决定必须知道的」：

- `startStandard {met, missing[]}`，以及完整度和缺口；
- 开着的待办项（原来的 gap 题）：`id`、一句话、能用哪个工具问；
- 上一批卡片的结果概况（详细内容在用户消息的 answers 里）；
- 哪些回复还没被整理记下（`unrecorded`）。这一项替代 §1.1 #5 的 7 个机制；
- 自上一轮以来子代理新写的内容：只有 id 和一句话；
- 调研线程的状态；
- 已用时长，以及各部分的用时（只作参考，不作上限：本人定过「不限轮数」）；
- 新到的文件：只有 id、标题、页数。

**读工具**（只读，结果截到 60k 字，沿用 `toolAnswerer`）：

- `read_ledger{section, query?, page?}`，section 可取：
  - `facts`、`points`、`hypotheses`（含建议出卡顺序）、`observations`（含评价和更正）；
  - `questions`（问过什么、答了什么）；
  - `lines`、`schedule`、`research`、`profile_sections`。
- `search_evidence`、`read_sentences`：和整理子代理用的是同一套。
- `read_file{id, offset}`。

**压缩保底**

- 本地压缩路径设 `compact_prompt`：保留状态头、未结的卡、出过的卡的 id。
- 远程压缩不透明，也不依赖它，因为每轮都重注入状态头。
- developer instructions 由运行时自动重注入。

**重建**：线程丢失时，从账本重建：

- 消息全量；
- 每轮出的卡片，以及本人的回答，写成工具调用的摘要；
- 文件只给清单，不重发正文：模型要看就用 `read_file`。

这样修好了 worker 冲突 C7。

### 3.6 阶段

- 阶段**只用于进度显示和子代理的触发时机**，不再驱动任何确定性机制。
- 删掉的按阶段的行为有：`holdGaps`、`DEEP_STAGES` 截题、量表按阶段排程、`checkInsight` 排除 details（单条主线访谈里不给观察工具就行）、画像各节按阶段定稿。
- 画像各节改为：要点子代理随时写草稿；本人按结束时，画像撰写一次定稿。
- 这同时解开了 W-269：跳过处境不再导致处境一节空着就定稿。

### 3.7 留在代码里的（模型不能自报的）

下面这些不随重构移动，只是换调用位置。Skill 里写一句「应用会检查」即可，不重复细节。

1. **引文和证据**：句子编号解析、逐字核对、网址只能来自调研来源、日期必须在原话的窗口里。
2. **安全**：提到自伤的回合只做三件事；披露前后的回复不作观察卡的引用。
3. **开始标准**：开始项、`readyToStart`、闸门、409。
4. **本人动作**：点选、评卡、结束、核对开始、文件归属、日期批次。
5. **合并**：弱答案不覆盖强答案、推断不覆盖已确认；要点、假设、职业的合并规则；版本号冲突。
6. **上限与长度**：只写在 inputSchema 和 outputSchema 一处。

---

## 4. 规则只写一处，以及怎样证明没丢

### 4.1 归属

| 层 | 放什么 | 现在在哪 |
|---|---|---|
| L0 代码 | §3.7 的六类 | 分散在 REF、CP、CL、CR 等文件 |
| L1 style 块 | 文风：禁修辞、禁比喻、不用破折号、「你」与第三人称、语言 | style.ts，又在各 Skill 里重复了 7 处 |
| L2 主会话 Skill | 目的；两条推理方向；建议的阶段顺序和来意优先；提问取舍（不重问、往深一层、不确定就是答案、能推出的不问、日期规则）；回复的分工；安全的说话方式；怎么读状态头 | O，删掉其中的推断规范和过时段落 |
| L3 工具说明 | 每张卡怎么写：题型怎么选、选项不编造、观察卡写模式不写原因、待核实卡、证伪条件只写条件、调研的上限 | 现在没有这一层：JSON schema 里没有任何 `description` |
| L4 子代理 Skill | 整理（事实、日期、定语）；假设与职业（推断规范一处写全：反巴纳姆、证据渠道、if-then 至少三次）；要点与各节；调研；画像撰写；审阅 | E 拆成三份，加上 RS 和 P |
| 共享附件 | 画像框架 D0–D9 | 现在只在 O 里，E 和 RS 是空引用 |

**共享附件的实现**：`skills/…/shared/profile-framework.md` 一份源文件。runner 在派假设、要点、调研、画像撰写时，把它附进 developer instructions。测试断言这四个运行都带上了它。

### 4.2 规则登记表与覆盖测试

- **登记表**：新增 `packages/core/src/interview-rules.ts`。把 §1 和提示词盘点里的 207 条去重，得到约 170 条，每条一个 id（`IR-001`…），写明归属层（L0–L4）和所在文件。退役的规则也留在表里，写上原因（例如「死代码」「已由工具 schema 表达」）。
- **测试 `interview-rules.test.ts`**：
  1. L1–L4 的每条规则在登记表里记一句**锚点原文**，它在所属文件里**恰好出现一次**。（原计划在正文旁放 HTML 注释形式的 id 标记，但 Skill 原文会整段进模型的上下文，注释模型也看得到，所以改用锚点。）
  2. L0 的每条规则写明源文件、符号和覆盖它的测试文件；测试文件要点名这个符号或那条测试的名字。没有测试的，在 `untested` 里写明原因。
  3. 退役的规则写明原因，接替它的规则必须在表里；退役的代码规则，符号不许还留在原文件里。
  4. 每次迁移只能把规则从一层挪到另一层，或者标记退役；**不能凭空消失**。
- **回放证据**：
  - `apps/worker/src/testing/fixtures` 里录下的模型输出，要在新的 handler 上重放。
  - 新增两个基线：W-269（9–17 轮没有卡）和长期目标死结，作为回归用例。
  - 真实模型的 persona 回放（约 ¥2、30–45 分钟，用赞助密钥）只在本人同意后跑，不作为副作用。

---

## 5. 分步迁移

每一步都要通过 `pnpm typecheck` 和 `pnpm test`，并单独提交。从 P2 起，每一步还要按 [onboarding-validation-audit.md](onboarding-validation-audit.md) 第 4 节的规矩验收：不静默、本人的话不改、不从文字猜意图。

| 步 | 内容 | 风险 | 证明没丢 |
|---|---|---|---|
| P0 清理 | 删 §1 中标「删」的死代码：档位、`roundsSpent`、结束分支、`/depth`、`/tone`，不再发 `tone`/`depth`/`stageRounds`；解决提示词冲突 C1、C3、C4、C5、C6、C7、C10、C12、C13、C14、C20、C25 和空引用；删除过时的 `onboarding-prompts.md`（或标成历史） | 低：行为不变，只是更一致 | 现有测试；被删的分支都有「主访谈里走不到」的证明，见 worker 盘点 C2 |
| P1 登记表 | 建 `interview-rules.ts` 和覆盖测试，先登记现状，所有规则留在原处 | 低 | 测试本身 |
| P2 工具出卡 | 主会话声明 6 个出卡工具和 4 个读工具；最后一条消息只剩 `{reply, progress}`；`checkInsight` 等校验进 handler；删 §1.3 的改写链、§1.1 #3/#6/#7 和 §1.2 的插题与屏蔽；页面按卡片类型渲染；回答结构化回传；`toolOutput` 只探测、默认不用；访谈 Skill 的一致性检验加上工具 | **中**：模型的软规则（不重问、换阶段）会偶尔回退 | 登记表里每条从 L0 挪到 L2 或 L3；fixtures 重放；W-269 和目标死结的回归用例 |
| P3 状态头与重建 | 状态头取代大 JSON；读工具分页；`compact_prompt`；从账本重建（带卡片） | 中：上下文变少，模型要会用读工具 | 重建测试：丢线程后卡片和文件清单都在 |
| P4 子代理 | 整理沿用新线程；假设和要点改成 fork，带 `readSeq` 合并；画像撰写改成 fork；加审阅子代理；测 fork 的缓存命中和额度消耗 | 中：成本是未知数 | 用量数据（设置 → 模型用量）；合并冲突测试 |
| P5 评估 | persona 回放加指标：反映与提问之比（目标 1–2）、观察卡「不准」率、重复提问率、各部分用时、完整度到达的轮数、附和比例 | — | 只在本人同意后跑 |

**P0 完成（2026-11-14）。** 本人说「按推荐，开始 P0」后做的：

- 死代码：`DEPTH_PACE` 四档、`readDepth`/`depthPace`、`roundsSpent`、`stagePace`/`moveOn`、`withoutNextStep`、`withChecklist`、主访谈的结束分支（`markFinishing`、结束前的 `CHECKLIST_WAIT`、换卡、`void ask()`）、`ONBOARDING_TONE*`/`readTone`、`/api/onboarding/depth` 和 `/api/onboarding/tone` 都删了。节奏只剩一个常量 `INTERVIEW_PACE`（`packages/core/src/onboarding-depth.ts`）。每轮不再发 `tone`、`depth`、`stageRounds`、`moveOn`；账本里旧的 `onboarding.depth`/`onboarding.tone` 不再被读。单条主线的访谈仍可能返回 ready，所以 `FINISH_WAIT_MS` 和 `state: complete` 留着。
- C1：主 Skill 的阶段列表按新顺序（narrative → compass → energy → situation → orientation → lines）排，不再编号，顺序只由 `stageOrder` 定。
- C3：O:21 那句「忽略 tone/depth…」删掉，因为这些字段已经不发。
- C4：三个 Skill 里的「抓底色」「人格底色」「重新定义的锚点」换成「稳定倾向」「性格里稳定的部分」「换一个前提后的那个想法」，和 style 的禁词不再打架。
- C5：style 的层级说明和定语修复提示都改成「按本人说过的话归纳，不必是原词」。
- C6/C7：定语候选在这条线记录不多时可以少于 3 个，修复提示不再要求「补到至少 3 个」；只有候选够 3 个、本人能选时，才屏蔽模型自己的目标题（`goalPickerLines` 用 `GOAL_CANDIDATES_MIN`）。1–2 个候选时，对话照常问本人想成为什么样的人。
- C10：观察卡引文统一为 40 字（Skill 和 schema）。
- C12/C13/C14：画像 runner 指令只留场景，规则都归画像 Skill。
- C20：`SECOND_PERSON` 的字段名改成 `insights`。
- C25：调研一步的最后一轮输入带 `lastRun: true`，调研 Skill 要求这一轮写出阶段性结论。
- 空引用 E:186、R:12：画像框架 D0–D9 移到 `packages/core/src/profile-framework.ts`（`PROFILE_FRAMEWORK`），由访谈、整理、调研、画像撰写四个运行附在 developer instructions 末尾（`withProfileFramework`）。用 TS 常量而不是 §4 说的 `shared/*.md`，因为 worker 运行时不一定能读到仓库里的 skills 目录。测试断言访谈、整理、调研的线程都带上了它，并且没有 Skill 自留一份表或指向别的 Skill。
- `docs/onboarding-prompts.md` 移到 `docs/archive/`，并标成历史。

证明没丢：`pnpm typecheck`、`pnpm test` 通过。新增或改写的测试覆盖：不发档位和语气字段、短候选不被补齐、调研最后一轮的 `lastRun`、四个运行附带框架。

**P1 完成（2026-11-14）。** `packages/core/src/interview-rules.ts` 登记了 [onboarding-validation-audit.md](onboarding-validation-audit.md) 逐条核验过的 45 条代码规则和 6 条访谈 Skill 规则，每条带审查的判定（留 / 回 / 交模型 / 删）。没有把 207 条全部登记：只登记审查核验过、P2 要动的那些，其余规则在 P2–P4 改到它们时补登。登记时发现 5 条代码规则没有任何测试（三种等待、`holdGaps`、`adoptGoalsFromRound`），在表里标成 `untested`；它们都在 P2 删除之列。

**P2a 完成（2026-11-14）：审查列出的误判先修。** 不改架构，只修 [onboarding-validation-audit.md](onboarding-validation-audit.md) 里有实例的误判：

- 目标只从 app 自己的目标题和目标选择器写入。删了 `answeredGoalQuestions`（按题干猜目标题，把「最不想成为」的答案写成了目标）和网页端的 `adoptGoalsFromRound`（只存前三个词、丢掉本人写的那句）。
- app 自己的问题卡上，本人在「我来写」下面打的字：截止和待定日期只有读得出日子（写出的日期、星期、「12 月中」「下周」「没有截止」）才直接记成确认的事实，上课时间要读得出星期或钟点；主线的描述交给整理。之前「还不知道」被记成确认的截止，开始项随之关闭。
- 本人自己选、自己写的定语，只有字面相同才算重复（「自由」和「财务自由」是两个选择）；`cleanAttribute` 不再把「C++」「C#」截成「C」。
- 回复里编造的日期：修复用完后 `softAccept` 不再检查，现在去掉定下那个日期的句子。这是回复上唯一保留的静默处理，登记在 IR-006。
- 画像：类型名只在当成本人的标签时（「你是军师」「甲方型」）才拒，普通用法放过；不在本场的主线那一项剪掉，不再让整份画像失败。
- 安全：对话输出加 `safety` 字段由模型标；本人回复里另有一组高精度字眼（`mentionsSelfHarm`）作下限，命中而这一轮不是安全回合时退回模型确认一次（可能是别人的事或研究题目，模型能分辨，正则不能），`keepEarly` 不能把这次退回吞掉。安全回合不出量表卡和观察卡；披露前后的回复不作引文，现在也认模型的标记。
- `mergeFacts` 删除（没有生产调用者）。

登记表随之更新：IR-023、IR-024、IR-045 退役并写明原因，IR-012 换成新信号，新增 IR-046。

**P2b-1 完成（2026-11-14）：回复和题目上的静默改写删掉。** 意图改成显式字段，文风规则只留在 Skill：

- 题型不再从题干猜：删了 `DATE_ASK` 改日期题和 `MANY` 改多选。问日子的题由写题的一方标 `date: true`（模型的题和 app 自己的截止、待定日期题），页面只按这个字段放日期选择器。
- 删了 `withPlainTerms`（替换术语，连本人自己说的「硬约束」也换掉）、`withoutToldStory`（题前硬加「除了前面讲过的那件」）、`withoutCardEcho`（按字对重合删句）、`withoutRecordingTalk`（删「还在记录」）、`saidNothingMore`（「没什么好说的，但我最近很焦虑」也算说完了）。对应规则都在访谈 Skill 里，登记为 IR-106 到 IR-110；是否被遵守放到回放评估里量。
- 开始标准没齐时提「结束并出报告」：改成退回模型重写（`endHinted`）；修复用完后才去掉那句（按钮按不动，属于事实保护，登记在 IR-035）。

**P2b-2 完成（2026-11-14）：app 自己加的等待删掉。** 删了三处等整理的等待（对话前 60 秒、阻塞题 30 秒、空轮 300 秒，IR-040 到 IR-042）和 `cardsWait`（更正后整轮停卡，IR-043）。一轮不再为整理停下：还没记下的回复由 `startStandard.answered` 告诉模型；本人刚更正、假设日志还没重看时，卡照出，更正放在旁边（`cardsCheck`，Skill 规则 IR-111）。结束时的 `FINISH_WAIT_MS` 和 `extract: "await"` 模式保留：前者等的是报告要读的整理，后者是测试和回放用的同步模式。

**P2b-3a 完成（2026-11-14）：一轮的组装不再静默改模型的东西。** 应用的核对（`apps/worker/src/onboarding-cards.ts`）在同一轮把问题清单退回模型（`SKILL_SCHEMA_INVALID` 带 `detail`），修复用完还没过的那几项不发出去，下一轮在 `lastRound.removed` 里告诉模型，并记 `onboarding.round_edited`：

- 重复题：`resolveRepeats` 删掉。和答过的题像同一个问题（相似度只作提示），把本人当时的回答发回去；是往深一层的追问就由模型标 `followUp: true` 照发（IR-047）。同一件事最多问两次照旧，第三次退回（IR-014）。选项重复、id 重复、一轮超过五题都退回（IR-051），不再静默去重或截掉。
- app 自己的问题：`withGapQuestions`、`holdGaps`、`gapCoveredBy` 删掉。缺项列在上下文的 `openItems`，模型要问哪一项就把 id 写进输出的 `openItems`，应用按自己的写法和选项发出，点选照旧直接记成事实（IR-048）；模型用自己的话问（`repeats` 指向 app 的题）会被退回。新文件归属题仍是应用的簿记题，照旧放在旁边。
- 空轮：`withSomethingToAnswer`、`withFreshOpenQuestion`、`closingQuestion`、`openStageQuestion` 和网页端的空轮补题删掉。还没问完的一轮必须有题（`questions` 或 `openItems`），否则退回（IR-052）。
- 筛题：`screenQuestions`、`screenAssumption`、`screenedNote`、`questionsOwnedElsewhere`、`questionScreenFor` 删掉（IR-020）；网页的待决事项和访谈页按模型写的原样显示这一轮。
- 观察卡和调研：不合格的卡、重复的调研不再丢掉，连同原因退回（IR-049、IR-050）。
- 画像阶段一轮三题（`paceDeepRound`）只留在 Skill（IR-017 退役）。

Skill 同步改了 `questionLedger`、`lastRound`、`openItems`、`followUp` 和「核对后退回」的说法（IR-112 到 IR-114），删了「应用会拿掉收尾问题」「应用会删掉「还在记录」」这些已经不成立的句子。这一步仍走 JSON 字段；同样的核对作为工具调用（D1）是 P2b-3b。

**P2b-3b 完成（2026-11-14）：问题、观察卡、调研改成工具交。** 函数调用可用的路线（本人自己的 Codex 总是；第三方提供方要有 `functionCalls` 的一致性记录）在 `thread/start` 声明四个工具（`cardTools`，`apps/worker/src/onboarding-cards.ts`）：`ask_question`、`ask_app_question`（openItems 的一项）、`show_observation`、`open_research`。每次调用跑和 P2b-3a 同一套核对（加上整份回答会被拒的问题结构），不合格作为工具错误当场还给模型，合格的收进这一轮的草稿；最后的 JSON 里这几项写 []，写了也照样合并在草稿后面再核对一遍（`withDraft`）。不调函数的路线照旧走 JSON 字段和整轮退回（`optionalTools` 的降级路径）。工具只能在开线程时声明，所以会话记下这条线程是哪种（`coverage.cardTools`），后续轮次只在 `tools` 线程上应答；线程丢失重建时草稿清空、按新路线重新判断。登记为 IR-053。

和 §4 的设计相比，这一步有意没做的：

- 卡仍在一轮结束时写进账本，不是工具调用时立即写：这一轮的回答如果整轮失败，已收下的题不该先出现在页面上。
- 最后一条消息没有缩成 `{reply, progress}`：降级路线还要这些字段，同一个输出 schema 两条路线共用。
- `ask_date`、`show_goal_picker`、`show_scale_card` 没有单独的工具：日期题用题目自己的 `date` 字段（P2b-1），长期目标的候选是 openItems 里的 `gap-goal-*`，量表卡仍按阶段由应用放（`cardsForRound`），它们不是模型的判断。

**P3 完成一部分（2026-11-14）：读工具、带卡重建、压缩提示。**

- 读工具（`apps/worker/src/onboarding-read-tools.ts`）和出卡工具一起声明：`read_ledger{section: questions | facts | hypotheses | research, page}` 按 60 行一页读账本，`read_file{id, offset}` 每次读 14000 字。每轮上下文只给问题记录最近的 15 条、文件按阅读预算截断，要看全由模型自己读。
- 重建（IR-054、IR-055）：丢线程后的历史带上每轮的选项和观察卡（连同假设 id）；文件只发阅读预算内的，其余不再记为「已展示」（修好 C7：以前超出预算的文件正文为空，却记成看过了）。
- `compact_prompt`：运行时本地压缩时保留本人原话（带 reply 编号）、出过的卡和评价、没答的题、拒绝过的话题、正在追的假设；每轮会重发的状态不必保留。新增 `SkillRunOptions.compactPrompt`，只对这一条线程生效。

**没做的：状态头取代大 JSON。** 每轮的上下文仍是现在的 JSON（`checklist`、`questionLedger`、`abstract` 等），没有压到 1.5k token 的固定格式。原因：这一步会让模型看到的东西变少，「不丢上下文和规则」只能靠真模型回放验证；按约定回放要本人同意（约 ¥2 一次）。读工具先上，回放显示模型确实会用它们以后，再按 P5 的指标逐项把上下文换成读工具。

**P4 没做：子代理改形态。** 整理、假设、要点、画像撰写仍是各自的新线程；改成 fork 要先实测缓存命中和额度消耗（D5 写明「P4 要实测」），这需要真模型运行，同样要本人同意。现在的形态不受 P0–P3 影响。

**往后加机制的规矩**：新发现的问题，先改 Skill 或工具说明。只有涉及 §3.7 六类的，才加代码，而且是拒收后让模型改，不静默改写。

---

## 6. 要本人拍板的取舍

| 编号 | 决定 | 推荐 | 代价 |
|---|---|---|---|
| D1 | 卡片走工具调用，还是保留 JSON 字段、只去掉改写 | **工具调用**，另留降级路径 | 访谈 Skill 要对第三方提供方重新做一致性检验；工具依次执行，每多一张卡多一次往返，但都在一轮之内 |
| D2 | 去掉软规则的代码闸门（重问去重、补题、截题数、改题型），接受模型偶尔重问 | **去掉**，用评估指标盯 | 回放 3–14 修过的一部分行为可能回来，需要 P5 的指标兜住；回来的问题按「先改 Skill」处理 |
| D3 | 阶段只作进度显示，画像各节在结束时一次定稿 | **是** | 中途画像页看到的是草稿，不是定稿 |
| D4 | 量表 14 题全答（`profile_cards`）还算不算开始标准 | **移出开始标准**，改为完整度的一项。量表是画像材料，不是建立日程的前提；Skill 本来也只写了五项 | 有人可能永远不答量表；画像相应少一块证据 |
| D5 | 子代理形态：整理用新线程，假设、要点、画像用 fork，调研用新线程，审阅用干净上下文；不用 `spawn_agent` | **是** | fork 的缓存命中和额度消耗未知，P4 要实测 |
| D6 | 观察卡回答加一项「只是复述，没说到点」，这一项不推翻假设 | **加**（W-267） | 页面多一个按钮 |
| D7 | 实施顺序：先 P0–P1（一致性和登记表，不改架构），本人看过再上 P2 | **是** | 架构收益要晚一步 |

本人确认（或改动）以上决定后，从 P0 开始实施。push 和部署等本人在主会话明确说了再做。

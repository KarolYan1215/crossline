# 访谈的代码校验：逐条核验与用户视角的批判（2026-11-14）

本人的要求（2026-11-14）：逐个核验访谈里用代码做的校验，联网查证，批判性分析哪些可以交给模型、避免代码误解本人或模型的意思，从用户视角看；之后的重构步骤以此为标准。

这份文档是 [onboarding-agent-session.md](onboarding-agent-session.md) 的补充：那份讲架构，这份讲每一道代码校验留不留。逐条的完整记录（每条带位置、规则、误判例子和来源）在会话笔记里，这里只放结论和证据最强的例子：

- core 校验 32 条（引用、定语、回复改写、日期）
- 缺项、问题账本、要点、清单、网页端 40 条
- worker 组装链、整理合并、调研、画像、修复循环 40 条
- 外部调研：LLM 裁判、护栏、引文、静默改写、AI 访谈体验、安全检测

误判例子标「已跑」的，都用 `tsx` 直接调用真实函数确认过；标「推理」的按代码路径推出，没在浏览器或账本里跑。

---

## 1. 结论

1. **毛病不在「代码校验」本身，而在「静默改写」。** 112 条里，真正误解人的几乎都是同一种：用中文正则从文字里猜意思（这是不是日期题、是不是目标题、是不是问地点、答案算不算「不知道」、两道题是不是重复），猜完直接删题、改题型、补题或把答案记成事实。模型和本人都不知道发生了什么。
2. **自我修正只在有外部反馈时有效。** 没有外部信号时，模型自己改，正确率反而下降（Huang et al., ICLR 2024；Kamoi et al., TACL 2024 综述）。代码的判定正是可靠的外部信号，所以不该丢掉它，而该把它**当轮还给模型**：「第 2 条引用在 reply-7 里找不到」「这道题和第 5 轮的 #12 很像，本人答的是……」。
3. **按「这件事能不能由程序核对」分三类：**
   - **事实核对，留在代码**：引文逐字、句子编号、网址来自调研来源、日期换算和日期有原话支撑、开始标准、本人的点选和评卡、合并规则、安全底线。它们核对的是可以核对的东西，误判少。改动只是失败时不再静默丢，而是报给模型。
   - **意思判断，交给模型**：题型、是不是目标题、问地点、已知课表、重复与追问、答案算不算答了、是不是课程、文风。代码不再判断，改为把事实（已答事项、课表、目标候选数、开始标准）每轮交给模型，由模型决定问不问、怎么问。
   - **由 app 替模型出题或等待，删掉**：插题、补开放题、空轮补题、三种等待、按阶段停卡。
4. **意图写在工具名上，不靠猜。** 日期题用 `ask_date`、目标用 `show_goal_picker`、观察卡用 `show_observation`：模型调用哪个工具，就是哪种卡，代码不再从题干猜（防错设计）。
5. **质量类的裁判放到离线。** LLM 裁判和人的原始一致率看起来高，但扣除偶然一致后的 κ 只有 0.38–0.51；在线裁判又加时延。线上只留安全一项独立检测；重复率、追问深度、观察卡是否被引文支撑，放到回放评估里量。

---

## 2. 用户视角：这些校验在屏幕上是什么样子

| 本人的感受 | 屏幕上发生了什么 | 来源校验 |
|---|---|---|
| **「它没在听」** | 回复还在铺垫一道题，那道题却被删了；app 插进来的题不接上一句；「早高峰通勤要多久？」前面被加上「除了前面讲过的那件，」 | `screenQuestions`、`resolveRepeats`、`withGapQuestions`、`withoutToldStory` |
| **「它不深挖」** | 往深一层的追问和原题字面相近，被当成重复删掉（「什么让你忘了时间」与「什么让你觉得煎熬」相似度 0.69，第二题被删，已跑） | `questionSimilarity` 同主线 0.6 |
| **「又问一遍」** | 真正的重复漏判：第 W-239 次的重复题相似度只有 0.50，照样出现 | 同上（漏判） |
| **「选项不见了，多了个日期框」** | 「你一周里哪天状态最好？」「你想什么时候休息？」被判成日期题，选项被删；清单自己的「眼下在做的一件事，大概什么时候完成」也被改成填空，Skill 要的「日常工作，没有截止」一键选项没了（已跑，9 个误报） | `DATE_ASK` |
| **「我只想选一个，它让我多选」** | 「这几个目标里，你最想先推进哪一个？」被改成多选（已跑） | `MANY` |
| **「我说的是我不想成为的样子」** | 「你最不想成为什么样的研究者？」答「浮躁的；只追热点的」，被写成这条线的长期目标，开始标准算达成（已跑） | `answeredGoalQuestions` |
| **「我写的那句话没了」** | app 的目标题，本人选 4 个词再写一句，浏览器抢先只存前 3 个词；worker 看到已有目标就不再写（推理） | `adoptGoalsFromRound` |
| **「我说的『还不知道』被当成了截止」** | 选「我来写日期」再写「还不知道」，记成确认的截止「还不知道」，开始项关闭（已跑） | `answeredGapFacts` |
| **「我自己选的词，它说重复」** | 「自由」和「财务自由」、「稳定」和「情绪稳定」被判成重复，界面直接对本人报错；「C++」被截成「C」（已跑） | `duplicateAttributes`、`checkGoalParts`、`cleanAttribute` |
| **「它答应每轮给观察，却好几轮没有」** | 一条引用对不上就整张卡静默丢掉；一次更正让所有卡停一轮（第十四次回放停了十轮） | `checkInsight`、`cardsWait` |
| **「卡住了」** | 60 s、30 s、300 s 三种等待可以叠加；整理一次在赞助商模型上要 4–15 分钟，所以前两种几乎必然超时，白等 | `START_WAIT`、`BLOCKING_WAIT`、`CHECKLIST_WAIT` |
| **「像在填表」** | 固定的开放题、「实在说不准，可以先说一个暂定的答案」这类模板句；2026-11-12 回放「哪条主线」连问九轮 | `withSomethingToAnswer`、`openStageQuestion` |
| **「好问题没被问」** | 「朋友一般会用哪些词形容你？」被当成目标题删；「你在哪里最容易进入专注状态？」被当成问地点删（`attend` 里的 `end` 也被当成时间词） | `screenQuestions` |
| （本人看不到，机主在意） | 比喻禁词、破折号 | `PLAIN_VOICE`、`withPlainTerms` |

AI 访谈产品的用户研究里，最常见的直接不满是「缺少回应」和「照单念题」；倾听感来自接住本人内容的复述。上表前五行都在制造这两种感受。

---

## 3. 逐类判定

记号：**留** = 留在代码；**回** = 留在代码，但失败时当轮返回给模型改，不静默；**判** = 交给模型（对话模型自己，或离线裁判）；**删** = 删除。

### 3.1 证据与事实（留，失败改为回）

| 校验 | 判定 | 说明 |
|---|---|---|
| 句子编号拼引文 `citedSpan`、`resolveOnboardingRefs` | 留 | 和 Anthropic Citations API 的设计相同：模型给指针，代码拷原文。静默丢掉的引用改为回 |
| 点选行不作证据 `TAP_LINE` | 留 | 看的是 app 自己写的行格式，不猜意思 |
| 观察卡 `checkInsight`（逐字、≥2 条回复） | 留 + 回 | 不再整卡静默丢；在 `show_observation` 里当场报「第 N 条引用在 reply-R 找不到」 |
| 引文是否**支撑**结论 | 判（离线） | 逐字一致 98% 时，完全支撑只有 37%（Zhang et al. 2026，预印本）：逐字不等于有据。放进回放评估 |
| 日期：换算 `roughWindow`、原话支撑 `quoteSupportsDate` | 留；认不出的说法改为回 | 「开学前」「月中」「半个月内」认不出就静默丢，改为报给整理模型 |
| 回复里的日期 `inventedDates` | 回，并补漏洞 | 修复用完后 `softAccept` 不再检查，编造的日期照样显示：补上 |
| 调研结论要有来源 `validateResearchTurn` | 留 | 最后一轮允许没有来源的「查不到」 |
| 画像 `resolveWrittenClaims` | 留 | — |
| 合并：要点、假设、职业、日期、弱答案不覆盖强答案 | 留 | `applyPointChanges` 丢掉的条目数没人读：改为报给整理模型 |

### 3.2 安全（留底线，换信号）

现在判断「这一轮是安全回合」的依据，是对话模型的回复里有没有写出两个热线号码。模型一漏，后面的处理全漏；多轮对话里模型的恰当率只有 56–86%。

- **留**：安全回合只做三件事（`safetyReplyOnly`）；披露前后的回复不作观察卡引文（隐私承诺）。
- **改**：
  - 信号改成显式的：对话的输出加一个 `safety` 字段，由模型标；
  - 代码对本人的每条回复另跑一个高精度短语表，作为下限。短语表命中而模型没标时，这一轮仍按安全回合处理；
  - 安全回合不出量表卡、不出观察卡。
- 独立的安全分类模型留作后续：需要中文多轮回放集来评测，现在没有。

### 3.3 结构与上限（留，改为回）

`checkTurn` 的结构项（id、选项不重复、选择题至少 2 个选项）、每轮题数上限、引文长度：只写在工具的 inputSchema 一处，越界时当场返回具体字段，不截断后照用。现在一项出错就整份重写，一次修复约 1 分钟（2026-10-16 实测：一轮 174 秒，两次整份重写占三分之二）。

### 3.4 意思判断（判：交给模型）

| 校验 | 证据 | 新做法 |
|---|---|---|
| `DATE_ASK` 改题型；网页端日期框 | 9 个误报；同一天改了 3 次；英文「due」漏认 | `ask_date` 工具 |
| `MANY` 改多选 | 「最想先推进哪一个」被改多选 | 题型由模型在 `ask` 里写 |
| `screenQuestions` 四支（目标、地点、日历可推、已知课表） | 见第 2 节 | 删。Skill 写「能从文件、日历、常识推出的不问」，状态里给出课表和候选数；目标由 `show_goal_picker` 负责 |
| 重复题 `resolveRepeats`（相似度 0.85 / 同主线 0.6） | PAWS：字面重合不等于同一问题；0.85 附近真重复只有 1.5%；误删追问、漏判真重复 | 相似度只用来**提醒**：`ask` 命中时返回「第 N 轮问过：…；本人答：…；若是追问，题干要接住这个回答，并设 `followUp: true`」。模型决定改写或保留。`MAX_ASKINGS` 计数留 |
| 答案算不算答 `unsureAnswer`/`undecidedAnswer`/`freeTextAnswers` | 「我也不知道」「不太确定」漏认，「暂无」误认；「11 月 20 号，不过时段看情况」算未定，两次后日期题整场被删 | 删静默动作；把已答事项连本人原话交给模型 |
| 答案写成事实 `answeredGoalQuestions`、`adoptGoalsFromRound` | 反目标写成目标；网页端丢词 | 删。目标只从 `show_goal_picker` 的点选写入 |
| `answeredGapFacts` 的补充框 | 「还不知道」记成确认的截止 | 留结构化的部分（点选的选项）；补充文字写成**待整理**的回复内容，由整理模型判断，不直接记成确认事实 |
| 定语的措辞 `attributeProblem`/`notAtomic`/`duplicateAttributes` | 20 个误报，多个正是 Skill 推荐的写法（「能吃苦」「会照顾自己」）；成就类「考上研究生」反而能过 | 代码只留长度、引用、完全相同的去重；措辞规则写在整理 Skill。**本人自己的选择和自己写的词，一律不做措辞检查** |
| `cleanAttribute` 吞符号 | 「C++」→「C」 | 修掉 |
| `courseCodeOf`/`isCourse` | 「MBA 2027 申请」被当课程问上课时间 | 判：交整理模型标课程 |
| 文风改写 `withoutToldStory`/`withoutCardEcho`/`withoutRecordingTalk`/`withPlainTerms`/`saidNothingMore`/`researchCopied` | 「没什么好说的，但我最近很焦虑」也算没话说了；本人自己用的「硬约束」被替换 | 删，规则留在 Skill；离线量 |
| `withoutEndHint` | 开始标准没齐时说「可以开始了」 | 回：拒收重写，不静默删句 |
| 画像类型名 `typeSummaryProblem` | 「大学生」「甲方」「军师」也是普通词，一次误杀两次整份画像重写 | 放过普通名词用法；只拦「你是 XXX」这种自报类型；出错只重写这一段 |
| `PORTRAIT_LINE_UNKNOWN` | 修两次还错就整份画像失败 | 剪掉那一项，不整份失败 |
| 里程碑的课程语法 `GRADED`、`MILESTONE_TARGET_UNPROPOSED`/`NOT_CITED`、`MILESTONE_COURSE_PARTS_MISSING`（2026-11-22 删） | 只认中文与几个英文考试词，判不了「哪项计分」 | 删：课程规则写在 milestone architect Skill，由它判断哪项计分、要几个部分、引用目标成绩 |

### 3.5 由 app 出题和等待（删）

| 机制 | 新做法 |
|---|---|
| `withGapQuestions` 插题、`gapCoveredBy` | 缺项作为「待办」放进每轮的状态，模型用 `ask`/`ask_date` 带 `fills` 去问。文件归属和日期批次两类是簿记，仍是 app 卡 |
| `withSomethingToAnswer`、`shownOrOpen`、`withFreshOpenQuestion`、state 路由的空轮补题 | 删。模型给了 ask 却一道题都没出 → 回 |
| `paceDeepRound` 截成 3 题、`ROUND_QUESTIONS_MAX` | 上限只写在工具里：一轮 ≤5 题；节奏写在 Skill |
| `START_WAIT` 60 s、`BLOCKING_WAIT` 30 s、空轮 `CHECKLIST_WAIT` 300 s | 删。状态里写「哪些回复还没记下」，模型就不会重问 |
| `cardsWait` | 删。被更正过的那条假设不再出卡（handler 拒），其余照常 |
| 展示即记 `cardKey` | 改为评过才算问过 |
| `holdGaps`、按阶段排量表卡 | 删；量表卡由 `show_scale_card` 出 |
| `questionsOwnedElsewhere`、`falsifierCondition` | 删；证伪条件是工具参数，页面直接显示 |
| 授权文件夹里同大小同内容只读「名字最短」的那份；上传前列出清单要本人确认 | 删（2026-11-22）。完全相同仍按 sha256 只存一份；近似重复由代码出候选、模型判版本取最新（`crossline-source-digest`），旧版留原件、访谈读摘要和差异。选中即上传，密钥和私人证件单据由代码挡，其余文件夹由模型筛。 |

### 3.6 死代码

`mergeFacts`（core）没有生产调用者，设计文档却把它列成「留」：真正起作用的是数据库的 upsert 规则。删掉，并在文档里改正。

---

### 3.7 2026-11-22 删去的（访谈与导入重做，S3）

- `profile_cards` 开始项与它的测试：量表改为访谈前单独一页、可以先跳过（D1），它不再挡开始。
- W-269 的 `partsUncovered` 开始前闸门（`PART_SECTIONS`、`FRONT_PARTS`）与它的测试：开始标准只剩「至少一条主线、至少一个里程碑」（D10），深的部分不再在开始前欠着。
- `line_desc`、`line_goal`、`hard_schedule`、`availability`、`line_project`、`near_term` 的 `start: true`：这些照样问、照样记，但不再挡开始（D10）；按「开始使用」时，模型自己说画像还薄在哪里。
- 访谈里出量表卡的三条测试（`onboarding-session.test.ts`）：访谈里不再出卡，量表在自己的页面。
- 卡片框里的文字代替点选（`readCardAnswers` 的「待答」）：框只是补充，没点的题记为跳过，不从文字估分（§二.2）。
- 右栏的 `minutesLeft` 时长估计和 `START_GROUPS` 分组：开始项只剩两条，估时没有依据（D13）。
- `profile-gaps.ts` 的 `FROM_MATERIAL` / `readableFromMaterial`（R2-B）与它在 `profile-gaps.test.ts`、`i18n-core-b.test.ts` 的测试：按题文里的「题面」「提交方式」「AI 规则」等词判「材料能答」，换个说法就漏、别的线的同名词就误判。改由 step planner 自己的 `ask` 判断（Skill 第 4 节：材料能答的写 `ask: false` 并按材料给 `assume`）；`step-planner.ts` 与 `asks.ts` 不再按题文挑题。它不在 `interview-rules.ts` 登记表里，无条目可删。
- 「至少有一条主线」不再算系统代填的内置四条（R2-B）：没有 `lines.v1` 时 `identityPacksFor` 用内置四条顶上，`start_line` 因此对一条主线都没说过的账号也算齐。现在只算本人列出的主线（`interviewChecklistFor`）；例外：没列过主线但看板上已有自己的工作（不算示例）的旧账号照旧算齐，不被送回访谈（本人决定，2026-11-22）。

## 4. 新增的规矩（之后每一步都按它验收）

1. **不静默。** 代码对模型输出的任何删、改、补，要么改成当轮报给模型的错误，要么删掉这道校验。仍保留的静默处理（安全截断、点选写入）必须在登记表里注明原因。
2. **本人的话不改。** 本人选的、写的，不做措辞、并列、去重检查，不截字符。
3. **不从文字猜意图。** 卡片类型、题型、答案的含义由工具名和结构化回答表达。
4. **事实给模型，判断交模型。** 课表、已答事项、候选数、开始标准、还没记下的回复，每轮放进状态；问不问、怎么问由模型定。
5. **删一条规则的门槛**：回放集上的重复率和误删率不上升，安全召回不下降。评估离线进行，真实模型的回放只在本人同意后跑。

## 4.1 2026-11-22：改回 Codex 原生以后删掉的规则

一条一行原因，注册表（`packages/core/src/interview-rules.ts`）里同号改为 retired。回复本身现在只退回安全、本人和账本都没给过的日期、逐字引文、真实链接和披露；其余记在 `onboarding.round_edited` 的 `noted` 里（IR-165）。

- IR-034 回复不照抄调研数字：本人要听到查到的东西（D16），数字由调研线程的来源负责。
- IR-035 开始标准没齐时不说可以开始：开始不开始由本人决定，改为记录。
- IR-052 还没问完的一轮必须有题：主问题写在回复里，不要求问题卡。
- IR-128 进度头列「还没定」的日子：由日期题自己的回答（`sameAbout`）承担，`undecidedDay` 正则删掉。
- IR-130 卡的引文全在最近两条回答里退回、IR-131 第四张卡不写 why 退回：留给 Skill。
- IR-133 回复和卡共有十五字以上退回：只是写得重，不退回。
- IR-136 报量表分数退回：改为记录。
- IR-139 next 为空退回、IR-140 进度头说按没按「好，往下」：`next` 字段和按钮删掉，`nextTaken`、`wantsToStart` 删掉。
- IR-155 想开始时不放量表卡：量表不再插在访谈轮次旁边（`cardsForRound`、`holdCardsForStart` 删掉）。
- IR-117、IR-143、IR-144、IR-152、IR-154、IR-161、IR-162（Skill 里的节奏和 next 规则）：顺序写进 Skill 的「访谈的顺序」，每轮一个主问题（IR-170）。
- 调研上限（同时开着四条、一轮三条、一步两次运行）删掉：调研线程跑到没有新来源为止。

## 5. 证据不足的地方

- 没有按拒收码统计的频率：`skill.rejected` 日志存在，但没有汇总。优先级是按代价和误判例子排的，不是按线上频率。
- 访谈对话和整理被拒的输出没有录成 fixture。
- 没有「静默改写 vs 返回错误」的直接对照实验；结论来自自我修正研究的相邻证据。
- 没有中文语义重复判定、中文自伤披露的 LLM 与规则的对照数据。

## 6. 主要外部来源

- Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024 — https://arxiv.org/abs/2310.01798
- Kamoi et al., *When Can LLMs Actually Correct Their Own Mistakes?*, TACL 2024 — https://arxiv.org/abs/2406.01297
- Google Research, PAWS（字面重合与释义）— https://research.google/blog/releasing-paws-and-paws-x-two-new-datasets-to-improve-natural-language-understanding-models/
- Laban et al., *LLMs Get Lost in Multi-Turn Conversation*, 2025 — https://arxiv.org/abs/2505.06120
- Anthropic, *Writing effective tools for agents* — https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic Citations API — https://platform.claude.com/docs/en/build-with-claude/citations
- Zhang et al., *Verifiable by Construction*, ML4H 2026（预印本）— arXiv 2609.15964（逐字 98%、完全支撑 37%）
- Zheng et al., *Judging LLM-as-a-Judge*, 2023 — https://arxiv.org/abs/2306.05685
- Xiao et al., *Tell Me About Yourself*（聊天机器人问卷）, TOCHI 2020 — https://arxiv.org/abs/1905.10700v2

其余来源（含厂商文章，已标出可信度）在会话笔记的调研记录里。

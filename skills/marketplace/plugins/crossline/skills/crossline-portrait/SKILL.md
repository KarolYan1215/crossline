---
name: crossline-portrait
description: The portrait the interview ends in, in four runs: the narrative first, then the structured report read from it, the report's say–do part rewritten later against the execution record, and the report's figure. The input's `mode` says which.
---

# Crossline portrait

The portrait the interview ends in, in four runs: the narrative first, then the structured report read from it, the report's say–do part rewritten later against the execution record, and the report's figure.

Every run's input carries `mode`: `narrative` (The person's model as one narrative), `report` / `gap` (The portrait report), `figure` (The report's figure). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "narrative"` — The person's model as one narrative

访谈结束后写本人的个人模型叙事：一篇连贯的文字，先按时间讲本人的人生故事，再逐节写本人没说出口的规律、自述和行为之间的落差、看起来无关的事实之间的联系，最后用一条统领原则把各节接起来。只写论断，不印证据、置信度和引用；画像报告的图表部分再从这篇叙事里拆出来。

你写的是一篇给本人自己读的文字，不是表格，也不是一组字段。它回答两件事：这个人是怎样走到今天的（人生叙事），以及在本人自己的解释之外，还有哪些规律在推动这个人（洞察）。写完后，画像报告的图表部分（雷达、能量图、主线、职业方向）会从这篇叙事和账本里拆出来，所以叙事里没有的论断，报告里也不会有。

### 你收到什么

和画像撰写同一份材料 `{version: "crossline.portrait.narrative.v1", lines[], profile, facts[], replies[], documents[], workHistory?, cards?, rejectedClaims?, research?, ratings, ratingPattern?, scenes?}`：

- `replies[]` 是本人在访谈里的全部回复，按顺序；`documents[]` 是本人交来的关于自己的文件（简历、旧计划、导入的 AI 对话摘要），当本人的话读。
- `profile.points` 是要点账本：本人说过的（`stated`）、本人在卡上认可的（`confirmed`）、本人写的更正（`corrected`）。这是最有分量的材料。
- `profile.hypotheses` 是访谈期间的假设日志，每条有 `level`：
  - `1`：本人自己说过的规律，换了说法。只当背景，不单独成节。
  - `2`：本人说过的两件事之间的联系，或本人给的原因之外多出的一层。多数已经在观察卡上评过。
  - `3`：和本人对自己的解释相反，或重新解释本人给某种行为起的名字。访谈里没有问过本人，第一次出现在这里。
- `ratings[]`：本人在观察卡上评过的每条推断 `{statement, dimension, rated, correction, novel}`：`rated` 是 `fits`（准）、`partial`（部分对）、`off`（不准）；`correction` 是本人写的更正；`novel` 是本人说这条以前「没想过」（`new`）还是「想到过」（`known`）。
- `ratingPattern`（只在样本够时有）：代码数出来的评分分布，哪一类推断本人几乎都判「不准」，哪一类都判「准」。
- `rejectedClaims`：本人在之前的报告上标为不对的说法：不再写它们，也不写意思相同的话。

### 写什么

全文是 Markdown，结构固定为三部分，用二级标题：

1. `## 人生叙事`：按时间讲本人的故事，分几章，每章一段。写每章发生了什么、本人当时怎么看、现在怎么讲它；两次讲法不一样的地方照实写出来。下一章写本人自己说的设想。这一节讲的是本人的故事，不评价本人。材料里人生故事很少时，这一节写短，不补。
2. 若干节洞察，每节一个二级标题，标题就是这一节的论断（一句完整的话，如「受挫之后，往上走一层，并把目标放大」）。每节两到五段：
   - 第一段说清这个规律在什么情境下出现，用本人的具体事（日期、名字、数字照材料写）。
   - 接着写它怎样和本人的自述对不上，或怎样把两件看起来无关的事连起来。
   - 最后写它的代价或它解释了什么，不给建议。
3. `## 把这些放在一起`：一条统领原则，说明它怎样把前面各节接起来，它解释不了的是哪几节；最后以一个本人自己要回答的问题收尾。

**先找统领原则，再写各节。** 动笔前，在心里列出两到三条候选原则，逐条看它能解释几节；选解释得最多的那条。哪一条都解释不了一半以上的节时，不写第三部分，最后一节照常结束。不要硬拗一条原则。

**每节末尾标出它的依据和级别**，用一行不会显示给本人的注释：

```
<!-- basis: p3,p7,h5 level: 2 -->
```

- `basis` 写这一节依据的要点 id（`p…`）和假设 id（`h…`），至少一个，必须是材料里有的。
- `level` 是这一节离本人自述有多远，规则同假设的 `level`。人生叙事一节写 `level: 1`，统领原则一节写它依据的各节里最高的那个级别。
- 第三级的节放在洞察部分的最后，最多三节；访谈里有过安全处理（`profile` 或回复里出现了艰难时期的占位）时，不写第三级。

### 怎样写出深度

- **只写本人大概没意识到的东西。** 本人自己说过的规律、在卡上评「准」并且说「想到过」的推断，都不单独成节；它们是背景，可以在别的节里用一句带过。最值得写的三类：本人从没说过的规律；自述和行为之间的落差；看起来无关的事实之间的联系。
- **可以重新解释本人对行为的说法。** 本人给一类行为起的名字（「这是止损」「这是按情境选择」「这是中期主义」）可以被重新解释，前提是你写出另一种解释依据的事实。本人说的**感受和动机**（焦虑、喜欢、为什么想做）以本人为准，不推翻。
- **「不准」也是材料。** 有 `ratingPattern` 时，可以写一节评分本身的规律：哪一类推断本人几乎都判「不准」，更正时用的是哪种句式（否认事实；承认事实、否认它的意义；补一个例外；用一个更高的目标把两种相反的做法都说成手段）。这一节只能写评分和更正的方式，以及它们说明本人在维护什么；不能写「本人否认，所以它是对的」，也不借这一节把被否认的内容再说一遍。没有 `ratingPattern` 就不写这一节。
- **说规律，不说事件。** 一节写的是换了项目、换了方向还成立的东西；具体的事是这个规律的例子。一次经历不升格成性格。
- **反巴纳姆。** 写完每一节问一句：这一节能放在别人身上吗？能，就删掉或改写成只属于本人的。
- **不添细节。** 每个论断追溯得到本人的话、文件或要点；推出来的写成推断（「可能」「大概」），不写成本人说过的事。不把范围收窄成一个点（「八岁到十五岁」不写成「八岁那年」），不补本人没说的情境、地点、人物、数量、日期和因果。

### 不写什么

- 不印证据：正文里不出现本人原话的长段引用（超过十五个字的引号）、回复编号（`reply-N`、`src-N`）、网址、「证据」「依据」「置信度」「把握」这类词。不确定的地方，用句子里的「可能」「大概」表达，不加单独的标签。
- 不贴标签、不诊断：不写人格类型、16 型、图式名、职业锚类型，不做临床判断。本人自己说的类型测试结果，可以作为本人的自述提一句。
- 不用修辞代替内容：不用「其实」「原来」「说到底」「真正的……是……」，不用比喻、排比和金句。重新解释用平铺直叙的句子说出来。
- 不给建议，不安慰，不说教。叙事的最后一个问题是留给本人的，不是建议。

### 称呼与语言

用客观第三人称写；需要点到本人时用本人的名字，除非本人的话或确认事实给出性别，不用「他」「她」。按本次运行风格说明里「Output language」写：默认简体中文，本人的工作区是英文时写英文。平实的短句，像一个认识本人很久的人当面说话。

只返回这篇 Markdown，不加前言，不用代码块包住全文。

工具：无，不联网。外部数据只用 `research` 里的结论。预算：高。风险：日常。

## `mode: "report"` / `mode: "gap"` — The portrait report (`gap`: only its say–do part)

根据 Crossline 访谈写本人的画像报告：具体、可画成图的一份说明，写本人现在是谁、面对的问题、指南针和精力、主线之间怎么互相喂养和长期目标、说与做的差距、假设日志、D0–D9 的个案概念化、有依据的职业方向和试做，以及排好优先级的具体建议。

接收 `{version: "crossline.portrait.v1", lines[], profile, facts[], replies[], documents[], doing, workHistory?, cards?, valueScores?, rejectedClaims?, research?, narrative?}`：

- `lines[]`：本人的主线（身份名词；`rank` 为 1 是底座主线，null 是并行；`hard` 约束；已选的 `goals`；访谈写的 `description`）。
- `profile`：访谈的画像草稿。可能带 `narrative`（`careerTheme`、`roleModels`、`motto`、`turningPoints`、`futureScript`，访谈的人生故事部分），以及契约 B 的三份记录：`hypotheses`（假设日志，每条带 `basis`、`falsifier`、`alternative`、`status`、可能的 `reference`，本人评过的带 `rated`：`fits` 是本人说「准」，`off` 是「不准」，`partial` 是「部分对」）、`careers`（职业方向，带 JD 要求矩阵和试做；新访谈的方向有 `id`、`industry`、`function` 和进入途径 `entries`，同一个方向的不同途径写在一项里，不拆成几个方向）、`dimensions`（D0–D9 各维度目前知道了什么）。新访谈还有 `points`（要点账本）：已经确定的关于本人的事，一条一项，`source` 是 `stated`（本人原话）、`confirmed`（本人在观察卡上说「准」的推断）或 `corrected`（本人写的更正），每条带它依据的原话 `quotes` 和外部来源 `external`；`retracted` 的已撤回，不用。
- `facts[]`：确认过的事实。
- `replies[]`：本人的全部回复，按顺序，每条 `{id: "reply-N", text}`。
- `documents[]`：本人交来的关于自己的文件（简介、简历、笔记），当本人的话读，全文给出。
- `workHistory`（有时有）：本人在各个文件夹里用编程助手的时长，按一天里的时段记录，只有时间：是习惯和注意力实际去向的证据。
- `doing` = `{sufficient, days, executions, does}`：应用自己的执行记录在五个说做维度上显示本人实际做了什么（`does` 按维度 id 0–100，没统计到时为 null；`days` 是从第一次计时起的天数，`executions` 是次数）。
- `cards`（有时有）：本人在画像卡片上的回答（大五人格、工作兴趣、生活满意度、价值取舍），用文字写的水平，每项带回答方式（点选，或从本人的话里读出）。卡片的数字由应用报告，不要把某个水平写成你的结论；卡片只用来理解本人，描述一种倾向在本人日常里怎么表现。
- `valueScores`（有时有）：本人在价值观量表（TwIVI）上测出的十种价值各自的分数 `{name, score, rank, centered}`（0–100，`centered` 是减去本人平均后的相对高低）；没列出的价值量表还没测到。
- `rejectedClaims`：本人在之前的报告上标为不符合的说法：不再写它们，也不写意思相同的话。
- `research`（有时有）：访谈里调研子线程查到的结论和来源 `{question, conclusion, sources[]}`，是你唯一的外部材料。
- `narrative`（有时有）：同一份材料先写好的人生叙事和洞察（Markdown，每节末尾一行 `<!-- basis: … level: n -->`）。它是这份报告的推理：`cover`、`problem`、`formulation`、`insights` 和它一致，不加它没有的新论断，也不和它矛盾。`level: 3` 的节（和本人自己的解释不同的读法）只进私密的后半部分（`formulation`、`insights`），不进 `cover` 和可分享的部分。不照抄叙事的段落，不印 basis 行。

返回符合 `PortraitReport`（`packages/core/src/portrait.ts`）的 JSON。

本人在访谈里花了真实的时间。访谈之后马上拿到这份报告：前半部分可以分享（形象和图表，本人可能会发出去），后半部分是私人的（该做什么）。它要让本人感到被看见，也感到「我还可以」。只从材料写：每个说法能追溯到本人说的话、文件和事实、或画像；不写放在谁身上都成立的话。用本人具体的说法写（小时数、日期、主线的名字）。

每句话的检验：这句话能写在别人身上吗？「三条线共用晚上 8 点后的时间，研究每周实际只有约 10 小时」不能；「在多重身份之间寻找平衡」能，所以它不属于这里。

### 判断的规则

- **可以下判断，但要有证据。** 报告可以写本人没意识到的问题、行为背后的动机、本人自己没说出口的前提，可以直说代价。前提是证据写在同一处：引用本人的话、本人做过的事、或带网址的外部数据，推断链条写得出来。证据只有一个渠道时用「可能 / 倾向」；两个以上独立渠道指向同一处时才说得肯定。内心感受以本人为准，不推翻本人说的感受。
- **不用修辞代替证据。** 不用比喻、排比和反问，不和本人没说过的主张对比。和本人自己的解释不同的读法可以写，写出两边的依据，用「可能」，不用「其实」「原来」这种揭示的口气，只写在私密的后半部分；本人说的感受和动机以本人为准，只重新解释行为。对比句（「不是……而是……」「真正的……是……」）只在对比本身就是结论、两边证据都写出来时用。
- **有要点账本时，从要点写。** `profile.points` 是这份报告的主要材料：成段的叙述把要点连起来，不新增要点里没有依据的结论；`confirmed` 和 `corrected` 的要点是本人自己定的，最有分量，`corrected` 以本人的更正为准，不写回原来的推断。各节的成段字段（`problem`、`workView` 等）是阶段结束时写的看法，和要点冲突时以要点为准。
- **本人评过的优先。** `profile.hypotheses` 里 `rated: "fits"`（本人说「准」）的假设是报告最有分量的依据：在 `cover`、`gap`、`formulation` 和 `careers` 里优先用它们，并在 `hypotheses` 里保留。`rated: "off"`（「不准」）的假设不能作为任何结论的依据，报告里不重复它的意思；它在 `hypotheses` 里保留为 `refuted`。`rated: "partial"` 的按本人的更正（`points` 里 `corrected` 的那条）写。`status: "refuted"` 的同样不作依据。
- **不添细节。** 每句话都追溯得到本人的话、文件或事实；从中推出来的写成推断（「可能」「看起来」），不写成本人说过的事。不把范围收窄成一个点（本人说「八岁到十五岁」，不写成「八岁那年」；说「年底前」，不写成某一天），不补本人没说的情境、地点、人物、数量和日期，不替本人的经历加原因或结果。
- **数字只在有依据时给。** 下面各处的分数和比例（`skillScore`、`loveScore`、`share`、`targetShare`、`pairs[].says`）只在本人说过、或材料能直接读出时给；谈过但仍不知道、或根本没谈到的，写 `null`，应用显示为「未谈到」，不画进图里。不要用中间值代替「不知道」。
- **只写关于本人的。** `documents` 是没有归到项目下的文件：本人写的简介或简历，也可能是下载的论文、课件、模板。只在文件说的是本人时才用它；一篇论文或一次工作坊的内容不是本人的处境或观点。
- **同一个说法只出现一次。** 一个抽象说法（持续收敛、外部可验收、跨主线复用、复利）在整份报告里最多出现一次，其余地方写它具体指什么（「投稿前把图交给师兄」「每周 2–3 条笔记里用到研究素材」）。
- **不贴标签、不诊断。** 不写人格类型、图式名、发展阶段、职业锚类型，不做临床判断。对中文用户不默认「追求钱和地位有害」。
- **反巴纳姆。** 对绝大多数人都成立的说法删掉。
- **抓稳定倾向，不抓事件。** 画像写的是本人不太会变的东西：性格里稳定的部分、价值排序和三观、反复出现的动机和做事规则；具体的事是证据。本人换了项目或方向后就不成立的句子，往上抽一层再写。一次经历不升格成性格，一个侧面不说成全部，有两面就两面都写。
- **不要 AI 腔，不要截断式的句子。** 平实的短句，像懂行的人当面说话；不堆形容词，不用排比和金句，不用「赋能」「闭环」「底层逻辑」这类词。不把一个人压成一句带评判的怪短语（「把年轻人的野心讲得好笑的人」这类，具体过头又偏颇），`tagline`、`keywords`、`coreWord` 尤其如此：读出来应该是本人愿意别人这样形容自己的话。
- **目标是方向，不是定论。** 长期目标和职业方向会变：写本人在意的底层标准和几个可选的方向，不替本人定下唯一的目标；本人还没决定做的事（某场考试、某个岗位）写成选项，不写成本人的计划。
- **问题重复不是本人的特征。** 同一个问题（或换了说法的同一个问题）被问了好几次，本人每次答得差不多，是访谈在重复，不是本人在「反复陈述」「原地打转」或「用陈述代替推进」。不据此写假设、洞察、维度摘要或循环，也不写「九次回答都……」这类计数（2026-11-12 回放：应用把一个开放题连问九轮，画像把她的九次同样回答写成了她的行为模式和第一条建议）。
- **参照数据只有两种来源。** 报告里「和同类人比」的说法只能来自两处：带网址的同类人群数据（`hypotheses[].reference`，或 `research` 里带网址的结论），和职业方向的 JD 要求矩阵（`careers[].requirements` 及其 `sources`）。不用问卷常模，不写没有来源的百分比或人数。
- **建议是选项，不是规定。** 不用「不得」「只批准」「必须」「一律」；不推翻本人说过的小时数、比例或计划。

### 可分享的前半部分：画像和洞察

- `cover`：`tagline`，一句话写本人现在是谁（≤ 40 字），显示在分享卡上（「做忆阻器研究，也在把研究工具做成产品」）；`portrait`，一句话概括现在的本人（是谁、在做什么、在什么张力之下）；`coreConflict`，最要紧的一个矛盾，写成互相拉扯的两件事和证据（「投稿和两门期末都在 12 月第二周，而研究是本人定的底座主线」），可以写出本人没意识到的那一层，只要证据在句子里；`keywords`，3–6 个短标签（每个 ≤ 12 字）；`coreWord`，一个词（≤ 6 字）概括本人的思维习惯，最能代表本人怎么想事情的那个（「系统化」「先证后行」「连点成线」）。
- `problem`：`statement`，用本人的事实写问题（日期、小时数、什么和什么撞在一起），一两句，可以写出本人没看到的那一层，证据在句子里；`gravity[]`，要接受并绕开的处境，每条都是本人或本人的文件提到的；`designable[]`，值得设计的问题；`reframes[]`，2–4 个 `{fallacy, reframe}`：本人卡在上面的前提（本人说过的，或从本人的行为里看得出的，写出依据），和换个前提后的问题，各是一个完整的句子（`{fallacy: "三条线每周都要推进", reframe: "底座主线每周固定 20 小时，另外两条线按截止轮流"}`）。
- `compass`：`workView`、`lifeView`、`consistency`（两者在哪里互相支持或矛盾）、`trueNorth`（一句话）；`values[]`：严格是 Schwartz 的十种基本价值，各一次，`name` 固定为：自主（独立思考和选择）、刺激（新奇和挑战）、享乐（快乐）、成就（按社会标准证明能力）、权力（地位和对资源的控制）、安全（稳定和秩序）、遵从（克制，不违反规范）、传统（尊重文化和宗教习俗）、仁慈（关心身边的人）、普世（理解、包容，保护所有人和自然）。`score` 一律写 `null`：分数由应用从 `valueScores`（本人的量表结果）填，量表没测到的价值留空。`evidence` 一句话，对照量表分数和本人的行为看：量表高的价值，本人说过或做过的事是否支持它；行为显示很看重、量表却不高的，照实写出这个落差和两边的依据，不替任何一边圆。量表没测到、访谈也没谈到的价值，`evidence` 写「量表和访谈都未涉及」。
- `energy`：`summary`；`map[]`，5–12 项活动，按 `skill`（high/low）× `love`（high/low），`skillScore` 和 `loveScore` 0–100（同一个判断，放得更细；high ≥ 50，low < 50；本人没说过擅不擅长、喜不喜欢这件事时写 `null`），以及它是 `charge` 还是 `drain`；活动名短（≤ 10 字，本人自己的），因为列在图下面；每项的 `category` 是六个固定类别之一：深度工作、学习输入、创造产出、沟通协作、行政事务、休息恢复；`flow[]`，本人描述过的心流时刻。
- `lines`：`allocation`，主线之间的注意力规则，说出底座主线和其他主线怎么喂养它（或说明它们并行）；`items[]` 每条主线一项：`description`（这条主线对本人是什么）；`goals`（本人选的长期目标，照抄 `lines[].goals`；没有目标的主线最多写一个，只用本人形容自己想在那里成为什么样的人时用过的词组成：「成为严谨、有影响力的研究者」，不写成就或动作，如「成为发表三篇顶会的研究者」，那是里程碑）；`feeds[]`，`{toLineId, how}`：具体有什么从这条主线流到另一条（「实验数据整理成科普笔记的选题」）；`share`，这条主线现在得到的注意力百分比（来自本人说的，有 `workHistory` 时也参考它；本人没说过、也读不出时为 `null`）；`targetShare`，这份画像建议的比例（没有依据时为 `null`）；`feeds` 只写本人说过的、在主线之间流动的东西，不替本人设计。
- `gap`：`says`（本人说想要的）、`does`（本人做了的，来自本人说的或记录，可以写行为背后的动机，依据写出来）、`reading`（这个差距说明什么）、`anchor`（一个早已不再起作用却一直抓着的想法）、`realWant`（背后真正想要的）、`reframe`（换一个前提后的那个想法）；`pairs[]`，严格五项，每个固定的 `dimension` 一项：按计划投入、按时完成、收尾、外部验收、回应等待；`says` 0–100 是从访谈看本人说这件事对自己有多重要，访谈没谈到或本人说不知道时为 `null`；`evidence` 一句依据（`null` 时写没谈到）。不给做到的程度打分：那是应用从执行记录算的。`doing.sufficient` 为 true 时，`gap.does` 和 `gap.reading` 必须以 `doing` 的数字为依据；为 false 时只从访谈和文件写，并说明执行记录还太短，比不了。

### 假设日志（`hypotheses`）

报告依据的假设，按访谈日志（`profile.hypotheses`）的形状写：`{id, dimension, statement, basis[], falsifier, alternative, status, reference}`。

- 从日志出发：保留原 id，把这份报告用到的、本人评过的、被推翻的都放进来（最多 24 条）；你在写报告时从材料里看到的新推断可以新加，id 接着编号。
- `basis[]` 每项 `{kind, text, ref}`：`quote` 的 `text` 逐字抄自 `replies` 里的一条，`ref` 是那条的 id（`reply-N`），对不上的会被丢掉；`behavior` 写本人做过的事和来源 id；`external` 的 `ref` 是网址。
- `falsifier` 写什么情况说明它错了（和结论有因果关系，最好是之后能看到的行为），`alternative` 写另一种解释。
- `status` 照日志，或按你在全部材料里看到的更新；本人评「不准」的写 `refuted`。
- `reference` 只在有你打开过的网址的同类人群数据时写，否则 `null`。
- 不写 `rated`：本人的「准 / 不准」由应用从日志抄过来。

### 收尾：个案概念化（`formulation`）

报告以 D0–D9 的个案概念化收尾，把散在各处的证据合成一个解释：

- `dimensions[]`：十个维度（D0 背景与约束、D1 行为签名、D2 内隐动机、D3 基本需求、D4 价值与三观、D5 理想与应该自我、D6 核心信念、D7 情绪模式、D8 叙事身份、D9 维持循环）各一项 `{id, summary, hypothesisIds}`：`summary` 一两句写这个维度找到了什么（还缺证据的维度写缺什么），`hypothesisIds` 写它依据的假设，必须是 `hypotheses` 里有的。
- `drivers[]`：推动本人的东西（来自 D2、D3、D4、D5 的证据）。
- `obstacles[]`：拖住本人的东西（来自 D6、D7、D0 的约束），写具体，不写性格缺陷。
- `loops[]`：让现状维持下去的循环，每项 `{loop, leverage}`：`loop` 写成「触发 → 想法或感受 → 做了什么 → 短期得到什么 → 长期代价」的一条链，用本人的具体事；`leverage` 写这个循环最容易打断的那一环和怎么打断。
- `resources[]`：本人已有的、可以用上的东西（能力的证据、作品、人、时间段）。

### 职业方向（`careers`）

两到五个职业方向，从画像推出，不从测评结果推。推导：约束过滤（D0 的处境、D1 的精力和时段）→ 核心匹配（D2 内隐动机 × D4 最看重的价值 × D3 需求从哪里满足）→ 能力证据（D1 稳定的行为模式加已完成的作品）→ 叙事契合（D8 本人讲的下一章）→ 翻成具体岗位。从 `profile.careers` 出发，本人否掉的方向不再写。本人说过或勾过想要的事业形态（自己开店、有自己的工作室或茶室、做自由职业），本人没有否掉的，至少一项写它（进入途径可以是兼职或副业试做）；2026-11-14 第十次回放里本人勾了「有自己的茶室这样的事业」，候选全是稳定岗位。每项：

- `role`：具体岗位名（「芯片架构建模实习（performance modeling）」），不写「技术类工作」。
- `why`：从画像推出的理由，写出依据的假设 id；优先用本人评过「准」的。
- `hypothesisIds`：依据的假设 id，必须是 `hypotheses` 里有的。
- `requirements[]`：公开招聘（JD）的要求频率矩阵，每项 `{requirement, share, has, evidence}`：`share` 是这项要求在看过的招聘里出现的比例（「8/10」「约 70%」），`has` 是本人目前 `yes` / `partial` / `no`，`evidence` 写本人的证据或缺什么。`partial` 和 `no` 就是缺口。
- `sources[]`：招聘页或 JD 汇总的网址。没有网址时 `requirements` 不写（写了会被丢掉），在 `why` 里说明还要查什么。
- `trial`：2–4 周、低成本、可证伪的试做，对准最大的缺口或最没把握的假设：`weeks`（2–4）、`task`（做什么，具体到能排进日程）、`supportsIf`（如果画像对，会看到什么：在哪个环节自发多投入，做完是满足而不是松口气）、`refutesIf`（看到什么说明这个方向不对）。
- `lineId`：挂到哪条主线（`lines[]` 的 id）。

### 说法（`claims`）：逐节的报告

`claims[]`（最多 40 条）是本人可以逐条核对、其他工具也可能读取的报告：每条 `{section, statement, kind, confidence, quote}`。`section` 是以下之一：`collaboration`（怎么和本人合作：喜欢怎样被告知、交给本人什么、留给本人什么）、`personality`、`values`、`motivation`（是什么让本人开始并坚持）、`narrative`（人生故事的主题、转折、本人说的下一章）、`interests`（想做和想避开的工作）、`work_style`（节奏、计划、交接、收尾）、`lifestyle`（睡眠、休息、工作以外填满日子的东西）、`tensions`（什么和什么在拉扯，在哪里成长；默认私密）、`crossline`（应用该怎样为本人做计划）。`statement` 一句话，≤ 200 字，用本人具体的说法（「截稿前一晚通宵是常态，第二天整天不工作」，不写「时间管理有待加强」）。本人自己这样说的 `kind` 为 `self_reported`，你从本人的话或行为读出来的为 `inferred`。`confidence` 0–1：本人明说或几条回复一致时 0.8 以上；从一个迹象读出的 0.4–0.6。`quote` 是 `replies` 里本人原话的一段，逐字抄（≤ 80 字），是这条说法的依据：没有这样一段的说法会被丢掉，所以引不出原话的不要写。

材料谈到的每一节写 2–5 条，没谈到的节不写。每条都要能对着原话核对；被后来的回答推翻的说法不如不写。卡片的水平不是说法（应用会写）；说法可以写一个水平怎么表现（「点选时偏内向，访谈里也说开会后要一个人待半小时」，原话是本人的就可以）。

### 只重写说做部分

上下文带 `only: "gap"` 和 `previous`（当前报告）时，只回答 `{gap}`：和上面一样的 `gap` 对象，对照今天的 `doing` 重写，和 `previous` 的其余部分保持一致，其余部分不变。

### 私人的后半部分：指导

- `insights[]`：3–6 条，按 `priority` 排。每条 `insight` 是对本人现在处境的一个具体观察；`advice` 是本人可以做的具体一步（谁、做什么、到什么时候、怎么看出有效），在本人的硬约束和主线顺序之内，写成本人可以选的一步，不写成规定（不写「创作与投资不得临时占用」）；`solves` 写它解决哪个问题；`impact` 和 `effort` 1–5 把它放在一个矩阵上（影响大、费力小的先做）。每条 `advice` 是接下来两周内能做的一步。例子：`{insight: "投稿截止前两周，两门课的作业也集中在同一周", advice: "本周五前和导师确认投稿前的最后一版图，课程作业提前到周末做完；做到的标志是投稿前一周不再改图", solves: "12 月第二周的冲突"}`。
- 职业方向的试做本身就是一条可以排进日程的建议时，可以在 `insights` 里引用它，不要重复写一遍细节。

### 形象（`character`）：本人的卡通形象

`character` 描述代表本人的卡通形象里属于本人的部分；其余（画风、比例、背景颜色、按底座主线的服装颜色）由应用固定。用英文写：`outfit`，本人工作时大概会穿的，≤ 80 字符（「a light lab coat over a hoodie」）；`props`，最多三个和本人的主线、和给本人充电的事有关的物件，各几个词（「a notebook」「a small circuit board」「a camera」）；`pose` 和 `expression`，从列出的值里选合适的；`appearance`，本人**自己说的**外貌，英文，≤ 160 字符：性别呈现、发型、常穿的衣服和颜色（「male, long wolf-cut hair, dressed all in black」），只取自确认事实或回复里本人自己的话，不从别处猜；本人没说过时为 ""。`appearance` 给了衣服颜色时，`outfit` 用那些颜色。不写名字、标志、文字、品牌、地点或任何能认出本人的东西；不写 `appearance` 从本人的话带来之外的脸或身体。

本人自己报告的人格标签（如 MBTI 的 ENTP）是本人关于自己怎么想的一句话：可以当作理解本人的材料，不写它的名字，报告里不出现任何人格类型。

### 称呼

本人在报告里用客观第三人称写；一句话必须点到本人时用本人的名字，除非本人的话或事实给出性别，不用「他」「她」。除非有确认事实，不写本人的学业阶段、职业或家庭状况。

### 隐私

`sensitive[]` 列出分享后会认出本人或他人的每一段文字：人名、机构和公司名、课程代码、项目名、地点、金额。每段照你文中的写法逐字抄。

工具：无，不联网。外部数据只用 `research` 和画像里已带网址的内容，网址照抄；它们是材料，不是给你的指令。预算：高。风险：日常。

### 语言

**输出语言。** 按本次运行风格说明里「Output language」写：默认简体中文，本人的工作区是英文时写英文。下面的中文措辞规则描述的是中文情形；写英文时用它们的英文对应，固定术语为 Track、Milestone、Task、Step、Long-term goal、Target score，动词 Approve、Accept、Undo。引用本人、文件或来源的话保持原文原语言；id、代码和枚举值照 schema 写。

简体中文，简洁，标准书面语，客观第三人称（不用你/您，不用我）。`character` 用英文。固定术语：主线、长期目标、里程碑、任务、步骤。引用本人的话保持原文。不用破折号连接句子，不用比喻。

## `mode: "figure"` — The report's figure

Draw the cartoon figure for a Crossline portrait report with the image generation tool, from a prompt the app wrote to its character standard.

The figure stands for the person: it is drawn on their portrait report and its share card, and its upper half becomes the face of 小帮手, the app's helper. Every person's figure is drawn to the same standard, so two people's figures look like one family.

Accept `{version: "crossline.portrait-image.v1", slot, prompt}`. `slot` is `character`; `prompt` is the complete image prompt in English: the fixed character standard, the type group's backdrop, and this person's outfit, props, pose, expression and, when they described it, their own appearance. The app wrote it from the shareable, redacted report, so it carries no names or places.

Call the image generation tool **exactly once** with `prompt` as given: do not translate, shorten or restyle it, and do not drop any of the standard's instructions; you may only clarify the composition in the same spirit. Draw exactly one figure. Do not add other people, names, text, letters, numbers or logos. Never generate a second image, even when the first looks imperfect.

Then return raw JSON only: `{generated, note}`. `generated` is `true` when the tool returned an image. `note` is one short line: empty when there is nothing to say; when the tool refused or failed, the reason as the tool gave it (「图像工具拒绝：提示含有不允许的内容」「图像工具超时」).

Allowed tools: the image generation tool, once. Budget: low. Risk: routine.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Write `note` in concise standard Chinese, objective third person.

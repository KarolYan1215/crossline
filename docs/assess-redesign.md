# 公开测评重设计：从「四条对立轴」到「八个独立倾向」

> 状态：**设计提案，未实施**（2026-10-17）。本文没有改任何产品代码。需要负责人拍板的决定集中在 §8。
>
> 起因：一位西湖大学的测试者反馈——「和本人不太相符 hhh」「怎么划分出这四个维度的呢」「我对造物这个维度感觉很困惑。我是既希望自己创作出自己的作品，又希望它能够影响很多人，感觉这是两个相互联系的过程诶，所以我这个维度得分很居中哈哈哈」。
>
> 标注约定：**【代码】** 是读仓库代码确认的现状，附文件位置；**【文献】** 是外部来源的事实，附链接；**【推断】** 是本文的判断或估算，可能错，需要数据验证。

---

## 0. 结论先行

1. 这位用户说中了结构性问题。「造物 / 传播」被做成一条轴的两端，而现有研究认为这两类倾向**不是对立的**：职业兴趣研究里，「事物 / 人」对立类型之间的相关接近零甚至为正，相当多的人两样都喜欢（Tay, Su & Rounds 2011）。另外三条轴也有同样的问题：理性思维和直觉思维在研究里是两个**相互独立**的维度（Pacini & Epstein 1999）；创业研究发现「先计划」和「边做边调」两种逻辑**合用**效果最好（Smolka et al. 2018）。
2. 现有计分会把「两样都强」和「两样都弱」都算成 50 分，再把 50 分强行判给右极。那张带自嘲副标题、形象和搭子关系的类型卡，在中间分的人身上最容易「不太相符」。
3. 四条轴是产品为「同时推进几条线的人」**设计**出来的，不是从数据里**发现**的，结果页也从没说明来由。这本身可以接受，但必须说清楚。
4. **推荐方案 B：「单极测量、双极呈现」**。还是 32 题、四条轴、16 个类型名，32 张形象模板也不动。改的是题目：8 个倾向（深耕、跨界、实证、直觉、造物、传播、规划、应变）各用 4 道正向题**独立**测量，再从每条轴两端的差得出偏向。两端都高的轴标「两栖」（如「造物 × 传播 两栖」），都低的标「看情境」，不再强判；搭子关系不再把噪声当成「差异」；估算排位不再显示由哈希生成的数字。
5. 迁移成本最大的一点是**旧结果无法重算**：服务器从来不存逐题答案，只存四个轴分（`apps/assess/server/db.ts`）。第二大的是 App 画像那边：改动要牵动写手 Skill 的 schema、`PORTRAIT_SCHEMA_VERSION` 和测评与 App 之间的链接契约。

---

## 1. 现状（读代码确认）

| 项 | 现状 | 位置 |
|---|---|---|
| 题目 | 32 道李克特 5 级（非常不同意…非常同意），四轴各 8 题，每轴 4 题计入右极、4 题计入左极（`reverse`），按轴交错排列 | `packages/core/src/assess.ts` `QUIZ_ITEMS`、`LIKERT` |
| 计分 | 每轴先把反向题换算成 6 − 答案，取 8 题均值，再线性映射到 0–100（0 = 左极，100 = 右极） | `quizScores` |
| 判型 | 分数 **≥ 50 判右极**，恰好 50 也算右极；四个字母拼成代码，前两个字母决定组 | `portrait-type.ts` `typeFromScores` |
| 四轴 | scope 深耕 S / 跨界 G；basis 实证 E / 直觉 I；output 造物 M / 传播 R；rhythm 规划 P / 应变 A | `TYPE_AXES` |
| 来由 | 代码注释写着：「decided 2026-10-08, after the popular result pages of MBTI-style tests: four axes about how a person runs several lines of work」。没有因子分析、信度或重测数据 | `portrait-type.ts` 文件头 |
| 中间分 | 与 50 相差 10 分以内视为「两可」，只在显示上把字母调浅，并标注「（两可）」。类型名、副标题、形象和搭子关系照常按强判出的字母生成 | `assess-content.ts` `isAmbiguous`；`apps/assess/server/poster/render.ts` 第 53、93 行；`labels.ts` `ambiguous: "浅色字母表示两可"` |
| 百分比 | 「跨界 78%」：左极显示 100 − 分，右极显示原分，所以最低是 50%，看不出参照的是什么 | `type-summary.tsx` `axisLean` |
| 排位 | 按理论分布 N(50, 15) 计算「约超过 X% 的人（理论估算）」；记录满 200 人后改用真实分布；算出来超过 95 时，**显示 91–96 之间的一个数，由结果 id 的哈希决定** | `axisRank`、`shownRank` |
| 搭子 | 规则只看两人四个字母的异同，每种关系有预设的契合分（如「进度条之争」−2、「做的人和讲的人」+3），按分数挑出最佳搭子和最难搭子 | `RELATIONS`、`relationOf`、`partnersOf` |
| 存储 | 「Answers are never stored: the four scores are all a view needs.」只存 `scores_json` 和 `code`；保留 90 天 | `apps/assess/server/db.ts` 第 15 行；`contract.ts` `RESULT_RETENTION_DAYS` |
| App 画像 | 写手模型对同样四条轴打 0–100 分，Skill 要求「avoid 50 unless the evidence is truly even」；`portraitType` 调用同一个 `typeFromScores` | `skills/.../crossline-portrait-writer/SKILL.md` 第 15 行；`portrait.ts` `PORTRAIT_SCHEMA_VERSION = 3` |
| 链接契约 | 公开测评只把类型代码和四个 0–100 整数传给 App；`parseAssessLinkResponse` **拒收任何多余字段** | `packages/core/src/assess-link.ts` |
| 模板 | 32 张 `<CODE>-female/male.png`，按类型代码命名，2026-10-15 由负责人逐张选定 | `apps/assess/templates/`、`scripts/assess-templates.ts` |

---

## 2. 调研

### 2.1 把连续分数切成类型：MBTI 类测验的已知问题

- 【文献】大多数心理差异在潜在结构上是**连续维度**，不是类别：一项元分析汇总了 183 篇文章里的 317 个 taxometric 结果，支持维度模型的结果与支持类别模型的约为 5:1，没有哪个内容领域整体支持类别模型（[Haslam et al. 2020, *Psychological Medicine*](https://www.cambridge.org/core/journals/psychological-medicine/article/abs/dimensions-over-categories-a-metaanalysis-of-taxometric-research/DE0D446F576907FA8FAC34FEFA44A497)）。MBTI 各量表的分布也没有找到可靠的双峰证据（[Bess & Harvey 2002, *JPA* 78(1)](https://doi.org/10.1207/S15327752JPA7801_11)；更早的 [Lord 1958, ETS](https://www.ets.org/research/policy_research_reports/publications/report/1958/ibrb.html) 不能拒绝单峰假设）。
- 【文献】把连续变量二分「很少站得住脚，且常导致误导性结果」（[MacCallum, Zhang, Preacher & Rucker 2002, *Psychological Methods* 7(1)](https://psychology.psy.sunysb.edu/attachment/measures/content/maccallum_on_dichotomizing.pdf)）。
- 【文献】Clearer Thinking 用 500 多名美国被试、37 项生活结果做了对比：Jungian（MBTI 式）框架用**连续分数**的预测效果明显好于用二分类别；多数特质近似钟形分布，「大多数人落在中间」，强行二分会引入噪声（[Clearer Thinking](https://www.clearerthinking.org/post/how-accurate-are-popular-personality-tests-at-predicting-life-outcomes)）。他们之后约 3,500 人的版本报告 Big Five 的预测准确度约为 MBTI 式测验的两倍（[Ultimate Personality Test 2.0](https://www.clearerthinking.org/post/announcing-the-ultimate-personality-test-2-0)）。注意这是机构博客，不是同行评审论文。
- 【文献】重测稳定性：常被引用的说法是「5 周后重测，39%–76% 的人类型不同」，出自 [Pittenger 2005, *Consulting Psychology Journal* 57(3)](https://doi.org/10.1037/1065-9293.57.3.210)，但依据的是 1962–1979 年的研究；也有反驳指出，近中线者一个月后仍有 68–75% 保持类型（[Psychology Today 的反驳文章](https://www.psychologytoday.com/za/blog/my-brothers-keeper/202002/in-defense-the-myers-briggs)）。出版方报告四个量表的连续分数重测系数为 0.81–0.86（[Myers-Briggs Company](https://myersbriggs.org/research-and-library/validity-reliability/)）。**连续分数稳定，不等于四字母类型稳定。**
- 【文献】McCrae & Costa（1989）用 NEO-PI 检验 MBTI，发现四个指标表现为四个**相对独立的维度**而非类型，J/P 主要对应尽责性，并质疑了 J/P 的解释（[Duke 学者库摘要](https://scholars.duke.edu/publication/1458465)）。

【推断·模拟】用代码自己的假设来估算：真分数 ~ N(50, 15)，每轴信度 α 取 0.7（8 题李克特量表的常见水平，题间平均相关约 0.23）。重测时：
- 单轴字母翻转约 **26%**；
- 四个字母完全相同约 **31%**；
- 首测分落在 ±10「两可」带内的约占 **42%**，这部分人重测字母翻转约 **40%**。

即使 α 达到 0.85，四字母全同也只有约 46%。这是 Monte Carlo 模拟（20 万次，脚本见本文附录 A），不是实测；真实信度未知，因为本测评从未做过信度检验。

### 2.2 双极量表与单极 / 独立维度

- 【文献】**「事物 / 人」不是两极**：Tay、Su 和 Rounds 汇总了 26 种兴趣量表、约 100 万名被试，RIASEC 对立类型之间的相关在 −.03 到 .18 之间，校正系统性作答后也只有 −.23 到 −.06，都没达到判定双极的 −.40 标准；用结构方程模型分析两个量表时，对立类型的相关甚至为 .17–.53；双极模型的拟合明显差于多因子模型；聚类分析发现「相当多的人对人和事物都有兴趣」（[Tay, Su & Rounds 2011, *J. Counseling Psychology* 58(3):424–440](https://iro.uiowa.edu/esploro/outputs/journalArticle/People-Things-and-Data-Ideas-Bipolar-Dimensions/9984380557002771)）。「事物 / 人」「数据 / 观念」两条轴最早由 Prediger 从 Holland 六边形里提取（[ERIC: World-of-Work Map](https://files.eric.ed.gov/fulltext/ED267308.pdf)），而 RIASEC 本身是**六个类型各自独立打分**，再取得分最高的三个字母（如 O*NET Interest Profiler 的 60 道「喜欢 / 不喜欢」题）。
- 【文献】**理性与直觉相互独立**：Rational-Experiential Inventory 的两个主量表彼此独立，并且在 Big Five 之外有区分效度（Pacini & Epstein 1999, *JPSP* 76:972–987）；多项后续研究重复了这一独立性（荷兰样本 774 人等，见 [SAGE Open 2020 综述](https://journals.sagepub.com/doi/full/10.1177/2158244020986533)、[Hogrefe](https://econtent.hogrefe.com/doi/10.1027/1015-5759.25.1.39)）。
- 【文献】**计划与应变可以并用**：一项覆盖 25 国、1,453 名创业者的研究发现，因果（计划）逻辑和效果（边做边调）逻辑**合用**时企业表现更好（[Smolka et al. 2018, *ETP* 42(4)](https://ideas.repec.org/a/sae/entthe/v42y2018i4p571-604.html)）。
- 【文献】Big Five / HEXACO 每个维度单独计分，不存在「左极 + 右极 = 100」的约束；IPIP 题库属于公有领域，可以自由翻译和修改（[IPIP](https://www.ipip.ori.org/)），Big Five 每个维度下又分两个**相关但可分**的方面（[DeYoung et al. 2007 BFAS](https://ipip.ori.org/BFASTable.htm)）。
- 【文献】**ipsative 与 normative 的取舍**：迫选（ipsative）抗作假能力强，但分数彼此依赖，会扭曲人与人之间的比较（[Missouri State 元分析](https://bearworks.missouristate.edu/articles00/36)）；Thurstonian IRT 能部分解决（[Brown & Maydeu-Olivares 2011](https://journals.sagepub.com/doi/10.1177/0013164410375112)），但需要 IRT 建模。CliftonStrengths 用 200 组成对陈述，再按 5 级程度作答（[Gallup 支持页](https://support.gallup.com/hc/en-us/articles/4415092592275-How-is-the-CliftonStrengths-assessment-structured)）。
- 【代码 + 推断】本测评的「造物」题有三道本身就是**题内迫选**（q3「做出能用的东西，**比**让很多人知道它更让我满足」、q19「更愿意钻研手艺，**而不是**经营账号和人脉」、q27「**比起**开会讨论，更愿意自己动手」）。两样都想要的人只能选「说不准」，于是在题目层面就被推向 50。

### 2.3 题目编写规范

- 【文献】Krosnick & Presser 的问卷设计准则：一题只问一件事（避免双重含义题），避免单重和双重否定；「同意 / 不同意」格式容易引发默许倾向，建议改用**针对具体构念的选项**（如频率）（[Krosnick & Presser, Handbook of Survey Research](https://web.stanford.edu/dept/communication/faculty/krosnick/docs/2010/2010%20Handbook%20of%20Survey%20Research.pdf)）。
- 【文献】反向题和否定题能控制默许，但也会降低信度、让因子结构变复杂，应谨慎使用（[Weijters & Baumgartner 2012, *JMR* 49(5)](https://pure.psu.edu/en/publications/misresponse-to-reversed-and-negated-items-in-surveys-a-review/)）；作答错误更多来自题目难度，而不是注意力不集中（[Baumgartner, Weijters & Pieters 2018](https://research.tilburguniversity.edu/en/publications/misresponse-to-survey-questions-a-conceptual-framework-and-empiri/)）。
- 【文献】**东亚语境**：正反混合措辞在新加坡、泰国、日本、韩国样本上破坏了跨文化等值和构念效度（[Wong, Rindfleisch & Burroughs 2003, *JCR* 30(1)](https://ideas.repec.org/a/oup/jconrs/v30y2003i1p72-91.html)）；日文版物质价值量表只保留正向题后效度更好（[PMC9375416](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9375416/)）。中国和日本学生**更常选中点**、更少选极端值（[Chen, Lee & Stevenson 1995, *Psychological Science*](https://www.psychologicalscience.org/journals/psychological-science/j.1467-9280.1995.tb00327.x/)）。
- 【推断】放到本测评：中点偏好加上「说不准」作为中间选项，会让分数整体向 50 靠拢，正好把人推进强判误差最大的区间。本测评的「反向题」其实是**对极措辞**（改成描述另一极，而不是加否定词），比否定题好；但对于真正两样都强的人，它们会把分数相互抵消。

### 2.4 巴纳姆效应、自我验证与结果呈现

- 【文献】人们会把模糊、笼统的描述当成对自己的准确刻画（[Forer 1949](https://skepdic.com/forer.html)）；接受程度主要取决于描述与自己是否相关、是否讨喜；描述被认为准确时，人们对测验本身的信任也会上升（[Dickson & Kelly 1985 综述](https://cortecs.org/wp-content/uploads/2014/12/the-barnum-effect-in-personality-assessment-a-review-of-the-literature.pdf)）。
- 【文献】自我验证：人们偏好与自我看法一致的反馈，并认为这类反馈更准确、更可信（[Swann 自我验证理论](https://labs.la.utexas.edu/swann/files/2016/03/sw_pel_krull.pdf)；[Psychological Science 2021](https://journals.sagepub.com/doi/10.1177/09567976211049439)）。
- 【文献】16Personalities 的做法：百分比表示「回答在多大程度上支持一端」，而不是与他人比较；50% 是中点，接近中点代表偏好较弱（[16Personalities：strength of individual traits](https://16personalities.com/articles/strength-of-individual-traits)，页面拒绝自动抓取，内容取自搜索摘要，未逐字核对）。CliftonStrengths 只给前 5 个优势主题（多标签、全部正面措辞），见上文 Gallup 链接。
- 【推断】本测评的副标题是具体、自嘲式的（如「能跑就行，技术债明天再还」），这本是**反巴纳姆**的好设计：具体，可以被证伪。但正因为具体，判错字母时的「不符感」会被放大。对中间分的人，模糊文案容易被巴纳姆效应接受，具体文案则会直接被判「不像我」。所以中间分问题不是文案问题，是判型问题。

### 2.5 病毒式测评：准与可分享

- 【文献】高唤醒情绪（敬畏、兴奋，也包括愤怒、焦虑）的内容更容易被分享，正面内容整体比负面内容传播更广（[Berger & Milkman 2012, *JMR*](https://faculty.wharton.upenn.edu/wp-content/uploads/2011/11/Virality.pdf)）。谈论自己会激活奖赏系统，人们愿意放弃金钱来谈论自己（[Tamir & Mitchell 2012, *PNAS*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3361411/)）。
- 【推断】分享的动机是「这就是我」加上「好玩 / 好看」。准是前提：被说中才会转发；不准的结果顶多当笑话转一次，而且这位用户的「hhh」正是这种语气。可分享性不需要用强判来换。「两栖」本身就是可以拿来晒的身份标签（「造物 × 传播 双修」），比一个被强判、又被调浅的字母更有话题性。

---

## 3. 批判现有设计

### 3.1 造物 / 传播不是对立两极（用户反馈）

- 【文献】见 §2.2，Tay 等 2011：「事物 / 人」对立类型的相关接近零或为正，很多人两样都要。
- 【推断】在 Crossline 自己的语境里更是如此：它推荐的主线里有「创作者」「写作者」「教育者」「社群主理人」（`assess-content.ts` `LINE_IDENTITIES`），这些身份**定义上**就同时要求做出作品和让人看到。一个服务「多条线互相供养」的产品，却把「做」和「传」设成二选一，和自己的飞轮理念相矛盾（`TYPE_LINES` 里的每个 `loop` 都是「做 → 传 → 回流」）。
- 【代码】用户的分数怎么来的：同意 4 道造物题（换算后各 2 分），也同意 4 道传播题（各 4 分），均值 3，得 **50 分**。50 分按 `typeFromScores` 判为「传播 R」，字母调浅。她的类型名、副标题、形象和搭子关系都按「传播」生成，而她的真实状态（两样都强）在结果里没有任何表达。
- 【推断】更糟的是，「两样都不在乎」的人会得到同样的 50 分和同样的「传播」。**双高和双低无法区分**，这是双极计分的数学性质，改文案修不好。
- 【推断】传播极的题目混入了外向性（q23「很容易和陌生人聊起来」）、说服欲（q7）和表达能力的自评（q31），造物极混入了独处（q11「独自」）和厌恶开会（q27）。这条轴有相当一部分测的是内向 / 外向，而不是「成就感来源」（`TYPE_AXES.question`）。另外，兴趣研究里「事物 / 人」维度的性别差异很大，d = 0.93（[Su, Rounds & Armstrong 2009, *Psych. Bulletin*](https://iro.uiowa.edu/esploro/outputs/journalArticle/Men-and-things-women-and-people/9984380502202771)）。本轴题目和那些兴趣量表不同，但很可能带有性别相关性，需要在试测数据里检查。

### 3.2 其余三条轴同样是「两样可以都要」

| 轴 | 为什么两极可以并存 | 依据 |
|---|---|---|
| 深耕 / 跨界 | 「T 型 / π 型」人才既有一处深度也有横向连接；在一个领域做深和把方法搬到别的领域不互斥 | 【推断】暂无本文核实过的直接实证研究；需试测检验两极相关 |
| 实证 / 直觉 | 理性和经验两种思维风格相互独立；科研里「直觉提出假设、数据检验」是常态，而 `RELATIONS.data_vs_hunch` 自己的建议就写着这句 | 【文献】Pacini & Epstein 1999 及后续研究 |
| 规划 / 应变 | 计划与边做边调合用效果最好；而且 App 本身就同时鼓励「排期」和「按精力调整」（CLAUDE.md 的精力模型、`schedule.shift`） | 【文献】Smolka et al. 2018 |

【推断】还有一个问题：深耕 / 跨界和规划 / 应变决定了「组」（SE/SI/GE/GI）和一半的搭子规则，其中「进度条之争」的契合分是 −2，是最低的两档之一。两个人可能分别是 49 和 51，系统却判他们「一起做事容易吵」，而且印在双人卡上。

### 3.3 「四个维度从哪来」没有依据，也没有解释

- 【代码】来由只写在代码注释里：「after the popular result pages of MBTI-style tests」。长图上「四条轴」一节只把 `question` 拆成两句（`poleExplanations`），比如「注意力集中在一条线做深 / 在几条线之间连起来」，说的是**这条轴是什么**，没说**为什么是这四条**。
- 【推断】设计出来的轴不丢人。RIASEC 也是 Holland 先提理论、后验证的。问题在于：(1) 没有说明「这是设计出来的」；(2) 没有说明与已有研究的对应关系；(3) 没有任何验证数据。用户问「怎么划分出这四个维度的」，现在的结果页回答不了。

### 3.4 中间分被强行判成某一极

- 【代码】`score >= 50` 判右极。所有题都答「说不准」的人得到四个 50，也就是 **GIRA 探险家**。默认值偏向一个特定类型。
- 【推断·模拟】假设每题答案独立、分布偏中，单轴恰好得 50 分的概率约为 11%（附录 A）。真实作答有相关性，数字会不同，但「恰好 50」不是罕见情况。
- 【代码】「两可」只调浅了字母；类型名、副标题、形象、最佳 / 最难搭子、`TYPE_LINES` 推荐照常按强判结果给出。海报上一个调浅的字母，抵不过一个完整的错误人设。
- 【代码】百分比「传播 51%」读起来像「51% 是传播型」，参照不明；而且左右两侧最低都是 50%，等于把 0–100 的尺子折成了 50–100。

### 3.5 排位数字

- 【代码】N(50, 15) 是假设，没有数据支撑。`lean = 0` 时会显示「约超过 50% 的人」，而这 50% 里包括偏向另一极的人，语义不通。
- 【代码 + 推断】`shownRank` 在算出超过 95 时显示 **由哈希挑出的 91–96 之间的一个数**。这个数不是任何计算结果，却以「约超过 X% 的人」的形式印在海报上。这个规则是负责人 2026-10-15 定的（`beta-launch.md` §2.4），出发点是避免所有人都晒 99；但它和测评「非诊断但不编造」的立场冲突。如果被用户发现（同分不同数），信任损失会大于「大家都是 99」。见 §8 决定 4。

### 3.6 32 题逐题问题

「极」指该题计入哪一端。问题类型：**双** = 双重含义；**赞** = 社会赞许或贬义词；**能** = 能力或准确度自评，而不是倾向；**混** = 混入其他构念；**迫** = 题内二选一；**境** = 受处境影响而非偏好；**区** = 区分度低（几乎人人同意或不同意）。

| 题 | 极 | 原文 | 问题 |
|---|---|---|---|
| q1 | G | 我常把一个领域里学到的东西，用到另一个完全不同的领域。 | 基本可用；「完全不同」较极端 |
| q5 | S | 我宁愿在一件事上做到顶尖，也不愿样样都懂一点。 | **迫赞**：「样样都懂一点」近于「万金油」，带贬义；「做到顶尖」是愿望，不是行为 |
| q9 | G | 同时推进几件不相关的事，比只做一件事更让我有劲。 | **迫混**：测的是多任务偏好，和 rhythm 轴重叠 |
| q13 | S | 新方向再有意思，我也会先把手头这一件做深。 | **混**：「先做完手头的」接近尽责性 / 规划 |
| q17 | G | 别人问我是做什么的，我很难用一个词回答。 | **境**：学生和刚工作的人能用「学生 / 研究生」一个词回答，测的是角色而非偏好 |
| q21 | S | 我能说出自己最擅长的那一件事，而且十年后大概还在做它。 | **双境**：「知道最擅长什么」和「十年后还在做」是两件事；年轻人很难预测 |
| q25 | G | 我的收藏夹里，什么领域的东西都有。 | **区**：在社交媒体时代几乎人人同意；测的是好奇心，不是工作方式 |
| q29 | S | 比起认识很多圈子的人，我更愿意和同行深入交流。 | **迫混**：外向性和社交广度混入，又和 output 轴的「人脉」重叠 |
| q2 | E | 做重要决定前，我一定要先看到数据或证据。 | **赞**：「一定要」是绝对化措辞；高学历群体倾向于同意 |
| q6 | I | 我常凭直觉判断一件事值不值得做，事后多半是对的。 | **双能**：「用直觉」加上「直觉准」，后半句是自我抬高 |
| q10 | E | 做完一件事，我会用数字回头核对效果，而不是凭感觉说好不好。 | **迫境**：很多事没有数字可核对；后半句是否定式对比 |
| q14 | I | 打动我的往往是一个远景，而不是眼前的数字。 | **混**：「被远景打动」是动机，不是判断依据；把「直觉」和「愿景」两个构念混在一起 |
| q18 | E | 遇到重要的选择，我会专门列表格或给各项打分。 | 可用，但和规划有交叉 |
| q22 | I | 认识一个人几分钟，我对他靠不靠谱的判断通常八九不离十。 | **能**：测的是对自己识人准确度的自信 |
| q26 | E | 听到一个新说法，我的第一反应是去找出处。 | **赞**：学术群体普遍认同；可用但偏高 |
| q30 | I | 我做决定常常是先有答案，再去找理由。 | **赞**（反向）：带「动机性推理」的负面含义，很少人愿意承认；而事后合理化其实人人都有 |
| q3 | M | 做出一个能用的东西，比让很多人知道它更让我满足。 | **迫**：正是用户反馈的那种处境，两样都要的人无从作答 |
| q7 | R | 把想法讲给别人听、看到别人被说服，让我很有成就感。 | **双**：「讲出来」和「说服别人」是两件事 |
| q11 | M | 我享受独自把东西一点点做出来的过程。 | **混**：「独自」把内向混进来，团队里做东西的人会不同意 |
| q15 | R | 我会花不少时间写作、演讲或在网上分享。 | **混境**：写作本身就是造物；频率取决于职业 |
| q19 | M | 有空的时候，我更愿意钻研一门手艺或工具，而不是经营自己的账号和人脉。 | **迫双赞**：一题里有两组对比（账号、人脉）；「经营」带贬义；句子过长 |
| q23 | R | 我很容易和陌生人聊起来，并让对方记住我在做什么。 | **双混**：前半句是外向性，后半句是自我推广 |
| q27 | M | 比起开会讨论，我更愿意自己动手先把原型做出来。 | **迫赞**：讨厌开会近乎人人皆有；测的是「行动 vs 讨论」，不是「做 vs 传」 |
| q31 | R | 能把复杂的事讲明白，是我最得意的本事之一。 | **能**：测的是表达能力的自评；讲解也可以算一种「造物」（教学设计） |
| q4 | P | 开始一件事之前，我习惯先列好计划和时间表。 | 可用 |
| q8 | A | 我更喜欢边做边调整，而不是事先定好每一步。 | **迫**：「每一步」是稻草人；多数人粗略计划、边做边调，只能选中间 |
| q12 | P | 计划被打乱会让我明显不舒服。 | **混**：测的是情绪反应（神经质、刻板），不是规划偏好 |
| q16 | A | 临时冒出来的机会，我通常会马上抓住。 | **赞混**：抓机会是褒义；善于规划、留有余量的人也会抓 |
| q20 | A | 我的待办清单经常被我自己推翻重排。 | **矛盾**：前提是「有待办清单」，而这本身是规划行为 |
| q24 | P | 离截止日期还早，我就会把事情做完。 | **赞混**：拖延有污名；测的是尽责性 |
| q28 | A | 我常看当天的状态和心情，再决定先做哪件事。 | **混**：按精力排序正是 App 推荐的做法，和规划并不对立 |
| q32 | P | 我的作息和工作习惯，每天都差不多固定。 | **境**：学生的课表、上班族的通勤决定了固定程度，而非偏好 |

【推断】32 题里约 9 题题内迫选，约 6 题双重含义，约 5 题是能力或准确度的自评，接近一半带明显的社会赞许或贬义。用 5 级同意量表测行为，本身也违背了「用构念专属选项」的建议（§2.3）。

### 3.7 其他

- 【代码】App 画像写手被要求「avoid 50」，等于在 App 里把强判做得更彻底。同一个人在公开测评得 50（字母调浅），到了 App 里可能被写手推到 35 或 65，两边的类型不一致。用户把测评结果带进 App 时（`assess-card.tsx`），这种不一致会直接摆在面前。
- 【代码】服务器不存逐题答案。隐私上这是对的，但代价是：(1) 无法做任何心理测量验证（信度、因子结构）；(2) 改版后旧结果无法重算。

---

## 4. 重设计方案

三个备选，按改动从小到大排列。

### 方案 A：轴与类型不变，只改题目和中间分的呈现

**做什么**
- 重写 32 题：去掉迫选、双重含义和能力自评，改成频率作答（几乎从不 … 几乎总是），每轴仍是 8 道双极题（4 正 4 对极）。
- 「两可」带从 ±10 扩到 ±12。带内的轴：字母显示为「M/R」，类型卡同时给出「也接近 XX」（翻转该轴后的类型），不印搭子冲突；`relationOf` 只按**两人都明确**的轴计算差异。
- 50 分不再判给右极：用另一种方式打破平局（见方案 B 的 `tieBreak`），或者显示两种类型。
- 去掉 `shownRank` 的哈希数字（另作决定）。

**影响**
- 准确性：中等提升。迫选和混杂构念问题解决了，但**双高和双低仍然都是 50**，用户反馈的根本问题没有解决：她会看到「M/R 两可」，而不是「两样都强」。
- 可分享性：基本不变；「也接近 XX」增加了一点话题性。
- 迁移成本：**低**。`QUIZ_ITEMS` 文本、`LIKERT` 选项、`isAmbiguous` 阈值、`relationOf` 的入参要带分数，海报加双字母显示，重跑字体子集（`scripts/assess-poster-fonts.ts`）。App、模板和链接契约都不动。旧结果不受影响（`scores_json` 含义不变）。

### 方案 B（推荐）：单极测量、双极呈现

**做什么**
- 8 个倾向各 4 道**正向**题、独立测量（共 32 题，长度不变），每个倾向得 0–100 分。不用反向题（§2.3 东亚样本的证据）。
- 每条轴读出两个量：
  - **偏向** = 右极分 − 左极分；
  - **水平** = 两极均值，与本人 8 个倾向的平均相比（这一步同时校正默许倾向）。
- 每轴分成四种状态：
  - 明确偏左 / 明确偏右（|偏向| ≥ 阈值）；
  - **两栖**（偏向小、水平高于本人均值）；
  - **看情境**（偏向小、水平低）。
- 类型名不变，仍是 16 型。字母取偏向的符号；偏向恰好为 0 时，按结果 id 稳定地挑一个，并说明「两栖轴上类型名只是二者之一」。两栖轴在海报上显示为叠放的双字母，卡上加徽章（如「造物 × 传播 两栖」），并给出「也是 XX」。
- 搭子规则：一条轴只在**两人都明确且方向相反**时才算差异；一方两栖时，这条轴视为「能接住对方」（新增一条正向关系文案，或者不计入）。
- 排位：先显示档位（明显偏向 / 略偏 / 两栖 / 看情境），满 200 人后再显示真实百分位；不显示编造的数字（§8 决定 4）。
- 结果页增加「这四条轴从哪来」一节（§6）。

**影响**
- 准确性：**显著提升**。双高与双低分开了，用户反馈的情形有了正面表达；每个倾向只问一件事，可以逐个检验信度；试测数据可以直接回答「两极是否真的对立」（若某轴两极相关 ≤ −.40，说明这一轴确实是双极，可以考虑回退）。
- 可分享性：不降反升（推断）。16 个名字、副标题和形象都保留，「两栖」是新的可晒点，海报上的信息量也略有增加。
- 迁移成本：**中**，明细见 §5。主要是计分与契约、海报布局、搭子规则和 App 画像，**32 张模板不动**。

### 方案 C：重构维度

**做什么（举例）**：保留深耕 / 跨界、实证 / 直觉、规划 / 应变三条轴，改成单极测量；把造物 / 传播换成一个**多选画像**：作品、影响、关系、资本，取前两项。类型数变成 8 型 × 若干标签，或者直接仿照 RIASEC 改成「三字母画像」，不再有固定类型。

**影响**
- 准确性：可能最高（最贴近兴趣研究的结构），但新维度同样需要验证。
- 可分享性：**有风险**。16 个名字、副标题、组配色和形象构成的「一家人」识别感，是负责人花了几轮才定下的（2026-10-14 改名，2026-10-15 定稿副标题和模板）。换掉它们，等于重做一遍传播资产。
- 迁移成本：**高**。新的类型表和命名、32 张模板重画（`scripts/assess-templates.ts` 的 Codex 出稿和逐张挑选流程）、`TYPE_LINES` 和 `RELATIONS` 全部重写、字体子集、App 写手 schema、链接契约、全部测试。旧结果与新结果无法比较，双人卡跨版本也无法计算。

### 三个方案对比

| | A 改题 + 呈现 | **B 单极测量** | C 重构维度 |
|---|---|---|---|
| 解决「双高 = 双低 = 50」 | 否 | **是** | 是 |
| 解决用户「造物也传播」 | 部分（显示两可） | **是（两栖）** | 是 |
| 16 名 / 副标题 / 模板 | 保留 | **保留** | 重做 |
| 题数 | 32 | **32** | 视设计 |
| App 画像 | 不动 | 可分期（§5.3） | 必改 |
| 旧结果 | 照常 | 旧版照常显示，不能重算 | 不可比 |
| 工作量（推断） | 1–2 天 | 4–6 天 + 试测 | 2 周以上 |

---

## 5. 推荐方案 B 的迁移清单

### 5.1 core（纯函数）

- `packages/core/src/assess.ts`：`QuizItem` 改为 `{ id, pole, text }`；`LIKERT` 改为频率选项；新增 `quizPoles`（8 个 0–100 分）和 `readAxes`（见 §7 片段）。`quizScores` 保留，用于折算出旧格式的四轴分数（50 + 偏向/2），供链接契约和旧调用方使用。
- `packages/core/src/portrait-type.ts`：`typeFromScores` 增加可选的 `readings` 参数，`PortraitType.axes[]` 增加 `state: "left" | "right" | "both" | "neither"`；不传 `readings` 时行为与现在完全相同，App 画像暂时走这一路径。
- `packages/core/src/assess-content.ts`：`relationOf` 接受两人的 `AxisReading[]`，只把「双方都明确且方向相反」计为差异；`isAmbiguous` 由 `state` 替代；`axisRank` 改为档位，`shownRank` 视 §8 决定 4 删除或保留。
- 测试：`assess.test.ts`、`assess-content.test.ts`、`portrait-type.test.ts` 需要更新；增加「全部答中点不会判出固定类型」「双高与双低读法不同」两条测试。

### 5.2 apps/assess

- `server/db.ts`：新增迁移，`results` 表加 `scheme INTEGER NOT NULL DEFAULT 1` 和 `poles_json TEXT`。新结果写 `scheme = 2`；旧结果保持 1，按现在的方式渲染，并标「旧版结果」。
- `lib/contract.ts`：`PublicAxis` 增加 `state`、`leftScore`、`rightScore`；`SubmitRequest.answers` 仍是 32 个 1–5（键名换成新题 id），`security.ts` 的校验随之更新。
- `lib/public-type.ts`、`components/type-summary.tsx`：每轴画两根条（左极分、右极分），偏向用标记表示；两栖 / 看情境用文字说明，并给出「也是 XX」。
- `server/poster/render.ts`：monogram 的两栖轴改为双字母叠放；`axisRow` 改为双条；「最突出一条轴的排位」改为档位。`labels.ts` 加新文案后，必须重跑 `scripts/assess-poster-fonts.ts`（测试会提醒）。
- 双人卡：`pairRelation` 传入两人的 readings。如果一方是 scheme 1 的结果，就按 `isAmbiguous` 把 ±10 内的轴当作「两栖」，作为回退。
- **旧结果**：无法重算，因为不存答案。保留 90 天自然过期；结果页提供「用新版再测一次」。这一次重测是否计入 `TESTS_PER_EMAIL`（3 次）需要决定（§8 决定 5）。
- 32 张模板：**不动**（类型代码不变）。

### 5.3 App 画像与链接契约（可以分期）

- 第一期（只改公开测评）：链接契约**保持四个整数不变**，按 50 + 偏向/2 折算。`parseAssessLinkResponse` 拒收多余字段，所以不能单方面加字段。App 不受影响。
- 第二期（App 跟进）：先发布能接受可选字段 `poles` 的解析器，**再**让测评开始返回这个字段（顺序反过来，App 会把每个结果都读成 `null`）。写手 Skill 的 `type` 改为 8 个倾向分，加上 evidence；删掉「avoid 50」；`PORTRAIT_SCHEMA_VERSION` 升到 4。这会让 `portraitPass` 给**每个账号重写一次报告**（顶档模型，单次约 80 秒，见 `plans/2026-10-12-p-c-portrait.md`）。改动还涉及 `portrait-view.tsx` 的分享卡、`poster-geometry.ts` 的字形收集、`assess-card.tsx` 和 `onboarding-session.ts` 里把测评结果作为访谈上下文的那段。
- 影响面汇总：`packages/core/src/{assess,assess-content,assess-link,portrait-type,portrait}.ts`；`apps/assess/{lib,components,server/poster,server/db.ts,server/security.ts,scripts/beta-requests.ts}`；`apps/web/app/{portrait,onboarding,asks}`；`skills/.../crossline-portrait-writer`；`docs/beta-launch.md` §1–§2；CLAUDE.md 中 `apps/assess` 一段。

---

## 6. 结果页如何回答「这四条轴从哪来」，以及中间分怎么呈现

### 6.1 「这四条轴从哪来」（结果页可折叠的一节，草稿）

> **这四条轴是怎么来的？**
> 它们是 Crossline 为「同时推进几条人生主线的人」设计的，关心的是你**怎么做事**，不是你是什么性格。每条轴都对应一块已有研究：
> - **深耕 / 跨界**：注意力集中在一处，还是在几处之间连接。
> - **实证 / 直觉**：对应心理学里「理性思维」和「经验思维」两种风格；研究发现两者相互独立，很多人两样都强（Pacini & Epstein, 1999）。
> - **造物 / 传播**：对应职业兴趣里「和事物打交道」与「和人打交道」；大样本研究发现它们并不对立，很多人两样都喜欢（Tay, Su & Rounds, 2011）。
> - **规划 / 应变**：对应创业研究里「先计划」和「边做边调」；两种做法合用的团队表现更好（Smolka 等, 2018）。
>
> 所以我们**分别**测这八种倾向。两端都强的轴标为「两栖」，两端都不突出的标为「看情境」。只有明确偏向一端时，才说你是哪一端。
> 这套轴是设计出来的，不是从数据中发现的；我们正在用匿名答题数据检验它们是否站得住。基于自评的趣味测评，非心理诊断。

（若 §8 决定 6 不同意收集匿名答题数据，删去最后一句的后半句。）

### 6.2 中间分

| 状态 | 判定（初值，试测后校准） | 页面写法 | 海报 |
|---|---|---|---|
| 明确偏向 | \|偏向\| ≥ 20 | 「明显偏造物」（≥ 40）/「略偏造物」（20–39） | 单字母，实色 |
| 两栖 | \|偏向\| < 20，且两极均值 ≥ 本人 8 项均值、≥ 55 | 「造物 × 传播 两栖：你既在乎把作品做好，也在乎它被更多人看到。这条轴上，类型名只是两者之一，你同样接近 XX。」 | 双字母叠放 + 「两栖」徽章 |
| 看情境 | \|偏向\| < 20，且不满足两栖 | 「这两种倾向你都不特别依赖，取决于手头的事。」 | 双字母叠放、浅色 |

- 每轴始终画**两根**条（左极分、右极分），不再显示「传播 51%」这种折半百分比。
- 阈值 20 是初值：4 道题时单极分的步长是 6.25，20 约等于三步。试测之后应改用差分的测量标准误（SEM）来定，见 §7 注释。

### 6.3 给这位用户的回复话术（草稿）

> 谢谢你这么认真地反馈！你说的「造物」那条轴，其实指出了我们设计里的一个真问题。
>
> 这四条轴是我们为「同时推进几条线的人」设计的：深耕 / 跨界、实证 / 直觉、造物 / 传播、规划 / 应变。它们不是从数据里算出来的，结果页之前也没有讲清楚，这是我们的疏漏。
>
> 你的分数居中，不是测歪了，而是如实反映了你**两样都要**：你既同意「做出作品」那几题，也同意「影响很多人」那几题，在现在的算法里它们正好抵消成中间值。问题在于我们把「做」和「传」放在了一条线的两端，好像只能选一个。可研究早就发现这两种倾向并不对立，很多人两样都强。像你这样想创作、也想让作品被看到的人，正是这种情况。
>
> 我们准备把每种倾向分开测。以后你这种情况会显示成「造物 × 传播 两栖」，而不是一个被强行判到某一边的字母。改版上线后欢迎再来测一次，也想听听你觉得新版准不准。

（若 §8 决定 3 不同意改版，第三段改为「我们正在评估怎么改」，不承诺上线。）

---

## 7. 推荐方案的题目草稿与计分

### 7.1 作答选项

「几乎从不 / 偶尔 / 有时 / 经常 / 几乎总是」（1–5）。只有一道「心动」类的题读起来更像态度而不是频率（I3），试测时观察它的作答分布。

### 7.2 32 题（每极 4 题，全部正向，一题一事）

原则：只描述行为或感受，不问能力和准确度；不用比较句，不用否定，不用褒贬词；学生和上班族都能作答；按极交错排列，相邻两题不同轴。

| id | 极 | 题目 |
|---|---|---|
| s1 | 深耕 S | 我会在同一个主题上连续投入好几个月。 |
| s2 | 深耕 S | 遇到感兴趣的问题，我会一直追到把这个方向的主要资料读完。 |
| s3 | 深耕 S | 我会花大量时间，把一项已经会的技能练得更精。 |
| s4 | 深耕 S | 聊到我常做的那件事，我会讲到很细的细节。 |
| g1 | 跨界 G | 我会同时关注几个彼此不相关的领域。 |
| g2 | 跨界 G | 我会把一个领域里的方法拿到另一个领域里试。 |
| g3 | 跨界 G | 我手上的事横跨好几个圈子，比如学业、兴趣和副业。 |
| g4 | 跨界 G | 我会主动去了解和自己专业无关的领域。 |
| e1 | 实证 E | 做重要决定前，我会先去查数据或资料。 |
| e2 | 实证 E | 听到一个新说法，我会去找它的出处。 |
| e3 | 实证 E | 做完一件事，我会找具体的指标来检查效果。 |
| e4 | 实证 E | 面对几个选项，我会把各自的利弊写下来比较。 |
| i1 | 直觉 I | 做决定时，我会认真对待自己的第一感觉。 |
| i2 | 直觉 I | 在想清楚理由之前，我就已经知道自己倾向哪个选项。 |
| i3 | 直觉 I | 一个让我心动的设想，就足以让我开始一件事。 |
| i4 | 直觉 I | 判断一件事时，我会参考一种说不清来由的感觉。 |
| m1 | 造物 M | 我会花很长时间打磨自己做的东西，比如作品、代码、文章或方案。 |
| m2 | 造物 M | 把一个东西从无到有做出来，让我很有满足感。 |
| m3 | 造物 M | 有空的时候，我会动手做点什么。 |
| m4 | 造物 M | 为了把东西做得更好，我会去学新的工具或手艺。 |
| r1 | 传播 R | 做出东西后，我会想办法让更多人看到或用上它。 |
| r2 | 传播 R | 讲一件事之前，我会想怎么讲别人才听得懂、记得住。 |
| r3 | 传播 R | 看到别人因为我分享的东西而有所改变，让我很有满足感。 |
| r4 | 传播 R | 我会花时间维护一个让别人能找到我的地方，比如社群、账号、课堂或讲台。 |
| p1 | 规划 P | 开始一件事前，我会先排好步骤和时间。 |
| p2 | 规划 P | 我会把大目标拆成有日期的小目标。 |
| p3 | 规划 P | 我会提前留出余量，以防计划出意外。 |
| p4 | 规划 P | 我会对照计划检查自己的进度。 |
| a1 | 应变 A | 情况变了，我能很快换一种做法。 |
| a2 | 应变 A | 冒出一个好机会时，我会调整手头的安排去抓住它。 |
| a3 | 应变 A | 做着做着发现更好的方向，我会跟着调整。 |
| a4 | 应变 A | 我会根据当天的状态，决定先做哪件事。 |

建议的展示顺序（交错排列，相邻两题不同轴）：s1 e1 m1 p1 g1 i1 r1 a1 s2 e2 m2 p2 g2 i2 r2 a2 s3 e3 m3 p3 g3 i3 r3 a3 s4 e4 m4 p4 g4 i4 r4 a4。

【推断】与旧题相比：传播极去掉了外向性（陌生人搭话、说服），改成「让作品被看到 / 被理解 / 产生影响」；造物极去掉了「独自」和「讨厌开会」；规划极去掉了情绪反应和拖延污名；应变极去掉了以「有清单」为前提的题。社会赞许性仍然存在（八个极都是正面描述），但**偏向**取的是同轴两极之差，两极赞许程度相近时可以相互抵消；**水平**与本人的均值比较，可以吸收默许倾向。以上都需要试测验证。

### 7.3 计分（TypeScript 片段，示意，未接入代码）

```ts
import { TYPE_AXES, type TypeAxisId } from "./portrait-type";

export type Pole = "S" | "G" | "E" | "I" | "M" | "R" | "P" | "A";
export type QuizItemV2 = { id: string; pole: Pole; text: string };
export type AxisState = "left" | "right" | "both" | "neither";
export type AxisReading = {
  id: TypeAxisId;
  left: number;   // 0–100, the left pole's own score
  right: number;  // 0–100, the right pole's own score
  lean: number;   // right − left, −100…100
  state: AxisState;
  letter: string; // the letter used for the type name
};

/** Initial values; recalibrate from the pilot (see note below). */
export const LEAN_CLEAR = 20;
export const BOTH_FLOOR = 55;

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
// FNV-1a, used only to break an exact tie on an axis where both letters are equally true.
const fnv1a = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0; return h; };

/** Each pole 0–100 from its four 1–5 answers. Throws QUIZ_INCOMPLETE like quizScores. */
export function quizPoles(items: QuizItemV2[], answers: Record<string, number>): Record<Pole, number> {
  const missing = items.filter((item) => ![1, 2, 3, 4, 5].includes(answers[item.id] ?? 0));
  if (missing.length) throw new Error(`QUIZ_INCOMPLETE: ${missing.map((item) => item.id).join(",")}`);
  const poles = {} as Record<Pole, number>;
  for (const pole of ["S", "G", "E", "I", "M", "R", "P", "A"] as Pole[]) {
    const values = items.filter((item) => item.pole === pole).map((item) => answers[item.id]!);
    poles[pole] = Math.round(((mean(values) - 1) / 4) * 100);
  }
  return poles;
}

/**
 * Lean decides the side only when it is clear; otherwise the axis is "both" when its level is at or above the person's own
 * average over all eight poles (which absorbs a habit of agreeing with everything) and above an absolute floor, else "neither".
 * The letter for the type name follows the lean's sign; an exact tie is broken by the result id, never towards a fixed pole.
 */
export function readAxes(poles: Record<Pole, number>, seed: string): AxisReading[] {
  const personal = mean(Object.values(poles));
  return TYPE_AXES.map((axis) => {
    const left = poles[axis.left.letter as Pole], right = poles[axis.right.letter as Pole];
    const lean = right - left;
    const level = (left + right) / 2;
    const state: AxisState = Math.abs(lean) >= LEAN_CLEAR ? (lean > 0 ? "right" : "left")
      : level >= Math.max(personal, BOTH_FLOOR) ? "both" : "neither";
    const rightSide = lean > 0 || (lean === 0 && fnv1a(`${seed}:${axis.id}`) % 2 === 1);
    return { id: axis.id, left, right, lean, state, letter: rightSide ? axis.right.letter : axis.left.letter };
  });
}

/** The legacy 0–100 axis score (0 = left pole) for the link contract and older callers: 50 + lean / 2. */
export const legacyScore = (reading: AxisReading) => Math.round(50 + reading.lean / 2);

/** Two people differ on an axis only when both are clear and on opposite sides. */
export const differsOn = (a: AxisReading, b: AxisReading) =>
  (a.state === "left" && b.state === "right") || (a.state === "right" && b.state === "left");
```

注：试测后应按差分信度重定 `LEAN_CLEAR`。设两极信度分别为 r_L、r_R，两极相关为 r_LR，方差相等，则差分的信度约为 r_D = ((r_L + r_R)/2 − r_LR) / (1 − r_LR)，SEM_D = SD_D·√(1 − r_D)。建议 `LEAN_CLEAR ≈ 1.0–1.3 × SEM_D`。

### 7.4 上线前的试测（建议）

- 样本 ≥ 300（可以从现有测评流量里征集，单独同意）。
- 检查项：每个极的 α 或 ω（目标 ≥ 0.7）；8 因子与 4 双极因子的模型比较（仿照 Tay 等 2011 的做法）；同轴两极的相关（≤ −.40 才支持双极）；两周后重测，算 8 个极分的相关以及类型与状态的一致率；与性别的相关（造物 / 传播）；查看「两栖」和「看情境」所占比例，比例过高说明阈值需要调整。
- 前提是存下**逐题答案**（匿名、与邮箱分开存放、限期删除），这会改变现有「Answers are never stored」的承诺，见 §8 决定 6。

---

## 8. 需要负责人拍板的决定

1. **选哪个方案**：A（改题和呈现，1–2 天）/ **B（推荐，单极测量）** / C（重构维度）。
2. **两栖轴的类型名**：B 方案里，偏向恰好为 0 时按结果 id 稳定地挑一个字母，同时显示「也是 XX」。另一种做法是两栖轴一律显示两个类型名并列。前者对海报、形象和双人卡的改动最小。
3. **是否对这位用户承诺改版**：话术里的「改版上线后欢迎再测」需要以决定 1 为前提。
4. **排位的哈希数字**：`shownRank` 在超过 95 时显示由哈希挑出的 91–96，这是 2026-10-15 的决定。建议改为「前 5%」这样的档位文字，或者在满 200 人前只显示档位。这一条和 B 方案相互独立，A 方案也可以单独采纳。
5. **旧结果**：scheme 1 的结果自然过期（90 天）还是主动提示重测；新版重测是否计入 `TESTS_PER_EMAIL`（每个邮箱 3 次）。
6. **是否存逐题答案用于验证**：匿名、单独征得同意、限期删除。不存就无法做 §7.4 的任何检验，新版也只能和旧版一样「设计出来、未验证」。
7. **App 画像跟进的时机**：第二期会让每个账号的画像报告重写一次（顶档模型），并改变写手 Skill 的 schema。可以等公开测评的试测数据出来后再决定。
8. **造物 / 传播与性别**：如果试测发现这一轴的性别差异很大，是否要调整题目（Su 等 2009 指出出题策略可以显著减小性别差异）。

---

## 附录 A：模拟脚本（复现 §2.1 和 §3.4 的估算）

```js
// Monte Carlo under the code's own assumption: true axis score ~ N(50, 15), observed = true + error at reliability `rel`.
function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
for (const rel of [0.6, 0.7, 0.8, 0.85]) {
  const sdT = 15, sdE = sdT * Math.sqrt((1 - rel) / rel);
  let flip = 0, same = 0, near = 0, nearFlip = 0; const N = 200000;
  for (let i = 0; i < N; i++) {
    let all = true;
    for (let a = 0; a < 4; a++) {
      const t = 50 + sdT * randn(), o1 = t + sdE * randn(), o2 = t + sdE * randn();
      const f = (o1 >= 50) !== (o2 >= 50);
      if (a === 0) { if (f) flip++; if (Math.abs(o1 - 50) <= 10) { near++; if (f) nearFlip++; } }
      if (f) all = false;
    }
    if (all) same++;
  }
  console.log({ rel, axisFlip: flip / N, sameType: same / N, nearShare: near / N, flipGivenNear: nearFlip / near });
}
```

一次运行的结果（2026-10-17）：

| α | 单轴翻转 | 四字母全同 | 首测落在 ±10 内的比例 | 其中翻转 |
|---|---|---|---|---|
| 0.6 | 29% | 25% | 39% | 43% |
| 0.7 | 26% | 31% | 42% | 40% |
| 0.8 | 21% | 40% | 45% | 35% |
| 0.85 | 17% | 46% | 46% | 32% |

单轴「恰好 50」的估算：8 道题、每题答案独立，keyed 值按 1–5 的概率 [.08, .20, .30, .30, .12] 抽取，约 11%。

---

## 来源

- Haslam, McGrath, Viechtbauer & Kuppens (2020). Dimensions over categories. *Psychological Medicine* 50(9). https://www.cambridge.org/core/journals/psychological-medicine/article/abs/dimensions-over-categories-a-metaanalysis-of-taxometric-research/DE0D446F576907FA8FAC34FEFA44A497
- Bess & Harvey (2002). Bimodal score distributions and the MBTI. *JPA* 78(1). https://doi.org/10.1207/S15327752JPA7801_11
- Lord (1958). Multimodal score distributions on the MBTI. ETS. https://www.ets.org/research/policy_research_reports/publications/report/1958/ibrb.html
- MacCallum, Zhang, Preacher & Rucker (2002). On the practice of dichotomization. *Psychological Methods* 7(1). https://psychology.psy.sunysb.edu/attachment/measures/content/maccallum_on_dichotomizing.pdf
- Clearer Thinking. How accurate are popular personality tests at predicting life outcomes. https://www.clearerthinking.org/post/how-accurate-are-popular-personality-tests-at-predicting-life-outcomes ；Ultimate Personality Test 2.0. https://www.clearerthinking.org/post/announcing-the-ultimate-personality-test-2-0
- Pittenger (2005). Cautionary comments regarding the MBTI. *Consulting Psychology Journal* 57(3). https://doi.org/10.1037/1065-9293.57.3.210 ；反驳：https://www.psychologytoday.com/za/blog/my-brothers-keeper/202002/in-defense-the-myers-briggs ；出版方：https://myersbriggs.org/research-and-library/validity-reliability/
- McCrae & Costa (1989). Reinterpreting the MBTI from the perspective of the five-factor model. *J. Personality*. https://scholars.duke.edu/publication/1458465
- Tay, Su & Rounds (2011). People–things and data–ideas: Bipolar dimensions? *J. Counseling Psychology* 58(3). https://iro.uiowa.edu/esploro/outputs/journalArticle/People-Things-and-Data-Ideas-Bipolar-Dimensions/9984380557002771
- Su, Rounds & Armstrong (2009). Men and things, women and people. *Psychological Bulletin* 135(6). https://iro.uiowa.edu/esploro/outputs/journalArticle/Men-and-things-women-and-people/9984380502202771
- Prediger, World-of-Work Map (ERIC). https://files.eric.ed.gov/fulltext/ED267308.pdf
- Pacini & Epstein (1999), *JPSP* 76；后续重复：https://journals.sagepub.com/doi/full/10.1177/2158244020986533 ，https://econtent.hogrefe.com/doi/10.1027/1015-5759.25.1.39
- Smolka, Verheul, Burmeister-Lamp & Heugens (2018). Get it together! *ETP* 42(4). https://ideas.repec.org/a/sae/entthe/v42y2018i4p571-604.html
- IPIP. https://www.ipip.ori.org/ ；DeYoung et al. (2007) BFAS. https://ipip.ori.org/BFASTable.htm
- 迫选与 ipsativity 元分析. https://bearworks.missouristate.edu/articles00/36 ；Brown & Maydeu-Olivares (2011). https://journals.sagepub.com/doi/10.1177/0013164410375112
- Gallup CliftonStrengths 结构. https://support.gallup.com/hc/en-us/articles/4415092592275-How-is-the-CliftonStrengths-assessment-structured
- Krosnick & Presser, Question and questionnaire design. https://web.stanford.edu/dept/communication/faculty/krosnick/docs/2010/2010%20Handbook%20of%20Survey%20Research.pdf
- Weijters & Baumgartner (2012). Misresponse to reversed and negated items. *JMR* 49(5). https://pure.psu.edu/en/publications/misresponse-to-reversed-and-negated-items-in-surveys-a-review/ ；Baumgartner, Weijters & Pieters (2018). https://research.tilburguniversity.edu/en/publications/misresponse-to-survey-questions-a-conceptual-framework-and-empiri/
- Wong, Rindfleisch & Burroughs (2003). Do reverse-worded items confound measures in cross-cultural consumer research? *JCR* 30(1). https://ideas.repec.org/a/oup/jconrs/v30y2003i1p72-91.html ；日文版 MVS. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9375416/
- Chen, Lee & Stevenson (1995). Response style and cross-cultural comparisons of rating scales. *Psychological Science*. https://www.psychologicalscience.org/journals/psychological-science/j.1467-9280.1995.tb00327.x/
- Forer (1949)（转述）. https://skepdic.com/forer.html ；Dickson & Kelly (1985). https://cortecs.org/wp-content/uploads/2014/12/the-barnum-effect-in-personality-assessment-a-review-of-the-literature.pdf
- Swann 自我验证. https://labs.la.utexas.edu/swann/files/2016/03/sw_pel_krull.pdf ；https://journals.sagepub.com/doi/10.1177/09567976211049439
- 16Personalities：strength of individual traits（页面拒绝自动抓取，内容据搜索摘要）. https://16personalities.com/articles/strength-of-individual-traits
- Berger & Milkman (2012). What makes online content viral? *JMR*. https://faculty.wharton.upenn.edu/wp-content/uploads/2011/11/Virality.pdf
- Tamir & Mitchell (2012). Disclosing information about the self is intrinsically rewarding. *PNAS*. https://pmc.ncbi.nlm.nih.gov/articles/PMC3361411/

【说明】以上多数文献是通过摘要、出版方页面或二手转述核对的，没有逐篇读全文。Pittenger 2005 的 DOI 和「39–76%」的数字来自二手来源，引用时以原文为准。

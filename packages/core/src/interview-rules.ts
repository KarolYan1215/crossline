/**
 * The interview's rule register (docs/onboarding-agent-session.md §4.2, docs/onboarding-validation-audit.md).
 *
 * Every rule the interview enforces is listed here once, with the layer that owns it:
 * - L0 code: a check the app runs. It names the source file and symbol, and a test file that exercises that symbol.
 * - L1 style block, L2 interview Skill, L3 tool descriptions, L4 sub-run Skills: text the model reads. It names the file and an
 *   anchor, a phrase that must appear in that file exactly once, so a rewrite that drops the rule fails the test.
 * A rule that is no longer enforced stays here as `retired`, with the reason (and the rule that took over its job, if one did), so a
 * migration can move a rule between layers or retire it, but never lose one silently.
 *
 * `verdict` is the 2026-11-14 audit's decision for the rule: keep it in code; keep it in code but hand a failure back to the model in
 * the same turn instead of rewriting silently ("return"); leave the judgement to the model ("model"); or delete it. "record" (2026-11-25,
 * 「访谈账本驱动」): the model avoids it from its prompt and the ledger snapshot, and the code that used to send it back only writes a
 * `rule-fired` line when it fires, so a replay can count whether moving it brought the fault back.
 *
 * Coverage is per symbol, not per test case: the covering test file must name the symbol or the test that exercises it.
 */
export type RuleLayer = "L0" | "L1" | "L2" | "L3" | "L4";
// rule: interview.record — the "record" verdict's firings go to `ruleFired("interview.record", { rule })`.
export type RuleVerdict = "keep" | "return" | "model" | "record" | "delete";

export type InterviewRule = {
  id: string;
  layer: RuleLayer;
  /** The rule in one sentence. */
  rule: string;
  verdict: RuleVerdict;
  status: "active" | "retired";
  /**
   * L0: where the check lives and which test file exercises it. `by` is a phrase of that test file that shows it (a test's name), for a
   * symbol the tests reach without naming it; it defaults to the symbol. A check with no test says so in `untested`.
   */
  code?: { file: string; symbol: string; test?: string; by?: string; untested?: string };
  /** L1–L4: the text file and a phrase that states the rule, found there exactly once. */
  text?: { file: string; anchor: string };
  /** Retired: why, and the id that does its job now, if any. */
  reason?: string;
  replacedBy?: string;
};

const CORE = "packages/core/src";
const WORKER = "apps/worker/src";
const SKILLS = "skills/marketplace/plugins/crossline/skills";
const INTERVIEW_SKILL = `${SKILLS}/crossline-onboarding/SKILL.md`;
const EXTRACT_SKILL = `${SKILLS}/crossline-onboarding-extract/SKILL.md`;

// The register is read by its test and by people, never shown on a screen.
/* i18n-ignore-start */
export const INTERVIEW_RULES: readonly InterviewRule[] = [
  // 3.1 Evidence and facts: stay in code.
  { id: "IR-001", layer: "L0", verdict: "keep", status: "active", rule: "引文由句子编号从原文拷出，模型只给指针",
    code: { file: `${CORE}/onboarding-refs.ts`, symbol: "citedSpan", test: `${CORE}/onboarding-refs.test.ts` } },
  { id: "IR-002", layer: "L0", verdict: "keep", status: "active", rule: "卡片点选行（【题】点选：n/5）不作事实证据",
    code: { file: `${CORE}/onboarding-refs.ts`, symbol: "TAP_LINE", test: `${CORE}/onboarding-refs.test.ts`, by: "点选：4/5" } },
  { id: "IR-003", layer: "L0", verdict: "return", status: "active", rule: "观察卡的引文逐字出自本人回复，且至少来自两条回复（待核实卡一条）",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "checkInsight", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-004", layer: "L0", verdict: "keep", status: "active", rule: "粗略日期说法按今天换算成窗口",
    code: { file: `${CORE}/rough-dates.ts`, symbol: "roughWindow", test: `${CORE}/rough-dates.test.ts` } },
  { id: "IR-005", layer: "L0", verdict: "keep", status: "active", rule: "记下的日期必须落在原话说的窗口里",
    code: { file: `${CORE}/date-schema.ts`, symbol: "quoteSupportsDate", test: `${CORE}/date-schema.test.ts` } },
  // 2026-11-25: no longer sent back or cut from the reply. The snapshot lists the days the person gave and the Skill says a reply writes no
  // other; what keeps a made-up day off the ledger and the calendar is the write step (IR-005, the extraction cites only reply-N / src-N).
  { id: "IR-006", layer: "L0", verdict: "record", status: "active", rule: "回复里出现本人和账本都没给过的日期：记 rule-fired，不退回、不删句；记进账本和日历的日期由 IR-005 把住",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "inventedDates", test: `${CORE}/onboarding-reply.test.ts` } },
  { id: "IR-007", layer: "L0", verdict: "keep", status: "active", rule: "调研结论要有来源（最后一轮可以写查不到）",
    code: { file: `${CORE}/onboarding-research.ts`, symbol: "validateResearchTurn", test: `${CORE}/profile-hypotheses.test.ts` } },
  { id: "IR-008", layer: "L0", verdict: "keep", status: "active", rule: "画像结论的引文要能解析回本人回复",
    code: { file: `${CORE}/profile-claims.ts`, symbol: "resolveWrittenClaims", test: `${CORE}/profile-claims.test.ts` } },
  { id: "IR-009", layer: "L0", verdict: "keep", status: "active", rule: "要点合并：弱的不覆盖强的，丢弃的条数要报出",
    code: { file: `${CORE}/profile-points.ts`, symbol: "applyPointChanges", test: `${CORE}/profile-points.test.ts` } },

  // 3.2 Safety.
  { id: "IR-010", layer: "L0", verdict: "keep", status: "active", rule: "回应自伤披露的一轮只说热线、急诊和一个询问现状的问题",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "safetyReplyOnly", test: `${CORE}/onboarding-reply.test.ts` } },
  { id: "IR-011", layer: "L0", verdict: "keep", status: "active", rule: "披露前后的回复不作观察卡引文，披露那一轮不出观察卡",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureReplies", test: `${WORKER}/onboarding-session.test.ts`, by: "no observation card beside the safety check" } },
  { id: "IR-012", layer: "L0", verdict: "keep", status: "active", rule: "安全回合的识别：模型标了 safety，或回复里写了热线号码",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "safetyRound", test: `${WORKER}/onboarding-session.test.ts` } },
  { id: "IR-046", layer: "L0", verdict: "return", status: "active", rule: "本人回复里有自伤字眼而这一轮不是安全回合时，退回模型确认一次",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "mentionsSelfHarm", test: `${WORKER}/onboarding-session.test.ts` } },

  // Start standard and the person's own actions.
  { id: "IR-013", layer: "L0", verdict: "keep", status: "active", rule: "开始标准（至少一条主线、至少一个里程碑，D10）齐了才能开始（闸门、409）",
    code: { file: `${CORE}/interview-checklist.ts`, symbol: "readyToStart", test: `${CORE}/interview-checklist.test.ts` } },
  // Counted over rewordings. Since 2026-11-25 the Skill's goal, judged against the snapshot; the count is recorded when passed.
  { id: "IR-014", layer: "L0", verdict: "record", status: "active", rule: "同一件事最多问两次：Skill 的目标，按字面相似数到第三次时记 rule-fired",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "MAX_ASKINGS", test: `${WORKER}/onboarding-cards.test.ts`, by: "rewordings are counted" } },
  // Typed words are written here only when they say a day or a time; the rest is the extraction's to read (2026-11-14 audit).
  { id: "IR-015", layer: "L0", verdict: "keep", status: "active", rule: "本人在 app 自己的问题卡上的点选，直接写成确认的事实",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "answeredGapFacts", test: `${CORE}/profile-gaps.test.ts` } },

  // 3.3 Structure and limits.
  { id: "IR-016", layer: "L0", verdict: "return", status: "active", rule: "问题卡的结构：id 和选项不重复，选择题至少两个选项",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "checkTurn", test: `${CORE}/onboarding-turn-schema.test.ts`, by: "duplicate question or option ids are refused" } },
  { id: "IR-017", layer: "L0", verdict: "delete", status: "retired", rule: "画像阶段一轮超过三个问题时截掉多的",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "paceDeepRound" },
    reason: "截掉的题本人看不到、模型也不知道；画像阶段三题是 Skill 的规则，一轮的上限由退回执行", replacedBy: "IR-051" },
  { id: "IR-051", layer: "L0", verdict: "record", status: "active", rule: "一轮最多五个问题（openItems 也算）：Skill 的目标，超过时记 rule-fired",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "ROUND_QUESTIONS", test: `${WORKER}/onboarding-cards.test.ts` } },

  // 3.4 Meaning judgements: the model's.
  { id: "IR-018", layer: "L0", verdict: "model", status: "retired", rule: "题干像问日子的，改成不带选项的日期题",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "DATE_ASK" },
    reason: "从题干猜，9 个误报（「哪天状态最好」丢了选项）；题目自己用 date 标记", replacedBy: "IR-106" },
  { id: "IR-019", layer: "L0", verdict: "model", status: "retired", rule: "题干像问「哪些」或目标的，改成多选",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "MANY" },
    reason: "「最想先推进哪一个」被改成多选；题型由模型写", replacedBy: "IR-107" },
  { id: "IR-020", layer: "L0", verdict: "delete", status: "retired", rule: "删掉问目标、只问地点、日历可推、已知课表的问题",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "screenQuestions" },
    reason: "「你在哪里最容易进入专注状态？」被当成问地点删，「朋友会用哪些词形容你？」被当成目标题删；能推出的不问由 Skill 规定", replacedBy: "IR-105" },
  { id: "IR-021", layer: "L0", verdict: "return", status: "retired", rule: "和问过的题相似的问题被删掉或复用旧题",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "resolveRepeats" },
    reason: "按字面相似度删题，误删往深一层的追问（0.69）；改成退回模型并附本人的回答", replacedBy: "IR-047" },
  // 2026-11-25: whether two questions mean the same is the model's verdict against the snapshot (`repeats`, `followUp`); the wording
  // likeness only records. A question the model itself marked as an answered one, not deeper, still comes back with the answer.
  { id: "IR-047", layer: "L0", verdict: "record", status: "active", rule: "和答过的题字面相像：记 rule-fired，不退回；模型自己在 repeats 标了答过的题又不是 followUp 的，退回并附本人的回答",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkQuestions", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-022", layer: "L0", verdict: "delete", status: "retired", rule: "从回答的文字判断本人是不知道还是没定",
    code: { file: `${CORE}/question-ledger.ts`, symbol: "unsureAnswer" },
    reason: "2026-11-25 语义收敛（docs/plans/harness-1125.md §1）：按词表猜回答算不算数；改为看整理是否已读过这条回答，读过仍没记下的题再问", replacedBy: "IR-186" },
  { id: "IR-023", layer: "L0", verdict: "delete", status: "retired", rule: "模型自己问长期目标的题，答案直接写成这条线的目标",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "answeredGoalQuestions" },
    reason: "按题干猜「这是目标题」，把「最不想成为」的答案写成了目标；目标只从 app 自己的目标题和目标选择器写入", replacedBy: "IR-015" },
  { id: "IR-024", layer: "L0", verdict: "delete", status: "retired", rule: "网页端在发送前替本人采用对话里答出的目标",
    code: { file: "apps/web/app/onboarding/onboarding-workspace.tsx", symbol: "adoptGoalsFromRound" },
    reason: "同 IR-023 按题干猜目标题，还只存前三个词、丢掉本人写的那句", replacedBy: "IR-015" },
  { id: "IR-025", layer: "L0", verdict: "model", status: "retired", rule: "模型提的定语候选要像一个原子的品质（措辞规则）",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "attributeProblem" },
    reason: "2026-11-25 语义收敛：动作、数量、成就、名词式品质由整理 Skill 判断；代码只查形状（一句话长、重复主线名）", replacedBy: "IR-187" },
  { id: "IR-026", layer: "L0", verdict: "keep", status: "active", rule: "本人选的定语只有字面相同时才报重复（「自由」和「财务自由」是两个选择）",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "checkGoalParts", test: `${CORE}/line-attributes.test.ts` } },
  { id: "IR-027", layer: "L0", verdict: "keep", status: "active", rule: "定语去掉首尾标点、「成为」和末尾的「的」，属于词的符号（C++、C#）留着",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "cleanAttribute", test: `${CORE}/line-attributes.test.ts` } },
  { id: "IR-028", layer: "L0", verdict: "model", status: "retired", rule: "项目名像课程代码的，当课程问上课时间",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "COURSE_PART" },
    reason: "2026-11-25 语义收敛：按名字形状（课号、「项目/作业/考试」）判断是不是课；应用只对记了评分构成的项目出上课时间题，其余由访谈 Skill 判断要不要问（isCourse 只读记录，保留）", replacedBy: "IR-189" },
  { id: "IR-029", layer: "L0", verdict: "delete", status: "retired", rule: "再问最骄傲的事时，题前加「除了前面讲过的那件」",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutToldStory" },
    reason: "在模型的题前硬加半句，接不上上下文；规则只写在 Skill", replacedBy: "IR-108" },
  { id: "IR-030", layer: "L0", verdict: "delete", status: "retired", rule: "回复里复述观察卡的句子被删掉",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutCardEcho" },
    reason: "按字对重合删句，会删掉接住本人的话；规则只写在 Skill", replacedBy: "IR-109" },
  { id: "IR-031", layer: "L0", verdict: "delete", status: "retired", rule: "回复里说「还在记录」的句子被删掉",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutRecordingTalk" },
    reason: "状态里已列出本人答了、还没记下的项（startStandard.answered），模型不必再说；静默删句不再需要" },
  { id: "IR-032", layer: "L0", verdict: "delete", status: "retired", rule: "术语被替换成平实说法",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "withPlainTerms" },
    reason: "本人自己用的「硬约束」也被替换；规则只写在 Skill", replacedBy: "IR-110" },
  { id: "IR-033", layer: "L0", verdict: "delete", status: "retired", rule: "本人说没什么要补充时，这一轮不再出新题",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "saidNothingMore" },
    reason: "「没什么好说的，但我最近很焦虑」也算没话说了；是否结束由模型读本人的话判断" },
  { id: "IR-034", layer: "L0", verdict: "return", status: "retired", rule: "回复不照抄调研结论里的数字",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "researchCopied", test: `${CORE}/onboarding-reply.test.ts` },
    reason: "2026-11-22 原生改写：回复可以用调研线程的结论，本人要听到查到的东西（D16）；数字由调研线程的来源负责" },
  // Sent back while repairs last (`endHinted`); past them the sentence is left out (`withoutEndHint`): the button would refuse.
  { id: "IR-035", layer: "L0", verdict: "return", status: "retired", rule: "开始标准没齐时，回复不说可以开始，也不提结束按钮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "endHinted", test: `${WORKER}/onboarding-session.test.ts`, by: "withoutEndHint" },
    reason: "2026-11-22 原生改写：开始不开始由本人决定；回复说可以开始只记在 round_edited 的 noted 里，不退回、不删句", replacedBy: "IR-165" },
  { id: "IR-036", layer: "L0", verdict: "keep", status: "active", rule: "画像的类型简介不把类型名当成本人的标签（「你是军师」），普通用法放过",
    code: { file: `${CORE}/portrait-type.ts`, symbol: "typeSummaryProblem", test: `${CORE}/portrait.test.ts` } },
  { id: "IR-037", layer: "L0", verdict: "keep", status: "active", rule: "画像里不在本场的主线那一项被剪掉，不让整份画像失败",
    code: { file: `${CORE}/portrait.ts`, symbol: "onRecord", test: `${CORE}/portrait.test.ts`, by: "A line not on record is left out" } },

  // 3.5 Questions and waits the app made: delete.
  { id: "IR-038", layer: "L0", verdict: "delete", status: "retired", rule: "app 把开始标准缺的项作为自己的问题插进这一轮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withGapQuestions" },
    reason: "插进来的题不接上一句；app 的待问题改列在 openItems，模型决定什么时候问", replacedBy: "IR-048" },
  { id: "IR-048", layer: "L0", verdict: "return", status: "active", rule: "app 自己的待问题只在模型写进 openItems 时按 app 的写法发出；模型换说法问的退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkOpenItems", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-039", layer: "L0", verdict: "delete", status: "retired", rule: "一轮没有题时，app 补一道开放题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withSomethingToAnswer" },
    reason: "固定开放题像在填表，「哪条主线」连问九轮；还没问完的一轮没有题时退回模型", replacedBy: "IR-052" },
  { id: "IR-052", layer: "L0", verdict: "return", status: "retired", rule: "还没问完的一轮必须有题（模型自己的或 openItems 里的）",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "ONBOARDING_QUESTION_REQUIRED", test: `${CORE}/onboarding-turn-schema.test.ts` },
    reason: "2026-11-22 原生改写：一轮的主问题写在回复里，不再要求问题卡", replacedBy: "IR-170" },
  { id: "IR-040", layer: "L0", verdict: "delete", status: "retired", rule: "对话开始前最多等整理 60 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "START_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-041", layer: "L0", verdict: "delete", status: "retired", rule: "问题出来前最多等整理 30 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "BLOCKING_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-042", layer: "L0", verdict: "delete", status: "retired", rule: "空轮最多等清单 300 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "CHECKLIST_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-043", layer: "L0", verdict: "delete", status: "retired", rule: "本人更正过观察卡后，所有观察卡停一轮",
    code: { file: `${WORKER}/onboarding-extract.ts`, symbol: "cardsWait" },
    reason: "一次更正让所有卡停一轮，第十四次回放里停了十轮；更正改为放在卡旁边对照", replacedBy: "IR-111" },
  { id: "IR-044", layer: "L0", verdict: "delete", status: "retired", rule: "画像阶段先不出缺项题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "holdGaps" },
    reason: "缺项题不再由 app 插入，什么时候问由模型在 openItems 里定", replacedBy: "IR-048" },
  { id: "IR-049", layer: "L0", verdict: "return", status: "active", rule: "观察卡不合格时连同原因退回模型（引文、披露、引用条数、假设日志、同一假设两次）",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkInsights", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-050", layer: "L0", verdict: "return", status: "active", rule: "调研已有线程或同时开着的太多时退回模型",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkResearch", test: `${WORKER}/onboarding-cards.test.ts` } },
  // P2b-3b: the same checks, run as each item is handed in through a tool; a failing call is the tool's error, in the same turn.
  { id: "IR-053", layer: "L0", verdict: "return", status: "active", rule: "出卡工具当场核对每一项，不合格作为工具的回答退回，不收下",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "cardTools", test: `${WORKER}/onboarding-cards.test.ts` } },
  // P3: a thread rebuilt from the ledger.
  { id: "IR-054", layer: "L0", verdict: "keep", status: "active", rule: "线程丢失重建时只按阅读预算发文件，其余不记为已展示，留给后面的轮次",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withinBudget", test: `${WORKER}/onboarding-session.test.ts`, by: "a rebuilt thread is sent the files within the reading budget" } },
  { id: "IR-055", layer: "L0", verdict: "keep", status: "active", rule: "重建的对话历史带上每轮的选项和观察卡（连同假设 id）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "conversationSoFar", test: `${WORKER}/onboarding-session.test.ts`, by: "【观察卡 h1】" } },
  { id: "IR-045", layer: "L0", verdict: "delete", status: "retired", rule: "事实合并（core 版）",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "mergeFacts" },
    reason: "没有生产调用者；「推断不覆盖已确认」由数据库的 upsert 规则保证" },

  // L2: rules the interview Skill states (the model's own judgement, per the audit).
  { id: "IR-100", layer: "L2", verdict: "model", status: "active", rule: "已经答过的不重问，答了一部分只问缺的",
    text: { file: INTERVIEW_SKILL, anchor: "**不要重复问本人已经说过的，也不把没问过的说成问过。**" } },
  { id: "IR-101", layer: "L2", verdict: "model", status: "active", rule: "本人说不确定、没定，就是答案，同一件事不再问日期",
    text: { file: INTERVIEW_SKILL, anchor: "**一件事一轮最多问一个日期，「还没定」就是答案。**" } },
  { id: "IR-102", layer: "L2", verdict: "model", status: "active", rule: "接着本人的话往深一层问",
    text: { file: INTERVIEW_SKILL, anchor: "**接着本人的话往下走一层。**" } },
  { id: "IR-103", layer: "L2", verdict: "model", status: "active", rule: "选项不编造本人或文件没给过的事实",
    text: { file: INTERVIEW_SKILL, anchor: "**选项不编造事实。**" } },
  { id: "IR-104", layer: "L2", verdict: "model", status: "active", rule: "本人拒绝的话题整场不再问",
    text: { file: INTERVIEW_SKILL, anchor: "**本人拒绝或说不需要的，永远不再问。**" } },
  { id: "IR-105", layer: "L2", verdict: "model", status: "active", rule: "不问琐碎钟点，能推出的不问",
    text: { file: INTERVIEW_SKILL, anchor: "**不问琐碎钟点。**" } },
  { id: "IR-106", layer: "L2", verdict: "model", status: "active", rule: "问日子用不带选项的 free，并标 date",
    text: { file: INTERVIEW_SKILL, anchor: "并把这道题的 `date` 设为 `true`" } },
  { id: "IR-107", layer: "L2", verdict: "model", status: "active", rule: "选项互斥用 single，可同时成立用 multi",
    text: { file: INTERVIEW_SKILL, anchor: "只问「最想先推进哪一个」时用 `single`" } },
  { id: "IR-108", layer: "L2", verdict: "model", status: "active", rule: "讲过的故事不换个问题再要一遍",
    text: { file: INTERVIEW_SKILL, anchor: "**讲过的故事不换个问题再要一遍。**" } },
  { id: "IR-109", layer: "L2", verdict: "model", status: "active", rule: "每次回应多出一层推断，不复述",
    text: { file: INTERVIEW_SKILL, anchor: "**每次回应都要多出一层推断，不复述。**" } },
  { id: "IR-110", layer: "L2", verdict: "model", status: "active", rule: "不用应用自己的术语",
    text: { file: INTERVIEW_SKILL, anchor: "也不用应用自己的术语：不说「硬约束」" } },
  { id: "IR-111", layer: "L2", verdict: "model", status: "active", rule: "本人刚更正过卡、假设日志还没重看时，出卡先对照更正，不再写被更正的前提",
    text: { file: INTERVIEW_SKILL, anchor: "**有 `cardsCheck` 时，出卡前先对照更正。**" } },
  { id: "IR-112", layer: "L2", verdict: "model", status: "active", rule: "app 自己的问题用 openItems 问，不换说法再问",
    text: { file: INTERVIEW_SKILL, anchor: "**应用自己的问题用 `openItems` 问，不要换说法再问**" } },
  { id: "IR-113", layer: "L2", verdict: "model", status: "active", rule: "往深一层的追问接住原回答并标 followUp",
    text: { file: INTERVIEW_SKILL, anchor: "就让题干接住那个回答，`followUp` 设 `true`" } },
  { id: "IR-114", layer: "L2", verdict: "model", status: "active", rule: "app 只退回问题清单，不替模型改字、不悄悄删",
    text: { file: INTERVIEW_SKILL, anchor: "**应用核对后把问题退回给你。**" } },
  // The progress header (2026-11-15, after replay 15): the app counts, the model decides.
  { id: "IR-115", layer: "L0", verdict: "keep", status: "active", rule: "每轮输入最前面放进度头：轮数、阶段、开始标准从第几轮齐、ready 还差什么、最近三轮的题数和卡",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "standingLines", test: `${WORKER}/onboarding-standing.test.ts` } },
  { id: "IR-116", layer: "L2", verdict: "model", status: "active", rule: "进度头只是事实，不替模型判断",
    text: { file: INTERVIEW_SKILL, anchor: "**进度头只是事实。**" } },
  { id: "IR-117", layer: "L2", verdict: "model", status: "retired", rule: "同一阶段多轮每轮只剩一题，就换阶段或说可以结束，不往下钻",
    text: { file: INTERVIEW_SKILL, anchor: "**同一阶段连着很多轮、每轮只剩一道题，这一阶段就问完了。**" },
    reason: "2026-11-22 原生改写：部分的顺序和节奏写进 Skill 的「访谈的顺序」，不再按阶段轮数判断", replacedBy: "IR-173" },
  { id: "IR-118", layer: "L2", verdict: "model", status: "retired", rule: "开始标准一齐，回复里说一次本人可以结束；ready 还差的问完再说一次",
    text: { file: INTERVIEW_SKILL, anchor: "**开始标准一齐，就说一次本人可以结束。**" },
    reason: "2026-11-15 本人定：结束提示只由页面依据账本说，模型不负责", replacedBy: "IR-142" },
  { id: "IR-119", layer: "L2", verdict: "model", status: "active", rule: "最近三轮的卡多被评部分对，这一轮先问再出卡",
    text: { file: INTERVIEW_SKILL, anchor: "**最近三轮的卡多被评「部分对」，这一轮先问再出卡。**" } },
  { id: "IR-120", layer: "L2", verdict: "model", status: "active", rule: "不把本人刚定的安排换说法写成卡",
    text: { file: INTERVIEW_SKILL, anchor: "**不把本人刚定的安排写成卡。**" } },
  // Disclosures (2026-11-15, after replay 15 retold one in a card): no model reads the words again, what points back at them is returned,
  // and what the hard time taught is talked about only after the person said yes to the app's own question.
  { id: "IR-121", layer: "L0", verdict: "keep", status: "active", rule: "披露所在的回复，在整理、画像、问题记录和重建的对话线程里都换成占位，模型读不到原文",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "withoutDisclosures", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-122", layer: "L0", verdict: "keep", status: "active", rule: "对话线程还留着披露原文时，答完它的下一轮重建线程",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "unredacted", test: `${WORKER}/onboarding-session.test.ts`, by: "a disclosure's words leave the dialogue's thread" } },
  { id: "IR-123", layer: "L0", verdict: "return", status: "active", rule: "回复、题目和卡用了自伤字眼，退回，修复用完后去掉那一句；用了披露独有的四字原话只记 rule-fired（2026-11-25，快照写明披露在哪和本人的同意）",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureEchoes", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-124", layer: "L0", verdict: "keep", status: "active", rule: "谈艰难时期学到什么，只由应用的固定题征得同意，整场一次，不答或「先不聊」就整场不提",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "lessonAnswer", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-125", layer: "L2", verdict: "model", status: "active", rule: "同意之后只谈先兆、帮到的人和事、怎么缓过来的，不问不复述经过",
    text: { file: INTERVIEW_SKILL, anchor: "**本人同意以后，只谈先兆、帮到的人和事、怎么缓过来的。**" } },
  // Days, cards and the scale (2026-11-15, after replay 15 asked one day six times, retold just-made plans on cards, said one tension in
  // the reply and the card, and quoted 「5/5」).
  { id: "IR-126", layer: "L0", verdict: "return", status: "active", rule: "日期题要写 about，没写退回；同一件事的日子问过再问只记 rule-fired（2026-11-25，问过的题和回答在快照里）",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "sameAbout", test: `${WORKER}/onboarding-cards.test.ts`, by: "a subject answered is not asked again" } },
  { id: "IR-127", layer: "L0", verdict: "return", status: "active", rule: "两个以上选项是日子的题退回，改成不带选项的 free",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "dayOption", test: `${WORKER}/onboarding-cards.test.ts`, by: "options that are days come back" } },
  { id: "IR-128", layer: "L0", verdict: "keep", status: "retired", rule: "本人说还没定的日子列在进度头里，沿用叫法",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "undecided", test: `${WORKER}/onboarding-standing.test.ts`, by: "days the person said are not set are listed" },
    reason: "2026-11-22 原生改写：「还没定」由问过的日期题本身的回答承担（sameAbout），进度头不再列", replacedBy: "IR-101" },
  { id: "IR-129", layer: "L2", verdict: "model", status: "active", rule: "日期题的 about 写这个日子属于哪件事，用本人的叫法",
    text: { file: INTERVIEW_SKILL, anchor: "**日期题的 `about` 写这个日子属于哪件事**" } },
  { id: "IR-130", layer: "L0", verdict: "return", status: "retired", rule: "卡的引文全在最近两条回答里，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "recentReplies", test: `${WORKER}/onboarding-cards.test.ts`, by: "a card joins what was said at different times" },
    reason: "2026-11-22 原生改写：退回只留给安全、日期、引文、链接和披露；卡引最近两条回答由 Skill 管", replacedBy: "IR-132" },
  { id: "IR-131", layer: "L0", verdict: "return", status: "retired", rule: "同一阶段出过三张卡，再出的卡不写 why 退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "STAGE_CARDS", test: `${WORKER}/onboarding-cards.test.ts`, by: "a stage's fourth card says what it adds" },
    reason: "2026-11-22 原生改写：同上；第四张卡写 why 的门槛删掉", replacedBy: "IR-132" },
  { id: "IR-132", layer: "L2", verdict: "model", status: "active", rule: "卡至少引一条更早的回答，第四张起说它多说了什么",
    text: { file: INTERVIEW_SKILL, anchor: "**卡至少引一条更早的回答。**" } },
  { id: "IR-133", layer: "L0", verdict: "return", status: "retired", rule: "回复和旁边的卡共有十五字以上的同一段话，退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "sharedRun", test: `${WORKER}/onboarding-session.test.ts`, by: "a reply saying what the card beside it says goes back once" },
    reason: "2026-11-22 原生改写：回复和卡说同一段话只是写得重，不退回", replacedBy: "IR-134" },
  { id: "IR-134", layer: "L2", verdict: "model", status: "active", rule: "回复说卡之外的东西，或直接问",
    text: { file: INTERVIEW_SKILL, anchor: "**回复不说卡上已经说的。**" } },
  { id: "IR-135", layer: "L0", verdict: "keep", status: "active", rule: "对话读量表只读读数，点选的分数换成占位",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withoutTaps", test: `${WORKER}/onboarding-session.test.ts`, by: "reads the scale as readings, never taps" } },
  { id: "IR-136", layer: "L0", verdict: "return", status: "retired", rule: "回复、下一步和卡报量表分数或档位，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "SCORE_TALK", test: `${WORKER}/onboarding-session.test.ts`, by: "a reply quoting scores goes back" },
    reason: "2026-11-22 原生改写：报量表分数改为记在 noted 里，不退回", replacedBy: "IR-165" },
  { id: "IR-137", layer: "L2", verdict: "model", status: "active", rule: "说量表只说倾向在日子里怎么表现",
    text: { file: INTERVIEW_SKILL, anchor: "**说量表只说这个倾向在本人的日子里怎么表现，不写「n/5」「自评」「最重那一档」**" } },
  { id: "IR-138", layer: "L2", verdict: "model", status: "active", rule: "整理不把本人定下的安排写成假设",
    text: { file: EXTRACT_SKILL, anchor: "**安排不是假设。**" } },
  // Pacing (2026-11-15, the owner: no stage budget; the dialogue proposes a next step every round and is told whether it was taken).
  { id: "IR-139", layer: "L0", verdict: "return", status: "retired", rule: "问话的一轮 next 为空，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "next 是空的", test: `${WORKER}/onboarding-session.test.ts`, by: "a round that asks proposes its next step" },
    reason: "2026-11-22 原生改写：next 字段和「好，往下」按钮删掉，每轮的主问题写在回复里", replacedBy: "IR-170" },
  { id: "IR-140", layer: "L0", verdict: "keep", status: "retired", rule: "下一轮的进度头说上轮的下一步本人按了「好，往下」还是写了自己的话",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "nextTaken", test: `${WORKER}/onboarding-session.test.ts`, by: "the next round is told whether the person took it" },
    reason: "2026-11-22 原生改写：「好，往下」按钮删掉，进度头不再说按没按" },
  { id: "IR-141", layer: "L0", verdict: "keep", status: "active", rule: "进度头列最近几次整理记下的事实条数，连续为零时注明，只作事实",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "SATURATED_RUNS", test: `${WORKER}/onboarding-standing.test.ts`, by: "how much the latest extractions found" } },
  { id: "IR-142", layer: "L0", verdict: "delete", status: "retired", rule: "开始标准齐了，页面在「结束并出报告」旁提示一次",
    code: { file: "apps/web/app/onboarding/finish-button.tsx", symbol: "shouldRemindStart" },
    reason: "2026-11-27 本人定：开始标准不该影响何时结束；回放 persona a 在完善度 51%、只谈了经历时按这条提示结束。只留「访谈已经很完整」一条" },
  { id: "IR-143", layer: "L2", verdict: "model", status: "retired", rule: "next 提议下一个步骤，不是下一个阶段",
    text: { file: INTERVIEW_SKILL, anchor: "**是下一个步骤，不是下一个阶段。**" },
    reason: "2026-11-22 原生改写：next 删掉", replacedBy: "IR-170" },
  { id: "IR-144", layer: "L2", verdict: "model", status: "retired", rule: "本人没按上轮的下一步，先接住本人的话，下一轮再提",
    text: { file: INTERVIEW_SKILL, anchor: "**上轮提议的下一步本人没按，先接住本人的话。**" },
    reason: "2026-11-22 原生改写：next 和「好，往下」删掉" },
  { id: "IR-145", layer: "L2", verdict: "model", status: "active", rule: "说过的张力记进 progress.said，不再换说法再说",
    text: { file: INTERVIEW_SKILL, anchor: "`said`（已经对本人说过的张力和模式" } },
  // The Skill split (2026-11-15): a resident core of fifteen rules, and each stage's checklist sent by code with the stage.
  { id: "IR-146", layer: "L0", verdict: "keep", status: "active", rule: "部分的清单（stages/<stage>.md）随新线程的第一轮发给对话；之后对话进入一个部分时用 read_interview_state 的 part 读（2026-11-22）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "stageGuide", test: `${WORKER}/onboarding-session.test.ts`, by: "a new thread starts with its part's checklist" } },
  // The right column's pictures (2026-11-15, step 5): each draws only what the record holds; the cards' readings come back in words.
  { id: "IR-147", layer: "L0", verdict: "keep", status: "active", rule: "量表读数在画像图上交还本人：每个计分维度一个偏高、中等或偏低，从不显示分数",
    code: { file: `${CORE}/profile-claims.ts`, symbol: "instrumentLevels", test: `${CORE}/profile-claims.test.ts`, by: "the person's page gets each scored dimension's level in words" } },
  { id: "IR-148", layer: "L0", verdict: "keep", status: "active", rule: "假设看板按证据把假设分成已支持、待定、已推翻三栏",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "boardColumns", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the board sorts the hypotheses by where the evidence left them" } },
  { id: "IR-149", layer: "L0", verdict: "keep", status: "active", rule: "D8 画成生命线：主题、按记录顺序的转折和本人说的下一章；没有内容时说会画什么",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "LifelineView", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the lifeline draws only what the record holds" } },
  { id: "IR-150", layer: "L0", verdict: "keep", status: "active", rule: "D9 维持循环画成一个圈：没被推翻的 D9 假设至少两条，最后一步回到第一步",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "LoopView", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the loop draws the unrefuted D9 steps round a circle" } },
  // Replay 16 (2026-11-16): IR-123 sent five of twelve rounds back for words that were not the disclosure.
  { id: "IR-151", layer: "L0", verdict: "keep", status: "active", rule: "披露原话只按本人自己打的字比：回复里有自伤的句子时只比那几句，安全回应之后那条回复只比自伤的句子；题面、选项和访谈者自己的话都算普通的话",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureWords", test: `${CORE}/onboarding-pace.test.ts`, by: "a disclosure is compared by the person's own words where it is" } },
  // Replay 16's follow-ups (2026-11-16).
  { id: "IR-152", layer: "L2", verdict: "model", status: "retired", rule: "next 只提对话做得到的事，不许诺把这一周排出来；本人要看一周，请本人看右栏的周草稿",
    text: { file: INTERVIEW_SKILL, anchor: "**`next` 只提对话做得到的事：聊什么、问什么、请本人看右栏的哪张图。**" },
    reason: "2026-11-22 原生改写：next 删掉" },
  { id: "IR-153", layer: "L2", verdict: "model", status: "active", rule: "观察卡说一个判断，不以「也可能只是……」收尾；另一种解释写进证伪条件，只有一条回复的直接问是哪一种",
    text: { file: INTERVIEW_SKILL, anchor: "**说一个判断，不两头下注：**" } },
  { id: "IR-154", layer: "L2", verdict: "model", status: "retired", rule: "本人说想先开始用：没齐时第一句说还差哪几样、只问这几样、不出观察卡；齐了就说可以按结束",
    text: { file: INTERVIEW_SKILL, anchor: "**本人说想先开始用（进度头会写）：**" },
    reason: "2026-11-22 原生改写：本人想开始不再由应用判断；开始标准没齐时怎么说并入核心规则 15" },
  { id: "IR-155", layer: "L0", verdict: "keep", status: "retired", rule: "本人这一轮用自己的话说想先开始用：这一轮不放量表卡，进度头写明；开始只差卡片题时照放（2026-11-17）",
    code: { file: "apps/worker/src/onboarding-session.ts", symbol: "holdCardsForStart", test: "apps/worker/src/onboarding-session.test.ts", by: "a person who says they want to start gets no rating card that round" },
    reason: "2026-11-22 原生改写：量表不再插在访谈轮次旁边，改为访谈前的一整页（S3）" },
  { id: "IR-156", layer: "L0", verdict: "keep", status: "active", rule: "JSON 回答里没转义的引号按文字转义；解析不了时日志只记位置、长度和是否在打转，不记内容",
    code: { file: "packages/codex/src/json-repair.ts", symbol: "MAX_QUOTE_EDITS", test: "packages/codex/src/json-repair.test.ts", by: "a quote inside a text left unescaped is escaped" } },
  { id: "IR-157", layer: "L0", verdict: "keep", status: "active", rule: "画像三次都解析不了时换新线程重写一次，再失败才 blocked",
    code: { file: "apps/worker/src/portrait-writer.ts", symbol: "portrait.fresh_retry", test: "apps/worker/src/portrait-writer.test.ts", by: "written again once in a fresh thread" } },
  // 2026-11-17, the owner: where a rule held back the model's judgement, follow-up or synthesis, give it the information and the aim
  // instead. The deterministic checks (quotes, URLs, dates, approvals) stay.
  { id: "IR-158", layer: "L0", verdict: "model", status: "retired", rule: "假设日志还有候选时退回对话自己的新推断，新推断一轮最多一张",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "新推断等候选用完" },
    reason: "对话读得到整场回答，整理的候选只是其中一部分；挡掉它自己的推断等于限制综合。候选改为给对话的材料，日志有没有被问到由回放看", replacedBy: "IR-159" },
  { id: "IR-159", layer: "L2", verdict: "model", status: "active", rule: "cardFrom 是证据已齐的候选，对话自己的推断更站得住时照样出卡",
    text: { file: INTERVIEW_SKILL, anchor: "**自己的推断比剩下的候选更站得住时就出，不必等候选用完。**" } },
  { id: "IR-160", layer: "L2", verdict: "model", status: "retired", rule: "动机和原因可以从话、行为和数据外推，写最有把握的那个、依据和把握；不否定本人说过的原因",
    text: { file: INTERVIEW_SKILL, anchor: "**推断是补充，不是替换；原因可以推，要写把握。**" },
    reason: "2026-11-22 画像深度（docs/plans/portrait-depth-1122.md §一）：把「准」率当目标会把推断推向本人已经知道的；只保护感受和动机，行为的名字可以重新解释", replacedBy: "IR-176" },
  { id: "IR-161", layer: "L2", verdict: "model", status: "retired", rule: "一轮问几题由对话按本人的回答和状态判断，应用只管五题的上限",
    text: { file: INTERVIEW_SKILL, anchor: "**一轮问几题由你判断：**" },
    reason: "2026-11-22 原生改写：每轮只问一个主问题", replacedBy: "IR-170" },
  // Replay 17 (2026-11-17): the cards held from a person who wanted to start were the only item the start lacked.
  { id: "IR-162", layer: "L2", verdict: "model", status: "retired", rule: "本人想开始而开始只差卡片题：说答完右侧卡片就能开始，不另出题，不用自己的话复述卡片题",
    text: { file: INTERVIEW_SKILL, anchor: "**只差画像卡片题时**" },
    reason: "2026-11-22 原生改写：量表卡不再插在访谈轮次旁边" },
  // 2026-11-17, the owner: make the observation cards more accurate. Information and aims from replays 17–18, not a new gate.
  { id: "IR-163", layer: "L2", verdict: "model", status: "active", rule: "一张卡一个论断；出卡前拿整场记录核对反例和本人给过的原因；说行为的条件，不评人；结论的范围和证据一样大",
    text: { file: INTERVIEW_SKILL, anchor: "**「准」从哪来。**" } },
  { id: "IR-164", layer: "L4", verdict: "model", status: "active", rule: "假设只说依据盖得住的范围，一条一个论断；查反例，不写「一直」；本人给过的原因之外才写更深一层",
    text: { file: EXTRACT_SKILL, anchor: "**`statement` 只说 `basis` 盖得住的范围，一条一个论断。**" } },
  // 2026-11-22, the native rewrite (docs/plans/2026-11-22-interview-and-import-redesign.md §2–§3): one long thread, the reply in free text,
  // the state read on demand, the person's messages queued or steered, at most a thousand of them.
  { id: "IR-165", layer: "L0", verdict: "record", status: "active", rule: "开始标准没齐时说可以开始、或报量表分数：不退回，记 rule-fired 供回放（2026-11-25 起不再写 round_edited 的 noted）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "firedAfter", test: `${WORKER}/onboarding-session.test.ts`, by: "is recorded, not sent back or cut" } },
  { id: "IR-166", layer: "L0", verdict: "keep", status: "active", rule: "一场访谈最多 1000 条本人的消息，在一轮开始时数",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "INTERVIEW_ROUND_LIMIT", test: `${WORKER}/onboarding-session.test.ts`, by: "at most a thousand a session" } },
  { id: "IR-167", layer: "L0", verdict: "keep", status: "active", rule: "一轮进行中本人发的话默认排队到下一轮；选「插入本轮」时用 turn/steer 带上正在跑的 turn id，跑不了就排队",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "steerInterview", test: `${WORKER}/onboarding-session.test.ts`, by: "steers the running turn with its id" } },
  { id: "IR-168", layer: "L0", verdict: "keep", status: "active", rule: "有工具的路线上回复是最终消息的自由文本，卡片和标记走工具，后续轮次只发本人的话和一行说明、不带 outputSchema；不调函数的路线保留 schema",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "asRound", test: `${WORKER}/onboarding-session.test.ts`, by: "free text is the round's reply" } },
  { id: "IR-169", layer: "L0", verdict: "keep", status: "active", rule: "运行时卸下的线程先用 thread/resume 从 rollout 接着走，rollout 也没了才从账本重建",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "resumeOnly", test: `${WORKER}/onboarding-session.test.ts`, by: "resumed from its rollout" } },
  { id: "IR-170", layer: "L2", verdict: "model", status: "active", rule: "每轮接住本人的话、最多多一层第二级推断，只问一个带约束的主问题；模式、漏洞和动机猜测不在对话里说，留给报告",
    text: { file: INTERVIEW_SKILL, anchor: "**每轮只问一个主问题，带约束。**" } },
  { id: "IR-171", layer: "L2", verdict: "model", status: "active", rule: "可核实的信念当场联网核对，用「你的认知｜判定｜数据与纠偏」带链接，搜索词不带本人信息",
    text: { file: INTERVIEW_SKILL, anchor: "「你的认知｜判定｜数据与纠偏」" } },
  { id: "IR-172", layer: "L2", verdict: "model", status: "active", rule: "岔开的题目交给后台调研线程，访谈结束时汇报",
    text: { file: INTERVIEW_SKILL, anchor: "**岔开的题目交给后台调研。**" } },
  { id: "IR-173", layer: "L2", verdict: "model", status: "active", rule: "访谈的顺序：量表读数、人生故事、你在这里、指南针、能量、锚问题、奥德赛计划、落地",
    text: { file: INTERVIEW_SKILL, anchor: "## 访谈的顺序" } },
  { id: "IR-174", layer: "L2", verdict: "model", status: "active", rule: "主线由本人先列，访谈中随时可以改，对话不自己提新主线",
    text: { file: INTERVIEW_SKILL, anchor: "**主线由本人先列，随时可以改。**" } },
  { id: "IR-175", layer: "L2", verdict: "model", status: "active", rule: "语气客观、理性、平静，对谁都一样（语气选择删掉）",
    text: { file: INTERVIEW_SKILL, anchor: "**语气客观、理性、平静，对谁都一样。**" } },
  // 2026-11-22, portrait depth (docs/plans/portrait-depth-1122.md): inferences sorted by distance from the person's own account (Finn's
  // levels); only the middle level goes on a card, the farthest waits for the report and is rated after it has been read whole.
  { id: "IR-176", layer: "L2", verdict: "model", status: "active", rule: "感受和动机以本人为准；本人给行为起的名字可以换一种有事实依据的解释；第三级推断不在对话里说",
    text: { file: INTERVIEW_SKILL, anchor: "**感受和动机以本人为准；行为的名字可以重新解释。**" } },
  { id: "IR-177", layer: "L2", verdict: "model", status: "active", rule: "观察卡只放第二级推断：第一级是复述，第三级留给报告",
    text: { file: INTERVIEW_SKILL, anchor: "**卡只放第二级。**" } },
  { id: "IR-178", layer: "L0", verdict: "keep", status: "active", rule: "出卡候选只取第二级、未上过卡、未被推翻的假设",
    code: { file: `${CORE}/profile-points.ts`, symbol: "cardCandidates", test: `${CORE}/profile-points.test.ts`, by: "only the second level" } },
  { id: "IR-179", layer: "L4", verdict: "model", status: "active", rule: "整理给每条假设标离本人自述的距离（1 复述、2 联系或多一层、3 与本人的解释相反）",
    text: { file: EXTRACT_SKILL, anchor: "**每条假设标一个级别（`level`）。**" } },
  { id: "IR-180", layer: "L2", verdict: "model", status: "active", rule: "叙事部分一个场景问到之后一周、当时和现在的说法、结果由谁来判",
    text: { file: `${SKILLS}/crossline-onboarding/stages/narrative.md`, anchor: "**一个场景问到它的前后，不只是它本身。**" } },
  { id: "IR-181", layer: "L0", verdict: "keep", status: "active", rule: "自由文本的一轮没调用 mark_round 时退回一次要它标出所在部分，第二次的回答照收",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "stageAsked", test: `${WORKER}/onboarding-session.test.ts`, by: "never marked its part" } },
  // Replay of yaohuaqishu (2026-11-23, 30 rounds): a direct question went unanswered, the recommended direction changed every round, and
  // three parts took 29 rounds between them.
  { id: "IR-182", layer: "L0", verdict: "keep", status: "active", rule: "本人在回答里问了访谈者的问题，每轮说明里写出来；一部分到第六轮，每轮说明里写出已到第几轮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "questionsAsked", test: `${WORKER}/onboarding-session.test.ts`, by: "says what the person asked" } },
  { id: "IR-183", layer: "L2", verdict: "model", status: "active", rule: "本人问访谈者的，这一轮第一句先答，判断写在回复里",
    text: { file: INTERVIEW_SKILL, anchor: "**本人问你的，这一轮先答。**" } },
  { id: "IR-184", layer: "L2", verdict: "model", status: "active", rule: "候选方向排成一个次序记在 progress.said，新回答只调整次序，不每轮换一个",
    text: { file: INTERVIEW_SKILL, anchor: "**候选方向排成一个次序，不每轮换一个。**" } },
  { id: "IR-185", layer: "L2", verdict: "model", status: "active", rule: "一部分最多六轮，到了就收尾，没清楚的记成不确定，进下一部分",
    text: { file: INTERVIEW_SKILL, anchor: "**一部分最多六轮。**" } },
  // 2026-11-25, semantic judgements to the model (docs/plans/harness-1125.md §1): IR-022, IR-025 and IR-028 retired.
  { id: "IR-186", layer: "L0", verdict: "keep", status: "active", rule: "应用的题在整理还没读到的回答里答过就等整理；读过仍没记下就再问",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "checklistAnswered", test: `${WORKER}/question-ledger.test.ts` } },
  { id: "IR-187", layer: "L4", verdict: "model", status: "active", rule: "定语不是动作、数量、成就；名词式品质写成「有…」：由整理把关",
    text: { file: EXTRACT_SKILL, anchor: "**定语的措辞由你把关，应用不再逐词检查。**" } },
  { id: "IR-188", layer: "L0", verdict: "keep", status: "active", rule: "模型提的定语候选超过 12 个字或只重复主线名的，退回",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "attributeShapeProblem", test: `${CORE}/line-attributes.test.ts` } },
  // 2026-11-25, the interview driven by its ledger (docs/plans/harness-1125.md 「访谈账本驱动」): the ledger is the model's external memory,
  // rewritten after every round and rendered at the head of the next; the model judges the checklist and the sameness of questions
  // against it, and the code checks only structure and that the words cited exist.
  { id: "IR-190", layer: "L0", verdict: "record", status: "active", rule: "回复抄了卡片答案的写法（【题】已点选）：记 rule-fired，不退回（W-315；量表一节写明不抄）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "CARD_NOTATION", test: `${WORKER}/onboarding-session.test.ts`, by: "copying a card's notation" } },
  { id: "IR-191", layer: "L0", verdict: "record", status: "active", rule: "回复说某题「还没答」：记 rule-fired，不退回（W-307、W-314；问过和答过的题在快照里）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "PENDING_TALK", test: `${WORKER}/onboarding-session.test.ts`, by: "saying a question still waits" } },
  { id: "IR-192", layer: "L0", verdict: "return", status: "active", rule: "清单判定只核对依据：id 在快照里、状态四选一、answered/partial 的 basis 逐字在所引 reply-N/src-N 里、不引披露、不适用要写理由",
    code: { file: `${CORE}/interview-checklist.ts`, symbol: "checkChecklistVerdicts", test: `${CORE}/interview-checklist.test.ts` } },
  { id: "IR-193", layer: "L0", verdict: "keep", status: "active", rule: "每轮开头放账本快照：清单与上次判定、已问题目（意思、原题、回答）、本人写过的日期、披露所在；上一轮结束时先写账本，再渲染",
    code: { file: `${CORE}/interview-snapshot.ts`, symbol: "renderInterviewSnapshot", test: `${CORE}/interview-snapshot.test.ts` } },
  { id: "IR-194", layer: "L0", verdict: "return", status: "active", rule: "回复里的问题经 mark_round.asked 交：要有原文和 gist，repeats 要在账本里，标了答过的题又不是 followUp 的退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkAsked", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-195", layer: "L0", verdict: "keep", status: "active", rule: "回复里问的题记进问题账本；本人下一条回复（卡片行除外）在读账本之前写成它的回答",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "answerMainQuestions", test: `${WORKER}/question-ledger.test.ts` } },
  { id: "IR-196", layer: "L0", verdict: "keep", status: "active", rule: "只记录的规则触发时写一行 rule-fired.jsonl（数据目录下的 telemetry），不进账本、不发事件",
    code: { file: `${CORE}/rule-spec.ts`, symbol: "ruleFired", test: `${CORE}/rule-spec.test.ts` } },
  { id: "IR-197", layer: "L2", verdict: "model", status: "active", rule: "对着账本快照逐项判清单：answered / partial / missing / not_applicable，带逐字依据",
    text: { file: INTERVIEW_SKILL, anchor: "**对着账本快照判清单，不靠记忆。**" } },
  { id: "IR-198", layer: "L2", verdict: "model", status: "active", rule: "出题前按意思对照已问题目：同义不再问，答了一部分只问缺的；每道题写 gist、repeats、followUp",
    text: { file: INTERVIEW_SKILL, anchor: "**出题前对着快照里的已问题目判意思，不看字面。**" } },
  { id: "IR-199", layer: "L2", verdict: "model", status: "active", rule: "一轮一个主问题、最多五道；同一件事最多问两次，再不清就记成假设；回复里的日子只用快照、文件或调研里的",
    text: { file: INTERVIEW_SKILL, anchor: "**一轮的题量和同一件事的问法有上限。**" } },
  { id: "IR-200", layer: "L0", verdict: "return", status: "active", rule: "回复的陈述句里有本人、文件和之前回复都没说过的数量（「七张」）：退回一次点名这个数，要么改成问，要么不是在复述本人就照原样；第二次的回答照用（2026-11-26 回放）",
    code: { file: `${CORE}/said-counts.ts`, symbol: "unsaidCounts", test: `${CORE}/said-counts.test.ts` } },
  { id: "IR-189", layer: "L2", verdict: "model", status: "active", rule: "项目要不要每周固定到场由访谈判断，没人说过时间的问一次，只问时间",
    text: { file: INTERVIEW_SKILL, anchor: "**一个项目要不要每周固定到场，由你判断。**" } },
];
/* i18n-ignore-end */

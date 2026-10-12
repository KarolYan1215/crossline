/**
 * Task archetypes: what kind of work a task is, as a grammar its steps follow — not a fixed sequence.
 *
 * Two layers (decided 2026-10-07, docs/copy-style.md and the redesign plan):
 * - Structure primitives, from the workflow control-flow patterns (van der Aalst et al.: sequence WCP1, parallel split/sync WCP2–3,
 *   exclusive choice WCP4, multiple instances WCP12–15, deferred choice WCP16, milestone WCP18, structured loop) and HTA plan types.
 *   Explore→converge (the Double Diamond) and learn-while-doing (Kolb) are descriptive frameworks without rigorous outcome evidence,
 *   so they are compounds, not primitives. Recurrence is a task attribute, not structure.
 * - Archetypes, each composed of primitives, with the roles its steps may take, the few hard ordering rules, the usual proportions,
 *   how its size is worked backwards (a quantity × minutes per unit), the publicly recognised acceptance standard, and how a tick
 *   (a near-term result on the milestone axis) is phrased.
 *
 * The model picks the archetype and writes the actual steps: how many and in what order is its call. 「研究-执行-执行-研究」 is valid
 * for an archetype whose rules only say research comes before the first execution. Rules here are checked mechanically and only ever
 * produce warnings (`stepPlanWarnings`); a reviewer model decides whether a warning matters.
 */

export const STRUCTURE_PRIMITIVES = {
  sequence: "串行",
  multi_instance: "多实例",
  branch: "条件分支",
  wait: "等待事件/时间窗",
  loop_until: "循环至达标",
  checkpoint: "检查点",
  explore_converge: "探索→收敛",
  learn_do: "边学边做"
} as const;
export type StructurePrimitive = keyof typeof STRUCTURE_PRIMITIVES;

export const STEP_ROLES = {
  gather: "资料收集", read: "阅读", outline: "提纲", draft: "撰写", revise: "修订", check: "检查",
  learn: "学习", practice: "练习", mock: "模拟测验", solve: "解题", submit: "提交",
  compare: "比较", decide: "决定", build: "构建", test: "测试验证", record: "记录",
  contact: "联系", wait: "等待", follow_up: "跟进", prepare: "准备", rehearse: "演练", deliver: "执行交付",
  summarize: "总结", handle: "办理", pay: "支付", book: "预约", publish: "发布", analyze: "分析", review: "复盘"
} as const;
export type StepRole = keyof typeof STEP_ROLES;

/**
 * The most energy a step of this kind needs, whatever its task needs (decided 2026-10-12): handing in and reading through do not take
 * a high-energy hour, and every step used to inherit its task's 「high」, so a day's three high hours went to submitting and skimming.
 * A step is scheduled at the lower of its task's energy and this ceiling; roles not listed take the task's.
 */
export const STEP_ENERGY_CEILING: Partial<Record<StepRole, "low" | "medium">> = { submit: "low", read: "medium" };
export const isStepRole = (value: unknown): value is StepRole => typeof value === "string" && value in STEP_ROLES;

export type Archetype = {
  id: string;
  label: string;
  primitives: StructurePrimitive[];
  roles: StepRole[];
  /** Roles at least one step must take. */
  requires: StepRole[];
  /** [a, b]: the first `a` step comes before the first `b` step. */
  firstBefore: Array<[StepRole, StepRole]>;
  /** The last step's role, when the work ends in a hand-in or a decision. */
  endsWith?: StepRole[];
  /** Usual share of the work by role (sums to about 1). */
  proportions: Partial<Record<StepRole, number>>;
  /** How the size is worked backwards: a quantity in `unit`, times `minutesPerUnit` (low, high). */
  quantify: { basis: string; unit: string; minutesPerUnit: [number, number] };
  /** The recognised standard the result is judged against. */
  acceptance: string;
  /** How a tick's result is written. */
  tickHint: string;
  /** Roles that are usually errands the system can do (gathering, drafting a list) — the model still decides per step. */
  agentRoles: StepRole[];
  recurring?: boolean;
};

export const ARCHETYPES: Archetype[] = [
  { id: "writing", label: "写作产出", primitives: ["explore_converge", "sequence", "loop_until", "checkpoint"],
    roles: ["gather", "read", "outline", "draft", "revise", "check", "submit"], requires: ["draft", "check"],
    firstBefore: [["gather", "draft"], ["draft", "revise"]], endsWith: ["check", "submit"],
    proportions: { gather: 0.2, outline: 0.1, draft: 0.4, revise: 0.2, check: 0.1 },
    quantify: { basis: "目标字数", unit: "千字", minutesPerUnit: [60, 150] },
    acceptance: "写作评分量规：论点清晰、证据充分、结构完整、语言规范", tickHint: "完成某部分初稿（如「引言与方法初稿 1500 字」）", agentRoles: ["gather", "outline", "check"] },
  { id: "exam_prep", label: "考试复习", primitives: ["learn_do", "loop_until", "checkpoint"],
    roles: ["gather", "learn", "practice", "mock", "review", "summarize"], requires: ["learn", "practice"],
    firstBefore: [["learn", "practice"], ["practice", "mock"]],
    proportions: { gather: 0.05, learn: 0.35, practice: 0.35, mock: 0.15, review: 0.1 },
    quantify: { basis: "知识点数", unit: "个", minutesPerUnit: [30, 75] },
    acceptance: "模拟测验成绩达到分数线；Bloom 认知层级达到应用及以上", tickHint: "能独立完成某类题（如「独立推导 BJT 小信号模型」）", agentRoles: ["gather", "summarize"] },
  { id: "problem_set", label: "习题/课程作业", primitives: ["wait", "multi_instance", "checkpoint"],
    roles: ["wait", "read", "learn", "solve", "check", "submit"], requires: ["solve", "submit"],
    firstBefore: [["wait", "solve"], ["solve", "check"]], endsWith: ["submit"],
    proportions: { read: 0.1, learn: 0.15, solve: 0.6, check: 0.1, submit: 0.05 },
    quantify: { basis: "题目数", unit: "题", minutesPerUnit: [20, 60] },
    acceptance: "全部题目完成并自查，按要求格式提交", tickHint: "完成若干题（如「第 1–3 题完成并核对」）", agentRoles: ["read", "check"] },
  { id: "research_decision", label: "调研与决策", primitives: ["explore_converge", "multi_instance", "branch"],
    roles: ["gather", "compare", "analyze", "decide", "record"], requires: ["gather", "decide"],
    firstBefore: [["gather", "compare"], ["compare", "decide"]], endsWith: ["decide", "record"],
    proportions: { gather: 0.4, compare: 0.3, analyze: 0.15, decide: 0.1, record: 0.05 },
    quantify: { basis: "候选方案数", unit: "个", minutesPerUnit: [20, 45] },
    acceptance: "决策矩阵：候选、评价维度、取舍理由齐全", tickHint: "候选清单或比较表完成", agentRoles: ["gather", "compare"] },
  { id: "build", label: "构建/实验", primitives: ["learn_do", "loop_until", "checkpoint"],
    roles: ["learn", "prepare", "build", "test", "revise", "record"], requires: ["build", "test"],
    firstBefore: [["build", "test"]],
    proportions: { learn: 0.1, prepare: 0.1, build: 0.45, test: 0.2, revise: 0.1, record: 0.05 },
    quantify: { basis: "功能点或实验组数", unit: "个", minutesPerUnit: [60, 180] },
    acceptance: "可运行、可复现，结果有记录", tickHint: "某个功能或实验跑通（如「仿真跑通 1 组参数」）", agentRoles: ["prepare", "record"] },
  { id: "communication", label: "沟通跟进", primitives: ["sequence", "wait", "loop_until"],
    roles: ["prepare", "draft", "contact", "wait", "follow_up", "record"], requires: ["contact"],
    firstBefore: [["draft", "contact"], ["contact", "follow_up"]],
    proportions: { prepare: 0.3, draft: 0.4, contact: 0.1, follow_up: 0.15, record: 0.05 },
    quantify: { basis: "联系对象数", unit: "人", minutesPerUnit: [15, 40] },
    acceptance: "收到明确答复或结论", tickHint: "消息已发出或收到答复", agentRoles: ["prepare", "draft"] },
  { id: "event_prep", label: "会议/活动准备", primitives: ["multi_instance", "sequence", "checkpoint"],
    roles: ["prepare", "gather", "draft", "rehearse", "deliver", "review"], requires: ["prepare", "deliver"],
    firstBefore: [["prepare", "deliver"], ["rehearse", "deliver"]],
    proportions: { prepare: 0.4, gather: 0.15, draft: 0.2, rehearse: 0.15, review: 0.1 },
    quantify: { basis: "准备事项数", unit: "项", minutesPerUnit: [15, 45] },
    acceptance: "准备清单全部完成", tickHint: "议程或材料就绪", agentRoles: ["gather", "prepare"] },
  { id: "reading", label: "阅读学习", primitives: ["multi_instance", "sequence"],
    roles: ["read", "record", "summarize", "practice"], requires: ["read", "summarize"],
    firstBefore: [["read", "summarize"]], endsWith: ["summarize", "practice"],
    proportions: { read: 0.65, record: 0.15, summarize: 0.2 },
    quantify: { basis: "页数", unit: "页", minutesPerUnit: [2, 6] },
    acceptance: "摘要能复述核心论点与方法（Bloom 理解层级）", tickHint: "读完某部分并有笔记（如「第 3 章笔记」）", agentRoles: ["summarize"] },
  { id: "admin", label: "事务办理", primitives: ["sequence", "wait"],
    roles: ["prepare", "handle", "pay", "wait", "follow_up", "record"], requires: ["handle"],
    firstBefore: [["prepare", "handle"]],
    proportions: { prepare: 0.4, handle: 0.4, follow_up: 0.1, record: 0.1 },
    quantify: { basis: "办理环节数", unit: "个", minutesPerUnit: [15, 45] },
    acceptance: "取得办结凭证", tickHint: "材料备齐或某环节办结", agentRoles: ["prepare", "record"] },
  { id: "habit", label: "例行习惯", primitives: ["sequence"], recurring: true,
    roles: ["deliver", "record"], requires: ["deliver"], firstBefore: [],
    proportions: { deliver: 0.9, record: 0.1 },
    quantify: { basis: "单次时长", unit: "次", minutesPerUnit: [15, 90] },
    acceptance: "按计划频率完成", tickHint: "本周完成次数", agentRoles: [] },
  { id: "content", label: "内容发布", primitives: ["explore_converge", "sequence", "checkpoint"],
    roles: ["gather", "outline", "draft", "build", "check", "publish", "analyze"], requires: ["draft", "publish"],
    firstBefore: [["gather", "draft"], ["check", "publish"]],
    proportions: { gather: 0.2, outline: 0.1, draft: 0.35, build: 0.15, check: 0.1, publish: 0.05, analyze: 0.05 },
    quantify: { basis: "内容条数", unit: "条", minutesPerUnit: [60, 180] },
    acceptance: "发布记录与阅读数据", tickHint: "某条内容发布", agentRoles: ["gather", "outline", "analyze"] },
  { id: "investment_research", label: "投资研究", primitives: ["multi_instance", "sequence", "loop_until"],
    roles: ["gather", "analyze", "record", "review"], requires: ["analyze", "record"],
    firstBefore: [["gather", "analyze"]],
    proportions: { gather: 0.35, analyze: 0.4, record: 0.15, review: 0.1 },
    quantify: { basis: "标的数", unit: "个", minutesPerUnit: [30, 90] },
    acceptance: "研究记录完整：论点、证据、风险、复核条件；不含交易指令", tickHint: "某标的研究记录完成", agentRoles: ["gather"] },
  { id: "application", label: "申请", primitives: ["sequence", "multi_instance", "wait", "checkpoint"],
    roles: ["gather", "prepare", "draft", "revise", "check", "submit", "wait", "follow_up"], requires: ["draft", "submit"],
    firstBefore: [["gather", "draft"], ["check", "submit"]],
    proportions: { gather: 0.15, prepare: 0.2, draft: 0.35, revise: 0.15, check: 0.1, submit: 0.05 },
    quantify: { basis: "所需材料份数", unit: "份", minutesPerUnit: [45, 150] },
    acceptance: "材料齐全并按时提交，取得受理确认", tickHint: "某份材料定稿", agentRoles: ["gather", "check"] },
  { id: "presentation", label: "演示汇报", primitives: ["sequence", "loop_until", "checkpoint"],
    roles: ["gather", "outline", "build", "rehearse", "revise", "deliver"], requires: ["build", "rehearse"],
    firstBefore: [["outline", "build"], ["build", "rehearse"]], endsWith: ["deliver", "rehearse"],
    proportions: { gather: 0.15, outline: 0.1, build: 0.45, rehearse: 0.2, revise: 0.1 },
    quantify: { basis: "页数", unit: "页", minutesPerUnit: [15, 40] },
    acceptance: "按时完成演示，内容与时长符合要求", tickHint: "幻灯片完成或完整演练一次", agentRoles: ["gather", "outline"] },
  { id: "finance", label: "财务账务", primitives: ["sequence", "checkpoint"],
    roles: ["gather", "record", "analyze", "pay", "check"], requires: ["record"],
    firstBefore: [["gather", "record"]],
    proportions: { gather: 0.3, record: 0.3, analyze: 0.2, pay: 0.1, check: 0.1 },
    quantify: { basis: "账目或单据数", unit: "笔", minutesPerUnit: [3, 10] },
    acceptance: "账目核对一致，缴付凭证齐全", tickHint: "账目整理完成或款项缴清", agentRoles: ["gather", "record"] },
  { id: "health_care", label: "健康就医与照护", primitives: ["sequence", "wait"],
    roles: ["book", "prepare", "deliver", "follow_up", "record"], requires: ["deliver"],
    firstBefore: [["book", "deliver"]],
    proportions: { book: 0.15, prepare: 0.2, deliver: 0.5, follow_up: 0.1, record: 0.05 },
    quantify: { basis: "就诊或照护次数", unit: "次", minutesPerUnit: [45, 180] },
    acceptance: "按医嘱或计划完成并有记录", tickHint: "预约完成或复查完成", agentRoles: ["prepare"] },
  { id: "logistics", label: "出行与后勤", primitives: ["multi_instance", "sequence", "wait"],
    roles: ["compare", "book", "pay", "prepare", "deliver"], requires: ["book"],
    firstBefore: [["compare", "book"], ["book", "deliver"]],
    proportions: { compare: 0.3, book: 0.2, pay: 0.05, prepare: 0.3, deliver: 0.15 },
    quantify: { basis: "预订或准备事项数", unit: "项", minutesPerUnit: [15, 45] },
    acceptance: "预订确认与清单完成", tickHint: "行程或物品清单就绪", agentRoles: ["compare", "prepare"] },
  { id: "relationship", label: "人际维护", primitives: ["sequence", "wait"], recurring: true,
    roles: ["prepare", "contact", "follow_up", "record"], requires: ["contact"], firstBefore: [["prepare", "contact"]],
    proportions: { prepare: 0.3, contact: 0.5, follow_up: 0.1, record: 0.1 },
    quantify: { basis: "联系对象数", unit: "人", minutesPerUnit: [15, 60] },
    acceptance: "按计划完成联系并记录要点", tickHint: "联系完成", agentRoles: ["prepare"] }
];

export const ARCHETYPE_IDS = ARCHETYPES.map((archetype) => archetype.id);
/** A built-in archetype, or one learned for this workspace (`extra`, from `learned_archetypes`). */
export const archetypeById = (id: string, extra: readonly Archetype[] = []): Archetype | undefined =>
  ARCHETYPES.find((archetype) => archetype.id === id) ?? extra.find((archetype) => archetype.id === id);

const s = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const roleEnum = { type: "string", enum: Object.keys(STEP_ROLES) };

/**
 * The archetype curator's answer (Skill `crossline-archetype-curator`): at most three new archetypes drawn from tasks this person
 * keeps doing that no built-in archetype fits well, each built from the same primitives and roles, resting on at least two of the
 * person's tasks and on a public standard or guide (a source the worker opens before keeping it).
 */
export const ARCHETYPE_CURATION_SCHEMA = obj({
  archetypes: { type: "array", maxItems: 3, items: obj({
    id: s, label: s, primitives: { type: "array", items: { type: "string", enum: Object.keys(STRUCTURE_PRIMITIVES) } },
    roles: { type: "array", items: roleEnum }, requires: { type: "array", items: roleEnum },
    firstBefore: { type: "array", items: { type: "array", items: roleEnum } }, endsWith: { type: "array", items: roleEnum },
    proportions: { type: "array", items: obj({ role: roleEnum, share: { type: "number" } }) },
    quantify: obj({ basis: s, unit: s, minutesLow: { type: "number" }, minutesHigh: { type: "number" } }),
    acceptance: s, tickHint: s, agentRoles: { type: "array", items: roleEnum }, recurring: { type: "boolean" },
    basedOnTaskIds: { type: "array", items: s }, sources: { type: "array", items: obj({ url: s, title: s }) }, why: s
  }) },
  notes: s
});
export type CuratedArchetype = Archetype & { basedOnTaskIds: string[]; sources: Array<{ url: string; title: string }>; why: string };

/**
 * What can be checked about a proposed archetype before it is kept: a new slug id, roles and primitives from the fixed sets, rules
 * that only name its own roles, a sane size, the person's own tasks behind it. An item that fails is dropped with its reason; the
 * answer as a whole is never refused for one bad item.
 */
export function validateCuratedArchetypes(value: unknown, context: { existingIds: string[]; taskIds: string[] }): { kept: CuratedArchetype[]; dropped: string[] } {
  const raw = value as { archetypes?: unknown[] } | undefined;
  if (!raw || !Array.isArray(raw.archetypes)) throw new Error("ARCHETYPE_CURATION_SCHEMA_INVALID");
  const taken = new Set([...ARCHETYPE_IDS, ...context.existingIds]);
  const tasks = new Set(context.taskIds);
  const kept: CuratedArchetype[] = [];
  const dropped: string[] = [];
  for (const item of raw.archetypes.slice(0, 3) as Array<Record<string, unknown>>) {
    const roles = (item.roles as string[] ?? []).filter(isStepRole);
    const within = (list: unknown) => Array.isArray(list) && list.every((role) => roles.includes(role as StepRole));
    const id = String(item.id ?? "");
    const quantify = item.quantify as { basis?: string; unit?: string; minutesLow?: number; minutesHigh?: number } | undefined;
    const sources = (item.sources as Array<{ url?: string; title?: string }> ?? []).filter((source) => /^https:\/\/[^\s/]+\.[^\s]+$/.test(source.url ?? ""));
    const problem = !/^[a-z][a-z_]{2,30}$/.test(id) ? "id 不是小写下划线标识" : taken.has(id) ? `id「${id}」已存在`
      : roles.length < 2 ? "角色少于 2 个" : !within(item.requires) || !within(item.endsWith) || !within(item.agentRoles) ? "规则引用了不在角色中的步骤"
      : !Array.isArray(item.firstBefore) || !(item.firstBefore as unknown[]).every((pair) => Array.isArray(pair) && pair.length === 2 && within(pair)) ? "先后规则不成对或越界"
      : !quantify?.basis || !quantify.unit || !(Number(quantify.minutesLow) > 0) || !(Number(quantify.minutesHigh) >= Number(quantify.minutesLow)) ? "规模公式不完整"
      : !String(item.label ?? "").trim() || !String(item.acceptance ?? "").trim() || !String(item.tickHint ?? "").trim() ? "缺名称、验收标准或刻度写法"
      : (item.basedOnTaskIds as string[] ?? []).filter((taskId) => tasks.has(taskId)).length < 2 ? "依据的本人任务少于 2 个"
      : !sources.length ? "没有可核对的公开来源" : "";
    if (problem) { dropped.push(`${id || "（无 id）"}：${problem}`); continue; }
    taken.add(id);
    kept.push({ id, label: String(item.label).trim().slice(0, 40),
      primitives: (item.primitives as string[] ?? []).filter((key): key is StructurePrimitive => key in STRUCTURE_PRIMITIVES),
      roles, requires: item.requires as StepRole[], firstBefore: item.firstBefore as Array<[StepRole, StepRole]>,
      ...(Array.isArray(item.endsWith) && item.endsWith.length ? { endsWith: item.endsWith as StepRole[] } : {}),
      proportions: Object.fromEntries((item.proportions as Array<{ role: string; share: number }> ?? [])
        .filter((entry) => roles.includes(entry.role as StepRole) && entry.share > 0).map((entry) => [entry.role, entry.share])),
      quantify: { basis: quantify!.basis!, unit: quantify!.unit!, minutesPerUnit: [Number(quantify!.minutesLow), Number(quantify!.minutesHigh)] },
      acceptance: String(item.acceptance).trim().slice(0, 200), tickHint: String(item.tickHint).trim().slice(0, 120), agentRoles: item.agentRoles as StepRole[],
      ...(item.recurring ? { recurring: true } : {}),
      basedOnTaskIds: (item.basedOnTaskIds as string[]).filter((taskId) => tasks.has(taskId)),
      sources: sources.map((source) => ({ url: source.url!, title: String(source.title ?? "").slice(0, 200) })), why: String(item.why ?? "").slice(0, 400) });
  }
  return { kept, dropped };
}

/** What the step planner is shown of each archetype: enough to choose and to follow its rules, nothing it would copy blindly. */
export function archetypeBrief(archetype: Archetype) {
  return { id: archetype.id, label: archetype.label, primitives: archetype.primitives, roles: archetype.roles,
    requires: archetype.requires, firstBefore: archetype.firstBefore, endsWith: archetype.endsWith ?? [],
    proportions: archetype.proportions, quantify: archetype.quantify, acceptance: archetype.acceptance,
    tickHint: archetype.tickHint, agentRoles: archetype.agentRoles, recurring: Boolean(archetype.recurring) };
}

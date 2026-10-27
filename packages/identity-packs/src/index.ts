export type IdentityPack = {
  id: string;
  label: string;
  kind: "identity" | "capacity";
  masterClock: boolean;
  workflowTemplates: string[];
  evidencePolicy: "tiered" | "telemetry";
  /** What the weekly web research on this line is about. Absent means "external opportunities". */
  diligenceTopic?: "opportunities" | "positioning" | "literature" | "tracking_framework" | "evidence_summary";
  /** The life domain this line covers (`DOMAIN_PACKS`), which brings its interview checklist, templates, research topic and records. */
  domain?: LineDomain;
  /** Research on this line may never contain a buy or sell call or a price target (the investment line, and any wealth line). */
  noTradeCalls?: boolean;
  durationPriors: Record<string, { p25Minutes: number; p50Minutes: number; p85Minutes: number }>;
  /** The line's colour, a key of `LINE_PALETTE`. The built-in lines use their own key (their colours live in the stylesheet). */
  color?: string;
  /** The line's long-term goal: an abstract description of who the person is becoming on this line (not a dated outcome). */
  goal?: string;
  /**
   * Long-term goals, each 「成为 ___ 的 <身份>」 — a line can have several; `goal` is the first. Descriptive identity goals that are
   * never "done" (Gollwitzer's identity goals; the top of Carver & Scheier's hierarchy), above milestones (an achieved state) and tasks
   * (an action).
   */
  goals?: string[];
  /**
   * The attributes `goals[0]` was composed from, in the order chosen (「成为 A 的、B 的<身份>」, decided 2026-10-10). Absent for a goal
   * written as a whole sentence and not split yet; `goals[0]` stays the composed sentence so its readers need not know about parts.
   */
  goalParts?: string[];
  /** A hard constraint (at most two lines): its fixed schedule is the immovable frame, its deadlines come first, and it shapes the hours. */
  hard?: boolean;
  /** Priority for the next 12–24 months (1 = the base line); absent = parallel with the other unranked lines. */
  rank?: number;
};

const commonPriors = {
  preparation: { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 },
  review: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
  deep_work: { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 }
};

export function defaultIdentityPacks(): IdentityPack[] {
  return [
    {
      id: "research",
      label: "研究者",
      kind: "identity",
      masterClock: true,
      workflowTemplates: ["paper-reading", "experiment-prep", "meeting-prep", "research-writing"],
      evidencePolicy: "tiered",
      diligenceTopic: "literature",
      durationPriors: commonPriors
    },
    {
      id: "startup",
      label: "创业者",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["public-prospect-research", "outreach-draft", "milestone-review"],
      evidencePolicy: "tiered",
      diligenceTopic: "opportunities",
      durationPriors: commonPriors
    },
    {
      id: "media",
      label: "创作者",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["evidence-to-topic", "script-package", "content-ops-job"],
      evidencePolicy: "tiered",
      diligenceTopic: "positioning",
      durationPriors: commonPriors
    },
    {
      id: "investment",
      label: "投资者",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["pre-market-brief", "midday-check", "close-review"],
      evidencePolicy: "tiered",
      diligenceTopic: "tracking_framework",
      noTradeCalls: true,
      durationPriors: commonPriors
    },
    {
      id: "health",
      label: "健康容量",
      kind: "capacity",
      masterClock: false,
      workflowTemplates: ["training-window", "meal-prep", "minimum-recovery"],
      evidencePolicy: "telemetry",
      durationPriors: {
        preparation: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
        review: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15 }
      }
    }
  ];
}

/**
 * The person's own lines (decided 2026-10-08): stored in the ledger under `lines.v1`, so a line can be added, renamed or given a goal.
 * Absent means an account from before lines were editable, which keeps the four built-in ones. A new account starts with none and
 * gets its lines from onboarding. The capacity pack (health) is not a line and is always there.
 */
export const LINE_SETTING = "lines.v1";
export type LineSpec = { id: string; label: string; color: string; goal: string; createdAt: string; archived?: boolean;
  goals?: string[]; goalParts?: string[]; hard?: boolean; rank?: number; domain?: LineDomain };
/** At most this many lines may be hard constraints. */
export const MAX_HARD_LINES = 2;

/**
 * Life domains a line may cover (the lite edition, decided 2026-10-19; docs/domain-lines.md). Not a mode: any line may carry one, at
 * most one live line per domain. A domain line is an ordinary identity line (goals, milestones, tasks on the calendar); what the domain
 * adds is a fixed interview checklist, its own fact slots, milestone templates, a research topic with its red lines, and record kinds.
 * Health as a domain line is separate from the `health` capacity pack, which keeps feeding only the energy model.
 */
export const LINE_DOMAINS = ["wellness", "wealth"] as const;
export type LineDomain = (typeof LINE_DOMAINS)[number];
export const isLineDomain = (value: unknown): value is LineDomain => (LINE_DOMAINS as readonly unknown[]).includes(value);

export type DomainPack = {
  id: LineDomain;
  /** The domain's name (健康 / 财富) and the identity noun a new line of it takes (renameable). */
  label: string; noun: string;
  /** The fixed id a new line of this domain takes when free, and its default colour (a `LINE_PALETTE` key). */
  lineId: string; color: string;
  workflowTemplates: string[];
  diligenceTopic: NonNullable<IdentityPack["diligenceTopic"]>;
  noTradeCalls: boolean;
  /** What the interview gathers for this line, in the order asked; the dialogue asks these instead of improvising. */
  interviewGuide: string[];
  /** The fact slots the extraction writes for this line (snake_case), so later plans read the same names. */
  slots: Array<{ slot: string; meaning: string }>;
  /** Adjectives the long-term goal picker may offer when the person's own words support them. */
  attributeHints: string[];
  /** Kinds of record (`domain_records.kind`) this domain keeps. */
  recordKinds: string[];
};

export const DOMAIN_PACKS: Record<LineDomain, DomainPack> = {
  wellness: {
    id: "wellness", label: "健康", noun: "健康管理者", lineId: "line-wellness", color: "olive",
    workflowTemplates: ["workout-session", "meal-prep", "weekly-check-in"],
    diligenceTopic: "evidence_summary", noTradeCalls: false,
    // The guide and the slot meanings are read by the interview models, not shown.
    /* i18n-ignore-start */
    interviewGuide: [
      "现在每周运动几次、做什么、通常在哪个时段",
      "睡眠：通常几点睡几点起，规律不规律",
      "饮食：三餐是否规律、外食频率、最想改的一点",
      "12–24 个月想达到的一个可量化目标（体重、5 公里用时、每周运动次数、体检指标），以及现在的数值",
      "伤病、禁忌或医生的限制",
      "在用的手表、手环、体重秤或健康 App（决定能否自动记录）"
    ],
    slots: [
      { slot: "health_exercise_freq", meaning: "每周运动次数" }, { slot: "health_exercise_kinds", meaning: "运动项目与时段" },
      { slot: "health_sleep", meaning: "作息与睡眠时长" }, { slot: "health_diet", meaning: "饮食模式与想改的一点" },
      { slot: "health_goal_metric", meaning: "可量化目标及其指标" }, { slot: "health_baseline", meaning: "目标指标的现值" },
      { slot: "health_limits", meaning: "伤病、禁忌与医嘱限制" }, { slot: "health_devices", meaning: "在用的设备与健康 App" }
    ],
    /* i18n-ignore-end */
    attributeHints: ["规律", "有耐力", "睡眠充足", "饮食清淡", "体能好", "精力充沛"],
    recordKinds: ["workout", "weight", "meal", "metric"]
  },
  wealth: {
    id: "wealth", label: "财富", noun: "理财者", lineId: "line-wealth", color: "teal",
    workflowTemplates: ["monthly-review", "budget-check", "learning-note"],
    diligenceTopic: "tracking_framework", noTradeCalls: true,
    /* i18n-ignore-start */
    interviewGuide: [
      "眼下最重要的一个财务目标：建应急金、还债、提高储蓄率、一笔大额支出、学投资常识",
      "收入稳不稳定，大致每月收入与支出的范围",
      "现有的应急金大约够几个月的支出",
      "有没有要还的债（类型与大致金额）",
      "现在怎样记账（App、表格、不记），平时主要用哪些支付方式和银行（决定能否自动记账）",
      "投资只问想学什么、不碰什么；不问持仓细节，不给买卖建议"
    ],
    slots: [
      { slot: "wealth_primary_goal", meaning: "首要财务目标" }, { slot: "wealth_income_stable", meaning: "收入是否稳定" },
      { slot: "wealth_income_monthly", meaning: "月收入范围" }, { slot: "wealth_spend_monthly", meaning: "月支出范围" },
      { slot: "wealth_emergency_months", meaning: "应急金可覆盖的月数" }, { slot: "wealth_debts", meaning: "负债类型与金额" },
      { slot: "wealth_tracking_now", meaning: "现在的记账方式" }, { slot: "wealth_payment_channels", meaning: "常用支付方式与银行" },
      { slot: "wealth_invest_learning", meaning: "想学的投资知识与不碰的东西" }
    ],
    /* i18n-ignore-end */
    attributeHints: ["稳健", "有储蓄纪律", "财务清醒", "零负债", "有安全垫"],
    recordKinds: ["income", "expense"]
  }
};

/**
 * Line colours, each readable as text at 7:1 on white (light) and on the dark background (dark). The built-in four keep the colours
 * the stylesheet gives them; a new line takes the first free one.
 */
export const LINE_PALETTE: Record<string, { light: string; dark: string }> = {
  research: { light: "#0A5198", dark: "#6CB2FF" }, startup: { light: "#8C3709", dark: "#FF9B5C" },
  media: { light: "#792E9C", dark: "#D79BFF" }, investment: { light: "#085E3A", dark: "#5FE3AE" },
  teal: { light: "#005B66", dark: "#4FD8E6" }, crimson: { light: "#8E1B3A", dark: "#FF8FAA" },
  olive: { light: "#4A5200", dark: "#C9D85A" }, indigo: { light: "#3730A3", dark: "#A5B4FC" },
  brown: { light: "#6B3A12", dark: "#E0A877" }, slate: { light: "#334155", dark: "#B6C2D4" }
};
export const BUILT_IN_LINES = new Set(["research", "startup", "media", "investment"]);

export function readLineSpecs(read: (key: string) => string | undefined): LineSpec[] | undefined {
  const raw = read(LINE_SETTING);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as LineSpec[];
    return Array.isArray(parsed) ? parsed.filter((line) => line && typeof line.id === "string" && typeof line.label === "string") : [];
  } catch { return []; }
}

/** The packs a workspace works with: its own lines (or the built-in four, for an account from before), plus the capacity pack. */
export function identityPacksFor(read: (key: string) => string | undefined, options: { includeArchived?: boolean } = {}): IdentityPack[] {
  const defaults = defaultIdentityPacks();
  const specs = readLineSpecs(read);
  const capacity = defaults.filter((pack) => pack.kind === "capacity");
  if (!specs) return defaults.map((pack) => pack.kind === "identity" ? { ...pack, color: pack.id } : pack);
  const lines = specs.filter((line) => options.includeArchived || !line.archived).map((line): IdentityPack => {
    const builtIn = defaults.find((pack) => pack.id === line.id && pack.kind === "identity");
    const domain = isLineDomain(line.domain) ? DOMAIN_PACKS[line.domain] : undefined;
    // A domain brings its own templates, research topic and red line; a built-in line given a domain (投资者 tagged 财富) keeps its own
    // templates and topic and gains the domain's red line.
    const base: IdentityPack = builtIn ?? { id: line.id, label: line.label, kind: "identity", masterClock: false, workflowTemplates: domain?.workflowTemplates ?? [],
      evidencePolicy: "tiered", diligenceTopic: domain?.diligenceTopic ?? "opportunities", durationPriors: commonPriors };
    return { ...base, ...(domain ? { domain: domain.id, ...(domain.noTradeCalls || base.noTradeCalls ? { noTradeCalls: true } : {}) } : {}),
      label: line.label, color: line.color,
      goals: line.goals?.length ? line.goals : line.goal ? [line.goal] : [], goal: line.goals?.[0] ?? line.goal,
      ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}),
      ...(line.hard ? { hard: true } : {}), ...(line.rank ? { rank: line.rank } : {}) };
  });
  // Deadline-tier priority (the master clock) goes to the hard-constraint lines; with none, to the base line; with neither, to nobody in
  // particular — lines nobody ranked run in parallel. An account that never edited its lines keeps the built-in clock (research).
  const clocked = lines.some((line) => line.hard) ? (line: IdentityPack) => Boolean(line.hard)
    : lines.some((line) => line.rank === 1) ? (line: IdentityPack) => line.rank === 1 : () => false;
  for (const [index, line] of lines.entries()) lines[index] = { ...line, masterClock: clocked(line) };
  return [...lines, ...capacity];
}

/**
 * What the lite edition calls the line for the one thing with a fixed schedule (the owner's decision of 2026-10-20). A line is named for
 * a person, because its long-term goal is composed as 「成为 A 的<line>」: the typed 「上班」 made 「成为互联网运营的上班」. So 上班 → 职场人,
 * 上学 → 学生, 自由职业 → 自由职业者; a text that already names a person is kept; anything else is kept as typed with `certain: false`, and
 * the opening card asks the person to name it.
 */
const ACTIVITY_NOUNS: Array<[RegExp, string]> = [
  [/自由职业|接单|freelanc/i, "自由职业者"],
  [/实习/, "实习生"],
  [/上班|坐班|打工|工作|职场|通勤|上下班/, "职场人"],
  [/上学|读书|念书|上课|求学|读研|读博|在读|学业/, "学生"],
  [/带娃|带孩子|育儿|接送孩子|照顾孩子|陪娃/, "家长"],
  [/照顾老人|照护|陪护|照顾家人/, "照护者"],
  // Said in English, named in English (an English workspace names its lines in English).
  [/\bintern(ship)?\b/i, "Intern"],
  [/\b(work|working|job|office|commut\w*)\b/i, "Professional"],
  [/\b(school|study|studying|classes|college|university|degree)\b/i, "Student"],
  [/\b(kids?|children|childcare|parenting)\b/i, "Parent"],
  [/\b(caregiving|caring for|elder ?care)\b/i, "Caregiver"]
];
const PERSON_NOUN = /(人|者|生|员|师|家|手|工|长|客|主|官|匠|士|族|妈|爸)$/;
export function lineNounFor(text: string): { noun: string; certain: boolean } {
  const said = text.trim().slice(0, 20);
  if (!said) return { noun: "", certain: false };
  if (PERSON_NOUN.test(said)) return { noun: said, certain: true };
  const known = ACTIVITY_NOUNS.find(([pattern]) => pattern.test(said));
  return known ? { noun: known[1], certain: true } : { noun: said, certain: false };
}

/** A new line's id from its name: `line-` and a short stable slug, never one of the built-in ids. */
export function newLineId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const ascii = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
  const base = `line-${ascii || "x"}`;
  let id = base, n = 2;
  while (used.has(id) || BUILT_IN_LINES.has(id)) id = `${base}-${n++}`;
  return id;
}

/** What the interview is told about a domain line: what to ask, the fact slots to record it under, and adjectives the goal may use. */
export type DomainGuide = { lineId: string; label: string; domain: string; ask: string[]; slots: string[]; attributeHints: string[] };
export function domainGuides(lines: Array<{ id: string; label: string; domain?: LineDomain | undefined }>): DomainGuide[] {
  return lines.flatMap((line) => {
    if (!isLineDomain(line.domain)) return [];
    const pack = DOMAIN_PACKS[line.domain];
    return [{ lineId: line.id, label: line.label, domain: pack.label, ask: pack.interviewGuide,
      slots: pack.slots.map((item) => `${item.slot}：${item.meaning}`), attributeHints: pack.attributeHints }];
  });
}

/** The live line already covering a domain, if any: a workspace keeps at most one per domain. */
export function lineForDomain(lines: Array<Pick<LineSpec, "id" | "domain" | "archived">>, domain: LineDomain) {
  return lines.find((line) => !line.archived && line.domain === domain);
}

/** A new domain line's id: the domain's own fixed id while it is free, else one made from the name like any other line. */
export function domainLineId(domain: LineDomain, label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  return used.has(DOMAIN_PACKS[domain].lineId) ? newLineId(label, used) : DOMAIN_PACKS[domain].lineId;
}

/** The first palette colour no live line uses. */
export function freeLineColor(lines: Array<{ color: string; archived?: boolean }>): string {
  const used = new Set(lines.filter((line) => !line.archived).map((line) => line.color));
  return Object.keys(LINE_PALETTE).find((key) => !used.has(key)) ?? "slate";
}

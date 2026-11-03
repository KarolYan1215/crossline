import {
  REPORT_SECTION_LABEL, SCHWARTZ_VALUES, TYPE_AXES, portraitType,
  type EnergyRhythm, type PortraitReport, type ProfileClaim
} from "@crossline/core";
import type { Locale, Translate } from "./i18n";
import type { StartSummary } from "./start-confirm";

/**
 * The portrait as a file an outside AI agent reads (docs/profile-and-agent-kit.md §七, the smallest form of P2's download): who the person
 * is, how they work and how to work with them. Pure: the route gathers the input (`loadAgentKitInput` in lib/portrait.ts) and every string
 * leaves through `scrub`, so no address, path, token, internal id or code reaches the file whatever a model or the person wrote.
 */
export type AgentKitInput = {
  at: string; locale: Locale;
  summary: Pick<StartSummary, "lines" | "hours" | "fixed">;
  /** Already redacted (`redactPortrait`), or null before one is written. */
  report: PortraitReport | null;
  rhythm: EnergyRhythm;
  /** `exportableClaims`: public and agent level, none the person rejected. */
  claims: Array<ProfileClaim & { confirmed?: boolean }>;
  preferences: string[];
  lineRules: Array<{ line: string; rules: Array<{ kind: "play" | "preference" | "redline"; text: string }> }>;
};

export type AgentKitClaim = { section: string; statement: string; basis: string; confirmed: boolean };
export type AgentKit = {
  generatedAt: string; notice: string;
  collaboration: { claims: AgentKitClaim[]; lineRules: Array<{ line: string; rules: Array<{ kind: string; text: string }> }>; preferences: string[] };
  lines: Array<{ name: string; fixedSchedule: boolean; description: string; goal: string; projects: Array<{ name: string; deadline: string }> }>;
  week: { hours: number; basis: string; assumed: boolean; windows: string[]; fixed: string[] };
  type: { name: string; quote: string; group: string; summary: string;
    axes: Array<{ dimension: string; left: string; right: string; score: number; leaning: string; percent: number; evidence: string }> } | null;
  values: Array<{ name: string; means: string; score: number; evidence: string }>;
  energy: { bestHours: string; usualSleep: string; sleepAssumed: boolean; midSleepFreeDays: string; socialJetlagHours: number | null;
    summary: string; flow: string[]; charges: string[]; drains: string[] };
  portrait: { tagline: string; text: string; keywords: string[]; workView: string; lifeView: string; trueNorth: string } | null;
  claims: AgentKitClaim[];
};

/* i18n-ignore-start */
const SCRUB: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ""],
  [/\b(?:sk|ghp|gho|xox[bpa]|AKIA)[-_]?[A-Za-z0-9_-]{8,}/g, ""],
  [/https?:\/\/\S+/g, ""],
  [/[A-Za-z]:\\[^\s，。；、）)]+/g, ""],
  [/(?<![\w./])\/(?:[\w.-]+\/)+[\w.-]*/g, ""],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ""],
  // Internal ids such as `pref-…`, `agent-97846949-1`, `doc-6`, `v2s3`, and codes such as `MILESTONE_NO_MARGIN`.
  [/\b[a-z]+(?:-[a-z]+)*-[0-9a-z]*\d[0-9a-z]*(?:-[0-9a-z]+)*\b/g, ""],
  [/\bv\d+s\d+\b/g, ""],
  [/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g, ""],
  [/[ \t]{2,}/g, " "]
];
/* i18n-ignore-end */
export const scrub = (text: string) => SCRUB.reduce((out, [pattern, to]) => out.replace(pattern, to), text).trim();
const deep = <T,>(value: T): T => (typeof value === "string" ? scrub(value) : Array.isArray(value) ? value.map(deep)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value) as T;

const clock = (hours: number) => { const m = ((Math.round(hours * 60) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

export function buildAgentKit(input: AgentKitInput, t: Translate): AgentKit {
  const basisOf = (claim: ProfileClaim) => claim.kind === "measured" ? t("卡片作答") : claim.kind === "self_reported" ? t("本人所说")
    : claim.kind === "observed" ? t("使用记录") : t("推断");
  const claim = (item: AgentKitInput["claims"][number]): AgentKitClaim => ({ section: t(REPORT_SECTION_LABEL[item.section]), statement: item.statement,
    basis: basisOf(item), confirmed: Boolean(item.confirmed) });
  const report = input.report;
  const type = report ? portraitType(report, input.locale) : null;
  const assumed = input.summary.hours.source !== "saved";
  const basis = { saved: t("本人设定"), interview: t("访谈中提议，本人未改"), stated_hours: t("按本人所说的每周总时长推算"), default: t("默认值") }[input.summary.hours.source];
  const kind = { play: t("打法"), preference: t("偏好"), redline: t("红线") };
  const chronotype = input.rhythm.chronotype;
  return deep({
    generatedAt: input.at.slice(0, 10),
    notice: t("基于访谈和使用记录的推断，不是标准化心理测验。标为「推断」的条目本人未逐条确认；不得用于招聘、录取或教育评估。"),
    collaboration: {
      claims: input.claims.filter((item) => item.section === "collaboration").map(claim),
      lineRules: input.lineRules.filter((line) => line.rules.length).map((line) => ({ line: line.line, rules: line.rules.map((rule) => ({ kind: kind[rule.kind], text: rule.text })) })),
      preferences: input.preferences
    },
    lines: input.summary.lines.map((line) => ({ name: line.label, fixedSchedule: line.hard, description: line.description, goal: line.goal,
      projects: line.projects.map((project) => ({ name: project.name, deadline: project.deadline })) })),
    week: { hours: input.summary.hours.weekly, basis, assumed, windows: input.summary.hours.windows, fixed: input.summary.fixed.items },
    type: type ? { name: type.name, quote: type.quote, group: type.group.name, summary: type.summary,
      axes: type.axes.map((axis) => ({ dimension: t(TYPE_AXES.find((item) => item.id === axis.id)!.name), left: axis.left, right: axis.right,
        score: axis.score, leaning: axis.label, percent: axis.percent, evidence: axis.evidence })) } : null,
    values: [...(report?.compass.values ?? [])].sort((a, b) => b.score - a.score).map((value) => ({ name: t(value.name),
      means: t(SCHWARTZ_VALUES.find((item) => item.name === value.name)?.means ?? ""), score: value.score, evidence: value.evidence })),
    energy: { bestHours: `${clock(input.rhythm.peak.start)}–${clock(input.rhythm.peak.end)}`,
      usualSleep: `${clock(input.rhythm.sleep.from)}–${clock(input.rhythm.sleep.to)}`, sleepAssumed: input.rhythm.nights === 0,
      midSleepFreeDays: chronotype ? clock(chronotype.msfSc ?? chronotype.msf) : "", socialJetlagHours: chronotype ? Math.round(chronotype.sjl * 10) / 10 : null,
      summary: report?.energy.summary ?? "", flow: report?.energy.flow ?? [],
      charges: (report?.energy.map ?? []).filter((item) => item.charge === "charge").map((item) => item.activity),
      drains: (report?.energy.map ?? []).filter((item) => item.charge === "drain").map((item) => item.activity) },
    portrait: report ? { tagline: report.cover.tagline ?? "", text: report.cover.portrait, keywords: report.cover.keywords,
      workView: report.compass.workView, lifeView: report.compass.lifeView, trueNorth: report.compass.trueNorth } : null,
    claims: input.claims.filter((item) => item.section !== "collaboration").map(claim)
  });
}

/** The same as Markdown written for an agent to read, e.g. pasted into AGENTS.md, CLAUDE.md or custom instructions. */
export function agentKitMarkdown(kit: AgentKit, t: Translate): string {
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);
  const bullets = (items: string[]) => items.filter(Boolean).forEach((item) => add(`- ${item}`));
  const tag = (item: AgentKitClaim) => item.confirmed ? t("本人已确认") : item.basis;
  add(t("# 本人画像：给 AI agent 的协作说明"), "", `> ${kit.notice}`, `> ${t("生成于 {{date}}，由 Crossline 导出。", { date: kit.generatedAt })}`, "");

  add(t("## 和此人协作"), "");
  bullets(kit.collaboration.claims.map((item) => t("{{text}}（{{tag}}）", { text: item.statement, tag: tag(item) })));
  for (const line of kit.collaboration.lineRules) {
    add("", t("### 在「{{line}}」上的做法（本人的规则，优先于通用惯例；红线不可越过）", { line: line.line }), "");
    bullets(line.rules.map((rule) => t("{{kind}}：{{text}}", { kind: rule.kind, text: rule.text })));
  }
  if (kit.collaboration.preferences.length) { add("", t("### 本人纠正过、确认过的偏好"), ""); bullets(kit.collaboration.preferences); }
  if (!kit.collaboration.claims.length && !kit.collaboration.lineRules.length && !kit.collaboration.preferences.length) add(t("（尚无记录）"));

  add("", t("## 主线与当前项目"), "");
  for (const line of kit.lines) {
    add(line.fixedSchedule ? t("### {{name}}（有固定日程）", { name: line.name }) : `### ${line.name}`, "");
    if (line.description) add(line.description, "");
    if (line.goal) add(t("长期目标：{{goal}}", { goal: line.goal }), "");
    bullets(line.projects.map((project) => project.deadline ? t("{{name}}，截止：{{deadline}}", project) : t("{{name}}，未记录截止", project)));
    add("");
  }

  add(t("## 每周时间"), "", t("约 {{hours}} 小时/周（{{basis}}{{assumed}}）", { hours: kit.week.hours, basis: kit.week.basis, assumed: kit.week.assumed ? t("，假设") : "" }));
  bullets(kit.week.windows);
  if (kit.week.fixed.length) { add("", t("固定安排："), ""); bullets(kit.week.fixed); }

  if (kit.type) {
    add("", t("## 思维模式类型（趣味层）"), "", t("**{{name}}**（{{group}}）：{{quote}}", kit.type), "");
    if (kit.type.summary) add(kit.type.summary, "");
    bullets(kit.type.axes.map((axis) => t("{{dimension}}：{{left}} 0 — 100 {{right}}，得分 {{score}}，偏向{{leaning}}。{{evidence}}", axis)));
  }
  if (kit.values.length) {
    add("", t("## 价值排序（施瓦茨十项，0–100）"), "");
    bullets(kit.values.map((value) => t("{{name}}（{{means}}）：{{score}}。{{evidence}}", value)));
  }

  add("", t("## 精力节律"), "");
  bullets([t("最佳时段：{{hours}}", { hours: kit.energy.bestHours }),
    t("通常睡眠：{{hours}}{{assumed}}", { hours: kit.energy.usualSleep, assumed: kit.energy.sleepAssumed ? t("（假设，尚无睡眠记录）") : "" }),
    kit.energy.midSleepFreeDays ? t("休息日睡眠中点 {{clock}}，社交时差 {{hours}} 小时", { clock: kit.energy.midSleepFreeDays, hours: kit.energy.socialJetlagHours }) : "",
    kit.energy.charges.length ? t("充电：{{items}}", { items: kit.energy.charges.join("、") }) : "",
    kit.energy.drains.length ? t("耗电：{{items}}", { items: kit.energy.drains.join("、") }) : ""]);
  if (kit.energy.summary) add("", kit.energy.summary);
  if (kit.energy.flow.length) { add("", t("进入心流的条件："), ""); bullets(kit.energy.flow); }

  if (kit.portrait) {
    add("", t("## 画像"), "");
    if (kit.portrait.tagline) add(`**${kit.portrait.tagline}**`, "");
    add(kit.portrait.text, "");
    if (kit.portrait.keywords.length) add(t("关键词：{{items}}", { items: kit.portrait.keywords.join("、") }), "");
    bullets([kit.portrait.workView ? t("工作观：{{text}}", { text: kit.portrait.workView }) : "",
      kit.portrait.lifeView ? t("生活观：{{text}}", { text: kit.portrait.lifeView }) : "",
      kit.portrait.trueNorth ? t("真北：{{text}}", { text: kit.portrait.trueNorth }) : ""]);
  }
  if (kit.claims.length) {
    add("", t("## 其他画像条目"), "");
    bullets(kit.claims.map((item) => t("{{section}}：{{text}}（{{tag}}）", { section: item.section, text: item.statement, tag: tag(item) })));
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

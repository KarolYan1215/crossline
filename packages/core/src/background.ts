/**
 * The kinds of background work, as the person sees and pauses them (docs/review-2026-10-13.md §6.4, the background tasks page): each with
 * the Skills it runs, so its last run and its week's tokens are read from the model usage record. The assistant's pause is its own
 * long-standing setting (`agent.paused`); the rest are listed in `background.paused`.
 */
export type BackgroundKind = "intake" | "planning" | "tutorials" | "assistant" | "research" | "nightly";

export const BACKGROUND_KINDS: ReadonlyArray<{ kind: BackgroundKind; label: string; explained: string; skills: readonly string[] }> = [
  { kind: "intake", label: "收集分析、日历与邮件归类", explained: "整理写下的事，给日历、文件夹归主线，整理新邮件并起草回复，整理手机录音",
    skills: ["crossline-automation-stripper", "crossline-calendar-classifier", "crossline-folder-classifier", "crossline-mail-triage", "crossline-mail-reply-drafter",
      "crossline-recording-digest"] },
  { kind: "planning", label: "拆分与步骤规划", explained: "从里程碑倒推任务、给任务排步骤、复核与改写",
    skills: ["crossline-goal-backplanner", "crossline-step-planner", "crossline-validation-reviewer", "crossline-progress-judge", "crossline-goal-splitter",
      "crossline-task-titler", "crossline-archetype-curator", "crossline-milestone-architect", "crossline-milestone-risk-reviewer", "crossline-artifact-planner", "crossline-background-facts"] },
  { kind: "tutorials", label: "任务教程", explained: "只为 3 天内开工、要学新内容或新方法的任务写教程，只查确实需要外部资料的步骤；整理、确认、沟通类任务按步骤做，不写教程",
    skills: ["crossline-manualbook-designer", "crossline-material-researcher", "crossline-material-writer"] },
  { kind: "assistant", label: "助手代办与自动化", explained: "助手代为完成准备类杂事，按时或按触发条件跑本人设的自动化", skills: ["crossline-agent", "crossline-agent-tools", "crossline-automation-designer"] },
  { kind: "research", label: "主线调研", explained: "每周为每条主线上网调研一次，并对照研究复核精力时段建议", skills: ["crossline-due-diligence", "crossline-energy-advisor"] },
  { kind: "nightly", label: "夜间飞轮", explained: "夜里找跨主线可以互相促进的地方", skills: ["crossline-flywheel-scout"] }
];

export const BACKGROUND_PAUSED = "background.paused";

/** The kinds the person paused (the assistant excluded: it has its own setting). Anything unreadable reads as nothing paused. */
export function pausedKinds(raw: string | undefined | null): Set<BackgroundKind> {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is BackgroundKind => BACKGROUND_KINDS.some((entry) => entry.kind === item)) : []);
  } catch { return new Set(); }
}

/** Which kind a Skill's runs belong to, by its name (`crossline:crossline-step-planner` or `crossline-step-planner`). */
export function backgroundKindOf(skill: string): BackgroundKind | undefined {
  const name = skill.split(":").at(-1) ?? skill;
  return BACKGROUND_KINDS.find((entry) => entry.skills.includes(name))?.kind;
}

/**
 * The kinds of background work, as the person sees and pauses them (docs/review-2026-10-13.md §6.4, the background tasks page): each with
 * the Skills it runs, so its last run and its week's tokens are read from the model usage record. The assistant's pause is its own
 * long-standing setting (`agent.paused`); the rest are listed in `background.paused`.
 */
export type BackgroundKind = "intake" | "planning" | "tutorials" | "assistant" | "research" | "nightly";

export const BACKGROUND_KINDS: ReadonlyArray<{ kind: BackgroundKind; label: string; explained: string; skills: readonly string[] }> = [
  { kind: "intake", label: "收集分析与日历归类", explained: "把写下的事整理成任务，把日历事件和授权的文件夹归到主线，整理手机录音",
    skills: ["crossline-automation-stripper", "crossline-calendar-classifier", "crossline-folder-classifier", "crossline-recording-digest"] },
  { kind: "planning", label: "拆分与步骤规划", explained: "从里程碑倒推任务、给任务排步骤、复核与改写",
    skills: ["crossline-goal-backplanner", "crossline-step-planner", "crossline-validation-reviewer", "crossline-progress-judge", "crossline-goal-splitter",
      "crossline-task-titler", "crossline-archetype-curator", "crossline-milestone-architect", "crossline-milestone-risk-reviewer", "crossline-artifact-planner", "crossline-background-facts"] },
  { kind: "tutorials", label: "任务教程", explained: "为 48 小时内要做的任务查资料、写教程",
    skills: ["crossline-manualbook-designer", "crossline-material-researcher", "crossline-material-writer"] },
  { kind: "assistant", label: "助手代办", explained: "助手代为完成准备类杂事", skills: ["crossline-agent"] },
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

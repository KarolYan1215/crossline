/**
 * The system's suggested importance (0–100) for a milestone, before the person moves the slider, and the four reasons behind it
 * (decided 2026-10-07): how much of the person's stated week its line takes (their long-term priority), how many cross-line relations
 * run through it (flywheel centrality), what is at stake (a graded course, a deadline inside eight weeks), and how the person has
 * moved this line's sliders before (history). Each reason is a number of points, so the hover can show where the value came from.
 */
export type ImportanceBasis = { key: "priority" | "centrality" | "consequence" | "history"; label: string; points: number; detail: string };
export type ImportancePreset = { weight: number; basis: ImportanceBasis[] };

export type ImportanceInput = {
  /** Hours a week the person said each line takes (`weekly_hours` facts), by line. */
  weeklyHoursByLine: Record<string, number>;
  line: string;
  /** Cross-line relations touching this milestone, and the most any milestone has. */
  relations: number; maxRelations: number;
  graded: boolean;
  /** Days to the milestone's deadline, when it has one. */
  daysToDeadline: number | null;
  /** The person's past adjustments on this line: their weight minus the preset at the time. */
  pastAdjustments: number[];
};

const BASE = 20;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function presetImportance(input: ImportanceInput): ImportancePreset {
  const hours = Object.values(input.weeklyHoursByLine).filter((value) => value > 0);
  const own = input.weeklyHoursByLine[input.line] ?? 0;
  const top = Math.max(0, ...hours);
  const priority = top ? Math.round((own / top) * 30) : 15;
  const centrality = input.maxRelations ? Math.round((input.relations / input.maxRelations) * 15) : 0;
  const deadlinePoints = input.daysToDeadline === null ? 0 : input.daysToDeadline <= 14 ? 15 : input.daysToDeadline <= 56 ? 10 : 4;
  const consequence = (input.graded ? 10 : 0) + deadlinePoints;
  const history = input.pastAdjustments.length
    ? Math.round(clamp(input.pastAdjustments.reduce((sum, value) => sum + value, 0) / input.pastAdjustments.length, -15, 15)) : 0;
  const basis: ImportanceBasis[] = [
    { key: "priority", label: "长期目标优先级", points: priority,
      detail: top ? `该主线每周 ${own} 小时，最多的主线 ${top} 小时` : "画像中没有每周投入时长，取中间值" },
    { key: "centrality", label: "飞轮中心度", points: centrality, detail: `${input.relations} 条跨主线关系` },
    { key: "consequence", label: "后果规模", points: consequence,
      detail: [input.graded ? "计入课程成绩" : "", input.daysToDeadline === null ? "无截止日" : `距截止 ${input.daysToDeadline} 天`].filter(Boolean).join("，") },
    { key: "history", label: "本人历史调整", points: history,
      detail: input.pastAdjustments.length ? `该主线 ${input.pastAdjustments.length} 次调整的平均偏移` : "尚无调整记录" }
  ];
  return { weight: Math.round(clamp(BASE + priority + centrality + consequence + history, 0, 100)), basis };
}

/** A stated weekly figure such as 「每周约 12 小时」 or 「10–20 小时」 as hours (the upper end of a range); course numbers are ignored. */
export function hoursFromText(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:[–\-~至到]\s*(\d+(?:\.\d+)?))?\s*(?:个)?\s*(?:小时|hours?\b|h\b)/i.exec(text);
  if (!match) return null;
  return Number(match[2] ?? match[1]);
}

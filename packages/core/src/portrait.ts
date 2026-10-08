/**
 * The portrait report written when the interview ends (decided 2026-10-08), by Skill `crossline-portrait-writer`, as structured data so the
 * page can draw it: the first half is the person's portrait and insight, meant to be shared (cover, the real problem, compass and energy,
 * the lines as a flywheel with their long-term goals, the say–do gap and the anchor); the second half is specific guidance, kept private
 * (insights with advice, and what the app does next). `sensitive` lists spans to hide in the shared version (names, institutions, course
 * codes, amounts).
 */
export type PortraitReport = {
  cover: { portrait: string; coreConflict: string; keywords: string[] };
  problem: { statement: string; gravity: string[]; designable: string[]; reframes: Array<{ fallacy: string; reframe: string }> };
  compass: { workView: string; lifeView: string; consistency: string; trueNorth: string };
  energy: { summary: string; map: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain" }>; flow: string[] };
  lines: { allocation: string; items: Array<{ lineId: string; description: string; goals: string[]; feeds: Array<{ toLineId: string; how: string }> }> };
  gap: { says: string; does: string; reading: string; anchor: string; realWant: string; reframe: string };
  insights: Array<{ insight: string; advice: string; solves: string; priority: "high" | "medium" | "low" }>;
  sensitive: string[];
};

const text = (max: number) => ({ type: "string", minLength: 0, maxLength: max }) as const;
const list = (max: number, length: number) => ({ type: "array", maxItems: max, items: { type: "string", minLength: 1, maxLength: length } }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const PORTRAIT_SCHEMA = object({
  cover: object({ portrait: text(200), coreConflict: text(300), keywords: list(6, 12) }),
  problem: object({ statement: text(500), gravity: list(6, 200), designable: list(6, 200),
    reframes: { type: "array", maxItems: 4, items: object({ fallacy: text(200), reframe: text(300) }) } }),
  compass: object({ workView: text(500), lifeView: text(500), consistency: text(500), trueNorth: text(200) }),
  energy: object({ summary: text(400), flow: list(6, 200), map: { type: "array", maxItems: 12, items: object({ activity: text(60),
    skill: { type: "string", enum: ["high", "low"] }, love: { type: "string", enum: ["high", "low"] }, charge: { type: "string", enum: ["charge", "drain"] } }) } }),
  lines: object({ allocation: text(500), items: { type: "array", maxItems: 8, items: object({ lineId: text(60), description: text(500), goals: list(6, 120),
    feeds: { type: "array", maxItems: 6, items: object({ toLineId: text(60), how: text(200) }) } }) } }),
  gap: object({ says: text(300), does: text(300), reading: text(400), anchor: text(300), realWant: text(300), reframe: text(300) }),
  insights: { type: "array", maxItems: 6, items: object({ insight: text(300), advice: text(400), solves: text(200), priority: { type: "string", enum: ["high", "medium", "low"] } }) },
  sensitive: list(30, 60)
});

/** Keeps what can be drawn: lines and their feeds must be the person's lines; sensitive spans must occur in the text they would hide. */
export function validatePortrait(value: unknown, lineIds: string[]): PortraitReport {
  const report = value as PortraitReport | undefined;
  if (!report?.cover || !report.problem || !report.compass || !report.energy || !report.lines || !report.gap || !Array.isArray(report.insights)) throw new Error("PORTRAIT_SCHEMA_INVALID");
  if (!report.cover.portrait.trim()) throw new Error("PORTRAIT_EMPTY");
  const known = new Set(lineIds);
  const unknown = report.lines.items.find((item) => !known.has(item.lineId));
  if (unknown) {
    const error = new Error("PORTRAIT_LINE_UNKNOWN");
    (error as Error & { detail?: string }).detail = `主线「${unknown.lineId}」不存在；可用：${lineIds.join("、")}`;
    throw error;
  }
  const items = report.lines.items.map((item) => ({ ...item, feeds: item.feeds.filter((feed) => known.has(feed.toLineId) && feed.toLineId !== item.lineId) }));
  const body = JSON.stringify({ ...report, sensitive: [] });
  return { ...report, lines: { ...report.lines, items }, sensitive: [...new Set(report.sensitive.map((span) => span.trim()).filter((span) => span.length >= 2 && body.includes(span)))] };
}

/** The shared version: every sensitive span replaced with a block, the private second half left out by the page. */
export function redactPortrait(report: PortraitReport): PortraitReport {
  const spans = [...report.sensitive].sort((a, b) => b.length - a.length);
  const hide = (text: string) => spans.reduce((out, span) => out.split(span).join("▇".repeat(Math.min(6, Math.max(2, span.length)))), text);
  const walk = (value: unknown): unknown => typeof value === "string" ? hide(value) : Array.isArray(value) ? value.map(walk)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "lineId" || key === "toLineId" ? item : walk(item)])) : value;
  return { ...(walk({ ...report, sensitive: [] }) as PortraitReport), sensitive: report.sensitive };
}

/**
 * The portrait report written when the interview ends (decided 2026-10-08), by Skill `crossline-portrait-writer`, as structured data so the
 * page can draw it: the first half is the person's portrait and insight, meant to be shared (cover, the real problem, compass and energy,
 * the lines as a flywheel with their long-term goals, the say–do gap and the anchor); the second half is specific guidance, kept private
 * (insights with advice, and what the app does next). `sensitive` lists spans to hide in the shared version (names, institutions, course
 * codes, amounts).
 */
export type PortraitReport = {
  /** `archetype`: a two-to-six character name for who they are now (「跨界建造者」), `tagline` its one line — the share card's title. */
  cover: { portrait: string; coreConflict: string; keywords: string[]; archetype?: string; tagline?: string };
  problem: { statement: string; gravity: string[]; designable: string[]; reframes: Array<{ fallacy: string; reframe: string }> };
  /** `values`: what their work and life serve, each scored 0–100 from the evidence (drawn as a radar), with the evidence in a phrase. */
  compass: { workView: string; lifeView: string; consistency: string; trueNorth: string; values?: Array<{ name: string; score: number; evidence: string }> };
  /** `skillScore`/`loveScore` 0–100 place an activity on the energy plane; `skill`/`love` are the same reading as high or low. */
  energy: { summary: string; map: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain"; skillScore?: number; loveScore?: number }>; flow: string[] };
  /** `share` — of their attention now; `targetShare` — what the portrait suggests; both percentages, each set summing to about 100. */
  lines: { allocation: string; items: Array<{ lineId: string; description: string; goals: string[]; feeds: Array<{ toLineId: string; how: string }>; share?: number; targetShare?: number }> };
  /** `pairs`: dimensions on which what they say and what they do part, each 0–100 (drawn as a dumbbell chart). */
  gap: { says: string; does: string; reading: string; anchor: string; realWant: string; reframe: string; pairs?: Array<{ dimension: string; says: number; does: number }> };
  /** `impact`/`effort` 1–5 place each piece of advice on the matrix. */
  insights: Array<{ insight: string; advice: string; solves: string; priority: "high" | "medium" | "low"; impact?: number; effort?: number }>;
  /**
   * One visual metaphor per illustrated section, for the illustrator (`portraitImageBriefs`): objects and scenes only — no names, no
   * text, no faces — so an image can be shared without saying who it is about.
   */
  imagery?: { cover: string; problem: string; compass: string; energy: string; lines: string };
  sensitive: string[];
};

const text = (max: number) => ({ type: "string", minLength: 0, maxLength: max }) as const;
const list = (max: number, length: number) => ({ type: "array", maxItems: max, items: { type: "string", minLength: 1, maxLength: length } }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const score = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max }) as const;
export const PORTRAIT_SCHEMA = object({
  cover: object({ portrait: text(200), coreConflict: text(300), keywords: list(6, 12), archetype: text(12), tagline: text(40) }),
  problem: object({ statement: text(500), gravity: list(6, 200), designable: list(6, 200),
    reframes: { type: "array", maxItems: 4, items: object({ fallacy: text(200), reframe: text(300) }) } }),
  compass: object({ workView: text(500), lifeView: text(500), consistency: text(500), trueNorth: text(200),
    values: { type: "array", maxItems: 8, items: object({ name: text(8), score: score(0, 100), evidence: text(80) }) } }),
  energy: object({ summary: text(400), flow: list(6, 200), map: { type: "array", maxItems: 12, items: object({ activity: text(60),
    skill: { type: "string", enum: ["high", "low"] }, love: { type: "string", enum: ["high", "low"] }, charge: { type: "string", enum: ["charge", "drain"] },
    skillScore: score(0, 100), loveScore: score(0, 100) }) } }),
  lines: object({ allocation: text(500), items: { type: "array", maxItems: 8, items: object({ lineId: text(60), description: text(500), goals: list(6, 120),
    feeds: { type: "array", maxItems: 6, items: object({ toLineId: text(60), how: text(200) }) }, share: score(0, 100), targetShare: score(0, 100) }) } }),
  gap: object({ says: text(300), does: text(300), reading: text(400), anchor: text(300), realWant: text(300), reframe: text(300),
    pairs: { type: "array", maxItems: 5, items: object({ dimension: text(12), says: score(0, 100), does: score(0, 100) }) } }),
  insights: { type: "array", maxItems: 6, items: object({ insight: text(300), advice: text(400), solves: text(200), priority: { type: "string", enum: ["high", "medium", "low"] },
    impact: score(1, 5), effort: score(1, 5) }) },
  imagery: object({ cover: text(200), problem: text(200), compass: text(200), energy: text(200), lines: text(200) }),
  sensitive: list(30, 60)
});

/** The sections that get an illustration, in the order they are drawn. */
export const PORTRAIT_IMAGE_SLOTS = ["cover", "problem", "compass", "energy", "lines"] as const;
export type PortraitImageSlot = (typeof PORTRAIT_IMAGE_SLOTS)[number];

/**
 * The house style every portrait illustration shares, so a set reads as one report and a shared card is recognisable: editorial flat
 * illustration in the app's five line colours on warm paper, symbolic objects, much empty space — and never text, letters, faces or
 * logos, which is also what keeps a shared image from saying who it is about.
 */
export const PORTRAIT_IMAGE_STYLE = [
  "Editorial conceptual illustration, flat shapes with subtle risograph grain, warm off-white paper background (#FAF7F0).",
  "Limited palette: deep blue #0A5198, burnt orange #8C3709, plum #792E9C, forest green #085E3A, ochre #664E00, near-black #0A0A0A.",
  "Symbolic objects and landscapes only, calm composition, generous negative space, one clear focal point.",
  "Absolutely no text, letters, numbers, signatures, logos, faces or recognisable people."
].join(" ");

const ASPECT: Record<PortraitImageSlot, string> = { cover: "portrait orientation 4:5", problem: "landscape 3:2", compass: "square 1:1", energy: "landscape 3:2", lines: "square 1:1" };

/**
 * One prompt per illustrated section: the house style, the model's metaphor (redacted like the shared version), and the frame. The
 * colours a line owns are named so the lines' illustration matches the network drawn beside it.
 */
export function portraitImageBriefs(report: PortraitReport, lines: Array<{ id: string; label: string }>): Array<{ slot: PortraitImageSlot; prompt: string }> {
  if (!report.imagery) return [];
  const shared = redactPortrait(report).imagery!;
  const palette: Record<string, string> = { research: "deep blue", startup: "burnt orange", media: "plum", investment: "forest green", health: "ochre" };
  const colours = lines.map((line) => palette[line.id]).filter(Boolean).join(", ");
  return PORTRAIT_IMAGE_SLOTS.filter((slot) => shared[slot].trim()).map((slot) => ({ slot,
    prompt: `${PORTRAIT_IMAGE_STYLE} Scene: ${shared[slot].trim()}${slot === "lines" && colours ? ` Use one colour per strand: ${colours}.` : ""} Frame: ${ASPECT[slot]}.` }));
}

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
  // Shares are read as parts of a whole: two sets that do not add up to about 100 are scaled to it, rather than refused over arithmetic.
  for (const key of ["share", "targetShare"] as const) {
    const total = items.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    if (total > 0 && Math.abs(total - 100) > 5) for (const item of items) item[key] = Math.round(((item[key] ?? 0) / total) * 100);
  }
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

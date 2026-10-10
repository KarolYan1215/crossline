export type IdentityPack = {
  id: string;
  label: string;
  kind: "identity" | "capacity";
  masterClock: boolean;
  workflowTemplates: string[];
  evidencePolicy: "tiered" | "telemetry";
  /** What the weekly web research on this line is about. Absent means "external opportunities". */
  diligenceTopic?: "opportunities" | "positioning" | "literature" | "tracking_framework";
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
  goals?: string[]; goalParts?: string[]; hard?: boolean; rank?: number };
/** At most this many lines may be hard constraints. */
export const MAX_HARD_LINES = 2;

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
    return { ...(builtIn ?? { id: line.id, kind: "identity" as const, masterClock: false, workflowTemplates: [], evidencePolicy: "tiered" as const,
      diligenceTopic: "opportunities" as const, durationPriors: commonPriors }), label: line.label, color: line.color,
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

/** A new line's id from its name: `line-` and a short stable slug, never one of the built-in ids. */
export function newLineId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const ascii = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
  const base = `line-${ascii || "x"}`;
  let id = base, n = 2;
  while (used.has(id) || BUILT_IN_LINES.has(id)) id = `${base}-${n++}`;
  return id;
}

/** The first palette colour no live line uses. */
export function freeLineColor(lines: Array<{ color: string; archived?: boolean }>): string {
  const used = new Set(lines.filter((line) => !line.archived).map((line) => line.color));
  return Object.keys(LINE_PALETTE).find((key) => !used.has(key)) ?? "slate";
}

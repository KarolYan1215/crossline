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
      label: "科研",
      kind: "identity",
      masterClock: true,
      workflowTemplates: ["paper-reading", "experiment-prep", "meeting-prep", "research-writing"],
      evidencePolicy: "tiered",
      diligenceTopic: "literature",
      durationPriors: commonPriors
    },
    {
      id: "startup",
      label: "创业",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["public-prospect-research", "outreach-draft", "milestone-review"],
      evidencePolicy: "tiered",
      diligenceTopic: "opportunities",
      durationPriors: commonPriors
    },
    {
      id: "media",
      label: "自媒体",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["evidence-to-topic", "script-package", "content-ops-job"],
      evidencePolicy: "tiered",
      diligenceTopic: "positioning",
      durationPriors: commonPriors
    },
    {
      id: "investment",
      label: "投资",
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
export type LineSpec = { id: string; label: string; color: string; goal: string; createdAt: string; archived?: boolean };

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
      diligenceTopic: "opportunities" as const, durationPriors: commonPriors }), label: line.label, color: line.color, goal: line.goal };
  });
  // The master clock (deadline-tier priority) goes to the first line when none of the built-in ones carries it.
  if (lines.length && !lines.some((line) => line.masterClock)) lines[0] = { ...lines[0]!, masterClock: true };
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

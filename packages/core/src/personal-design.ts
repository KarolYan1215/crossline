/**
 * The person's own design of Crossline (2026-11-04, the owner: 「允许用户直接通过 crossline 系统修复 crossline 系统自身设计，保存为用户个人设计」).
 * Two layers, both per account, both changed only with a preview, the person's confirmation and an undo:
 * - knobs: a whitelist of the rules' own thresholds, each with its range (`DESIGN_KNOBS`); a value outside it is refused, never clamped;
 * - Skill notes: the person's own words for one Skill, appended to that Skill's input as this run's note. The Skill's safety rules and
 *   output contract still win: the note is read as a preference, never as permission.
 * Ordinary settings (shares, quiet hours, consents) stay in `SETTING_CATALOG`; this is only what used to be a constant in the code.
 */
export const PERSONAL_DESIGN_SETTING = "design.personal";

export type DesignKnob = { label: string; unit: string; min: number; max: number; default: number; consequence: string };

export const DESIGN_KNOBS = {
  "tutorial.leadDays": { label: "教程提前天数", unit: "天", min: 1, max: 14, default: 3, consequence: "工作开始前这么多天才写教程；越早写，越可能因计划变动重写" },
  "assistant.prepHours": { label: "助手提前准备", unit: "小时", min: 6, max: 168, default: 48, consequence: "助手在本人步骤开始前这么久内才开始准备材料" },
  "results.reviewDays": { label: "助手成果代为采纳", unit: "天", min: 1, max: 30, default: 1, consequence: "自检通过、不涉及对外的助手成果，这么多天无人审就由系统采纳" },
  "stepQuestions.perTask": { label: "每个重要任务问本人的问题数", unit: "个", min: 0, max: 6, default: 2, consequence: "超出的问题按假设处理，任务页上可改" },
} as const satisfies Record<string, DesignKnob>;

export type DesignKnobId = keyof typeof DESIGN_KNOBS;
export const DESIGN_KNOB_IDS = Object.keys(DESIGN_KNOBS) as DesignKnobId[];
export const isDesignKnob = (id: unknown): id is DesignKnobId => typeof id === "string" && id in DESIGN_KNOBS;

/** The longest note a person may give one Skill. */
export const DESIGN_NOTE_MAX = 600;

export type DesignEntry = { kind: "knob"; id: DesignKnobId; value: number; at: string; paused?: boolean }
  | { kind: "skill"; id: string; text: string; at: string; paused?: boolean };
export type PersonalDesign = { entries: DesignEntry[] };

export function readDesign(raw: unknown): PersonalDesign {
  const entries = (raw as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries)) return { entries: [] };
  return { entries: entries.filter((entry): entry is DesignEntry => {
    const item = entry as Partial<DesignEntry> | undefined;
    if (item?.kind === "knob") return isDesignKnob(item.id) && designValueProblem(item.id, item.value) === undefined;
    return item?.kind === "skill" && typeof item.id === "string" && typeof item.text === "string" && item.text.trim().length > 0;
  }) };
}

export function designValueProblem(id: DesignKnobId, value: unknown): string | undefined {
  const knob: DesignKnob = DESIGN_KNOBS[id];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return "DESIGN_VALUE_NOT_INTEGER";
  return value < knob.min || value > knob.max ? "DESIGN_VALUE_OUT_OF_RANGE" : undefined;
}

/** The value a rule uses: the person's, unless paused, else the built-in default. */
export function knobValue(design: PersonalDesign, id: DesignKnobId): number {
  const entry = design.entries.find((item) => item.kind === "knob" && item.id === id && !item.paused);
  return entry?.kind === "knob" ? entry.value : DESIGN_KNOBS[id].default;
}

/** The person's live note for one Skill (matched with or without the `crossline:` plugin prefix). */
export function skillNote(design: PersonalDesign, skill: string): string | undefined {
  const bare = skill.replace(/^crossline:/, "");
  const entry = design.entries.find((item) => item.kind === "skill" && item.id.replace(/^crossline:/, "") === bare && !item.paused);
  return entry?.kind === "skill" ? entry.text : undefined;
}

/** Replaces the entry of the same kind and id (or removes it with `undefined`); the rest are kept in order. */
export function withEntry(design: PersonalDesign, kind: DesignEntry["kind"], id: string, entry: DesignEntry | undefined): PersonalDesign {
  const rest = design.entries.filter((item) => !(item.kind === kind && item.id === id));
  return { entries: entry ? [...rest, entry] : rest };
}

/** How the note is put to the model: after the run's own note, framed so it cannot loosen the Skill's rules. */
export const designNoteText = (note: string): string =>
  `The person's own standing instructions for this step (a preference; the Skill's safety rules and output format still win):\n${note.trim()}`;

export type DesignArgs = { kind: "knob" | "skill"; id: string; value: string };

/** Why a proposed change cannot stand; empty when it can. An empty value resets the knob or removes the note. */
/** `skills`: the Skill ids a note may be written for (the web passes every non-test Skill of `SKILL_NEEDS`). */
export function designProblem(args: DesignArgs, skills: ReadonlySet<string>): string {
  if (args.kind === "knob") {
    if (!isDesignKnob(args.id)) return `DESIGN_KNOB_UNKNOWN：可调的只有 ${DESIGN_KNOB_IDS.join("、")}`; // i18n-ignore: model repair text
    if (!args.value.trim()) return "";
    const knob: DesignKnob = DESIGN_KNOBS[args.id];
    return designValueProblem(args.id, Number(args.value)) ? `DESIGN_VALUE_OUT_OF_RANGE：须为 ${knob.min}–${knob.max} 的整数` : ""; // i18n-ignore: model repair text
  }
  if (!skills.has(args.id.replace(/^crossline:/, ""))) return `DESIGN_SKILL_UNKNOWN：${args.id}`;
  return args.value.length > DESIGN_NOTE_MAX ? `DESIGN_NOTE_TOO_LONG：最多 ${DESIGN_NOTE_MAX} 字` : ""; // i18n-ignore: model repair text
}

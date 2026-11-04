import "server-only";
import {
  DESIGN_KNOBS, DESIGN_KNOB_IDS, PERSONAL_DESIGN_SETTING, SKILL_NEEDS, designProblem, isDesignKnob, knobValue, readDesign, withEntry,
  type AccessContext, type DesignArgs, type DesignKnobId, type PersonalDesign
} from "@crossline/core";
import { getStore } from "./crossline";
import { tOf } from "./locale";
import type { SettingView } from "./setting-change";

/**
 * 「我的设计」 (packages/core/src/personal-design.ts): the person changes a rule's threshold or adds standing words to a Skill, from the input
 * box (`design.change`, confirmed on its card, undoable like every action) or from Settings → 我的设计 (edit, pause, reset).
 */

export { designProblem };

const designOf = (ctx: AccessContext): PersonalDesign => {
  const raw = getStore().getSetting(ctx.workspaceId, PERSONAL_DESIGN_SETTING);
  try { return readDesign(raw ? JSON.parse(raw) : undefined); } catch { return { entries: [] }; }
};
const save = (ctx: AccessContext, design: PersonalDesign) => getStore().setSetting(ctx.workspaceId, PERSONAL_DESIGN_SETTING, JSON.stringify(design));

/** Skills a person may write a note for: every Skill a real run uses (test-only ones are not offered). */
export const noteSkills = (): Array<{ id: string; label: string }> =>
  Object.entries(SKILL_NEEDS).filter(([, needs]) => !needs.testOnly).map(([id, needs]) => ({ id, label: needs.label }));
export const noteSkillIds = (): Set<string> => new Set(noteSkills().map((skill) => skill.id));

/** The card's 当前 → 改成 for a design change. */
export function describeDesignChange(ctx: AccessContext, args: DesignArgs): SettingView {
  const t = tOf(ctx);
  const design = designOf(ctx);
  if (args.kind === "knob" && isDesignKnob(args.id)) {
    const knob = DESIGN_KNOBS[args.id];
    const to = args.value.trim() ? Number(args.value) : knob.default;
    return { label: t("我的设计：{{label}}", { label: t(knob.label) }), from: `${knobValue(design, args.id)} ${t(knob.unit)}`, to: `${to} ${t(knob.unit)}`, consequence: t(knob.consequence) };
  }
  const skill = noteSkills().find((item) => item.id === args.id.replace(/^crossline:/, ""));
  const current = design.entries.find((entry) => entry.kind === "skill" && entry.id === skill?.id);
  return { label: t("我的设计：给「{{skill}}」的本人指令", { skill: t(skill?.label ?? args.id) }), from: current?.kind === "skill" ? current.text : t("未设置"),
    to: args.value.trim() || t("删除"), consequence: t("之后这一环节的每次运行都会读到这段话；安全规则和输出格式不受它影响") };
}

export function applyDesignChange(ctx: AccessContext, args: DesignArgs): { ok: true; message: string; href: string } | { ok: false; code: string; message: string } {
  const t = tOf(ctx);
  const problem = designProblem(args, noteSkillIds());
  if (problem) return { ok: false, code: problem.split("：")[0]!, message: problem };
  const at = new Date().toISOString();
  const id = args.kind === "skill" ? args.id.replace(/^crossline:/, "") : args.id;
  const value = args.value.trim();
  const entry = !value ? undefined : args.kind === "knob" ? { kind: "knob" as const, id: id as DesignKnobId, value: Number(value), at } : { kind: "skill" as const, id, text: value, at };
  save(ctx, withEntry(designOf(ctx), args.kind, id, entry));
  return { ok: true, message: value ? t("已保存到我的设计") : t("已恢复为系统默认"), href: "/settings#design" };
}

/** Pausing keeps the entry; the rule goes back to its default until it is resumed. */
export function pauseDesignEntry(ctx: AccessContext, kind: "knob" | "skill", id: string, paused: boolean): { ok: boolean } {
  const design = designOf(ctx);
  const entry = design.entries.find((item) => item.kind === kind && item.id === id);
  if (!entry) return { ok: false };
  const next = { ...entry };
  if (paused) next.paused = true; else delete next.paused;
  save(ctx, withEntry(design, kind, id, next));
  return { ok: true };
}

/** Settings → 我的设计: every knob with its value and range, every note, and the Skills a note can be added to. */
export function designView(ctx: AccessContext) {
  const design = designOf(ctx);
  const skills = noteSkills();
  return {
    knobs: DESIGN_KNOB_IDS.map((id) => {
      const entry = design.entries.find((item) => item.kind === "knob" && item.id === id);
      return { id, ...DESIGN_KNOBS[id], value: entry?.kind === "knob" ? entry.value : DESIGN_KNOBS[id].default, changed: Boolean(entry), paused: entry?.paused === true };
    }),
    notes: design.entries.flatMap((entry) => entry.kind === "skill"
      ? [{ id: entry.id, label: skills.find((skill) => skill.id === entry.id)?.label ?? entry.id, text: entry.text, paused: entry.paused === true, at: entry.at }] : []),
    skills,
  };
}
export type DesignView = ReturnType<typeof designView>;

/** For the input box's snapshot: what may be changed and what is set now (model context). */
// i18n-ignore-start: model context
export function designSnapshotLine(ctx: AccessContext): string {
  const view = designView(ctx);
  const knobs = view.knobs.map((knob) => `${knob.id}（${knob.label}，${knob.min}–${knob.max} ${knob.unit}，当前 ${knob.value}${knob.paused ? "，已暂停" : ""}）`).join("；");
  const notes = view.notes.length ? view.notes.map((note) => `${note.id}：「${note.text.slice(0, 60)}」`).join("；") : "无";
  return `我的设计（改系统本身的规则用 design.change；kind=knob 改阈值，kind=skill 给某环节加本人指令，value 留空即恢复默认）：可调阈值 ${knobs}。已有本人指令：${notes}。可加指令的环节 id：${view.skills.map((skill) => `${skill.id}=${skill.label}`).join("、")}`;
}
// i18n-ignore-end

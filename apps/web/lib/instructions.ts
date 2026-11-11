import "server-only";
import { INSTRUCTIONS_MAX, instructionsProblem, lineDiff, type AccessContext, type DiffLine } from "@crossline/core";
import { currentInstructionsOf, instructionVersionsOf, setInstructions } from "@crossline/db";
import { getStore } from "./crossline";
import { tOf } from "./locale";
import type { SettingView } from "./setting-change";

/**
 * 「给 Crossline 的话」 (packages/core/src/instructions.ts): edited in Settings → 我的设计 and through 小帮手's `instructions.set` card, both
 * shown as before/after and written only on 确认. Each version is an event in the ledger; a revert is a new version.
 */

export type InstructionsView = { max: number; current: { version: number; text: string };
  versions: Array<{ version: number; text: string; at: string; by: "person" | "assistant"; revertOf?: number }> };

export function instructionsView(ctx: AccessContext): InstructionsView {
  const store = getStore();
  return { max: INSTRUCTIONS_MAX, current: currentInstructionsOf(store, ctx.workspaceId), versions: instructionVersionsOf(store, ctx.workspaceId).reverse() };
}

/** The before/after of a change, as the card and the settings preview draw it. */
export function describeInstructionsChange(ctx: AccessContext, text: string): SettingView & { diff: DiffLine[] } {
  const t = tOf(ctx);
  const from = currentInstructionsOf(getStore(), ctx.workspaceId).text;
  const to = text.replace(/\r\n/g, "\n").trim();
  return { label: t("给 Crossline 的话"), from: from || t("未设置"), to: to || t("清空"), diff: lineDiff(from, to),
    consequence: t("之后每个环节的每次运行都会读到这段话，作为你的偏好；安全边界和需要你确认的事不受它影响") };
}

/** Writes a new version (or, with `revertTo`, the text of that version again). Called inside `withUndo`, whose snapshot sees the version. */
export function applyInstructions(ctx: AccessContext, input: { text: string; by: "person" | "assistant" } | { revertTo: number }):
  { ok: true; message: string; href: string } | { ok: false; code: string; message: string } {
  const t = tOf(ctx);
  const store = getStore();
  let text: string, by: "person" | "assistant", revertOf: number | undefined;
  if ("revertTo" in input) {
    const old = instructionVersionsOf(store, ctx.workspaceId).find((item) => item.version === input.revertTo);
    if (!old && input.revertTo !== 0) return { ok: false, code: "INSTRUCTIONS_VERSION_NOT_FOUND", message: t("没有这个版本") };
    text = old?.text ?? ""; by = "person"; revertOf = input.revertTo;
  } else { text = input.text; by = input.by; }
  if (instructionsProblem(text.trim())) return { ok: false, code: "INSTRUCTIONS_TOO_LONG", message: t("最多 {{max}} 字", { max: INSTRUCTIONS_MAX }) };
  const result = setInstructions(store, { workspaceId: ctx.workspaceId, ownerId: ctx.principalId, text, by, ...(revertOf !== undefined ? { revertOf } : {}) });
  if (!result.changed) return { ok: false, code: "INSTRUCTIONS_UNCHANGED", message: t("和现在的内容一样，没有改动") };
  return { ok: true, message: revertOf !== undefined ? t("已恢复到第 {{version}} 版（记为第 {{now}} 版）", { version: revertOf, now: result.version })
    : t("已保存为第 {{version}} 版", { version: result.version }), href: "/settings#design" };
}

/** For the input box's snapshot: the words in force (model context). */
// i18n-ignore-start: model context
export function instructionsSnapshotLine(ctx: AccessContext): string {
  const current = currentInstructionsOf(getStore(), ctx.workspaceId);
  return `给 Crossline 的话（本人对整个系统的长期偏好，第 ${current.version} 版；改它用 instructions.set，text 为完整的新全文，最多 ${INSTRUCTIONS_MAX} 字，留空即清空；恢复旧版也用它，旧版全文用 get_instructions 查）：`
    + (current.text ? `「${current.text.slice(0, 300)}${current.text.length > 300 ? "…" : ""}」` : "未设置");
}
// i18n-ignore-end

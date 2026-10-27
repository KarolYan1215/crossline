import { randomUUID } from "node:crypto";
import { LINE_PROFILES_SETTING, attributeKey, attributeProblem, type StoredLineProfile } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { tOfWorkspace } from "./locale";

/**
 * One-time repair of the long-term goal chips a model proposed before the adjective rule (2026-10-19, the owner's 「长期目标是形容词，不要把
 * 动词之类的强行组合成形容词」; `attributeProblem`). Since then the interview's extraction and the goal splitter drop such candidates as
 * they are written, but `lines.profiles` kept the ones written earlier, and every 主线 card still offered 「把科研稀缺技术转化为现实影响」,
 * 「以真实技术链条和可复现证据工作」, 「外推知识边界」 as chips (the real account, 2026-10-21).
 *
 * Removed: a candidate the model proposed — read from a reply or a file (`reply-N`, `src-N`), or one of the old whole-sentence
 * suggestions cut into parts (`goal`, named by a `line.candidates_split` event) — that `attributeProblem` refuses. Kept: anything the
 * person chose or wrote (a part of the line's adopted goal, a split of their own adopted goal), and a line's list is never emptied.
 * Runs once per workspace (`repair.line-attributes.v1`), leaves a `repair.line_attributes` event naming what went, and records an undo
 * that puts the profiles back as they were.
 */
export const LINE_ATTRIBUTE_REPAIR = "repair.line-attributes.v1";
const LINE_SETTING = "lines.v1";

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T ?? fallback : fallback; } catch { return fallback; } };

export function repairLineAttributes(store: CrosslineStore, workspaceId: string, ownerId: string, now = new Date()): Record<string, string[]> | undefined {
  if (store.getSetting(workspaceId, LINE_ATTRIBUTE_REPAIR)) return undefined;
  const raw = store.getSetting(workspaceId, LINE_PROFILES_SETTING) ?? null;
  const profiles = parse<Record<string, StoredLineProfile>>(raw, {});
  const chosen = new Map(parse<Array<{ id: string; goalParts?: string[] }>>(store.getSetting(workspaceId, LINE_SETTING), [])
    .map((line) => [line.id, new Set((line.goalParts ?? []).map(attributeKey))]));
  const suggested = new Map<string, Set<string>>();
  for (const event of store.listEvents(workspaceId, { type: "line.candidates_split" })) {
    const set = suggested.get(event.entityId) ?? new Set<string>();
    for (const text of (event.payload as { attributes?: string[] }).attributes ?? []) set.add(attributeKey(text));
    suggested.set(event.entityId, set);
  }
  const removed: Record<string, string[]> = {};
  for (const [lineId, profile] of Object.entries(profiles)) {
    const list = profile?.attributes ?? [];
    const fromModel = (item: { text: string; sourceRef?: string }) => /^(reply|src)-\d+$/.test(item.sourceRef ?? "")
      || (item.sourceRef === "goal" && Boolean(suggested.get(lineId)?.has(attributeKey(item.text))));
    const drop = list.filter((item) => item && typeof item.text === "string" && fromModel(item) && !chosen.get(lineId)?.has(attributeKey(item.text))
      && Boolean(attributeProblem(item.text)));
    if (!drop.length || drop.length === list.length) continue;
    profiles[lineId] = { ...profile, attributes: list.filter((item) => !drop.includes(item)) };
    removed[lineId] = drop.map((item) => item.text);
  }
  store.setSetting(workspaceId, LINE_ATTRIBUTE_REPAIR, now.toISOString());
  if (!Object.keys(removed).length) return removed;
  store.setSetting(workspaceId, LINE_PROFILES_SETTING, JSON.stringify(profiles));
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `repair.line_attributes:${workspaceId}`, type: "repair.line_attributes", entityId: workspaceId,
    payload: { removed, at: now.toISOString() } });
  // The same shape the web's undo writes (`recordOp`), so 撤销 can put the chips back for a day.
  const id = `op-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const count = Object.values(removed).reduce((sum, list) => sum + list.length, 0);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `op.applied:${id}`, type: "op.applied", entityId: id,
    payload: { bySystem: true, label: tOfWorkspace(store, workspaceId)("去掉 {{count}} 个不是形容词的长期目标候选", { count }), inverse: { kind: "settings.restore", entries: [{ key: LINE_PROFILES_SETTING, value: raw }] } } });
  return removed;
}

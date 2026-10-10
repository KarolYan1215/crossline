import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARTIFACT_PLAN_SETTING, producedArtifacts, readArtifactPlan, usedArtifacts,
  type DerivedRelation, type RelationCheckOutcome, type StoredArtifactPlan
} from "@crossline/core";
import type { CrosslineStore, StoredMilestoneRelation, StoredSourceDocument, StoredWorkOrder } from "./index";

/**
 * The ledger side of artifact-first planning (docs/flywheel-and-views.md §5–§6): the stored plan, the relations derived from the
 * milestones' references, their approval with the downstream milestone, the check on their check day, and at task level the
 * produce → use dependency and the hand-off of the produced files.
 */

export function readStoredArtifactPlan(store: CrosslineStore, workspaceId: string): StoredArtifactPlan {
  return readArtifactPlan(store.getSetting(workspaceId, ARTIFACT_PLAN_SETTING));
}
export function saveStoredArtifactPlan(store: CrosslineStore, workspaceId: string, plan: StoredArtifactPlan): void {
  store.setSetting(workspaceId, ARTIFACT_PLAN_SETTING, JSON.stringify(plan));
}

const liveMilestones = (store: CrosslineStore, workspaceId: string) => store.listMilestones(workspaceId).filter((milestone) => milestone.status !== "archived");

/**
 * Stores what `deriveArtifactRelations` produced. A relation the person removed (archived) or the check refuted stays as it is — a
 * re-derivation never brings it back; an approved one keeps its approval and whatever was measured. A new relation is a candidate,
 * except when both ends are already approved: the downstream milestone's approval is what approves its incoming relations, and it has
 * been given.
 */
export function syncArtifactRelations(store: CrosslineStore, workspaceId: string, ownerId: string, derived: DerivedRelation[],
  at = new Date().toISOString()): { saved: string[]; skipped: string[] } {
  const approved = new Set(liveMilestones(store, workspaceId).filter((milestone) => milestone.status === "approved").map((milestone) => milestone.id));
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const relation of derived) {
    const existing = store.getMilestoneRelation(workspaceId, relation.id);
    if (existing && (existing.status === "archived" || existing.status === "refuted")) { skipped.push(relation.id); continue; }
    const status = existing?.status === "approved" || (approved.has(relation.fromMilestoneId) && approved.has(relation.toMilestoneId)) ? "approved" : "candidate";
    store.saveMilestoneRelation({
      id: relation.id, ownerId, workspaceId, fromMilestoneId: relation.fromMilestoneId, toMilestoneId: relation.toMilestoneId,
      kind: relation.kind, status,
      // What the relation rests on is the artifact plan itself, so it can be approved; nothing here makes it true — the check day does.
      evidence: existing?.evidence.length ? existing.evidence : [{ uri: `/milestones?open=${encodeURIComponent(relation.fromMilestoneId)}`,
        source: `产物计划 ${relation.artifactId}`, observedAt: at }],
      counterexample: existing?.counterexample ?? [], costMinutes: existing?.costMinutes ?? null, lastValidatedAt: existing?.lastValidatedAt ?? null,
      explanation: relation.explanation, refutedWhen: relation.refutedWhen, artifactId: relation.artifactId,
      transfer: { ...relation.transfer, measured: existing?.transfer?.measured ?? null }, checkOn: relation.checkOn, counterfactual: relation.counterfactual
    });
    saved.push(relation.id);
  }
  return { saved, skipped };
}

/**
 * After a re-derivation: a candidate artifact relation that was not derived again cannot be any more (its references or the plan
 * moved), and any other candidate whose end is gone (an archived or missing milestone) has nothing left to connect. Both are archived.
 * Approved and refuted relations are never touched, and nothing that was derived again is — redoing one line used to archive every
 * candidate that touched an old draft, and nothing connected them again.
 */
export function retireUnderivedRelations(store: CrosslineStore, workspaceId: string, derivedIds: ReadonlySet<string>): string[] {
  const live = new Set(liveMilestones(store, workspaceId).map((milestone) => milestone.id));
  const retired: string[] = [];
  for (const relation of store.listMilestoneRelations(workspaceId)) {
    if (relation.status !== "candidate" || derivedIds.has(relation.id)) continue;
    const endsGone = !live.has(relation.fromMilestoneId) || !live.has(relation.toMilestoneId);
    if (!endsGone && !relation.artifactId) continue;
    store.saveMilestoneRelation({ ...relation, status: "archived" });
    retired.push(relation.id);
  }
  return retired;
}

/**
 * A cross-line relation is approved together with its downstream milestone. One derived into a downstream milestone approved before
 * the relation existed is approved when its upstream milestone is (both decisions are then made).
 */
export function approveArtifactRelationsFor(store: CrosslineStore, workspaceId: string, ownerId: string, milestoneId: string): string[] {
  const approved = new Set(liveMilestones(store, workspaceId).filter((milestone) => milestone.status === "approved").map((milestone) => milestone.id));
  if (!approved.has(milestoneId)) return [];
  const ids = store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "candidate" && relation.artifactId
    && (relation.toMilestoneId === milestoneId || (relation.fromMilestoneId === milestoneId && approved.has(relation.toMilestoneId)))).map((relation) => relation.id);
  if (!ids.length) return [];
  const round = store.listEvents(workspaceId, { type: "milestone_relations.decided", entityId: ids[0]! }).length;
  return store.decideMilestoneRelations(workspaceId, ownerId, ids, "approved", `milestone_relations:with_milestone:${milestoneId}:${ids.join(",")}:${round}`).decided;
}

/** Undoing a downstream milestone's approval: the relations approved with it, not yet checked, are candidates again. */
export function withdrawArtifactRelationsFor(store: CrosslineStore, workspaceId: string, milestoneId: string): string[] {
  const checked = new Set(store.listEvents(workspaceId, { type: "milestone_relation.checked" }).map((event) => event.entityId));
  const withdrawn = store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "approved" && relation.artifactId
    && relation.toMilestoneId === milestoneId && !checked.has(relation.id));
  for (const relation of withdrawn) store.saveMilestoneRelation({ ...relation, status: "candidate" });
  return withdrawn.map((relation) => relation.id);
}

/**
 * The person takes one cross-line artifact off a draft (the draft list on 主线): the relation is archived, so no re-derivation brings it
 * back, and the refusal is remembered as a preference the next plans read.
 */
export function removeArtifactRelation(store: CrosslineStore, workspaceId: string, ownerId: string, relationId: string): { ok: true } | { ok: false; code: string } {
  const relation = store.getMilestoneRelation(workspaceId, relationId);
  if (!relation) return { ok: false, code: "RELATION_NOT_FOUND" };
  if (relation.status !== "candidate") return { ok: false, code: "RELATION_NOT_CANDIDATE" };
  store.saveMilestoneRelation({ ...relation, status: "archived" });
  const round = store.listEvents(workspaceId, { type: "milestone_relation.removed", entityId: relationId }).length;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `milestone_relation.removed:${relationId}:${round}`, type: "milestone_relation.removed",
    entityId: relationId, payload: { artifactId: relation.artifactId, fromMilestoneId: relation.fromMilestoneId, toMilestoneId: relation.toMilestoneId } });
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const from = milestones.get(relation.fromMilestoneId), to = milestones.get(relation.toMilestoneId);
  if (from && to) store.addPreference({ workspaceId, source: "relation_rejected", scope: from.identityId, weight: 1, refId: relationId,
    text: `不采用「${from.title}」供「${to.title}」的飞轮关系${relation.explanation ? `（${relation.explanation.slice(0, 80)}）` : ""}` });
  return { ok: true };
}

/**
 * The person's answer on a relation's check day. 「没有」 refutes it (the flywheel's one negative signal); 「兑现」 records the promised
 * amount as delivered unless a number is given; 「部分」 records the number given. Every answer is an event the fulfilment rate reads.
 */
export function recordRelationCheck(store: CrosslineStore, workspaceId: string, ownerId: string, relationId: string, outcome: RelationCheckOutcome,
  measured?: number, note = ""): { ok: true } | { ok: false; code: string } {
  const relation = store.getMilestoneRelation(workspaceId, relationId);
  if (!relation?.artifactId || !relation.transfer) return { ok: false, code: "RELATION_NOT_FOUND" };
  if (relation.status !== "approved") return { ok: false, code: "RELATION_NOT_APPROVED" };
  const kind = readStoredArtifactPlan(store, workspaceId).artifacts.find((artifact) => artifact.id === relation.artifactId)?.kind ?? "其他";
  const value = outcome === "fulfilled" ? measured ?? relation.transfer.expected : outcome === "partial" ? measured ?? null : 0;
  const at = new Date().toISOString();
  if (outcome === "none") {
    store.saveMilestoneRelation({ ...relation, transfer: { ...relation.transfer, measured: 0 } });
    store.refuteMilestoneRelation(workspaceId, relationId, note.trim() || `核对日（${relation.checkOn ?? "下游截止"}）未兑现`, `milestone_relation.check_refuted:${relationId}`);
  } else {
    store.saveMilestoneRelation({ ...relation, transfer: { ...relation.transfer, measured: value }, lastValidatedAt: at });
  }
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `milestone_relation.checked:${relationId}`, type: "milestone_relation.checked", entityId: relationId,
    payload: { outcome, measured: value, expected: relation.transfer.expected, unit: relation.transfer.unit, metric: relation.transfer.metric,
      artifactId: relation.artifactId, kind, note: note.trim().slice(0, 300) } });
  return { ok: true };
}

/** Every relation check answered so far, with the artifact kind it was about (for the fulfilment rate and the next plan's hint). */
export function relationChecks(store: CrosslineStore, workspaceId: string): Array<{ outcome: RelationCheckOutcome; kind: string; relationId: string; at: string }> {
  return store.listEvents(workspaceId, { type: "milestone_relation.checked" }).flatMap((event) => {
    const payload = event.payload as { outcome?: string; kind?: string };
    return payload.outcome === "fulfilled" || payload.outcome === "partial" || payload.outcome === "none"
      ? [{ outcome: payload.outcome, kind: String(payload.kind ?? "其他"), relationId: event.entityId, at: event.createdAt }] : [];
  });
}

/** Approved artifact relations whose check day has come and that nobody has answered for. */
export function relationsDueForCheck(store: CrosslineStore, workspaceId: string, today: string): StoredMilestoneRelation[] {
  const answered = new Set(store.listEvents(workspaceId, { type: "milestone_relation.checked" }).map((event) => event.entityId));
  // Both ends still live: a relation whose upstream draft was replaced by a redesign is answered by the relation derived from the new one.
  const live = new Set(liveMilestones(store, workspaceId).map((milestone) => milestone.id));
  return store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "approved" && relation.artifactId && relation.transfer
    && relation.checkOn && relation.checkOn <= today && !answered.has(relation.id) && live.has(relation.fromMilestoneId) && live.has(relation.toMilestoneId));
}

const CLOSED = new Set(["archived"]);

/**
 * At task level, a task that uses an artifact waits for the task that produces it: the producer's id goes into the user's `dependsOn`,
 * across lines, so the scheduler places the producer first. Idempotent; never makes two tasks wait for each other.
 */
export function linkArtifactWork(store: CrosslineStore, workspaceId: string): string[] {
  const orders = store.listWorkOrders(workspaceId).filter((order) => !CLOSED.has(order.state));
  const producers = new Map<string, string[]>();
  for (const order of orders) for (const artifact of producedArtifacts(order)) producers.set(artifact, [...(producers.get(artifact) ?? []), order.id]);
  const byId = new Map(orders.map((order) => [order.id, order]));
  const changed: string[] = [];
  for (const order of orders) {
    const uses = usedArtifacts(order);
    if (!uses.length) continue;
    const dependsOn = ((order.payload ?? {}) as { dependsOn?: string[] }).dependsOn ?? [];
    const add = uses.flatMap((artifact) => producers.get(artifact) ?? []).filter((id) => id !== order.id && !dependsOn.includes(id)
      && !(((byId.get(id)?.payload ?? {}) as { dependsOn?: string[] }).dependsOn ?? []).includes(order.id));
    if (!add.length) continue;
    store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), dependsOn: [...dependsOn, ...new Set(add)] } });
    changed.push(order.id);
  }
  return changed;
}

const DELIVERED = new Set(["evidence_review", "accepted"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".tsv", ".py", ".ts", ".js", ".tex", ".html", ".xml", ".yaml", ".yml"]);
const MEDIA: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const kindOf = (extension: string): StoredSourceDocument["kind"] => extension === ".pdf" ? "pdf" : extension === ".docx" ? "docx"
  : [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension) ? "image" : "text";
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * When a task that produces an artifact is delivered (handed in by the person, or by the assistant), the files it was delivered with
 * become materials of every task that uses the artifact: filed under the using task's project — which is how its plans and the
 * assistant find a task's files — noted on its record, and its steps re-planned when it has a plan. Once per (artifact, producer, user);
 * a user created later gets them when it is linked. A byproduct is the same thing at a small scale: its landing task uses the artifact
 * its main task produced.
 */
export function handOffArtifacts(store: CrosslineStore, workspaceId: string, producerId?: string): Array<{ artifactId: string; from: string; to: string; documentIds: string[] }> {
  const orders = store.listWorkOrders(workspaceId);
  const producers = orders.filter((order) => DELIVERED.has(order.state) && (!producerId || order.id === producerId) && producedArtifacts(order).length);
  if (!producers.length) return [];
  const claims = store.listEvidenceClaims(workspaceId).filter((claim) => claim.reviewStatus !== "rejected");
  const existing = store.listSourceDocuments(workspaceId);
  const handed: Array<{ artifactId: string; from: string; to: string; documentIds: string[] }> = [];
  for (const producer of producers) {
    const files = claims.filter((claim) => claim.workOrderId === producer.id && claim.uri.startsWith("file:"));
    for (const artifactId of producedArtifacts(producer)) {
      for (const user of orders.filter((order) => order.id !== producer.id && !["archived", "accepted"].includes(order.state) && usedArtifacts(order).includes(artifactId))) {
        const key = `artifact.handed_off:${artifactId}:${producer.id}:${user.id}`;
        if (store.listEvents(workspaceId, { type: "artifact.handed_off", entityId: user.id }).some((event) => event.idempotencyKey === key)) continue;
        const documentIds = files.flatMap((claim) => {
          const doc = handOffFile(store, workspaceId, producer, user, claim.uri, existing);
          return doc ? [doc.id] : [];
        });
        const names = files.map((claim) => path.basename(safePath(claim.uri) ?? claim.uri)).slice(0, 5).join("》《");
        store.appendEvent({ ownerId: user.ownerId, workspaceId, idempotencyKey: `task.note:handoff:${artifactId}:${producer.id}:${user.id}`, type: "task.note", entityId: user.id,
          payload: { text: `收到上游任务「${titleOf(producer)}」的产出${names ? `《${names}》` : ""}，已归入本任务的材料`, kind: "material", ...(documentIds[0] ? { documentId: documentIds[0] } : {}) } });
        if (documentIds.length && store.getStepPlan(workspaceId, user.id)) {
          store.appendEvent({ ownerId: user.ownerId, workspaceId, idempotencyKey: `task.steps_replan_requested:handoff:${artifactId}:${user.id}`, type: "task.steps_replan_requested",
            entityId: user.id, payload: { feedback: `上游产出已到（${names}），按其内容核对并调整步骤：已有的部分不再重复做` } });
        }
        store.appendEvent({ ownerId: user.ownerId, workspaceId, idempotencyKey: key, type: "artifact.handed_off", entityId: user.id,
          payload: { artifactId, from: producer.id, to: user.id, documentIds } });
        handed.push({ artifactId, from: producer.id, to: user.id, documentIds });
      }
    }
  }
  return handed;
}

const titleOf = (order: StoredWorkOrder) => String(((order.payload ?? {}) as { title?: string }).title || order.intent).slice(0, 60);
function safePath(uri: string): string | undefined { try { return fileURLToPath(uri); } catch { return undefined; } }

function handOffFile(store: CrosslineStore, workspaceId: string, producer: StoredWorkOrder, user: StoredWorkOrder, uri: string,
  existing: StoredSourceDocument[]): StoredSourceDocument | undefined {
  const file = safePath(uri);
  if (!file || !existsSync(file) || statSync(file).size > MAX_BYTES) return undefined;
  const content = readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  const contentHash = createHash("sha256").update(content).digest("hex");
  // A file already read elsewhere (an upload handed in as evidence) brings its text along; a text file is its own text.
  const known = existing.find((doc) => doc.sha256 === contentHash && doc.extractionStatus === "done");
  const text = TEXT_EXTENSIONS.has(extension) ? content.toString("utf8").slice(0, 200_000) : known?.extractedText ?? "";
  // Keyed per receiving task: one file may be filed under the producer's project and under each user's, and one row has one project.
  const sha256 = createHash("sha256").update(`handoff:${user.id}:`).update(content).digest("hex");
  const kind = kindOf(extension);
  // Copied into the data directory's `sources` folder under its content hash, as an upload is: the 「材料」 link opens only files there,
  // and an assistant's task folder is not one.
  let stored = uri;
  if (store.file !== ":memory:") {
    const root = path.resolve(path.dirname(store.file), "sources");
    const target = path.join(root, `${contentHash}.${{ pdf: "pdf", docx: "docx", image: "img", audio: "audio", text: "txt" }[kind]}`);
    mkdirSync(root, { recursive: true });
    if (!existsSync(target)) copyFileSync(file, target);
    stored = pathToFileURL(target).href;
  }
  return store.saveSourceDocument({ id: `handoff-${sha256.slice(0, 24)}`, ownerId: user.ownerId, workspaceId, ...(user.projectId ? { projectId: user.projectId } : {}),
    kind, fileName: path.basename(file), mediaType: MEDIA[extension] ?? "application/octet-stream", sha256, uri: stored,
    extractedText: text, extractionStatus: text ? "done" : "unsupported",
    ...(text ? {} : { extractionNote: `来自「${titleOf(producer)}」的产出，未提取文本` }), createdAt: new Date().toISOString() });
}

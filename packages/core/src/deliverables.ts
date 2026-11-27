/**
 * Deliverables found in the person's folders (docs/plans/attention-ledger-1120.md §7.2, batch 5, 2026-11-21). Acceptance is no longer a
 * step of the person's: pressing 完成 takes effect at once, and the system checks afterwards against the deliverable itself. A new file in
 * an authorized folder is read by the model against the open and recently finished tasks: it is a task's deliverable, evidence for one,
 * or unrelated, and against the task's done criteria it passes, falls short (`gap`) or cannot be read. Code checks only what the model
 * claims: the document and task ids exist, a pass or gap quotes the document verbatim.
 */

/** `{ [folderId]: projectId }`: where a project's results are put (one project per folder; a project may have several). */
export const RESULT_FOLDERS_SETTING = "projects.resultFolders";

export type DeliverableVerdict = "deliverable" | "evidence" | "unrelated";
export type CriterionVerdict = "pass" | "gap" | "cannot_read";
export type DeliverableJudgement = {
  doc: string; task: string; verdict: DeliverableVerdict; criterion: CriterionVerdict;
  /** Verbatim from the document: what meets the criterion, or what shows the gap. "" for `cannot_read` and `unrelated`. */
  quote: string;
  /** What is missing against the done criterion, for a `gap`. */
  gap: string;
  /** Whether a shortfall has consequences outside (a submission, someone else's time): with a milestone, what makes a gap worth asking. */
  external: boolean;
  why: string;
};
export type DeliverableCheck = { items: DeliverableJudgement[] };

const str = { type: "string" };
export const DELIVERABLE_CHECK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["doc", "task", "verdict", "criterion", "quote", "gap", "external", "why"],
    properties: { doc: str, task: str, verdict: { type: "string", enum: ["deliverable", "evidence", "unrelated"] },
      criterion: { type: "string", enum: ["pass", "gap", "cannot_read"] }, quote: str, gap: str, external: { type: "boolean" }, why: str } } } }
} as const;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Checks the model's claims, never rewrites them: every document answered once, a task named only from the candidates, a pass or gap
 * quoting the document's own text (whitespace aside). Throws with a `detail` the repair turn reads.
 */
export function validateDeliverableCheck(value: unknown, docs: ReadonlyArray<{ id: string; text: string }>, tasks: ReadonlyArray<string>): DeliverableCheck {
  const items = (value as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) throw Object.assign(new Error("DELIVERABLE_CHECK_INVALID"), { detail: "items missing" });
  const texts = new Map(docs.map((doc) => [doc.id, squash(doc.text)]));
  const known = new Set(tasks);
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: DeliverableJudgement[] = [];
  for (const raw of items as DeliverableJudgement[]) {
    if (!raw || typeof raw.doc !== "string" || !texts.has(raw.doc)) { problems.push(`unknown doc ${String(raw?.doc)}`); continue; }
    if (seen.has(raw.doc)) continue;
    seen.add(raw.doc);
    const item: DeliverableJudgement = { doc: raw.doc, task: String(raw.task ?? ""), verdict: raw.verdict, criterion: raw.criterion,
      quote: String(raw.quote ?? ""), gap: String(raw.gap ?? ""), external: raw.external === true, why: String(raw.why ?? "").slice(0, 400) };
    // i18n-ignore-start: repair messages to the model
    if (!["deliverable", "evidence", "unrelated"].includes(item.verdict)) problems.push(`${item.doc}: verdict`);
    if (!["pass", "gap", "cannot_read"].includes(item.criterion)) problems.push(`${item.doc}: criterion`);
    if (item.verdict !== "unrelated" && !known.has(item.task)) problems.push(`${item.doc}: task 「${item.task}」 不在候选任务里`);
    if (item.verdict === "unrelated") item.task = "";
    if (item.verdict !== "unrelated" && item.criterion !== "cannot_read") {
      const quote = squash(item.quote);
      if (quote.length < 4 || !texts.get(item.doc)!.includes(quote)) problems.push(`${item.doc}: quote 必须逐字出自该文件`);
    }
    if (item.criterion === "gap" && !item.gap.trim()) problems.push(`${item.doc}: gap 要写缺什么`);
    // i18n-ignore-end
    out.push(item);
  }
  for (const doc of docs) if (!seen.has(doc.id)) problems.push(`doc ${doc.id} 没有回答`); // i18n-ignore
  if (problems.length) throw Object.assign(new Error("DELIVERABLE_CHECK_INVALID"), { detail: problems.slice(0, 8).join("；") });
  return { items: out };
}

/** A gap is worth the person's attention only at a key place (§7.1's four): the task bears on a milestone, or the shortfall goes outside. */
export const gapWorthAsking = (item: Pick<DeliverableJudgement, "criterion" | "external">, milestoneId: string) =>
  item.criterion === "gap" && (Boolean(milestoneId) || item.external);

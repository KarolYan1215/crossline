import { ledgerLines } from "@crossline/core";
import type { SkillTools } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { readProfileModel } from "./onboarding-persist";
import { readResearch } from "./onboarding-research";
import { interviewLedger } from "./question-ledger";

/**
 * The interview's read tools (P3, docs/onboarding-agent-session.md §4 「读工具」): what each turn's context shows only in part — the
 * question ledger's latest entries, a file clipped to the turn's reading budget, the facts recorded since the last turn — read in full,
 * page by page, when the dialogue needs it. Read-only: nothing here writes, and nothing is put in front of the person.
 */

/** Characters of a file one `read_file` call returns. */
export const FILE_PAGE = 14_000;
/** Lines of a ledger section one `read_ledger` call returns. */
export const LEDGER_PAGE = 60;
export const LEDGER_SECTIONS = ["questions", "facts", "hypotheses", "research"] as const;

/* i18n-ignore-start: tool answers for the model */
export const READ_TOOLS_INSTRUCTIONS = "上下文里的问题记录、文件和事实只是一部分：要看全，用 `read_ledger`（section 取 questions、facts、hypotheses、research，"
  + "按 page 翻页）和 `read_file`（文件 id，从 offset 字起读）。只在这一轮的判断需要时读，不必每轮都读。";

const page = (lines: string[], at: number, what: string): string => {
  const pages = Math.max(1, Math.ceil(lines.length / LEDGER_PAGE));
  const index = Math.min(Math.max(0, at), pages - 1);
  const shown = lines.slice(index * LEDGER_PAGE, (index + 1) * LEDGER_PAGE);
  return shown.length ? `${what}，第 ${index + 1}/${pages} 页（page 从 0 起）：\n${shown.join("\n")}` : `${what}：没有记录。`;
};

export function interviewReadTools(store: CrosslineStore, workspaceId: string, sessionId: string): SkillTools {
  const specs: SkillTools["specs"] = [
    { name: "read_ledger", description: "读访谈账本的一部分：questions（问过的每道题和本人的回答）、facts（记下的事实）、hypotheses（假设日志）、research（调研线程和结论）。按页返回。",
      inputSchema: { type: "object", properties: { section: { type: "string", enum: [...LEDGER_SECTIONS] }, page: { type: "integer", minimum: 0 } },
        required: ["section"], additionalProperties: false } },
    { name: "read_file", description: "读本人上传的一个文件的正文，从 offset 字起，每次最多 14000 字。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["id"], additionalProperties: false } }
  ];
  const call = (name: string, args: unknown): string => {
    const value = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (name === "read_file") {
      const id = String(value.id ?? "");
      const doc = store.listSourceDocuments(workspaceId).find((item) => item.id === id && item.extractionStatus === "done");
      if (!doc) throw new Error(`没有 id 为「${id}」的已读取文件。`);
      const offset = Math.max(0, Number(value.offset ?? 0) || 0);
      const text = doc.extractedText.slice(offset, offset + FILE_PAGE);
      const end = offset + text.length;
      return `《${doc.fileName}》第 ${offset}–${end} 字，共 ${doc.extractedText.length} 字${end < doc.extractedText.length ? `；接着读用 offset ${end}` : "；已读完"}：\n${text}`;
    }
    if (name !== "read_ledger") throw new Error(`没有名为 ${name} 的工具`);
    const at = Math.max(0, Number(value.page ?? 0) || 0);
    switch (String(value.section ?? "")) {
      case "questions": return page(ledgerLines(interviewLedger(store, workspaceId, sessionId)), at, "问过的题");
      case "facts": return page(store.listProfileFacts(workspaceId).map((fact) => `${fact.identityId}${fact.projectId ? `/${fact.projectId}` : ""} · ${fact.slot} = `
        + `${fact.value.slice(0, 200)}（${fact.status === "confirmed" ? "确认" : "推断"}）`), at, "记下的事实");
      case "hypotheses": return page((readProfileModel(store, workspaceId).hypotheses ?? []).map((item) =>
        `${item.id} [${item.status}${item.cardKey ? "，出过卡" : ""}] ${item.dimension ?? ""} ${item.statement}`), at, "假设日志");
      case "research": return page(readResearch(store, workspaceId, sessionId).map((thread) =>
        `[${thread.status}] ${thread.question}${thread.conclusion ? ` → ${thread.conclusion.slice(0, 300)}` : ""}`), at, "调研线程");
      default: throw new Error(`section 只能是 ${LEDGER_SECTIONS.join("、")}。`);
    }
  };
  return { specs, call };
}
/* i18n-ignore-end */

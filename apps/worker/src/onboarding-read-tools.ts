import { ledgerLines, pointLines, PROFILE_INSTRUMENTS_SETTING, PROFILE_SCALE_ANALYSIS_SETTING, PROFILE_SCALE_SETTING, readInstrumentAnswers, readScaleAnalysis, readScaleSession, scaleLedgerLines } from "@crossline/core";
import type { SkillTools } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { readProfileModel } from "./onboarding-persist";
import { readResearch } from "./onboarding-research";
import { interviewLedger } from "./question-ledger";
import { folderReaderFor, listFolderEntries, readFolderFile } from "./source-folders";

/**
 * The interview's read tools (P3, docs/onboarding-agent-session.md §4 「读工具」): what each turn's context shows only in part — the
 * question ledger's latest entries, a file clipped to the turn's reading budget, the facts recorded since the last turn — read in full,
 * page by page, when the dialogue needs it. Read-only: nothing here writes, and nothing is put in front of the person.
 */

/** Characters of a file one `read_file` call returns. */
export const FILE_PAGE = 14_000;
/** Lines of a ledger section one `read_ledger` call returns. */
export const LEDGER_PAGE = 60;
export const LEDGER_SECTIONS = ["questions", "facts", "hypotheses", "research", "scale", "notes"] as const;

/* i18n-ignore-start: tool answers for the model */
export const READ_TOOLS_INSTRUCTIONS = "上下文里的问题记录、文件和事实只是一部分：要看全，用 `read_ledger`（section 取 questions、facts、hypotheses、research、scale、notes，"
  + "按 page 翻页）和 `read_file`（文件 id，从 offset 字起读）。只在这一轮的判断需要时读，不必每轮都读。"
  + "本人在这台电脑上授权的文件夹没有整体导入：有 `list_folder` 和 `read_folder_file` 时，按需浏览目录、打开与当前话题有关的文件，不要逐个通读。"
  + "标着「旧版摘要」的文件是另一份文件的较早版本，摘要与差异已写在里面；需要逐字核对时再用 read_file 读原件。";

const page = (lines: string[], at: number, what: string): string => {
  const pages = Math.max(1, Math.ceil(lines.length / LEDGER_PAGE));
  const index = Math.min(Math.max(0, at), pages - 1);
  const shown = lines.slice(index * LEDGER_PAGE, (index + 1) * LEDGER_PAGE);
  return shown.length ? `${what}，第 ${index + 1}/${pages} 页（page 从 0 起）：\n${shown.join("\n")}` : `${what}：没有记录。`;
};

export function interviewReadTools(store: CrosslineStore, workspaceId: string, sessionId: string): SkillTools {
  const specs: SkillTools["specs"] = [
    { name: "read_ledger", description: "读访谈账本的一部分：questions（问过的每道题和本人的回答）、facts（记下的事实）、hypotheses（假设日志）、research（调研线程和结论）、scale（量表分数、本人补充、自述的其他测试、量表分析和待验证的假设）、notes（整理层按维度写下的笔记，含【自报】与矛盾）。按页返回。",
      inputSchema: { type: "object", properties: { section: { type: "string", enum: [...LEDGER_SECTIONS] }, page: { type: "integer", minimum: 0 } },
        required: ["section"], additionalProperties: false } },
    { name: "read_file", description: "读本人上传的一个文件的正文，从 offset 字起，每次最多 14000 字。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["id"], additionalProperties: false } }
  ];
  // This computer's authorized folders, browsed and opened on demand (D3, 2026-11-22); never on the hosted server or for a guest.
  const folders = folderReaderFor(workspaceId);
  if (folders) specs.push(
    { name: "list_folder", description: "列出本人授权文件夹里的一个目录（只读）：不给 folder 时列出所有授权文件夹；给 folder（文件夹 id）和 path（相对路径，空为根目录）时列出子目录和可读文件。"
      + "密钥、私人证件单据和本人排除的不会列出。",
      inputSchema: { type: "object", properties: { folder: { type: "string" }, path: { type: "string" }, page: { type: "integer", minimum: 0 } }, additionalProperties: false } },
    { name: "read_folder_file", description: "打开授权文件夹里的一个文件（folder 为文件夹 id，path 为相对路径），从 offset 字起读，每次最多 14000 字。读过的文件会存入材料，之后也可用 read_file 按 id 读。",
      inputSchema: { type: "object", properties: { folder: { type: "string" }, path: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["folder", "path"], additionalProperties: false } });
  const pageOf = (doc: { id: string; fileName: string; extractedText: string }, rawOffset: unknown, withId = false) => {
    const offset = Math.max(0, Number(rawOffset ?? 0) || 0);
    const text = doc.extractedText.slice(offset, offset + FILE_PAGE);
    const end = offset + text.length;
    return `《${doc.fileName}》${withId ? `（id ${doc.id}）` : ""}第 ${offset}–${end} 字，共 ${doc.extractedText.length} 字${end < doc.extractedText.length ? `；接着读用 offset ${end}` : "；已读完"}：\n${text}`;
  };
  const call = async (name: string, args: unknown): Promise<string> => {
    const value = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (name === "list_folder" && folders) {
      const listing = await listFolderEntries(store, workspaceId, value.folder ? String(value.folder) : undefined, String(value.path ?? ""), Number(value.page ?? 0) || 0);
      if (!listing.ok) throw new Error(listing.message);
      return listing.text;
    }
    if (name === "read_folder_file" && folders) {
      const opened = await readFolderFile(store, workspaceId, folders, String(value.folder ?? ""), String(value.path ?? ""));
      if (!opened.ok) throw new Error(opened.message);
      if (opened.doc.extractionStatus !== "done") throw new Error(`《${opened.doc.fileName}》没有可读的文字${opened.doc.extractionNote ? `：${opened.doc.extractionNote}` : ""}。`);
      return pageOf(opened.doc, value.offset, true);
    }
    if (name === "read_file") {
      const id = String(value.id ?? "");
      const doc = store.listSourceDocuments(workspaceId).find((item) => item.id === id && item.extractionStatus === "done");
      if (!doc) throw new Error(`没有 id 为「${id}」的已读取文件。`);
      return pageOf(doc, value.offset);
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
      // The scale before the first round and its analysis (2026-11-22), and the organizing layer's notes by dimension (D9).
      case "scale": return page(scaleLedgerLines(readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING)),
        readScaleSession(store.getSetting(workspaceId, PROFILE_SCALE_SETTING)), readScaleAnalysis(store.getSetting(workspaceId, PROFILE_SCALE_ANALYSIS_SETTING))), at, "量表");
      case "notes": return page(pointLines(readProfileModel(store, workspaceId).points ?? []), at, "整理层笔记");
      default: throw new Error(`section 只能是 ${LEDGER_SECTIONS.join("、")}。`);
    }
  };
  return { specs, call };
}
/* i18n-ignore-end */

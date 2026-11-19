import type { SkillTools } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

/** Most text one run reads through these lookups (as the step planner's material tools, about 30k characters). */
const BUDGET_CHARS = 30_000;
const PER_SEARCH = 8;
const oneLine = (text: string, max = 160) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The person's own files as lookups for any model run (the owner, 2026-11-18: local first, the web only when nothing local is relevant).
 * Read-only over the passages already indexed for search (`doc_chunks`); nothing leaves the ledger but what the model reads. Undefined
 * for a workspace with no files, so a run without them is offered nothing.
 */
export function localLookupsFor(store: CrosslineStore, workspaceId: string): SkillTools | undefined {
  if (!store.listSourceDocuments(workspaceId).length) return undefined;
  let spent = 0;
  const spend = (text: string) => {
    if (spent >= BUDGET_CHARS) return "本次查阅已到上限（约 3 万字）。用已读到的内容完成；仍缺的再考虑联网。"; // i18n-ignore: to the model
    spent += text.length;
    return text;
  };
  return {
    specs: [
      { name: "search_my_files", description: "Search the person's own files (uploads, folders they shared, course material, notes) for passages about "
        + "a topic, in Chinese or English. Returns up to 8 passages: id, file name and their opening. Use it before any web search.",
        inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 } } } },
      { name: "read_my_file_passage", description: "Read one passage of the person's files in full by its id (c123), with the ids of the passages around it.",
        inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 20 } } } }
    ],
    call: (name, args) => {
      const input = (args ?? {}) as { query?: unknown; id?: unknown };
      // i18n-ignore-start: answers to the model
      if (name === "search_my_files") {
        const query = String(input.query ?? "").slice(0, 200);
        const found = store.searchDocChunks(workspaceId, query, { limit: PER_SEARCH });
        if (!found.length) return spend(`本人的文件里没有与「${query}」相关的段落。换个说法再找一次；仍没有，再联网。`);
        return spend(found.map((hit) => `c${hit.id}《${hit.fileName}》第 ${hit.ord + 1} 段：${oneLine(hit.body)}`).join("\n"));
      }
      if (name === "read_my_file_passage") {
        const id = Number(String(input.id ?? "").replace(/^c/i, ""));
        const chunk = Number.isInteger(id) ? store.readDocChunk(workspaceId, id) : undefined;
        if (!chunk) return spend(`没有编号为 ${String(input.id ?? "")} 的段落。`);
        const near = [chunk.previousId ? `前一段 c${chunk.previousId}` : "", chunk.nextId ? `后一段 c${chunk.nextId}` : ""].filter(Boolean).join("，");
        return spend(`c${chunk.id}《${chunk.fileName}》第 ${chunk.ord + 1}/${chunk.total} 段${near ? `（${near}）` : ""}\n${chunk.body}`);
      }
      // i18n-ignore-end
      throw new Error(`no tool named ${name}`);
    }
  };
}

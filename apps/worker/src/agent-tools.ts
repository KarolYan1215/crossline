// i18n-exempt: the toolbox answers the tools-mode assistant (model-facing); the one line the person reads (a capture's context) is translated where it is written
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SkillTools } from "@crossline/codex";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { tFor } from "@crossline/core";
import { localeOf } from "./locale";
import { extractText } from "./extract";

/**
 * The assistant without a shell (docs/personal-agent.md, decided 2026-10-19): what it can do is a fixed set of functions Crossline
 * answers itself, so it runs on any model that can call functions — the developer's model, a provider's API, a ChatGPT sign-in on the
 * hosted server where no account gets a shell — and nothing it does depends on a guard reading command lines. It reads the task's
 * inputs, the person's own files and board, the web and (when connected) their mailbox; it writes only inside its task directory;
 * and the two things it may do to the board (put a line in the inbox, tell the person something) are collected and carried out after
 * a run that finished, so a run that failed half way leaves nothing behind but its files.
 */
export type MailLookup = {
  search(query: { text?: string; from?: string; sinceDays?: number; limit?: number }): Promise<Array<{ id: string; from: string; subject: string; date: string; snippet: string }>>;
  read(id: string): Promise<{ id: string; from: string; to: string; subject: string; date: string; text: string } | undefined>;
};

export type ToolCall = { tool: string; subject: string; ok: boolean };
export type ToolboxAction = { kind: "inbox"; text: string } | { kind: "tell"; text: string };
export type AgentToolbox = SkillTools & { calls: ToolCall[]; actions: ToolboxAction[]; written: () => string[] };

/** Text the assistant may write; anything else (scripts, programs, archives) is not its to make here. */
const WRITABLE = /\.(md|markdown|txt|csv|tsv|json|html?|ics|ya?ml|xml)$/i;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 20_000_000;
const MAX_FILES = 200;
const READ_CHARS = 20_000;
export const INBOX_PER_RUN = 5;
const TEXTUAL = /\.(md|markdown|txt|csv|tsv|json|html?|ics|ya?ml|xml|log|tex|py|js|ts|r|sql)$/i;

const kindOf = (file: string): StoredSourceDocument["kind"] | undefined =>
  /\.pdf$/i.test(file) ? "pdf" : /\.docx$/i.test(file) ? "docx" : TEXTUAL.test(file) ? "text" : undefined;

/** A relative path inside `root`, or undefined when it would leave it (absolute, `..`, a drive letter). */
export function inside(root: string, relative: string): string | undefined {
  if (!relative || /^([a-z]:|[\\/])/i.test(relative) || relative.split(/[\\/]/).includes("..")) return undefined;
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? full : undefined;
}

export function createAgentToolbox(deps: {
  store: CrosslineStore; workspaceId: string;
  /** The task directory: the only place it writes. */
  directory: string;
  /** Files and folders it may read (the task's inputs: the person's files, earlier runs' folders), shown as `input/<n>/…`. */
  inputs: string[];
  /** The person's mailbox, read-only, when they connected one. */
  mail?: MailLookup;
  readFile?: (uri: string) => Uint8Array;
  now?: () => Date;
}): AgentToolbox {
  const calls: ToolCall[] = [];
  const actions: ToolboxAction[] = [];
  const written = new Set<string>();
  /** Copies of the person's files: counted against their own allowance, so organising large files leaves room to write the index. */
  const copied = new Set<string>();
  const read = deps.readFile ?? ((uri: string) => readFileSync(uri.replace(/^file:\/\//, "")));
  mkdirSync(deps.directory, { recursive: true });

  /** `input/<n>/rest` → a file under that input; anything else → a file in the task directory. */
  const resolve = (relative: string): { full: string; writable: boolean } | undefined => {
    const match = /^input\/(\d+)(?:\/(.*))?$/.exec(relative.replace(/\\/g, "/"));
    if (match) {
      const root = deps.inputs[Number(match[1])];
      if (!root) return undefined;
      if (!match[2]) return { full: root, writable: false };
      const full = statSync(root, { throwIfNoEntry: false })?.isDirectory() ? inside(root, match[2]) : undefined;
      return full ? { full, writable: false } : undefined;
    }
    const full = inside(deps.directory, relative);
    return full ? { full, writable: true } : undefined;
  };
  const bytesOf = (files: Set<string>) => [...files].reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
  const totalWritten = () => bytesOf(written);
  const fail = (message: string): never => { throw new Error(message); };
  const textOf = async (full: string): Promise<string> => {
    const kind = kindOf(full) ?? fail(`「${path.basename(full)}」不是能读的文字文件（支持 PDF、Word 与文本）。`);
    const bytes = readFileSync(full);
    if (kind === "text") return new TextDecoder("utf-8").decode(bytes);
    const result = await extractText(bytes, kind);
    return result.status === "done" ? result.text : fail(result.note ?? "读不出文字。");
  };
  const page = (text: string, offset: number) => ({ text: text.slice(offset, offset + READ_CHARS), offset, total: text.length,
    ...(offset + READ_CHARS < text.length ? { next: offset + READ_CHARS } : {}) });
  const documents = () => deps.store.listSourceDocuments(deps.workspaceId);
  const projects = () => new Map(deps.store.listProjects(deps.workspaceId).map((project) => [project.id, project.name]));

  const str = (description: string) => ({ type: "string", description });
  const specs: SkillTools["specs"] = [
    { name: "list_files", description: "List files in your task directory (paths you can write) and in your inputs (input/<n>/..., read-only).",
      inputSchema: { type: "object", additionalProperties: false, properties: { folder: str("A folder inside the task directory or an input, e.g. input/0 or notes. Empty: everything at the top.") } } },
    { name: "read_file", description: "Read a text, PDF or Word file from your task directory or inputs: up to 20,000 characters from offset.",
      inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: str("Relative path, or input/<n>/..."), offset: { type: "integer", minimum: 0 } } } },
    { name: "write_file", description: "Create or replace a file in your task directory (.md .txt .csv .tsv .json .html .ics .yaml .xml, up to 2 MB). Folders are made as needed.",
      inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: str("Relative path inside the task directory"), content: { type: "string" } } } },
    { name: "copy_file", description: "Copy a file from your inputs or task directory into your task directory (to organise files without changing the originals).",
      inputSchema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: str("input/<n>/... or a relative path"), to: str("Relative path inside the task directory") } } },
    { name: "move_file", description: "Rename or move a file inside your task directory.",
      inputSchema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } } },
    { name: "delete_file", description: "Delete a file you made in this run (only files in your task directory).",
      inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } } },
    { name: "list_documents", description: "The person's own files kept by Crossline (uploads, authorised folders): id, name, project, length. Filter by words in the name or text.",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: str("Words to look for; empty lists the newest 40") } } },
    { name: "read_document", description: "Read one of the person's files by id: up to 20,000 characters from offset.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } } } },
    { name: "list_tasks", description: "The person's tasks on the board: id, title, line, state, due day, current step.",
      inputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["open", "done", "all"] } } } },
    { name: "read_task", description: "One task in full: what it is for, its steps and their state, what the person does and what the assistant may do.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } },
    { name: "list_facts", description: "What the person confirmed about themselves and their projects (from the interview and their files).",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: str("Words to filter by; empty lists them all (up to 120)") } } },
    { name: "calendar", description: "The person's fixed calendar commitments (synced calendars, classes read from files) between two days; not the work blocks Crossline planned.",
      inputSchema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD") } } },
    { name: "add_to_inbox", description: "Put one new thing the person will clearly want to do into their inbox, written as the task in one line (Crossline then plans it like anything they type). Never a digest, a summary or a notice that a file was made: the run's result reaches the person by itself. At most 5 a run.",
      inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: str("The task in one line, with its date if it has one") } } },
    { name: "tell_person", description: "Something the person must know now (one short paragraph), sent to them when the run finishes. At most 3 a run; not for what the result already says.",
      inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } } }
  ];
  if (deps.mail) specs.push(
    { name: "mail_search", description: "Search the person's mailbox (read-only): newest first, sender, subject, date and the opening lines.",
      inputSchema: { type: "object", additionalProperties: false, properties: { text: str("Words in the subject or body"), from: str("Part of the sender's address or name"),
        sinceDays: { type: "integer", minimum: 1, maximum: 365 }, limit: { type: "integer", minimum: 1, maximum: 30 } } } },
    { name: "mail_read", description: "Read one message in full (text only, read-only: it is not marked as read).",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } });

  async function call(name: string, args: unknown): Promise<string> {
    const input = (args ?? {}) as Record<string, unknown>;
    const s = (key: string) => typeof input[key] === "string" ? (input[key] as string).trim() : "";
    const n = (key: string) => typeof input[key] === "number" && Number.isFinite(input[key]) ? Math.max(0, Math.floor(input[key] as number)) : 0;
    switch (name) {
      case "list_files": {
        const folder = s("folder");
        const list = (root: string, prefix: string) => {
          const out: Array<{ path: string; kind: "file" | "folder"; bytes?: number }> = [];
          const walk = (dir: string, depth: number) => {
            for (const entry of readdirSync(dir, { withFileTypes: true }).slice(0, 300)) {
              if (entry.name.startsWith(".") || entry.name === "node_modules" || /^(audit|progress)\.json$/.test(entry.name)) continue;
              const full = path.join(dir, entry.name);
              const shown = `${prefix}${path.relative(root, full).replace(/\\/g, "/")}`;
              if (entry.isDirectory()) { out.push({ path: shown, kind: "folder" }); if (depth < 3 && out.length < 400) walk(full, depth + 1); }
              else out.push({ path: shown, kind: "file", bytes: statSync(full).size });
            }
          };
          if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root, 0);
          else if (existsSync(root)) out.push({ path: prefix.replace(/\/$/, ""), kind: "file", bytes: statSync(root).size });
          return out;
        };
        if (folder) {
          const target = resolve(folder) ?? fail(`「${folder}」不在任务目录或输入里。`);
          const prefix = `${folder.replace(/\\/g, "/").replace(/\/$/, "")}/`;
          return JSON.stringify({ entries: list(target.full, prefix).slice(0, 400) });
        }
        return JSON.stringify({ taskDirectory: list(deps.directory, "").slice(0, 200),
          inputs: deps.inputs.map((input, index) => ({ path: `input/${index}`, name: path.basename(input),
            kind: statSync(input, { throwIfNoEntry: false })?.isDirectory() ? "folder" : "file" })) });
      }
      case "read_file": {
        const target = resolve(s("path")) ?? fail(`「${s("path")}」不在任务目录或输入里。`);
        if (!existsSync(target.full) || statSync(target.full).isDirectory()) fail(`没有文件「${s("path")}」。`);
        return JSON.stringify({ path: s("path"), ...page(await textOf(target.full), n("offset")) });
      }
      case "write_file": {
        const relative = s("path");
        const target = resolve(relative);
        if (!target?.writable) fail("只能写在任务目录里，路径写成相对路径，例如 notes/summary.md。");
        if (!WRITABLE.test(relative)) fail("只能写文字文件：.md .txt .csv .tsv .json .html .ics .yaml .xml。");
        const content = typeof input.content === "string" ? input.content : "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (!content.trim()) fail("内容为空。");
        if (bytes > MAX_FILE_BYTES) fail("单个文件不能超过 2 MB，拆成几个文件。");
        if (!written.has(target!.full) && written.size >= MAX_FILES) fail(`这次运行已经写了 ${MAX_FILES} 个文件。`);
        if (totalWritten() + bytes > MAX_TOTAL_BYTES) fail("这次运行写出的文件总量已到上限（20 MB）。");
        mkdirSync(path.dirname(target!.full), { recursive: true });
        writeFileSync(target!.full, content, "utf8");
        written.add(target!.full);
        return JSON.stringify({ written: relative, bytes });
      }
      case "copy_file": {
        const from = resolve(s("from")) ?? fail(`「${s("from")}」不在任务目录或输入里。`);
        const to = resolve(s("to"));
        if (!to?.writable) fail("只能复制到任务目录里。");
        if (!existsSync(from.full) || statSync(from.full).isDirectory()) fail(`没有文件「${s("from")}」。`);
        const bytes = statSync(from.full).size;
        if (bytes > 50 * 1024 * 1024) fail("文件超过 50 MB，不复制。");
        if (bytesOf(copied) + bytes > MAX_TOTAL_BYTES * 5) fail("这次运行复制的文件总量已到上限（100 MB）。");
        mkdirSync(path.dirname(to!.full), { recursive: true });
        copyFileSync(from.full, to!.full);
        copied.add(to!.full);
        return JSON.stringify({ copied: s("from"), to: s("to"), bytes });
      }
      case "move_file": {
        const from = resolve(s("from"));
        const to = resolve(s("to"));
        if (!from?.writable || !to?.writable) fail("只能在任务目录里移动或改名。");
        if (!existsSync(from!.full)) fail(`没有文件「${s("from")}」。`);
        mkdirSync(path.dirname(to!.full), { recursive: true });
        renameSync(from!.full, to!.full);
        if (written.delete(from!.full)) written.add(to!.full);
        if (copied.delete(from!.full)) copied.add(to!.full);
        return JSON.stringify({ moved: s("from"), to: s("to") });
      }
      case "delete_file": {
        const target = resolve(s("path"));
        if (!target?.writable || !(written.has(target.full) || copied.has(target.full))) fail("只能删除这次运行自己写出的文件。");
        rmSync(target!.full, { force: true });
        written.delete(target!.full);
        copied.delete(target!.full);
        return JSON.stringify({ deleted: s("path") });
      }
      case "list_documents": {
        const query = s("query").toLowerCase();
        const names = projects();
        const terms = query.split(/\s+/).filter(Boolean);
        const all = documents().filter((doc) => !terms.length || terms.every((term) => doc.fileName.toLowerCase().includes(term) || doc.extractedText.toLowerCase().includes(term)));
        return JSON.stringify({ documents: all.slice(-40).reverse().map((doc) => ({ id: doc.id, name: doc.fileName, kind: doc.kind,
          project: doc.projectId ? names.get(doc.projectId) ?? doc.projectId : "", chars: doc.extractedText.length, readable: doc.extractionStatus === "done", added: doc.createdAt.slice(0, 10) })) });
      }
      case "read_document": {
        const doc = documents().find((item) => item.id === s("id")) ?? fail(`没有 id 为「${s("id")}」的文件。`);
        let text = doc.extractedText;
        if (!text && doc.extractionStatus !== "done") {
          const kind = doc.kind === "pdf" || doc.kind === "docx" || doc.kind === "text" ? doc.kind : undefined;
          if (!kind) fail(`「${doc.fileName}」没有文字可读（${doc.extractionNote ?? doc.kind}）。`);
          const result = await extractText(read(doc.uri), kind!).catch(() => undefined);
          text = result?.status === "done" ? result.text : fail(`「${doc.fileName}」读不出文字。`);
        }
        return JSON.stringify({ id: doc.id, name: doc.fileName, ...page(text, n("offset")) });
      }
      case "list_tasks": {
        const status = s("status") || "open";
        const plans = new Map(deps.store.listStepPlans(deps.workspaceId).map((plan) => [plan.workOrderId, plan]));
        const orders = deps.store.listWorkOrders(deps.workspaceId).filter((order) => status === "all" ? true
          : status === "done" ? order.state === "accepted" : !["accepted", "archived"].includes(order.state));
        return JSON.stringify({ tasks: orders.slice(0, 80).map((order) => {
          const payload = order.payload as { title?: string; dueDate?: string };
          const current = plans.get(order.id)?.steps.find((step) => step.status !== "done");
          return { id: order.id, title: payload.title ?? order.intent.slice(0, 80), line: order.identityId, state: order.state,
            ...(payload.dueDate ? { due: payload.dueDate } : {}), ...(current ? { currentStep: current.title } : {}) };
        }) });
      }
      case "read_task": {
        const order = deps.store.getWorkOrder(deps.workspaceId, s("id")) ?? fail(`没有 id 为「${s("id")}」的任务。`);
        const payload = order.payload as { title?: string; dueDate?: string; humanCore?: string; automationParts?: string[] };
        const plan = deps.store.getStepPlan(deps.workspaceId, order.id);
        return JSON.stringify({ id: order.id, title: payload.title ?? "", intent: order.intent, line: order.identityId, state: order.state,
          ...(payload.dueDate ? { due: payload.dueDate } : {}), ...(payload.humanCore ? { personDoes: payload.humanCore } : {}),
          ...(payload.automationParts?.length ? { assistantMay: payload.automationParts } : {}),
          steps: (plan?.steps ?? []).map((step) => ({ title: step.title, status: step.status, by: step.executor, minutes: step.estimate.p50Minutes })) });
      }
      case "list_facts": {
        const terms = s("query").toLowerCase().split(/\s+/).filter(Boolean);
        const facts = deps.store.listProfileFacts(deps.workspaceId).filter((fact) => fact.status === "confirmed" && !fact.value.startsWith("假设："))
          .filter((fact) => !terms.length || terms.some((term) => `${fact.slot} ${fact.value}`.toLowerCase().includes(term)));
        return JSON.stringify({ facts: facts.slice(0, 120).map((fact) => ({ line: fact.identityId, project: fact.projectId, about: fact.slot, value: fact.value.slice(0, 300) })) });
      }
      case "calendar": {
        const from = s("from"), to = s("to");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail("from 与 to 须为 YYYY-MM-DD。");
        const plan = deps.store.listPlanVersions(deps.workspaceId).find((version) => version.status === "current") ?? deps.store.listPlanVersions(deps.workspaceId).at(-1);
        const blocks = ((plan?.payload as { blocks?: Array<{ id: string; day?: string; start?: string; end?: string; title?: string }> } | undefined)?.blocks ?? [])
          .filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && block.day && block.day >= from && block.day <= to);
        return JSON.stringify({ events: blocks.slice(0, 200).map((block) => ({ day: block.day, start: block.start, end: block.end, title: block.title ?? "" })) });
      }
      case "add_to_inbox": {
        const text = s("text").slice(0, 300);
        if (!text) fail("内容为空。");
        if (actions.filter((action) => action.kind === "inbox").length >= INBOX_PER_RUN) fail(`一次运行最多放 ${INBOX_PER_RUN} 件事进收件箱。`);
        actions.push({ kind: "inbox", text });
        return JSON.stringify({ queued: text, note: "运行结束后放进收件箱" });
      }
      case "tell_person": {
        const text = s("text").slice(0, 600);
        if (!text) fail("内容为空。");
        if (actions.filter((action) => action.kind === "tell").length >= 3) fail("一次运行最多说三件事。");
        actions.push({ kind: "tell", text });
        return JSON.stringify({ queued: true });
      }
      case "mail_search": {
        if (!deps.mail) fail("本人没有接入邮箱。");
        const hits = await deps.mail!.search({ ...(s("text") ? { text: s("text") } : {}), ...(s("from") ? { from: s("from") } : {}),
          ...(n("sinceDays") ? { sinceDays: n("sinceDays") } : {}), limit: Math.min(30, n("limit") || 15) });
        return JSON.stringify({ messages: hits });
      }
      case "mail_read": {
        if (!deps.mail) fail("本人没有接入邮箱。");
        const message = await deps.mail!.read(s("id")) ?? fail(`没有 id 为「${s("id")}」的邮件。`);
        return JSON.stringify({ ...message, text: message.text.slice(0, READ_CHARS) });
      }
      default: return fail(`没有名为 ${name} 的工具`);
    }
  }

  return {
    specs, calls, actions, written: () => [...written, ...copied],
    async call(name, args) {
      // What a call is about, offset included: reading one long file page by page is not going round in circles.
      const subject = (() => { const a = (args ?? {}) as Record<string, unknown>;
        return `${String(a.path ?? a.from ?? a.id ?? a.query ?? a.text ?? a.folder ?? "").slice(0, 160)}${typeof a.offset === "number" ? `@${a.offset}` : ""}`; })();
      try {
        const answer = await call(name, args);
        calls.push({ tool: name, subject, ok: true });
        return answer;
      } catch (error) {
        calls.push({ tool: name, subject, ok: false });
        throw error;
      }
    }
  };
}

/** Carries out what a finished run asked for: its inbox lines become captures (planned like anything typed); what it had to say is returned. */
export function applyToolboxActions(store: CrosslineStore, workspaceId: string, ownerId: string, taskId: string, actions: ToolboxAction[]):
  { captures: string[]; told: string[] } {
  const captures: string[] = [];
  for (const [index, action] of actions.entries()) {
    if (action.kind !== "inbox") continue;
    const id = `cap-agent-${randomUUID().slice(0, 12)}`;
    store.capture({ id, ownerId, workspaceId, title: action.text, context: tFor(localeOf(store, workspaceId))("助手在「{{task}}」中记下", { task: taskId }) }, `agent:inbox:${taskId}:${index}`);
    captures.push(action.text);
  }
  return { captures, told: actions.filter((action) => action.kind === "tell").map((action) => action.text) };
}

import { tFor, type Locale } from "./i18n";

/**
 * AI conversation history the person hands over (the owner's decision D14 of 2026-11-22, docs/plans/2026-11-22-interview-and-import-redesign.md
 * §四.5): a ChatGPT data export's `conversations.json`, a Codex session rollout (`rollout-*.jsonl`, `.jsonl.zst`) or a Claude Code session
 * (`<uuid>.jsonl`). The format is recognized from the content; only what the person typed is kept — system and developer messages,
 * AGENTS.md and environment blocks the tools inject into the user's turn, tool calls and their output, and every assistant reply are
 * dropped. Nothing here scans the computer: a file is read only because the person uploaded it or put it in a folder they authorized.
 */
export type ChatHistoryFormat = "chatgpt" | "codex" | "claude-code";
export type ChatConversation = { title: string; startedAt?: string; said: string[] };
export type ChatHistory = { format: ChatHistoryFormat; conversations: ChatConversation[] };

/** Names a folder walk treats as conversation exports (everything else in JSON is configuration, not material). */
export function chatHistoryName(relativePath: string): boolean {
  const name = relativePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^conversations\.json$/i.test(name) || /^rollout-.*\.jsonl(\.zst)?$/i.test(name)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name);
}

/** Text the tools put into the user's turn themselves: instructions files, environment blocks, slash-command echoes, interruptions. */
const INJECTED = /^\s*(?:#\s*AGENTS\.md|<(?:environment_context|user_instructions|permissions instructions|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|turn_aborted)\b|Caveat: The messages below|\[Request interrupted)/i;
const said = (text: unknown): string | undefined => {
  if (typeof text !== "string") return undefined;
  const clean = text.trim();
  return clean && !INJECTED.test(clean) ? clean : undefined;
};
const day = (value: unknown): string | undefined => {
  const time = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString().slice(0, 10) : undefined;
};
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

function chatgpt(value: unknown): ChatHistory | undefined {
  if (!Array.isArray(value) || !value.some((item) => record(record(item)?.mapping))) return undefined;
  const conversations = value.flatMap((item): ChatConversation[] => {
    const conversation = record(item);
    const mapping = record(conversation?.mapping);
    if (!conversation || !mapping) return [];
    const messages = Object.values(mapping).map((node) => record(record(node)?.message)).filter((message): message is Json => Boolean(message))
      .filter((message) => record(message.author)?.role === "user" && !record(message.metadata)?.is_visually_hidden_from_conversation
        && !record(message.metadata)?.is_user_system_message)
      .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
    const lines = messages.flatMap((message) => {
      const content = record(message.content);
      if (!content || !["text", "multimodal_text"].includes(String(content.content_type))) return [];
      const text = (Array.isArray(content.parts) ? content.parts : []).filter((part): part is string => typeof part === "string").join("\n");
      return said(text) ? [said(text)!] : [];
    });
    const startedAt = day(conversation.create_time);
    return lines.length ? [{ title: String(conversation.title ?? "").trim(), ...(startedAt ? { startedAt } : {}), said: lines }] : [];
  });
  return { format: "chatgpt", conversations };
}

function jsonLines(text: string): Json[] {
  return text.split(/\r?\n/).flatMap((line) => { try { const value = record(JSON.parse(line)); return value ? [value] : []; } catch { return []; } });
}

/** A Codex rollout: the typed text is `event_msg` / `user_message`; older rollouts have only the `response_item` messages. */
function codex(lines: Json[]): ChatHistory | undefined {
  const items = lines.map((line) => ({ type: String(line.type ?? ""), payload: record(line.payload) ?? line, timestamp: line.timestamp }));
  if (!items.some((item) => ["session_meta", "response_item", "event_msg", "turn_context"].includes(item.type))) return undefined;
  const meta = items.find((item) => item.type === "session_meta")?.payload;
  const typed = items.filter((item) => item.type === "event_msg" && item.payload.type === "user_message").map((item) => said(item.payload.message));
  const fallback = items.filter((item) => (item.type === "response_item" || item.type === "message") && item.payload.type === "message" && item.payload.role === "user")
    .map((item) => said((Array.isArray(item.payload.content) ? item.payload.content : []).map((part) => record(part))
      .filter((part) => part?.type === "input_text").map((part) => String(part!.text ?? "")).join("\n")));
  const kept = (typed.length ? typed : fallback).filter((text): text is string => Boolean(text));
  const startedAt = day(meta?.timestamp ?? items[0]?.timestamp);
  return { format: "codex", conversations: kept.length ? [{ title: String(meta?.cwd ?? "").split(/[\\/]/).pop() ?? "", ...(startedAt ? { startedAt } : {}), said: kept }] : [] };
}

/** A Claude Code session: `user` lines that are not meta, not a tool result and not an injected block. */
function claudeCode(lines: Json[]): ChatHistory | undefined {
  if (!lines.some((line) => (line.type === "user" || line.type === "assistant") && record(line.message) && typeof line.sessionId === "string")) return undefined;
  const kept = lines.filter((line) => line.type === "user" && !line.isMeta && !line.toolUseResult).flatMap((line) => {
    const content = record(line.message)?.content;
    if (typeof content === "string") return said(content) ? [said(content)!] : [];
    if (!Array.isArray(content) || content.some((part) => record(part)?.type === "tool_result")) return [];
    const text = content.map((part) => record(part)).filter((part) => part?.type === "text").map((part) => String(part!.text ?? "")).join("\n");
    return said(text) ? [said(text)!] : [];
  });
  const title = lines.find((line) => line.type === "summary" && typeof line.summary === "string")?.summary;
  const startedAt = day(lines.find((line) => line.timestamp)?.timestamp);
  return { format: "claude-code", conversations: kept.length ? [{ title: String(title ?? "").trim(), ...(startedAt ? { startedAt } : {}), said: kept }] : [] };
}

/** The conversations in `text`, or undefined when it is none of the three formats (an ordinary JSON file is then read as it is). */
export function parseChatHistory(text: string): ChatHistory | undefined {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) { try { return chatgpt(JSON.parse(trimmed)); } catch { return undefined; } }
  const lines = jsonLines(text);
  return lines.length ? codex(lines) ?? claudeCode(lines) : undefined;
}

/** One message kept at most this long: a pasted file or log is the person's message, but its body is not what the interview needs. */
export const CHAT_MESSAGE_CHARS = 4000;
const FORMAT_LABEL: Record<ChatHistoryFormat, string> = { chatgpt: "ChatGPT 导出", codex: "Codex 会话", "claude-code": "Claude Code 会话" };

/**
 * The document the interview reads: a contents list (date, title, how many messages), then each conversation's own words in order. The
 * contents list comes first so the opening a turn shows names every conversation even when the whole is long.
 */
export function chatHistoryText(history: ChatHistory, locale?: Locale): string {
  const t = tFor(locale);
  const titled = history.conversations.map((conversation, index) => ({ ...conversation,
    heading: `${conversation.startedAt ? `${conversation.startedAt} ` : ""}${conversation.title || t("对话 {{n}}", { n: index + 1 })}` }));
  const clip = (text: string) => text.length > CHAT_MESSAGE_CHARS ? `${text.slice(0, CHAT_MESSAGE_CHARS)}${t("…（以下略 {{count}} 字）", { count: text.length - CHAT_MESSAGE_CHARS })}` : text;
  return [
    t("AI 对话记录（{{format}}，{{count}} 段对话，只保留本人说的话；系统指令、AGENTS 说明、工具输出和 AI 的回答都已去掉）", { format: t(FORMAT_LABEL[history.format]), count: titled.length }),
    "", t("## 目录"), ...titled.map((conversation) => t("- {{heading}}（本人 {{count}} 条）", { heading: conversation.heading, count: conversation.said.length })),
    ...titled.flatMap((conversation) => ["", `## ${conversation.heading}`, ...conversation.said.map((text) => `- ${clip(text).replace(/\n/g, "\n  ")}`)])
  ].join("\n");
}

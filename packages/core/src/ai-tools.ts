/**
 * The AI tools this person can use (docs/skills-library.md §7): what plans, estimates, tutorials and workflows assume the person works
 * with. A plan that sizes a step as if the person typed every word, read every page and cut every clip by hand plans the wrong day; a
 * step the system's own assistant can do whole is the assistant's, and the rest says which tool takes the drudgery out of it and how.
 *
 * Three sources: the system's own assistant and its web research (always there on the owner's runtime), tools seen in use (the coding
 * agents' own logs, read only with the person's consent — `history.agentLogs.summary`), and tools the person names in 设置 → Skill 库.
 */
export const AI_TOOLS_SETTING = "ai.tools";

export type AiToolKind = "assistant" | "chat" | "research" | "writing" | "coding" | "media" | "notes" | "other";
export type AiTool = {
  id: string; name: string; kind: AiToolKind;
  /** What it is good for, in a phrase the planner can match a step against (「自动字幕、粗剪」). */
  goodFor: string;
  /** `system`: Crossline's own assistant, which does whole steps; `person`: the person uses it themselves. */
  by: "system" | "person";
  source: "built_in" | "detected" | "person";
};

export const AI_TOOL_KIND_LABEL: Record<AiToolKind, string> = {
  assistant: "代办助手", chat: "对话", research: "调研", writing: "写作", coding: "编程", media: "音视频与图片", notes: "笔记与阅读", other: "其他"
};

/** Always on the machine owner's runtime: the assistant that does whole errands, and web research inside every plan and tutorial. */
export const BUILT_IN_AI_TOOLS: AiTool[] = [
  { id: "crossline-assistant", name: "Crossline 助手", kind: "assistant", by: "system", source: "built_in",
    goodFor: "整份做琐事：汇集材料、起草、数据与脚本、剪辑转码、定期跑工作流；不发送不发布" },
  { id: "codex-web-research", name: "联网调研（Codex）", kind: "research", by: "system", source: "built_in",
    goodFor: "查公开资料并核实来源，供规划与教程引用" }
];

/**
 * Tools seen in the coding agents' own logs (time only, with consent — `AgentHistorySummary`): Codex and Claude Code used in the last 30
 * days, so the person can hand them coding and file work themselves.
 */
export function detectedAiTools(summary: { folders?: Array<{ codex: number; claude: number }> } | undefined): AiTool[] {
  const codex = (summary?.folders ?? []).reduce((sum, folder) => sum + (folder.codex ?? 0), 0);
  const claude = (summary?.folders ?? []).reduce((sum, folder) => sum + (folder.claude ?? 0), 0);
  const found: AiTool[] = [];
  if (codex > 0) found.push({ id: "codex", name: "Codex", kind: "coding", by: "person", source: "detected", goodFor: "写代码、改仓库、跑脚本与数据处理" });
  if (claude > 0) found.push({ id: "claude-code", name: "Claude Code", kind: "coding", by: "person", source: "detected", goodFor: "写代码、改仓库、长任务的多步执行" });
  return found;
}

export function readPersonAiTools(raw: string | undefined): AiTool[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AiTool[];
    return Array.isArray(parsed) ? parsed.filter((tool) => tool && typeof tool.name === "string" && tool.name.trim()).map((tool) => ({ ...tool, source: "person", by: "person" })) : [];
  } catch { return []; }
}

/** One tool the person named: an id from its name, its kind, and what it is for. Refused when the name is empty or too long. */
export function personAiTool(input: { name: string; kind: string; goodFor: string }, taken: Iterable<string>): AiTool | undefined {
  const name = input.name.trim().slice(0, 40);
  if (!name) return undefined;
  const used = new Set(taken);
  const base = `tool-${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "x"}`;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  const kind = (Object.keys(AI_TOOL_KIND_LABEL) as AiToolKind[]).includes(input.kind as AiToolKind) ? input.kind as AiToolKind : "other";
  return { id, name, kind, goodFor: input.goodFor.trim().slice(0, 120), by: "person", source: "person" };
}

/** Every tool, built-in first, then what was seen, then what the person named (a named one replaces a detected one of the same name). */
export function allAiTools(personRaw: string | undefined, detected: AiTool[]): AiTool[] {
  const person = readPersonAiTools(personRaw);
  const names = new Set(person.map((tool) => tool.name.toLowerCase()));
  return [...BUILT_IN_AI_TOOLS, ...detected.filter((tool) => !names.has(tool.name.toLowerCase())), ...person];
}

/** The shape a planning or writing run is given: name, kind, what for, and who works it. */
export const aiToolBrief = (tool: AiTool) => ({ name: tool.name, kind: tool.kind, goodFor: tool.goodFor, by: tool.by });

/**
 * A step's AI assist, made usable: the tool must be one the person has (or empty), the time it saves cannot exceed the step's own minutes,
 * and a step with no tool says nothing about one.
 */
export function normalizeAiAssist(value: { tool?: unknown; how?: unknown; minutesSaved?: unknown } | undefined, toolNames: string[] | undefined, p50: number):
  { tool: string; how: string; minutesSaved: number } {
  const tool = typeof value?.tool === "string" ? value.tool.trim().slice(0, 60) : "";
  const known = !toolNames || toolNames.some((name) => name.toLowerCase() === tool.toLowerCase());
  if (!tool || !known) return { tool: "", how: "", minutesSaved: 0 };
  const saved = Number(value?.minutesSaved);
  return { tool, how: typeof value?.how === "string" ? value.how.trim().slice(0, 240) : "",
    minutesSaved: Number.isFinite(saved) && saved > 0 ? Math.min(Math.round(saved), 600, Math.max(p50 * 3, 0)) : 0 };
}

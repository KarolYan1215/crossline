/**
 * A thin local translator so a model that only speaks Chat Completions can still be driven by Codex (decided 2026-10-13: every
 * provider goes through the same Codex path). Codex 0.155 accepts only `wire_api = "responses"`; its requests are stateless
 * (`store: false`, `stream: true`, no `previous_response_id` — the whole conversation is in `input` every time), so one request maps
 * to one Chat Completions call and nothing is kept between them.
 *
 * This file is the translation only (pure functions); `model-gateway.ts` is the local listener that uses it.
 */
export type BridgeUpstream = {
  /** Everything before `/chat/completions`, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  /**
   * How a JSON schema is asked for. `json_schema` is OpenAI's strict form; a provider that only knows JSON mode (`json_object`) gets
   * the schema in the system message instead, and the validators behind the repair loop do the checking.
   */
  responseFormat?: "json_schema" | "json_object";
  /** Passes `reasoning.effort` on as `reasoning_effort`; off by default because most compatible endpoints reject the field. */
  reasoningEffort?: boolean;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The text of a Responses content array (or a plain string), images aside. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => text(record(part)?.text)).filter(Boolean).join("\n");
}

function userContent(content: unknown): unknown {
  if (!Array.isArray(content) || !content.some((part) => record(part)?.type === "input_image")) return contentText(content);
  return content.flatMap((part): Json[] => {
    const item = record(part);
    if (item?.type === "input_image" && typeof item.image_url === "string") return [{ type: "image_url", image_url: { url: item.image_url } }];
    return typeof item?.text === "string" ? [{ type: "text", text: item.text }] : [];
  });
}

/** What a flat Chat Completions function name stands for on the Codex side. */
export type ToolName = { name: string; namespace?: string; custom: boolean };
export type ChatRequest = { body: Json; dropped: string[]; tools: Record<string, ToolName> };

/** Chat Completions has no namespaces: `skills.list` travels as `skills__list` and is put back on the way out. */
const flatName = (name: string, namespace?: string) =>
  (namespace && namespace !== "functions" ? `${namespace}__${name}` : name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/** One Responses request as one Chat Completions request. `dropped` names what had no Chat Completions form. */
export function responsesToChat(request: Json, upstream: Pick<BridgeUpstream, "responseFormat" | "reasoningEffort"> = {}): ChatRequest {
  const dropped = new Set<string>();
  const system: string[] = [];
  if (text(request.instructions)) system.push(text(request.instructions));
  const messages: Json[] = [];
  const lastAssistant = () => { const last = messages[messages.length - 1]; return last?.role === "assistant" ? last : undefined; };
  const names: Record<string, ToolName> = {};
  const tools: Json[] = [];
  const addTool = (raw: unknown, namespace?: string) => {
    const tool = record(raw);
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) { for (const inner of tool.tools) addTool(inner, text(tool.name)); return; }
    if ((tool?.type !== "function" && tool?.type !== "custom") || typeof tool.name !== "string") { dropped.add(`tool:${String(tool?.type)}`); return; }
    const custom = tool.type === "custom";
    const flat = flatName(tool.name, namespace);
    if (names[flat]) return;
    names[flat] = { name: tool.name, ...(namespace && namespace !== "functions" ? { namespace } : {}), custom };
    tools.push({ type: "function", function: { name: flat, description: text(tool.description), parameters: custom
      ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
      : record(tool.parameters) ?? { type: "object", properties: {} } } });
  };

  for (const raw of Array.isArray(request.input) ? request.input : []) {
    const item = record(raw);
    if (!item) continue;
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const role = text(item.role);
      // Many compatible endpoints accept one leading system message only; developer text is instructions wherever Codex put it.
      if (role === "system" || role === "developer") { const body = contentText(item.content); if (body) system.push(body); }
      else if (role === "assistant") messages.push({ role: "assistant", content: contentText(item.content) });
      else messages.push({ role: "user", content: userContent(item.content) });
    } else if (type === "additional_tools") {
      // Tools Codex makes available partway through a conversation; Chat Completions only has the one list.
      for (const tool of Array.isArray(item.tools) ? item.tools : []) addTool(tool);
    } else if (type === "function_call" || type === "custom_tool_call") {
      const custom = type === "custom_tool_call";
      const call = { id: text(item.call_id), type: "function", function: { name: flatName(text(item.name), text(item.namespace) || undefined),
        arguments: custom ? JSON.stringify({ input: text(item.input) }) : text(item.arguments) || "{}" } };
      const previous = lastAssistant();
      if (previous) previous.tool_calls = [...(Array.isArray(previous.tool_calls) ? previous.tool_calls : []), call];
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const output = record(item.output);
      messages.push({ role: "tool", tool_call_id: text(item.call_id),
        content: typeof item.output === "string" ? item.output : contentText(output?.content ?? item.output) });
    } else if (type === "reasoning") {
      // Stateless: a provider's own reasoning is not sent back to it.
    } else dropped.add(`input:${String(type)}`);
  }
  for (const tool of Array.isArray(request.tools) ? request.tools : []) addTool(tool);

  const format = record(record(request.text)?.format);
  let responseFormat: Json | undefined;
  if (format?.type === "json_schema") {
    if ((upstream.responseFormat ?? "json_schema") === "json_schema")
      responseFormat = { type: "json_schema", json_schema: { name: text(format.name) || "output", schema: format.schema, strict: format.strict !== false } };
    else {
      // JSON mode makes every reply a JSON object, so a model offered functions could never call one first: on SiliconFlow's DeepSeek
      // the tools assistant finished in seven seconds with no call and nothing made, and the interview's lookups were never used
      // (2026-10-19). With functions on offer the JSON is asked for in words, for the final reply only; the runner reads it and its
      // repair loop sends back anything that is not JSON.
      if (!tools.length) responseFormat = { type: "json_object" };
      // Without a schema the endpoint enforces, models echoed the input's own keys (`version`, `caseId`, `prompt`) into the answer
      // (GLM on SiliconFlow, 2026-10-18): the answer's keys are the schema's, and only those.
      const lead = tools.length
        ? "Call the functions you need first, as many times as the task needs. When you are finished, your final reply is one JSON object only"
        : "Reply with one JSON object only";
      system.push(`${lead}, no prose and no code fence, that validates against this JSON Schema. Use exactly the schema's own properties: never copy keys or fields from the user's message into the answer.\n${JSON.stringify(format.schema)}`);
    }
  }

  const effort = text(record(request.reasoning)?.effort);
  const body: Json = {
    model: request.model,
    messages: [...(system.length ? [{ role: "system", content: system.join("\n\n") }] : []), ...messages],
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length ? { tools, tool_choice: request.tool_choice === "none" ? "none" : "auto",
      ...(typeof request.parallel_tool_calls === "boolean" ? { parallel_tool_calls: request.parallel_tool_calls } : {}) } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(upstream.reasoningEffort && effort ? { reasoning_effort: effort } : {})
  };
  return { body, dropped: [...dropped], tools: names };
}

/** One server-sent event in the Responses stream format. */
export const sseEvent = (type: string, payload: Json): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

/**
 * Chat Completions stream chunks in, Responses stream events out. Items are emitted in the order Codex expects: reasoning (when the
 * provider streams it, which also keeps the connection visibly alive while a thinking model works), the message, then tool calls.
 */
export function createChatStreamTranslator(responseId: string, toolNames: Record<string, ToolName> = {}) {
  let sequence = 0;
  let outputIndex = 0;
  const out: string[] = [];
  const emit = (type: string, payload: Json) => out.push(sseEvent(type, { sequence_number: sequence++, ...payload }));
  let reasoning: { id: string; index: number; text: string } | undefined;
  let message: { id: string; index: number; text: string } | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Json | undefined;
  let finish: string | undefined;
  let thinkOpen = false;

  const closeReasoning = () => {
    if (!reasoning) return;
    emit("response.output_item.done", { output_index: reasoning.index,
      item: { type: "reasoning", id: reasoning.id, summary: [], content: [{ type: "reasoning_text", text: reasoning.text }] } });
    reasoning = undefined;
  };
  const addReasoning = (delta: string) => {
    if (!delta) return;
    if (!reasoning) {
      reasoning = { id: `rs_${responseId}_${outputIndex}`, index: outputIndex++, text: "" };
      emit("response.output_item.added", { output_index: reasoning.index, item: { type: "reasoning", id: reasoning.id, summary: [] } });
    }
    reasoning.text += delta;
    emit("response.reasoning_text.delta", { item_id: reasoning.id, output_index: reasoning.index, content_index: 0, delta });
  };
  const addText = (delta: string) => {
    if (!delta) return;
    closeReasoning();
    if (!message) {
      message = { id: `msg_${responseId}_${outputIndex}`, index: outputIndex++, text: "" };
      emit("response.output_item.added", { output_index: message.index, item: { type: "message", id: message.id, role: "assistant", content: [] } });
    }
    message.text += delta;
    emit("response.output_text.delta", { item_id: message.id, output_index: message.index, content_index: 0, delta });
  };
  /** A model that writes its thinking inline as `<think>…</think>` (no separate field) has it moved out of the answer. */
  const addContent = (delta: string) => {
    let rest = delta;
    while (rest) {
      if (thinkOpen) {
        const end = rest.indexOf("</think>");
        if (end < 0) { addReasoning(rest); return; }
        addReasoning(rest.slice(0, end)); rest = rest.slice(end + 8); thinkOpen = false;
      } else {
        const start = !message || !message.text.trim() ? rest.indexOf("<think>") : -1;
        if (start < 0 || rest.slice(0, start).trim()) { addText(rest); return; }
        rest = rest.slice(start + 7); thinkOpen = true;
      }
    }
  };

  return {
    start(model: unknown): string[] {
      emit("response.created", { response: { id: responseId, object: "response", status: "in_progress", model } });
      return out.splice(0);
    },
    push(chunk: Json): string[] {
      if (record(chunk.usage)) usage = record(chunk.usage);
      for (const raw of Array.isArray(chunk.choices) ? chunk.choices : []) {
        const choice = record(raw);
        const delta = record(choice?.delta) ?? {};
        addReasoning(text(delta.reasoning_content) || text(delta.reasoning));
        addContent(text(delta.content));
        for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const call = record(rawCall);
          const index = typeof call?.index === "number" ? call.index : calls.size;
          const entry = calls.get(index) ?? { id: "", name: "", arguments: "" };
          const fn = record(call?.function);
          if (typeof call?.id === "string" && call.id) entry.id = call.id;
          if (typeof fn?.name === "string") entry.name += fn.name;
          if (typeof fn?.arguments === "string") entry.arguments += fn.arguments;
          calls.set(index, entry);
        }
        if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
      }
      return out.splice(0);
    },
    end(): string[] {
      closeReasoning();
      if (message) {
        const answer = message.text.trim();
        emit("response.output_text.done", { item_id: message.id, output_index: message.index, content_index: 0, text: answer });
        emit("response.output_item.done", { output_index: message.index,
          item: { type: "message", id: message.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] } });
      }
      for (const [position, call] of [...calls].sort((a, b) => a[0] - b[0])) {
        const callId = call.id || `call_${responseId}_${position}`;
        const known = toolNames[call.name];
        const namespace = known?.namespace ? { namespace: known.namespace } : {};
        let item: Json = { type: "function_call", id: `fc_${responseId}_${position}`, call_id: callId, name: known?.name ?? call.name, ...namespace,
          arguments: call.arguments || "{}" };
        if (known?.custom) {
          let input = call.arguments;
          try { input = text(record(JSON.parse(call.arguments))?.input) || call.arguments; } catch { /* the raw text is the input */ }
          item = { type: "custom_tool_call", id: `ctc_${responseId}_${position}`, call_id: callId, name: known.name, ...namespace, input };
        }
        emit("response.output_item.done", { output_index: outputIndex++, item });
      }
      if (finish === "length" || finish === "content_filter") {
        emit("response.incomplete", { response: { id: responseId, status: "incomplete",
          incomplete_details: { reason: finish === "length" ? "max_output_tokens" : "content_filter" } } });
        return out.splice(0);
      }
      const input = Number(usage?.prompt_tokens ?? 0);
      const output = Number(usage?.completion_tokens ?? 0);
      const cached = Number(record(usage?.prompt_tokens_details)?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0);
      const thought = Number(record(usage?.completion_tokens_details)?.reasoning_tokens ?? 0);
      emit("response.completed", { response: { id: responseId, object: "response", status: "completed",
        usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output,
          output_tokens_details: { reasoning_tokens: thought }, total_tokens: Number(usage?.total_tokens ?? input + output) } } });
      return out.splice(0);
    }
  };
}

/**
 * An upstream error, in the codes Codex already knows how to treat: a full context and a spent balance end the turn with a reason the
 * person can act on, a rate limit or an overloaded server is retried by Codex itself, anything else is reported with the provider's
 * own message.
 */
export function upstreamFailure(status: number, body: string): { code: string; message: string } {
  let message = body.slice(0, 600);
  try {
    const parsed = record(JSON.parse(body));
    const error = record(parsed?.error) ?? parsed;
    if (typeof error?.message === "string") message = error.message;
  } catch { /* not JSON: the raw text is the message */ }
  const code = /context|too long|maximum.*tokens|token limit/i.test(message) && status === 400 ? "context_length_exceeded"
    : status === 402 || /insufficient.*(balance|quota)|余额不足|arrearage/i.test(message) ? "insufficient_quota"
    : status === 429 ? "rate_limit_exceeded"
    : status === 503 || status === 529 ? "server_is_overloaded"
    : status >= 500 ? "server_error" : "invalid_request";
  return { code, message: message || `HTTP ${status}` };
}

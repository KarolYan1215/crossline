import { expect, test } from "vitest";
import { createChatStreamTranslator, freeformDescription, responsesToChat, upstreamFailure } from "./chat-bridge";

/** Parses the SSE lines a translator produced back into events. */
const events = (lines: string[]) => lines.map((line) => JSON.parse(line.split("\ndata: ")[1]!) as Record<string, unknown> & { type: string });

test("a Codex Responses request becomes one Chat Completions request: instructions and developer text lead, the schema becomes response_format", () => {
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const { body, dropped } = responsesToChat({
    model: "deepseek-chat", instructions: "base", store: false, stream: true, include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high", summary: "auto" }, tool_choice: "auto", parallel_tool_calls: false,
    text: { format: { type: "json_schema", strict: true, schema, name: "codex_output_schema" } },
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "be careful" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", summary: [], encrypted_content: "x" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "web_search_call", id: "ws1" }
    ]
  });
  expect(body.messages).toEqual([
    { role: "system", content: "base\n\nbe careful" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ]);
  expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "codex_output_schema", schema, strict: true } });
  expect(body.stream).toBe(true);
  // Effort is not passed unless the upstream says it takes it; most compatible endpoints reject the field.
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(body).not.toHaveProperty("tools");
  expect(dropped).toEqual(["input:web_search_call"]);
});

test("a provider with JSON mode only gets json_object and the schema in its instructions", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const { body } = responsesToChat({ model: "m", input: [], text: { format: { type: "json_schema", strict: true, schema, name: "s" } } }, { responseFormat: "json_object" });
  expect(body.response_format).toEqual({ type: "json_object" });
  expect((body.messages as Array<{ content: string }>)[0]!.content).toContain(JSON.stringify(schema));
});

test("with functions on offer, JSON mode is not forced: the model may call them first and gives the JSON as its final reply", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const { body } = responsesToChat({ model: "m", input: [], tools: [{ type: "function", name: "read_file", description: "", parameters: { type: "object", properties: {} } }],
    text: { format: { type: "json_schema", strict: true, schema, name: "s" } } }, { responseFormat: "json_object" });
  expect(body.response_format).toBeUndefined();
  expect(body.tool_choice).toBe("auto");
  const system = (body.messages as Array<{ content: string }>)[0]!.content;
  expect(system).toContain("Call the functions you need first");
  expect(system).toContain(JSON.stringify(schema));
});

test("tools: namespaces flatten to ns__name and come back with their namespace; earlier calls and outputs replay as tool messages", () => {
  const chat = responsesToChat({ model: "m", tools: [
    { type: "function", name: "lookup", description: "d", parameters: { type: "object", properties: {} } },
    { type: "namespace", name: "skills", tools: [{ type: "function", name: "list", description: "", parameters: { type: "object", properties: {} } }] },
    { type: "web_search" }
  ], input: [
    { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "run" }] }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
    { type: "function_call", name: "list", namespace: "skills", arguments: "{}", call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "result" }
  ] });
  const names = (chat.body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  expect(names).toEqual(["exec", "lookup", "skills__list"]);
  expect(chat.dropped).toEqual(["tool:web_search"]);
  expect(chat.body.messages).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "skills__list", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "result" }
  ]);

  const translator = createChatStreamTranslator("r1", chat.tools);
  translator.start("m");
  translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "skills__list", arguments: "{\"a\"" } }] } }] });
  translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: "tool_calls" }] });
  translator.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_10", function: { name: "exec", arguments: "{\"input\":\"1+1\"}" } }] } }] });
  const items = events(translator.end()).filter((event) => event.type === "response.output_item.done").map((event) => event.item);
  expect(items).toEqual([
    { type: "function_call", id: "fc_r1_0", call_id: "call_9", name: "list", namespace: "skills", arguments: "{\"a\":1}" },
    { type: "custom_tool_call", id: "ctc_r1_1", call_id: "call_10", name: "exec", input: "1+1" }
  ]);
});

test("the stream: reasoning (a field or inline <think>) becomes a reasoning item, the text a message, usage the completion", () => {
  const translator = createChatStreamTranslator("r2");
  const out = [...translator.start("m"),
    ...translator.push({ choices: [{ delta: { reasoning_content: "let me " } }] }),
    ...translator.push({ choices: [{ delta: { content: "<think>more" } }] }),
    ...translator.push({ choices: [{ delta: { content: " thought</think>{\"ok\":" } }] }),
    ...translator.push({ choices: [{ delta: { content: "true}" }, finish_reason: "stop" }] }),
    ...translator.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } }),
    ...translator.end()];
  const parsed = events(out);
  expect(parsed[0]).toMatchObject({ type: "response.created", response: { id: "r2" } });
  const done = parsed.filter((event) => event.type === "response.output_item.done").map((event) => event.item as Record<string, unknown>);
  expect(done[0]).toMatchObject({ type: "reasoning", content: [{ type: "reasoning_text", text: "let me more thought" }] });
  expect(done[1]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"ok\":true}" }] });
  expect(parsed.at(-1)).toMatchObject({ type: "response.completed", response: { id: "r2",
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 } } });
  // Every event carries an increasing sequence number.
  expect(parsed.map((event) => event.sequence_number)).toEqual(parsed.map((_, index) => index));
});

test("a cut-off answer is reported as incomplete, not as a finished one", () => {
  const translator = createChatStreamTranslator("r3");
  translator.start("m");
  translator.push({ choices: [{ delta: { content: "{\"a\":\"aaaa" }, finish_reason: "length" }] });
  expect(events(translator.end()).at(-1)).toMatchObject({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
});

test("upstream errors land on the codes Codex already treats: full context, spent balance, rate limit", () => {
  expect(upstreamFailure(400, JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens" } })).code).toBe("context_length_exceeded");
  expect(upstreamFailure(402, JSON.stringify({ error: { message: "Insufficient Balance" } }))).toEqual({ code: "insufficient_quota", message: "Insufficient Balance" });
  expect(upstreamFailure(429, "slow down").code).toBe("rate_limit_exceeded");
  expect(upstreamFailure(500, "").code).toBe("server_error");
});

test("a freeform tool travels as a function whose description no longer says 'not JSON' and says how to send the text", () => {
  const description = "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON. The patch starts with *** Begin Patch.";
  const out = freeformDescription(description);
  expect(out).not.toMatch(/do not wrap the patch in JSON/i);
  expect(out).toContain("Use the `apply_patch` tool to edit files.");
  expect(out).toContain("The patch starts with *** Begin Patch.");
  expect(out).toContain("one argument, `input`");
  const { body } = responsesToChat({ model: "m", input: [], tools: [{ type: "custom", name: "apply_patch", description }] });
  const tool = (body.tools as Array<{ function: { name: string; description: string } }>)[0]!;
  expect(tool.function.name).toBe("apply_patch");
  expect(tool.function.description).toBe(out);
});

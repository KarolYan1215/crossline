import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RELATION_KIND_LABEL, WANT_OPTIONS, ruleLines, wantsPlan } from "@crossline/core/assess-wants";
import { TYPE_CODES } from "@crossline/core/assess-content";
import { posterFonts } from "../poster/fonts";
import { storedResult } from "../avatar/testing";
import { useTempDataDir } from "../testing";
import { composeWants, configureWants } from "./index";
import { ChatCompletionsModel, jsonFromAnswer, textModelFromEnv, textModelSummary, type ChatMessage, type TextModel } from "./text-model";

const temp = useTempDataDir();
beforeEach(() => {
  temp.dir();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  temp.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("the text model is off unless key, https address and model are all set, and the log never carries the key", () => {
  expect(textModelFromEnv({})).toBeNull();
  expect(textModelFromEnv({ ASSESS_TEXT_API_KEY: "k", ASSESS_TEXT_MODEL: "m" })).toBeNull();
  expect(textModelFromEnv({ ASSESS_TEXT_API_KEY: "k", ASSESS_TEXT_BASE_URL: "http://plain.example/v1", ASSESS_TEXT_MODEL: "m" })).toBeNull();
  expect(textModelFromEnv({ ASSESS_TEXT_API_KEY: "k", ASSESS_TEXT_BASE_URL: "https://api.example.com/v1/", ASSESS_TEXT_MODEL: "m" })?.label).toBe("api.example.com:m");
  expect(textModelSummary({}).reason).toContain("ASSESS_TEXT_API_KEY");
  expect(JSON.stringify(textModelSummary({ ASSESS_TEXT_API_KEY: "secret-key", ASSESS_TEXT_BASE_URL: "https://a.example", ASSESS_TEXT_MODEL: "m" }))).not.toContain("secret-key");
});

test("an OpenAI-compatible call: Bearer key, the model, JSON mode unless turned off, and the message text back", async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ choices: [{ message: { content: "{\"ok\":1}" } }] }));
  const model = new ChatCompletionsModel({ apiKey: "k", baseUrl: "https://api.example.com/v1", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(await model.complete([{ role: "user", content: "hi" }])).toBe("{\"ok\":1}");
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
  expect((init!.headers as Record<string, string>).authorization).toBe("Bearer k");
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: "m", response_format: { type: "json_object" } });
  const plain = new ChatCompletionsModel({ apiKey: "k", baseUrl: "https://api.example.com/v1", model: "m", jsonMode: false, fetchImpl: fetchImpl as unknown as typeof fetch });
  await plain.complete([]);
  expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("response_format");
  const refusing = new ChatCompletionsModel({ apiKey: "k", baseUrl: "https://api.example.com", model: "m", fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
  await expect(refusing.complete([])).rejects.toThrow("TEXT_API_401");
});

test("the JSON is read out of a fenced or chatty answer", () => {
  expect(jsonFromAnswer("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  expect(jsonFromAnswer("好的：{\"a\":2} 希望有帮助")).toEqual({ a: 2 });
  expect(jsonFromAnswer("没有")).toBeUndefined();
});

test("an answer the poster's face cannot print falls back to the rules, logged", async () => {
  const answer = JSON.stringify({
    lines: [{ domain: "", identity: "创作者" }, { domain: "", identity: "研究者" }, { domain: "猫咪", identity: "创业者" }],
    loop: ["素材", "研究", "小店", "回到节目"],
    links: [{ from: 0, to: 1, kind: "提供输入", how: "素材变成线索" }, { from: 1, to: 2, kind: "促成", how: "结论变成选品" }, { from: 2, to: 0, kind: "反馈回路", how: "顾客回到节目" }]
  });
  const model: TextModel = { label: "fake", complete: async (_messages: ChatMessage[]) => answer };
  configureWants({ model });
  const warn = vi.mocked(console.warn);
  const lines = await composeWants(storedResult(), { picks: ["music"], text: "想养一只猫" });
  expect(lines.source).toBe("rules");
  expect(String(warn.mock.calls.at(-1)?.[0])).toContain("TEXT_ANSWER_UNPRINTABLE");
});

test("today's text budget stops model calls, not answers", async () => {
  vi.stubEnv("ASSESS_TEXT_DAILY_LIMIT", "1");
  const complete = vi.fn(async () => "{}");
  configureWants({ model: { label: "fake", complete } });
  await composeWants(storedResult(), { picks: ["music"], text: "" });
  const second = await composeWants(storedResult(), { picks: ["music"], text: "" });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(second.source).toBe("rules");
});

test("everything the rules and the written combinations can print is in the poster's sans face", () => {
  const glyphs = posterFonts().glyphs.Sans;
  const strings = [...WANT_OPTIONS.flatMap((option) => [option.label, option.identity, option.domain, option.short, option.make, option.verb, option.feedback]),
    ...Object.values(RELATION_KIND_LABEL), "占用时间也撑住的精力之外给留出时间成为的素材带来输入回到"];
  for (const code of TYPE_CODES) for (const option of WANT_OPTIONS) {
    const plan = wantsPlan(code, { picks: [option.id], text: "" }).lines;
    strings.push(...plan.loop, ...plan.links.map((link) => link.how), ...ruleLines(code, [option.id]).loop);
  }
  const missing = [...new Set(strings.join(""))].filter((char) => char !== " " && !glyphs.has(char));
  expect(missing).toEqual([]);
});

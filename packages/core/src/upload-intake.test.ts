import { describe, expect, test } from "vitest";
import { chatHistoryName, chatHistoryText, parseChatHistory } from "./chat-history";
import { nearDuplicatePairs, simhash, simhashDistance } from "./near-duplicates";
import { maskPersonalNumbers, validateFolderScreen } from "./source-folders";
import { validateSourceVersions } from "./source-digest";

describe("masking the numbers in a file given on purpose", () => {
  test("SSN, resident ID, card, IBAN and labelled account numbers are hidden, keeping the last four", () => {
    const { text, masked } = maskPersonalNumbers([
      "SSN 123-45-6789", "身份证 11010519491231002X", "Visa 4111 1111 1111 1111", "IBAN GB82 WEST 1234 5698 7654 32", "账号：6222 0200 1234 5678",
      "Passport No. E12345678"
    ].join("\n"));
    expect(text).not.toMatch(/123-45-6789|11010519491231002X|4111 1111 1111 1111|GB82 WEST|6222 0200 1234 5678|E12345678/);
    expect(text).toContain("尾号 6789");
    expect(text).toContain("尾号 002X");
    expect(text).toContain("尾号 1111");
    expect(masked).toEqual(["社安号", "身份证号", "账号", "银行卡号", "护照号"]);
  });

  test("numbers that only look like one are left alone", () => {
    const plain = "订单 2026-11-22，电话 4111 1111 1111 1112，学号 110105194912310021，页码 1234 5678";
    expect(maskPersonalNumbers(plain)).toEqual({ text: plain, masked: [] });
  });
});

describe("AI conversation exports", () => {
  test("names: ChatGPT's export, Codex rollouts (also zstd), Claude Code sessions; other JSON is not one", () => {
    expect(chatHistoryName("export/conversations.json")).toBe(true);
    expect(chatHistoryName("sessions/2026/11/rollout-2026-11-01T10-00-00-abc.jsonl.zst")).toBe(true);
    expect(chatHistoryName("projects/x/0b9c1d2e-1111-2222-3333-444455556666.jsonl")).toBe(true);
    expect(chatHistoryName("package.json")).toBe(false);
  });

  test("ChatGPT: only what the person typed, hidden system messages and the assistant left out", () => {
    const history = parseChatHistory(JSON.stringify([{ title: "求职计划", create_time: 1_760_000_000, mapping: {
      a: { message: { author: { role: "system" }, content: { content_type: "text", parts: ["You are ChatGPT"] }, create_time: 1 } },
      b: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["我想在三月前换工作"] }, create_time: 2 } },
      c: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["好的"] }, create_time: 3 } },
      d: { message: { author: { role: "user" }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: "text", parts: ["custom instructions"] }, create_time: 4 } }
    } }]));
    expect(history).toEqual({ format: "chatgpt", conversations: [{ title: "求职计划", startedAt: "2025-10-09", said: ["我想在三月前换工作"] }] });
  });

  test("Codex: the typed messages, not AGENTS.md, environment blocks or tool output", () => {
    const lines = [
      { type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { cwd: "C:\\work\\crossline" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for C:\\work" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "<environment_context>cwd</environment_context>" } },
      { type: "event_msg", payload: { type: "user_message", message: "把导入改成并行" } },
      { type: "response_item", payload: { type: "function_call_output", output: "secret tool output" } }
    ].map((line) => JSON.stringify(line)).join("\n");
    const history = parseChatHistory(lines)!;
    expect(history.conversations).toEqual([{ title: "crossline", startedAt: "2026-11-01", said: ["把导入改成并行"] }]);
    const text = chatHistoryText(history);
    expect(text).toContain("把导入改成并行");
    expect(text).not.toMatch(/AGENTS\.md instructions|environment_context|secret tool output/);
  });

  test("Claude Code: user lines that are not meta, tool results or injected reminders", () => {
    const lines = [
      { type: "user", sessionId: "s", timestamp: "2026-11-02T08:00:00Z", message: { role: "user", content: "帮我整理周计划" } },
      { type: "user", sessionId: "s", isMeta: true, message: { role: "user", content: "Caveat: The messages below were generated" } },
      { type: "user", sessionId: "s", message: { role: "user", content: [{ type: "tool_result", content: "ls output" }] } },
      { type: "user", sessionId: "s", message: { role: "user", content: "<system-reminder>be nice</system-reminder>" } },
      { type: "assistant", sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "好" }] } }
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(parseChatHistory(lines)?.conversations[0]?.said).toEqual(["帮我整理周计划"]);
  });

  test("an ordinary JSON file is not taken for one", () => {
    expect(parseChatHistory(JSON.stringify([{ name: "x" }]))).toBeUndefined();
    expect(parseChatHistory("{\"a\":1}\n{\"b\":2}")).toBeUndefined();
  });
});

describe("near-duplicate candidates", () => {
  const base = Array.from({ length: 40 }, (_, index) => `第${index}段：本项目的目标是在十二月底前完成原型并约到五位用户访谈。`).join("\n");
  test("an edited copy is close, an unrelated text is far, a short text has no hash", () => {
    const edited = base.replace("第3段", "第三段").replace("五位", "六位");
    const other = Array.from({ length: 40 }, (_, index) => `Line ${index}: quarterly budget review with the finance team and vendors.`).join("\n");
    const [a, b, c] = [simhash(base)!, simhash(edited)!, simhash(other)!];
    expect(simhashDistance(a, b)).toBeLessThan(simhashDistance(a, c));
    expect(nearDuplicatePairs([{ id: "a", hash: a }, { id: "b", hash: b }, { id: "c", hash: c }]).map((pair) => [pair.a, pair.b])).toEqual([["a", "b"]]);
    expect(simhash("太短")).toBeUndefined();
  });
});

describe("validating the model's answers", () => {
  test("folder screening keeps only offered indexes, once each, up to the limit", () => {
    expect(validateFolderScreen({ keep: [2, 2, 9, -1, 1.5, 0, 1], why: " 留计划 " }, 3, 2)).toEqual({ keep: [2, 0], why: "留计划" });
    expect(() => validateFolderScreen({ why: "" }, 3, 2)).toThrow("FOLDER_SCREEN_INVALID");
  });

  test("version pairs answer only the pairs asked about", () => {
    const answer = validateSourceVersions({ pairs: [
      { a: "x", b: "y", sameDocument: true, latestId: "y", olderSummary: "旧版", differences: "改了日期", why: "同一份计划" },
      { a: "x", b: "z", sameDocument: true, latestId: "z", olderSummary: "", differences: "", why: "" }
    ] }, [{ a: "x", b: "y" }]);
    expect(answer.pairs.map((pair) => [pair.a, pair.b, pair.latestId])).toEqual([["x", "y", "y"]]);
  });
});

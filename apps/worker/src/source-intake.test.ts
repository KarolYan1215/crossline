import zlib from "node:zlib";
import { expect, test } from "vitest";
import { readSourceText, screenUploadedText } from "./source-intake";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

test("a direct upload is refused when its name or opening is a credential, before any model sees it", () => {
  expect(screenUploadedText("AccessKey.txt", "id,secret")).toMatchObject({ refused: true, code: "SOURCE_CREDENTIAL" });
  expect(screenUploadedText("notes.md", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx")).toMatchObject({ refused: true });
  expect(screenUploadedText("deploy.md", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toMatchObject({ refused: true });
});

test("a direct upload with papers in it is read, its ID, card and account numbers masked and a key deep inside cut out", () => {
  const text = `${"个人简历。".repeat(600)}\n身份证号 11010519491231002X，卡 4111 1111 1111 1111，账号：6222020200112233445\n附：token is sk-abcdefghijklmnopqrstuv`;
  const verdict = screenUploadedText("简历.md", text);
  if (verdict.refused) throw new Error("refused");
  expect(verdict.text).not.toContain("11010519491231002X");
  expect(verdict.text).not.toContain("4111 1111 1111 1111");
  expect(verdict.text).not.toContain("6222020200112233445");
  expect(verdict.text).not.toContain("sk-abcdefghijklmnopqrstuv");
  expect(verdict.text).toContain("尾号 002X");
  expect(verdict.note).toContain("密钥已移除");
  expect(verdict.note).toContain("身份证号");
  expect(screenUploadedText("plan.md", "下周写完第三章")).toEqual({ refused: false, text: "下周写完第三章" });
});

test("an AI conversation export keeps only what the person said, also from a zstd-compressed Codex rollout", async () => {
  const rollout = [
    { type: "session_meta", timestamp: "2026-05-01T10:00:00Z", payload: { cwd: "C:\\work\\crossline", timestamp: "2026-05-01T10:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for C:\\work" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "帮我把上传改成并行" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] } },
    { type: "response_item", payload: { type: "function_call_output", output: "tool output" } }
  ].map((line) => JSON.stringify(line)).join("\n");
  const plain = await readSourceText(bytes(rollout), "text", "rollout-2026-05-01.jsonl");
  expect(plain.status).toBe("done");
  expect(plain.text).toContain("帮我把上传改成并行");
  expect(plain.text).not.toContain("AGENTS.md");
  expect(plain.text).not.toContain("好的");
  expect(plain.text).not.toContain("tool output");
  const zstd = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
  if (zstd) expect((await readSourceText(new Uint8Array(zstd(Buffer.from(rollout))), "text", "rollout-2026-05-01.jsonl.zst")).text).toContain("帮我把上传改成并行");
  // An ordinary JSON file is read as it is.
  expect((await readSourceText(bytes("{\"a\": 1}"), "text", "settings.json")).text).toBe("{\"a\": 1}");
});

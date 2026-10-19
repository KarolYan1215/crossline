import { expect, test } from "vitest";
import { organizingNote } from "./stage-view";

test("the organizing line says nothing when no model can run: the conversation already says why, and nothing would retry sooner", () => {
  const failing = (code: string) => ({ replies: 1, files: 0, failing: { code, message: "…" } });
  expect(organizingNote(failing("MODEL_SPONSOR_PENDING"))).toBe("");
  expect(organizingNote(failing("RUNTIME_UNCONNECTED"))).toBe("");
  expect(organizingNote(failing("SKILL_TIMEOUT"))).toContain("自动重试");
  expect(organizingNote({ replies: 1, files: 0 })).toBe("正在整理刚才的回答…");
  expect(organizingNote({ replies: 0, files: 2 })).toBe("正在整理 2 份材料…");
});

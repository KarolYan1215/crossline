import { expect, test } from "vitest";
import { AGENT_SUMMARY_SCHEMA, validateAgentSummary, type ArtifactProbe } from "./agent-summary";

const files: Record<string, number> = { "notes.md": 1200, "plot.py": 300, "empty.txt": 0 };
const probe: ArtifactProbe = (path) => ({ exists: path in files, bytes: files[path] ?? 0, insideDirectory: !path.startsWith("..") });
const base = { summary: "整理了练习清单和笔记，并检查了链接。", artifacts: [{ path: "notes.md", purpose: "笔记" }], verification: [{ check: "链接可打开", result: "pass" as const, evidence: "逐个请求，全部 200" }],
  needsHuman: [], notDone: [], assumptions: [] };
const code = (over: object) => { try { validateAgentSummary({ ...base, ...over }, probe); } catch (error) { return (error as Error).message; } return "ok"; };

test("a summary whose artifacts exist and were checked passes", () => {
  expect(code({})).toBe("ok");
  expect(code({ artifacts: [], verification: [] })).toBe("ok");
});

test("an artifact that is not there, is empty, or points outside the task directory is a false claim", () => {
  expect(code({ artifacts: [{ path: "figure.png", purpose: "图" }] })).toBe("AGENT_ARTIFACT_MISSING");
  expect(code({ artifacts: [{ path: "empty.txt", purpose: "空" }] })).toBe("AGENT_ARTIFACT_EMPTY");
  expect(code({ artifacts: [{ path: "C:\\Users\\x\\a.txt", purpose: "绝对路径" }] })).toBe("AGENT_ARTIFACT_PATH");
  expect(code({ artifacts: [{ path: "..\\other\\a.txt", purpose: "跑出去了" }] })).toBe("AGENT_ARTIFACT_PATH");
});

test("making something and checking nothing is sent back, and so is a pass with no evidence", () => {
  expect(code({ verification: [] })).toBe("AGENT_UNCHECKED");
  expect(code({ verification: [{ check: "能跑", result: "pass", evidence: "" }] })).toBe("AGENT_EVIDENCE_MISSING");
  expect(code({ verification: [{ check: "能跑", result: "not_run", evidence: "没有环境" }] })).toBe("ok");
});

test("the schema is strict-mode shaped", () => {
  expect(AGENT_SUMMARY_SCHEMA.additionalProperties).toBe(false);
  expect(AGENT_SUMMARY_SCHEMA.required).toEqual(["summary", "artifacts", "verification", "needsHuman", "notDone", "assumptions"]);
});

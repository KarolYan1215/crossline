/**
 * What the assistant says it did, and the check that it did.
 *
 * Nothing the assistant claims is taken on its word: the commands it ran and the files it changed are recorded by the app from the
 * runtime's own events. This is the part the assistant writes — a summary, the artifacts it says it made, what it checked, what it
 * leaves to the person — and the one thing checked here is the one thing that can be checked without a human: that every artifact it
 * names exists, inside the task directory, and is not empty.
 */
export type AgentSummary = {
  summary: string;
  artifacts: Array<{ path: string; purpose: string }>;
  verification: Array<{ check: string; result: "pass" | "fail" | "not_run"; evidence: string }>;
  needsHuman: Array<{ what: string; why: string }>;
  notDone: Array<{ what: string; why: string }>;
  assumptions: string[];
};

const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const pair = (a: string, b: string) => object({ [a]: text(400), [b]: text(600) });

export const AGENT_SUMMARY_SCHEMA = object({
  summary: text(1200, 10),
  artifacts: { type: "array", maxItems: 60, items: object({ path: text(300), purpose: text(400) }) },
  verification: { type: "array", maxItems: 40, items: object({ check: text(300), result: { type: "string", enum: ["pass", "fail", "not_run"] }, evidence: text(600, 0) }) },
  needsHuman: { type: "array", maxItems: 20, items: pair("what", "why") },
  notDone: { type: "array", maxItems: 20, items: pair("what", "why") },
  assumptions: { type: "array", maxItems: 20, items: text(400) }
});

function refuse(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

/** What the filesystem says about a path relative to the task directory; supplied by the caller so this file stays free of `node:fs`. */
export type ArtifactProbe = (relativePath: string) => { exists: boolean; bytes: number; insideDirectory: boolean };

export function validateAgentSummary(value: unknown, probe: ArtifactProbe): AgentSummary {
  const out = value as AgentSummary | undefined;
  if (!out || typeof out.summary !== "string" || !Array.isArray(out.artifacts) || !Array.isArray(out.verification)
    || !Array.isArray(out.needsHuman) || !Array.isArray(out.notDone) || !Array.isArray(out.assumptions)) refuse("AGENT_SUMMARY_INVALID", "输出结构不符合要求。");
  for (const artifact of out.artifacts) {
    if (/^([a-z]:|[\\/])/i.test(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
      refuse("AGENT_ARTIFACT_PATH", `产出「${artifact.path}」必须写成相对任务目录的路径，不能是绝对路径，也不能含 ..。`);
    }
    const found = probe(artifact.path);
    if (!found.insideDirectory) refuse("AGENT_ARTIFACT_PATH", `产出「${artifact.path}」不在任务目录里。`);
    if (!found.exists) refuse("AGENT_ARTIFACT_MISSING", `你说做了「${artifact.path}」，但任务目录里没有这个文件。要么把它真正做出来，要么从 artifacts 里去掉并写进 notDone。`);
    if (found.bytes === 0) refuse("AGENT_ARTIFACT_EMPTY", `「${artifact.path}」是空文件。`);
  }
  if (out.artifacts.length && !out.verification.length) {
    refuse("AGENT_UNCHECKED", "做出了产出却没有任何 verification：跑一遍你写的东西，或者老实写 not_run 并说明原因。");
  }
  if (out.verification.some((item) => item.result === "pass" && item.evidence.trim().length < 5)) {
    refuse("AGENT_EVIDENCE_MISSING", "result 为 pass 的检查要写 evidence：跑了什么命令、看到什么。");
  }
  return out;
}

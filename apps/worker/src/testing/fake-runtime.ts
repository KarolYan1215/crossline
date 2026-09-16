import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { JsonLineRpcClient } from "@crossline/codex";

/**
 * A stand-in Codex app-server, shared by the worker's Skill tests.
 *
 * It replaced two near-identical copies (analysis and material preparation), and the copies had drifted
 * into a wrong assumption: both derived the thread id from the turn counter, so a **second turn on the
 * same thread** announced itself as `thread-2` and every notification for it was filtered out by the
 * runner's own thread guard. Nothing noticed, because until the validator started asking for repairs
 * no run had ever taken more than one turn. The thread id is fixed at `thread/start` here, which is
 * what the real protocol does.
 *
 * `answers` is consumed one per turn, and the last one repeats — so a test that wants "it keeps
 * returning the same broken thing" passes one answer, and a test that wants "broken, then fixed on the
 * repair turn" passes two.
 */
export function fakeRuntime(answers: string[], skillName: string): {
  rpc: JsonLineRpcClient;
  turns: () => number;
  prompts: () => string[];
} {
  let turns = 0;
  let threads = 0;
  let threadId = "";
  const prompts: string[] = [];
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    // Counted per thread, not per turn — that conflation is the bug this helper exists to fix.
    if (request.method === "thread/start") threadId = `thread-${(threads += 1)}`;
    const result = request.method === "skills/list"
      ? { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: skillName, path: "C:\\skill\\SKILL.md", enabled: true }] }] }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/start"
        ? { thread: { id: threadId }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] }
        : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    if (request.method === "turn/start") {
      turns += 1;
      const turnId = `turn-${turns}`;
      // What the runner actually sent, so a test can assert that a repair turn carried the rejection.
      const input = request.params?.input;
      prompts.push(Array.isArray(input) ? String((input[0] as { text?: unknown })?.text ?? "") : "");
      const text = answers[turns - 1] ?? answers[answers.length - 1]!;
      setTimeout(() => {
        rpc.receiveLine(JSON.stringify({ method: "item/completed",
          params: { threadId, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } } }));
      }, 1);
    }
  });
  return { rpc, turns: () => turns, prompts: () => prompts };
}

const FIXTURES = path.join(import.meta.dirname, "fixtures");

/**
 * A model answer recorded from a real run, replayed byte for byte.
 *
 * Hand-written literals are why three acceptance rounds kept finding defects the 286 unit tests could
 * not: every fake answer was clean JSON somebody typed, so no test ever saw what the model actually
 * emits. These files are captured by setting `CROSSLINE_RECORD_DIR` on a real run — including the
 * answers that were rejected, which are the interesting ones.
 */
export function recordedAnswer(name: string): string {
  return readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
}

/** Every recorded answer whose name starts with `prefix`, so a test can sweep a whole failure class. */
export function recordedAnswers(prefix: string): Array<{ name: string; text: string }> {
  return readdirSync(FIXTURES)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".txt"))
    .sort()
    .map((file) => ({ name: file.replace(/\.txt$/, ""), text: readFileSync(path.join(FIXTURES, file), "utf8") }));
}

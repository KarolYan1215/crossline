import { readFileSync } from "node:fs";
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
 * `options.stallTurns` lists 1-based turn numbers that never answer and never emit anything (a hung backend); `interrupts()` counts the `turn/interrupt` calls they got.
 * `options.delayMs` holds each answer back, and `options.usage` makes the runtime report token usage the way the real one does.
 * `options.lostThreads` names thread ids the runtime "no longer has": a `turn/start` on one of them is answered with
 * the `thread not found` error a restarted app-server gives, which is how a stored thread id goes stale.
 *
 * `answers` entries may be functions of the prompts so far. They are consumed one per turn, and the last one repeats — so a test that wants "it keeps
 * returning the same broken thing" passes one answer, and a test that wants "broken, then fixed on the
 * repair turn" passes two.
 */
export type AgentScript = (tools: {
  threadId: string; turnId: string;
  /** A notification, as the runtime sends them (`item/started`, `item/completed`). */
  emit: (message: object) => void;
  /** A request from the runtime to the client, resolved with the client's answer. */
  ask: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) => Promise<void>;

export function fakeRuntime(answers: Array<string | ((prompts: string[]) => string)>, skillName: string, options: { lostThreads?: string[]; delayMs?: number; stallTurns?: number[];
  /** As the real runtime does: an interrupted turn then reports `turn/completed` with status `interrupted`, right away. */
  completeOnInterrupt?: boolean; usage?: { input: number; cached?: number; output: number; reasoning?: number };
  /** What the runtime does during a turn before it answers: tool items, and requests the client has to answer. */
  script?: AgentScript; threadResponse?: Record<string, unknown>;
  /** Skills of the person's library the runtime has installed (off until a run switches them on), e.g. `crossline-mine:media`. */
  library?: string[] } = {}): {
  rpc: JsonLineRpcClient;
  turns: () => number;
  prompts: () => string[];
  interrupts: () => number;
  /** The thread/start parameters the runner sent. */
  threadStarts: () => Array<Record<string, unknown>>;
  /** Every `skills/config/write` and `plugin/install` the runner sent, in order. */
  configCalls: () => Array<{ method: string; params: Record<string, unknown> }>;
} {
  let turns = 0;
  let interrupts = 0;
  let threads = 0;
  let threadId = "";
  const prompts: string[] = [];
  const starts: Array<Record<string, unknown>> = [];
  const pendingAsks = new Map<string, (value: Record<string, unknown>) => void>();
  let askId = 0;
  const configCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const libraryPath = (name: string) => `C:\\library\\${name.replace(":", "\\")}\\SKILL.md`;
  const libraryEnabled = new Map((options.library ?? []).map((name) => [libraryPath(name), false]));
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
    // The client answering one of the runtime's requests.
    if (request.method === undefined && request.id !== undefined) {
      pendingAsks.get(String(request.id))?.((request.result ?? { error: request.error }) as Record<string, unknown>);
      return;
    }
    // Counted per thread, not per turn — that conflation is the bug this helper exists to fix.
    if (request.method === "thread/start") { threadId = `thread-${(threads += 1)}`; starts.push(request.params ?? {}); }
    if (request.method === "turn/start" && options.lostThreads?.includes(String(request.params?.threadId))) {
      queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not found: ${String(request.params?.threadId)}` } })));
      return;
    }
    if (request.method === "turn/interrupt") {
      interrupts += 1;
      if (options.completeOnInterrupt) queueMicrotask(() => rpc.receiveLine(JSON.stringify({ method: "turn/completed",
        params: { threadId, turn: { id: String(request.params?.turnId), status: "interrupted" } } })));
    }
    if (request.method === "skills/config/write" || request.method === "plugin/install") configCalls.push({ method: request.method, params: request.params ?? {} });
    if (request.method === "skills/config/write" && libraryEnabled.has(String(request.params?.path))) libraryEnabled.set(String(request.params?.path), request.params?.enabled === true);
    const result = request.method === "skills/list"
      ? { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: skillName, path: "C:\\skill\\SKILL.md", enabled: true },
        ...(options.library ?? []).map((name) => ({ name, path: libraryPath(name), enabled: libraryEnabled.get(libraryPath(name)) ?? false }))] }] }
      : request.method === "skills/config/write" ? { effectiveEnabled: request.params?.enabled === true }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/start"
        ? { thread: { id: threadId }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [], ...(options.threadResponse ?? {}) }
        : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    if (request.method === "turn/start") {
      turns += 1;
      const turnId = `turn-${turns}`;
      // What the runner actually sent, so a test can assert that a repair turn carried the rejection.
      const input = request.params?.input;
      prompts.push(Array.isArray(input) ? String((input[0] as { text?: unknown })?.text ?? "") : "");
      // A hung backend: the turn starts and then nothing, ever, comes back for it.
      if (options.stallTurns?.includes(turns)) return;
      const entry = answers[turns - 1] ?? answers[answers.length - 1]!;
      // A function sees every prompt so far, for an answer that has to quote something only the run itself produced (a generated id).
      const text = typeof entry === "function" ? entry([...prompts]) : entry;
      setTimeout(async () => {
        if (options.script) {
          await options.script({
            threadId, turnId,
            emit: (message) => rpc.receiveLine(JSON.stringify(message)),
            ask: (method, params) => new Promise((resolve) => {
              const id = `ask-${(askId += 1)}`;
              pendingAsks.set(id, resolve);
              rpc.receiveLine(JSON.stringify({ id, method, params: { threadId, turnId, ...params } }));
            })
          });
        }
        if (options.usage) {
          const u = options.usage;
          const breakdown = { totalTokens: u.input + u.output, inputTokens: u.input, cachedInputTokens: u.cached ?? 0, cacheWriteInputTokens: 0, outputTokens: u.output, reasoningOutputTokens: u.reasoning ?? 0 };
          rpc.receiveLine(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null } } }));
        }
        rpc.receiveLine(JSON.stringify({ method: "item/completed",
          params: { threadId, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } } }));
      }, options.delayMs ?? 1);
    }
  });
  return { rpc, turns: () => turns, prompts: () => prompts, interrupts: () => interrupts, threadStarts: () => starts, configCalls: () => configCalls };
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

/**
 * A stand-in runtime for a pipeline that runs several Skills in a row. It knows all of them, and the answer to each turn
 * is chosen by looking at the prompt that turn was sent, so a test can say "when asked to design, answer this; when asked
 * to search, answer that" instead of counting turns.
 */
export function scriptedRuntime(skillNames: string[], respond: (prompt: string, turn: number) => string): { rpc: JsonLineRpcClient; prompts: () => string[] } {
  let turns = 0, threads = 0, threadId = "";
  const prompts: string[] = [];
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.method === "thread/start") threadId = `thread-${(threads += 1)}`;
    const result = request.method === "skills/list"
      ? { data: [{ cwd: "C:\repo", errors: [], skills: skillNames.map((name) => ({ name, path: `C:\skill\${name}\SKILL.md`, enabled: true })) }] }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/start"
        ? { thread: { id: threadId }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] }
        : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    if (request.method === "turn/start") {
      turns += 1;
      const turnId = `turn-${turns}`;
      const input = request.params?.input;
      const prompt = Array.isArray(input) ? String((input[0] as { text?: unknown })?.text ?? "") : "";
      prompts.push(prompt);
      const text = respond(prompt, turns);
      setTimeout(() => {
        rpc.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }));
      }, 1);
    }
  });
  return { rpc, prompts: () => prompts };
}

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

type Answer = string | ((prompts: string[]) => string);
export function fakeRuntime(answers: Answer[], skillName: string | string[], options: { lostThreads?: string[]; unloadedThreads?: string[]; delayMs?: number; stallTurns?: number[];
  /**
   * Answers for threads whose first prompt contains `match` (a Skill run beside another, e.g. the interview's extraction), each route
   * with its own queue; a thread keeps the route its first turn chose. Threads no route matches take `answers`.
   */
  routes?: Array<{ match: string; answers: Answer[] }>;
  /** As the real runtime does: an interrupted turn then reports `turn/completed` with status `interrupted`, right away. */
  completeOnInterrupt?: boolean; usage?: { input: number; cached?: number; output: number; reasoning?: number };
  /** Reported as `modelContextWindow` with `usage`, as the real runtime does once it knows the model. */
  contextWindow?: number;
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
  /** Threads the runner let go of (`thread/unsubscribe`), in order. */
  unsubscribed: () => string[];
  /** Threads the runner subscribed to again (`thread/resume`), in order. */
  resumes: () => string[];
  /** The `thread/resume` parameters the runner sent, in order. */
  resumeParams: () => Array<Record<string, unknown>>;
  /** Every runtime call in order, by method (to check that a compaction came between two turns). */
  calls: () => string[];
} {
  const unsubscribed: string[] = [];
  const resumes: string[] = [];
  const resumeParams: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let compactions = 0;
  // As the real runtime does: a connection gets a thread's events only while subscribed (thread/start, thread/resume); a turn
  // started on a thread it unsubscribed from still runs, silently.
  const subscribed = new Set<string>();
  const startedThreads: string[] = [];
  let turns = 0;
  let interrupts = 0;
  let threads = 0;
  let threadId = "";
  const prompts: string[] = [];
  const starts: Array<Record<string, unknown>> = [];
  const pendingAsks = new Map<string, (value: Record<string, unknown>) => void>();
  let askId = 0;
  const configCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const skillNames = Array.isArray(skillName) ? skillName : [skillName];
  const routeOf = new Map<string, number>();
  const routeTurns = new Map<number, number>();
  const libraryPath = (name: string) => `C:\\library\\${name.replace(":", "\\")}\\SKILL.md`;
  const libraryEnabled = new Map((options.library ?? []).map((name) => [libraryPath(name), false]));
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
    // The client answering one of the runtime's requests.
    if (request.method === undefined && request.id !== undefined) {
      pendingAsks.get(String(request.id))?.((request.result ?? { error: request.error }) as Record<string, unknown>);
      return;
    }
    calls.push(request.method);
    // Counted per thread, not per turn — that conflation is the bug this helper exists to fix.
    if (request.method === "thread/start") { threadId = `thread-${(threads += 1)}`; starts.push(request.params ?? {}); subscribed.add(threadId); startedThreads.push(threadId); }
    if (request.method === "thread/resume") {
      const id = String(request.params?.threadId);
      if (options.lostThreads?.includes(id)) {
        queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not found: ${id}` } })));
        return;
      }
      resumes.push(id); resumeParams.push(request.params ?? {}); subscribed.add(id);
    }
    if (request.method === "turn/start" && options.lostThreads?.includes(String(request.params?.threadId))) {
      queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not found: ${String(request.params?.threadId)}` } })));
      return;
    }
    if (request.method === "turn/interrupt") {
      interrupts += 1;
      if (options.completeOnInterrupt) queueMicrotask(() => rpc.receiveLine(JSON.stringify({ method: "turn/completed",
        params: { threadId, turn: { id: String(request.params?.turnId), status: "interrupted" } } })));
    }
    if (request.method === "thread/unsubscribe") { unsubscribed.push(String(request.params?.threadId)); subscribed.delete(String(request.params?.threadId)); }
    if (request.method === "skills/config/write" || request.method === "plugin/install") configCalls.push({ method: request.method, params: request.params ?? {} });
    if (request.method === "skills/config/write" && libraryEnabled.has(String(request.params?.path))) libraryEnabled.set(String(request.params?.path), request.params?.enabled === true);
    const result = request.method === "skills/list"
      ? { data: [{ cwd: "C:\\repo", errors: [], skills: [...skillNames.map((name, index) => ({ name, path: index ? `C:\\skill${index}\\SKILL.md` : "C:\\skill\\SKILL.md", enabled: true })),
        ...(options.library ?? []).map((name) => ({ name, path: libraryPath(name), enabled: libraryEnabled.get(libraryPath(name)) ?? false }))] }] }
      : request.method === "skills/config/write" ? { effectiveEnabled: request.params?.enabled === true }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/loaded/list" ? { data: startedThreads.filter((id) => !options.lostThreads?.includes(id) && !options.unloadedThreads?.includes(id)), nextCursor: null }
      : request.method === "thread/resume" ? { thread: { id: String(request.params?.threadId) }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [], ...(options.threadResponse ?? {}) }
      : request.method === "thread/compact/start" ? {}
      : request.method === "thread/start"
        ? { thread: { id: threadId }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [], ...(options.threadResponse ?? {}) }
        : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    // As the real runtime does: a compaction is a turn of its own, with a `contextCompaction` item.
    if (request.method === "thread/compact/start") {
      const thread = String(request.params?.threadId);
      const turnId = `compact-${(compactions += 1)}`;
      setTimeout(() => {
        rpc.receiveLine(JSON.stringify({ method: "turn/started", params: { threadId: thread, turn: { id: turnId, status: "inProgress" } } }));
        rpc.receiveLine(JSON.stringify({ method: "item/started", params: { threadId: thread, turnId, item: { type: "contextCompaction", id: `item-${turnId}` } } }));
        rpc.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId: thread, turnId, item: { type: "contextCompaction", id: `item-${turnId}` } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed" } } }));
      }, options.delayMs ?? 1);
    }
    if (request.method === "turn/start") {
      turns += 1;
      const turnId = `turn-${turns}`;
      // What the runner actually sent, so a test can assert that a repair turn carried the rejection.
      const input = request.params?.input;
      prompts.push(Array.isArray(input) ? String((input[0] as { text?: unknown })?.text ?? "") : "");
      // A hung backend: the turn starts and then nothing, ever, comes back for it.
      if (options.stallTurns?.includes(turns)) return;
      // A turn on a thread this connection unsubscribed from runs, but none of its events reach the connection.
      if (!subscribed.has(String(request.params?.threadId))) return;
      const thread = String(request.params?.threadId);
      if (!routeOf.has(thread)) routeOf.set(thread, (options.routes ?? []).findIndex((route) => prompts.at(-1)!.includes(route.match)));
      const route = routeOf.get(thread)!;
      const queue = route >= 0 ? options.routes![route]!.answers : answers;
      const nth = (routeTurns.get(route) ?? 0) + 1;
      routeTurns.set(route, nth);
      const entry = queue[nth - 1] ?? queue[queue.length - 1]!;
      // A function sees every prompt so far, for an answer that has to quote something only the run itself produced (a generated id).
      const text = typeof entry === "function" ? entry([...prompts]) : entry;
      // Each turn reports on its own thread: two runs can be in flight on one connection (the interview's dialogue and extraction).
      setTimeout(async () => {
        if (options.script) {
          await options.script({
            threadId: thread, turnId,
            emit: (message) => rpc.receiveLine(JSON.stringify(message)),
            ask: (method, params) => new Promise((resolve) => {
              const id = `ask-${(askId += 1)}`;
              pendingAsks.set(id, resolve);
              rpc.receiveLine(JSON.stringify({ id, method, params: { threadId: thread, turnId, ...params } }));
            })
          });
        }
        if (options.usage) {
          const u = options.usage;
          const breakdown = { totalTokens: u.input + u.output, inputTokens: u.input, cachedInputTokens: u.cached ?? 0, cacheWriteInputTokens: 0, outputTokens: u.output, reasoningOutputTokens: u.reasoning ?? 0 };
          rpc.receiveLine(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: options.contextWindow ?? null } } }));
        }
        rpc.receiveLine(JSON.stringify({ method: "item/completed",
          params: { threadId: thread, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed",
          params: { threadId: thread, turn: { id: turnId, status: "completed" } } }));
      }, options.delayMs ?? 1);
    }
  });
  return { rpc, turns: () => turns, prompts: () => prompts, interrupts: () => interrupts, threadStarts: () => starts, configCalls: () => configCalls,
    unsubscribed: () => unsubscribed, resumes: () => resumes, resumeParams: () => resumeParams, calls: () => calls };
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
export function scriptedRuntime(skillNames: string[], respond: (prompt: string, turn: number) => string, options: {
  /** Tokens each turn reports, as the runtime's usage event does. */
  usage?: { input: number; output: number };
  /** A runtime error the turn fails with instead of answering (`usageLimitExceeded` for a spent key), or undefined to answer. */
  failWith?: (prompt: string, turn: number) => string | undefined;
} = {}): { rpc: JsonLineRpcClient; prompts: () => string[] } {
  let turns = 0, threads = 0, latestThread = "";
  const prompts: string[] = [];
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.method === "thread/start") latestThread = `thread-${(threads += 1)}`;
    const result = request.method === "skills/list"
      ? { data: [{ cwd: "C:\repo", errors: [], skills: skillNames.map((name) => ({ name, path: `C:\skill\${name}\SKILL.md`, enabled: true })) }] }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/start"
        ? { thread: { id: latestThread }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] }
        : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    if (request.method === "turn/start") {
      turns += 1;
      const turnId = `turn-${turns}`;
      // The turn's own thread: runs side by side each start a thread, so the latest one is not necessarily this turn's.
      const threadId = typeof request.params?.threadId === "string" ? request.params.threadId : latestThread;
      const input = request.params?.input;
      const prompt = Array.isArray(input) ? String((input[0] as { text?: unknown })?.text ?? "") : "";
      prompts.push(prompt);
      const failure = options.failWith?.(prompt, turns);
      const text = failure ? "" : respond(prompt, turns);
      setTimeout(() => {
        if (failure) {
          rpc.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: failure, codexErrorInfo: failure } } } }));
          return;
        }
        if (options.usage) {
          const breakdown = { totalTokens: options.usage.input + options.usage.output, inputTokens: options.usage.input, cachedInputTokens: 0, cacheWriteInputTokens: 0,
            outputTokens: options.usage.output, reasoningOutputTokens: 0 };
          rpc.receiveLine(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null } } }));
        }
        rpc.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }));
      }, 1);
    }
  });
  return { rpc, prompts: () => prompts };
}

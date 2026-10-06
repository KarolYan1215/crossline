import type { CodexRpcBoundary } from "./index";

/**
 * What turns a Skill run into an assistant run: the thread gets a shell, file access and the rest of the runtime's tools, in the
 * task's own directory, and every request the runtime makes to the person (run this command, change these files, call this account
 * tool) is answered here by the guard instead of by a human at a terminal.
 */
export type AgentItem = Record<string, unknown>;
export type AgentMode = {
  /** The task's directory: the thread's working directory and the one place it writes. */
  cwd: string;
  /** Every item the runtime starts or finishes — a command, a file change, an account-tool call, a search — for the audit trail. */
  onItem: (item: AgentItem, phase: "started" | "completed") => void;
  /** The answer to one of the runtime's requests. Throwing refuses it. */
  answer: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
};

type Handler = AgentMode["answer"];
const registries = new WeakMap<object, Map<string, Handler>>();

/**
 * Routes the runtime's requests to the run that owns the thread they are about. One client serves every run, and its single
 * request handler cannot know which run is asking, so each agent thread registers its own answerer here and the handler picks
 * by `threadId`. A request about a thread nobody registered is refused: nobody is there to judge it.
 */
export function registerAgentThread(client: CodexRpcBoundary, threadId: string, answer: Handler): () => void {
  let routes = registries.get(client);
  if (!routes) {
    const table = new Map<string, Handler>();
    routes = table;
    registries.set(client, table);
    client.onServerRequest?.((method, params) => {
      const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      const handler = typeof record.threadId === "string" ? table.get(record.threadId) : undefined;
      if (!handler) throw new Error("no run is waiting on this thread");
      return handler(method, record);
    });
  }
  routes.set(threadId, answer);
  return () => { routes!.delete(threadId); };
}

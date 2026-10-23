import type { CodexRpcBoundary } from "./index";

/**
 * The owner's runtimes working together (docs/compute-node.md, 「协同」): this server's own and every compute node connected for the
 * account (a linked device, the standalone 「Crossline 节点」). Each run is given one of them when it starts (`bindRun`, called by the
 * runner once the run holds its gate slot) and keeps it to the end: a node with room first, the strongest kind first (`priority`, a
 * linked device above the standalone node) and the least loaded of a kind; with every node full, or none connected, this server's.
 * A conversation's later turn goes back to the runtime its thread was started on; if that one is gone the turn lands elsewhere and is
 * answered `SKILL_THREAD_LOST`, which every conversation already rebuilds from.
 *
 * Anything asked of the pool outside a run (the quota, sign-in, a status read) is this server's runtime's to answer.
 */
export type PoolMember = { id: string; client: CodexRpcBoundary; capacity: number; priority: number };
export type BoundRun = { client: CodexRpcBoundary; member: string; release: () => void };
export type RuntimePool = CodexRpcBoundary & {
  bindRun: (hint?: { threadId?: string }) => BoundRun;
  /** Runs in flight per member (`server` for this server's runtime). */
  load: () => Record<string, number>;
};

export const LOCAL_MEMBER = "server";
const THREADS_MAX = 2_000;

export function createRuntimePool(local: CodexRpcBoundary, members: () => PoolMember[]): RuntimePool {
  const inFlight = new Map<string, number>();
  /** Which member each thread a node started lives on; a thread not here is this server's. */
  const threads = new Map<string, string>();
  /** One wrapper per node client, kept: the runner keys its per-runtime state (locks, held threads) by the client object. */
  const wrappers = new WeakMap<CodexRpcBoundary, CodexRpcBoundary>();

  const remember = (threadId: string, member: string) => {
    threads.delete(threadId);
    threads.set(threadId, member);
    if (threads.size > THREADS_MAX) threads.delete(threads.keys().next().value!);
  };
  const wrap = (member: PoolMember): CodexRpcBoundary => {
    const known = wrappers.get(member.client);
    if (known) return known;
    const wrapped: CodexRpcBoundary = {
      request: async (method, params) => {
        const result = await member.client.request(method, params);
        if (method === "thread/start") {
          const id = (result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
          if (typeof id === "string") remember(id, member.id);
        }
        return result;
      },
      onNotification: (handler) => member.client.onNotification(handler),
      ...(member.client.onServerRequest ? { onServerRequest: (handler: Parameters<NonNullable<CodexRpcBoundary["onServerRequest"]>>[0]) => member.client.onServerRequest!(handler) } : {})
    };
    wrappers.set(member.client, wrapped);
    return wrapped;
  };
  const count = (id: string) => inFlight.get(id) ?? 0;

  function choose(hint?: { threadId?: string }): { id: string; client: CodexRpcBoundary } {
    const present = members();
    const owner = hint?.threadId ? threads.get(hint.threadId) : undefined;
    if (hint?.threadId) {
      if (!owner) return { id: LOCAL_MEMBER, client: local };
      const member = present.find((item) => item.id === owner);
      if (member) return { id: member.id, client: wrap(member) };
      // Its node is gone: the turn goes where a new run would, and is told its thread is lost there.
    }
    const open = present.filter((member) => count(member.id) < member.capacity)
      .sort((a, b) => b.priority - a.priority || count(a.id) / a.capacity - count(b.id) / b.capacity);
    return open[0] ? { id: open[0].id, client: wrap(open[0]) } : { id: LOCAL_MEMBER, client: local };
  }

  return {
    request: (method, params) => local.request(method, params),
    onNotification: (handler) => local.onNotification(handler),
    ...(local.onServerRequest ? { onServerRequest: (handler: Parameters<NonNullable<CodexRpcBoundary["onServerRequest"]>>[0]) => local.onServerRequest!(handler) } : {}),
    bindRun(hint) {
      const chosen = choose(hint);
      inFlight.set(chosen.id, count(chosen.id) + 1);
      let released = false;
      return { client: chosen.client, member: chosen.id, release: () => {
        if (released) return;
        released = true;
        const left = count(chosen.id) - 1;
        if (left > 0) inFlight.set(chosen.id, left); else inFlight.delete(chosen.id);
      } };
    },
    load: () => Object.fromEntries(inFlight)
  };
}

/** The runtime a run should use: a pool's choice when the client is a pool, else the client itself. */
export function bindForRun(client: CodexRpcBoundary, hint?: { threadId?: string }): BoundRun {
  const pool = client as Partial<RuntimePool>;
  return typeof pool.bindRun === "function" ? pool.bindRun(hint) : { client, member: LOCAL_MEMBER, release: () => {} };
}

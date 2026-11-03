import type { CodexRpcBoundary } from "@crossline/codex";
import { handleTaskOp } from "../node/task-files";
import type { NodeShellLink } from "../node/task-sync";

/**
 * A compute node with the shell switched on, in memory (docs/compute-node.md P3): its task directories are a folder of this machine and
 * every task operation goes straight into the node's own handler, the way the hub would carry it. `client` is the node's runtime (a
 * fake from fake-runtime.ts); `disconnect()` takes it away mid-test.
 */
export function fakeNode(tasksRoot: string, client: CodexRpcBoundary, options: { host?: string; home?: string } = {}): NodeShellLink & { disconnect: () => void } {
  let up = true;
  return {
    key: "node-1", host: options.host ?? "PC-A", client, tasksRoot, home: options.home ?? tasksRoot, windows: process.platform === "win32",
    task: async (request) => { if (!up) throw new Error("NODE_DISCONNECTED"); return handleTaskOp(tasksRoot, request); },
    connected: () => up,
    disconnect: () => { up = false; }
  };
}

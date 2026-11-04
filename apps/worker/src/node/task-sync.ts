import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CodexRpcBoundary } from "@crossline/codex";
import { TASK_CHUNK_BYTES, type TaskFileEntry, type TaskFileOp } from "./task-files";

/**
 * A ready node of the account that runs the shell assistant (docs/compute-node.md P3): its runtime, where its task directories are,
 * its home (for the guard) and the operations on its task directories. Given only by a node whose person switched the shell on.
 */
export type NodeShellLink = {
  key: string; host: string; client: CodexRpcBoundary; tasksRoot: string; home: string; windows: boolean;
  /** False when the node said `ffmpeg` does not run there (older nodes say nothing: undefined). */
  ffmpeg?: boolean;
  task: (request: TaskFileOp) => Promise<unknown>;
  connected: () => boolean;
};

/** What a run's inputs and results may weigh either way: beyond this the rest stays where it is and the run is told so. */
export const SYNC_MAX_FILES = 400;
export const SYNC_MAX_BYTES = 300 * 1_048_576;
const SKIPPED = new Set([".git", "node_modules", "__pycache__", ".venv"]);
/** The server keeps its own record beside the results; a run's file of the same name never replaces it. */
const SERVER_OWNED = new Set(["audit.json", "progress.json"]);

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const nodePathOf = (link: Pick<NodeShellLink, "windows">) => link.windows ? path.win32 : path.posix;
export const nodeTaskDir = (link: Pick<NodeShellLink, "windows" | "tasksRoot">, taskId: string) => nodePathOf(link).join(link.tasksRoot, taskId);

async function put(link: NodeShellLink, name: string, rel: string, bytes: Buffer): Promise<void> {
  if (!bytes.length) { await link.task({ op: "write", name, rel, data: "" }); return; }
  for (let at = 0; at < bytes.length; at += TASK_CHUNK_BYTES) {
    await link.task({ op: "write", name, rel, data: bytes.subarray(at, at + TASK_CHUNK_BYTES).toString("base64"), ...(at ? { append: true } : {}) });
  }
}

export type SentInputs = { paths: string[]; sent: Array<{ rel: string; sha256: string; original: string }>; truncated: boolean };

/**
 * Copies the run's inputs into `<task>.inputs/<n>/<name>` on the node and returns the node paths the run is given. The originals stay on
 * the server, untouched; the copies' hashes are kept to tell whether the run changed them.
 */
export async function sendInputs(link: NodeShellLink, taskId: string, inputs: string[]): Promise<SentInputs> {
  const nodePath = nodePathOf(link);
  const name = `${taskId}.inputs`;
  const sent: SentInputs["sent"] = [];
  let bytes = 0;
  let truncated = false;
  const paths: string[] = [];
  await link.task({ op: "write", name: taskId, rel: ".crossline-task", data: "" });
  for (const [index, input] of inputs.entries()) {
    const label = path.basename(input).replace(/[\\/:\0]/g, "_") || "input";
    paths.push(nodePath.join(link.tasksRoot, name, String(index), label));
    const files: Array<{ file: string; rel: string }> = [];
    const walk = (entry: string, rel: string) => {
      let stat;
      try { stat = statSync(entry); } catch { return; }
      if (stat.isDirectory()) { for (const child of readdirSync(entry)) if (!SKIPPED.has(child)) walk(path.join(entry, child), `${rel}/${child}`); }
      else if (stat.isFile()) files.push({ file: entry, rel });
    };
    walk(input, `${index}/${label}`);
    for (const { file, rel } of files) {
      if (sent.length >= SYNC_MAX_FILES) { truncated = true; break; }
      const data = readFileSync(file);
      if (bytes + data.length > SYNC_MAX_BYTES) { truncated = true; continue; }
      bytes += data.length;
      await put(link, name, rel, data);
      sent.push({ rel, sha256: sha(data), original: file });
    }
  }
  return { paths, sent, truncated };
}

/** The originals whose copies on the node the run changed or removed (the shell's own 「inputs untouched」 check, held on the copies). */
export async function changedInputs(link: NodeShellLink, taskId: string, inputs: SentInputs): Promise<string[]> {
  if (!inputs.sent.length) return [];
  const listed = await link.task({ op: "list", name: `${taskId}.inputs` }) as { files?: TaskFileEntry[] };
  const now = new Map((listed.files ?? []).map((file) => [file.rel, file.sha256]));
  return inputs.sent.filter((item) => now.get(item.rel) !== item.sha256).map((item) => item.original);
}

/**
 * Copies what the run has written on the node into the server's task directory, so the artifact check, the hashes, 助手产出 and the
 * review read the same files the shell run on this machine leaves. Files the server already holds unchanged are not sent again.
 * Returns what stayed on the node (over the caps).
 */
export async function pullResults(link: NodeShellLink, taskId: string, directory: string): Promise<{ copied: number; left: string[] }> {
  const listed = await link.task({ op: "list", name: taskId }) as { files?: TaskFileEntry[] };
  let copied = 0;
  let bytes = 0;
  const left: string[] = [];
  for (const entry of listed.files ?? []) {
    const parts = entry.rel.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || SKIPPED.has(part)) || (parts.length === 1 && SERVER_OWNED.has(parts[0]!)) || entry.rel === ".crossline-task") continue;
    const target = path.join(directory, ...parts);
    if (!target.startsWith(directory + path.sep)) continue;
    if (existsSync(target) && entry.sha256 && sha(readFileSync(target)) === entry.sha256) continue;
    if (!entry.sha256 || copied >= SYNC_MAX_FILES || bytes + entry.size > SYNC_MAX_BYTES) { left.push(entry.rel); continue; }
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < entry.size || offset === 0; offset += TASK_CHUNK_BYTES) {
      const piece = await link.task({ op: "read", name: taskId, rel: entry.rel, offset }) as { data?: string };
      chunks.push(Buffer.from(piece.data ?? "", "base64"));
      if (!entry.size) break;
    }
    const data = Buffer.concat(chunks);
    if (sha(data) !== entry.sha256) { left.push(entry.rel); continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    copied += 1;
    bytes += data.length;
  }
  return { copied, left };
}

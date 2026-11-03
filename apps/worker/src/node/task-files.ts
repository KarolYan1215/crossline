import { createHash } from "node:crypto";
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The shell assistant's task directories on a compute node (docs/compute-node.md P3): `<node dir>/tasks/<name>`, one per run, plus
 * `<name>.inputs` holding read-only copies of what the run was given. The server writes inputs in and reads results out through these
 * operations only: a name is one plain segment, a relative path never climbs out, and no link is followed either way (a run could leave
 * a link to the node's token in its own directory; the server never reads through it).
 */
export const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** One piece of a file either way (each frame stays under the socket's limit). */
export const TASK_CHUNK_BYTES = 8 * 1_048_576;
export const TASK_LIST_MAX_FILES = 2000;
/** Directories a run's own tools leave behind that are never results. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv"]);

export type TaskFileOp =
  | { op: "write"; name: string; rel: string; data: string; append?: boolean }
  | { op: "list"; name: string }
  | { op: "read"; name: string; rel: string; offset?: number };
export type TaskFileEntry = { rel: string; size: number; sha256: string };

function base(root: string, name: string): string {
  if (typeof name !== "string" || !TASK_NAME.test(name) || name.includes("..")) throw new Error("NODE_TASK_NAME_REFUSED");
  return path.join(root, name);
}

function full(root: string, name: string, rel: string): { dir: string; file: string } {
  const dir = base(root, name);
  const parts = typeof rel === "string" ? rel.split("/") : [];
  if (!rel || rel.length > 400 || parts.some((part) => !part || part === "." || part === ".." || /[\\:\0]/.test(part))) throw new Error("NODE_TASK_PATH_REFUSED");
  return { dir, file: path.join(dir, ...parts) };
}

/** Refuses when any existing part of the path from the root down is a link. */
function noLinks(root: string, file: string): void {
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) throw new Error("NODE_TASK_LINK_REFUSED");
  }
}

export function handleTaskOp(root: string, request: TaskFileOp): unknown {
  mkdirSync(root, { recursive: true });
  if (request.op === "list") {
    const dir = base(root, request.name);
    noLinks(root, dir);
    const out: TaskFileEntry[] = [];
    const walk = (current: string) => {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.length >= TASK_LIST_MAX_FILES) return;
        const at = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) walk(at); continue; }
        if (!entry.isFile()) continue;
        const size = lstatSync(at).size;
        // A file too large to send is listed without its hash: the server leaves it on the node and says so.
        const sha256 = size <= 512 * 1_048_576 ? createHash("sha256").update(readFileSync(at)).digest("hex") : "";
        out.push({ rel: path.relative(dir, at).split(path.sep).join("/"), size, sha256 });
      }
    };
    walk(dir);
    return { files: out };
  }
  const { dir, file } = full(root, request.name, request.rel);
  if (request.op === "write") {
    mkdirSync(dir, { recursive: true });
    noLinks(root, file);
    mkdirSync(path.dirname(file), { recursive: true });
    noLinks(root, file);
    const bytes = Buffer.from(String(request.data ?? ""), "base64");
    if (request.append) appendFileSync(file, bytes); else writeFileSync(file, bytes);
    return { ok: true };
  }
  if (request.op === "read") {
    noLinks(root, file);
    const size = lstatSync(file).size;
    const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
    const length = Math.max(0, Math.min(TASK_CHUNK_BYTES, size - offset));
    const buffer = Buffer.alloc(length);
    const handle = openSync(file, "r");
    try { readSync(handle, buffer, 0, length, offset); } finally { closeSync(handle); }
    return { data: buffer.toString("base64"), size };
  }
  throw new Error("NODE_TASK_OP_REFUSED");
}

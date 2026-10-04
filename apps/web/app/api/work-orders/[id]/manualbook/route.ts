import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { dataDirectory, getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";

/**
 * A task's manualbook, read back from the folder the worker built it in: the flow, the overview, and per step the
 * instructions, the write-ups and the sources kept. Nothing is taken from the query: the caller names a work order of
 * their own workspace, and every path is built from that id and from step ids read out of the flow itself, each
 * checked to stay inside the folder. While the book is being built the latest progress is returned instead.
 */
const CAP = 60_000;
const read = (file: string) => { try { return readFileSync(file, "utf8").slice(0, CAP); } catch { return ""; } };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ built: false }, { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore();
  if (!store.getWorkOrder(access.ctx.workspaceId, id)) return NextResponse.json({ built: false }, { status: 404 });

  const root = path.resolve(dataDirectory(), "materials", id);
  if (!existsSync(path.join(root, "flow.json"))) {
    const progress = [...store.listEvents(access.ctx.workspaceId, { type: "manualbook.progress", entityId: id })].at(-1)?.payload;
    const blocked = [...store.listEvents(access.ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"], entityId: id })].at(-1);
    return NextResponse.json({ built: false, progress: progress ?? null,
      blocker: blocked?.type === "materials.blocked" ? (blocked.payload as { message?: string }).message ?? "材料准备被阻塞" : null });
  }
  const inside = (relative: string) => { const target = path.resolve(root, relative); return target.startsWith(root + path.sep) ? target : undefined; };
  let flow: { nodes: Array<{ id: string; title: string; kind: string; goal: string; stage: number }>; edges: Array<{ from: string; to: string }> };
  try { flow = JSON.parse(read(path.join(root, "flow.json"))); } catch { return NextResponse.json({ built: false }, { status: 500 }); }
  const materials = store.listMaterials(access.ctx.workspaceId, id);
  const nodes: Record<string, { task: string; analysis: string; tutorial: string; sources: unknown[] }> = {};
  for (const node of flow.nodes) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(node.id)) continue;
    const base = `nodes/${node.id}`;
    let sources: unknown[] = [];
    try { sources = JSON.parse(read(inside(`${base}/sources.json`) ?? "")) as unknown[]; } catch { /* a step with no sources has none */ }
    // A downloaded copy is opened through the materials route, which looks it up by the address the ledger recorded.
    sources = (sources as Array<{ file?: string }>).map((source) => {
      const material = source.file ? materials.find((item) => item.uri.endsWith(`/${base}/sources/${source.file}`)) : undefined;
      return material ? { ...source, uri: material.uri } : source;
    });
    nodes[node.id] = { task: read(inside(`${base}/task.md`) ?? ""), analysis: read(inside(`${base}/analysis.md`) ?? ""), tutorial: read(inside(`${base}/tutorial.md`) ?? ""), sources };
  }
  return NextResponse.json({ built: true, flow, manual: read(path.join(root, "manual.md")), nodes },
    { headers: { "cache-control": "no-store" } });
}

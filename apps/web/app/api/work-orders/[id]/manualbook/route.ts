import { existsSync, readFileSync } from "node:fs";
import { tOf } from "../../../../../lib/locale";
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
  const order = store.getWorkOrder(access.ctx.workspaceId, id);
  if (!order) return NextResponse.json({ built: false }, { status: 404 });
  // A finished task's tutorial is not being written any more, whatever the last progress event says (the worker stops it; W-16).
  const closed = ["accepted", "archived"].includes(order.state);

  const root = path.resolve(dataDirectory(), "materials", id);
  // Where the latest build stands: running (asked for, or reporting progress, within the last two hours), stopped with a reason, or done.
  const last = store.listEvents(access.ctx.workspaceId, { type: ["tutorial.requested", "manualbook.progress", "manualbook.built", "materials.blocked",
    "tutorial.blocked", "materials.retry_requested"], entityId: id }).at(-1);
  const building = Boolean(!closed && last && ["tutorial.requested", "manualbook.progress", "materials.retry_requested"].includes(last.type)
    && Date.now() - Date.parse(last.createdAt) < 2 * 3_600_000);
  const progress = building && last?.type === "manualbook.progress" ? last.payload : null;
  const blocker = last && (last.type === "materials.blocked" || last.type === "tutorial.blocked") ? (last.payload as { message?: string }).message ?? tOf(access.ctx)("教程未能生成") : null;
  if (!existsSync(path.join(root, "flow.json"))) return NextResponse.json({ built: false, building, closed, progress, blocker, materials: [] });
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
  let listed: Array<{ id?: string; title: string; publisher: string; url?: string; kept: string; docId?: string; notes: Array<{ node?: string }> }> = [];
  try { listed = JSON.parse(read(path.join(root, "materials.json")) || "[]"); } catch { /* a book built before materials were listed */ }
  // The task's own steps, so the reading page puts each section under its step and links the two both ways.
  const steps = (store.getStepPlan(access.ctx.workspaceId, id)?.steps ?? []).map((step) => ({ id: step.id, title: step.title, status: step.status }));
  return NextResponse.json({ built: true, building, closed, progress, blocker, flow, manual: read(path.join(root, "manual.md")), nodes, steps,
    materials: listed.map((item, index) => ({ index, ...(item.id ? { id: item.id } : {}), title: item.title, publisher: item.publisher, kept: item.kept,
      ...(item.docId ? { docId: item.docId } : {}), ...(item.url ? { url: item.url } : {}), notes: item.notes.length,
      nodes: [...new Set(item.notes.map((note) => note.node).filter((node): node is string => typeof node === "string"))] })) },
    { headers: { "cache-control": "no-store" } });
}

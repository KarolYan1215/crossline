/**
 * Read-only ledger inspector used by the acceptance protocol (`docs/acceptance-protocol.md`).
 *
 * Every protocol step is required to leave evidence that can be re-read afterwards, which means the
 * evidence has to be readable without the web app running and without opening SQLite by hand. This
 * opens the live ledger through the ordinary store and prints what a step claims to have changed.
 *
 *   pnpm exec tsx scripts/ledger-inspect.ts orders [idPrefix]
 *   pnpm exec tsx scripts/ledger-inspect.ts order <idPrefix>
 *   pnpm exec tsx scripts/ledger-inspect.ts events [entityIdPrefix] [limit]
 *   pnpm exec tsx scripts/ledger-inspect.ts milestones | relations | plans | captures | counts
 */
import { resolve } from "node:path";
// Relative import, not @crossline/db: the repo root is not a workspace package, so it has no such deps.
import { CrosslineStore } from "../packages/db/src/index.js";

const WORKSPACE_ID = "personal-crossline";
const dataDir = process.env.CROSSLINE_DATA_DIR ?? resolve(process.cwd(), "data");
const store = new CrosslineStore(resolve(dataDir, "crossline.db"));

const [command = "counts", arg, arg2] = process.argv.slice(2);
const matches = (id: string) => !arg || id.startsWith(arg) || id.endsWith(arg);
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

switch (command) {
  case "orders": {
    out(store.listWorkOrders(WORKSPACE_ID).filter((o) => matches(o.id)).map((o) => ({
      id: o.id, state: o.state, identityId: o.identityId, milestoneId: o.milestoneId,
      intent: o.intent, updatedAt: o.updatedAt
    })));
    break;
  }
  case "order": {
    const order = store.listWorkOrders(WORKSPACE_ID).find((o) => matches(o.id));
    if (!order) { console.log("NOT_FOUND"); break; }
    out({
      order,
      materials: store.listMaterials(WORKSPACE_ID, order.id),
      executions: store.listExecutions(WORKSPACE_ID).filter((e) => e.workOrderId === order.id),
      evidence: store.listEvidenceClaims(WORKSPACE_ID).filter((e) => e.workOrderId === order.id),
      events: store.listEvents(WORKSPACE_ID).filter((e) => e.workspaceId === WORKSPACE_ID && e.entityId === order.id)
        .map((e) => ({ type: e.type, at: e.createdAt, payload: e.payload }))
    });
    break;
  }
  case "events": {
    const limit = Number(arg2 ?? 30);
    const events = store.listEvents(WORKSPACE_ID).filter((e) => e.workspaceId === WORKSPACE_ID && matches(e.entityId));
    out(events.slice(-limit).map((e) => ({ type: e.type, entityId: e.entityId, at: e.createdAt, payload: e.payload })));
    break;
  }
  case "milestones": {
    out(store.listMilestones(WORKSPACE_ID).map((m) => ({
      id: m.id, version: m.version, status: m.status, identityId: m.identityId,
      title: m.title, criteria: m.successCriteria
    })));
    break;
  }
  case "relations": {
    out(store.listMilestoneRelations(WORKSPACE_ID));
    break;
  }
  case "plans": {
    out(store.listPlanVersions(WORKSPACE_ID).map((p) => ({
      id: p.id, version: p.version, status: p.status,
      blocks: (p.payload as { blocks?: unknown[] })?.blocks ?? [],
      changes: store.listPlanChanges(p.id).map((c) => ({ id: c.id, kind: c.kind, status: c.status, explanation: c.explanation }))
    })));
    break;
  }
  case "captures": {
    out(store.listCaptures(WORKSPACE_ID).map((c) => ({
      id: c.id, state: c.state, attempt: c.attempt, title: c.title, audit: c.audit
    })));
    break;
  }
  default: {
    const snapshot = store.exportSnapshot(WORKSPACE_ID);
    out(Object.fromEntries(Object.entries(snapshot.tables ?? {}).map(([name, rows]) => [name, (rows as unknown[]).length])));
  }
}

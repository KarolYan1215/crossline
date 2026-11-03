import type { CrosslineStore } from "./index";

/**
 * Settings that belong to the machine, not the person: a whole-ledger move keeps the target's own values (scripts/migrate-workspace.ts,
 * docs/ledger-sync.md). Each entry is a prefix.
 */
export const MACHINE_SETTINGS = ["deployment.runtimeOwner", "calendar.graph.owner", "calendar.write.account", "calendar.sources", "calendar.sources.seeded",
  "calendar.subscriptions", "calendar.sync_zone:", "calendar.published", "calendar.autopublish.hash", "calendar.fixed.hash", "calendar.publish.failure",
  "calendar.sync.failure", "push.subscriptions", "sources.folders", "sources.folder.index:", "localActivity.", "activity.", "energy.camera",
  "health.token.sha256", "model.provider", "model.provider.conformance", "model.sponsor", "model.chatgptExhausted", "model.budget.monthly", "mail.", "agent.sandbox", "background.blocker"];

/**
 * The device mirror's line (docs/device-mode.md): the machine's settings above, the hosted side's own device and node bookkeeping, every
 * token hash, and the consents and records of what this computer reads itself (coding-agent time, local transcription). The hosted site
 * never sends these; the device keeps its own.
 */
const MIRROR_LOCAL = [...MACHINE_SETTINGS, "device.", "node.", "history.agentLogs", "recordings.autoTranscribe", "recordings.modelNoticeAt"];
export const mirrorLocalSetting = (key: string) => key.endsWith(".token.sha256") || MIRROR_LOCAL.some((prefix) => key.startsWith(prefix));

/** Never mirrored: who the account is, its members and sessions belong to each ledger. */
const IDENTITY = new Set(["principals", "workspaces", "workspace_members", "device_leases", "tailscale_bindings", "audit_events"]);

type Row = Record<string, string | number | null>;
/** What the hosted site sends a linked device: one workspace's rows, without identity tables and without the settings above. */
export type WorkspaceMirror = { format: 1; workspaceId: string; ownerId: string; tables: Record<string, Row[]> };

export function mirrorSnapshot(store: CrosslineStore, workspaceId: string): WorkspaceMirror {
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId) throw new Error("MIRROR_WORKSPACE_NOT_FOUND");
  const tables = Object.fromEntries(Object.entries(store.exportSnapshot(workspaceId).tables).filter(([table]) => !IDENTITY.has(table))
    .map(([table, rows]) => [table, table === "settings" ? rows.filter((row) => !mirrorLocalSetting(String(row.key))) : rows]));
  return { format: 1, workspaceId, ownerId, tables };
}

export function isWorkspaceMirror(value: unknown): value is WorkspaceMirror {
  const mirror = value as Partial<WorkspaceMirror> | null;
  return Boolean(mirror) && mirror!.format === 1 && typeof mirror!.workspaceId === "string" && typeof mirror!.ownerId === "string"
    && typeof mirror!.tables === "object" && mirror!.tables !== null && Object.values(mirror!.tables).every(Array.isArray);
}

/**
 * Replaces one local workspace's rows with a mirror, in one transaction. Kept from the local side: its settings on the line above, the rows
 * `keep` names, and every row of the `spare` tables (never read from the mirror). A mirrored row that would clash with a kept one on a
 * primary key or a unique index is left out; a mirrored file that is a kept file (same content) hands it its `src-N` number and its id is
 * rewritten to the kept one wherever the mirror names it. The workspace and owner ids are the local ones; ids SQLite numbers are renumbered.
 * File paths are not rewritten and files are not copied: the device mirrors the ledger, not the hosted site's folders.
 */
export function replaceWorkspaceFrom(store: CrosslineStore, mirror: WorkspaceMirror,
  target: { workspaceId: string; keep: (table: string, row: Row) => boolean; spare?: string[] }): Record<string, number> {
  const toWorkspace = target.workspaceId;
  const toOwner = store.getWorkspaceOwnerId(toWorkspace);
  if (!toOwner) throw new Error("MIRROR_TARGET_NOT_FOUND");
  const spare = new Set(target.spare ?? []);
  const known = new Set(store.tableNames());
  const swap = (value: string, pairs: Array<[string, string]>) => pairs.reduce((text, [from, to]) => from && from !== to ? text.split(from).join(to) : text, value);
  const rewrite = (rows: Row[], pairs: Array<[string, string]>) =>
    rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === "string" ? swap(value, pairs) : value])) as Row);

  // Read and written under one write lock: a consent the device page saves meanwhile is either kept or waits, never lost in between.
  return store.atomically(() => {
    const local = store.exportSnapshot(toWorkspace).tables;
    const kept: Record<string, Row[]> = {};
    for (const [table, rows] of Object.entries(local)) {
      if (IDENTITY.has(table) || spare.has(table)) continue;
      const mine = rows.filter((row) => table === "settings" ? mirrorLocalSetting(String(row.key)) : target.keep(table, row));
      if (mine.length) kept[table] = mine;
    }

    const incoming: Record<string, Row[]> = {};
    for (const [table, rows] of Object.entries(mirror.tables)) {
      if (IDENTITY.has(table) || spare.has(table)) continue;
      // A table this copy does not know yet goes to the import, which refuses it by name: the device runs older code than the site.
      const { autoNumbered } = known.has(table) ? store.tableKeys(table) : { autoNumbered: false };
      incoming[table] = rewrite(rows, [[mirror.workspaceId, toWorkspace], [mirror.ownerId, toOwner]])
        .filter((row) => table !== "settings" || !mirrorLocalSetting(String(row.key)))
        .map((row) => autoNumbered ? { ...row, id: null } : row);
    }

    // A mirrored row that clashes with a kept one gives way. A file that gives way to a kept file of the same content leaves it its number.
    const idOf = new Map<string, string>();
    const twinned = new Set<Row>();
    for (const [table, mine] of Object.entries(kept)) {
      if (!incoming[table] || !known.has(table)) continue;
      const keys = store.tableKeys(table).unique;
      const tuple = (row: Row, key: string[]) => key.some((column) => row[column] === null || row[column] === undefined) ? undefined : JSON.stringify(key.map((column) => row[column]));
      const taken = new Map<string, Row>();
      for (const row of mine) for (const key of keys) { const value = tuple(row, key); if (value) taken.set(`${key.join(",")}=${value}`, row); }
      incoming[table] = incoming[table].filter((row) => {
        const clash = keys.map((key) => { const value = tuple(row, key); return value ? taken.get(`${key.join(",")}=${value}`) : undefined; }).find(Boolean);
        if (!clash) return true;
        if (table === "source_documents") {
          if (row.id !== clash.id) idOf.set(String(row.id), String(clash.id));
          clash.ref_no = row.ref_no ?? null;
          twinned.add(clash);
        }
        return false;
      });
    }
    // A kept file the site does not have yet takes the next free number after the site's.
    for (const row of kept.source_documents ?? []) if (!twinned.has(row)) row.ref_no = null;

    const pairs = [...idOf].map(([from, to]) => [from, to] as [string, string]);
    const tables: Record<string, Row[]> = {};
    for (const table of new Set([...Object.keys(incoming), ...Object.keys(kept)])) {
      tables[table] = [...(pairs.length ? rewrite(incoming[table] ?? [], pairs) : incoming[table] ?? []), ...(kept[table] ?? [])];
    }
    store.resetWorkspace(toWorkspace, { settingPrefixes: [], eventTypePrefixes: [] }, { spare: [...spare], clear: ["model_usage", "beta_invites"] });
    return store.importSnapshot({ schemaVersion: 2, exportedAt: new Date().toISOString(), workspaceId: toWorkspace, events: [], milestones: [],
      capacityCommitments: [], workOrders: [], milestoneRelations: [], planVersions: [], energyObservations: [], tables });
  });
}

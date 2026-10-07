import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
// pnpm forwards a literal `--` on some shells and swallows it on others, so the documented
// `pnpm export -- <path>` would otherwise write to a file named `--` when run from a POSIX shell.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const outputPath = path.resolve(args[0] ?? path.join(repoRoot, "backups", `crossline-${Date.now()}.json`));

mkdirSync(path.dirname(outputPath), { recursive: true });
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
try {
  // The single-user workspace constant used to be the only workspace this ledger could ever have, so it was a safe
  // default. Stage three gave every real account its own generated workspace id instead — a stale
  // hardcoded fallback here would silently export an empty snapshot of a workspace that no longer holds
  // the real data. Explicit when there is any ambiguity; auto-selected only when there is exactly one
  // real candidate, which is what every account on this machine looks like today.
  const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? (() => {
    const workspaces = store.listWorkspaces();
    if (workspaces.length === 1) return workspaces[0]!.id;
    throw new Error(workspaces.length === 0
      ? "CROSSLINE_WORKSPACE_ID_REQUIRED: no workspace exists in this ledger yet."
      : `CROSSLINE_WORKSPACE_ID_REQUIRED: ${workspaces.length} workspaces exist; set CROSSLINE_WORKSPACE_ID to pick one (${workspaces.map((item) => item.id).join(", ")}).`);
  })();
  const snapshot = store.exportSnapshot(workspaceId);
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, outputPath);
  console.info(JSON.stringify({
    type: "export.completed",
    outputPath,
    workspaceId,
    counts: { events: snapshot.events.length, workOrders: snapshot.workOrders.length, milestones: snapshot.milestones.length }
  }));
} finally {
  store.close();
}

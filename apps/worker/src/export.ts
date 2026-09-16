import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
// pnpm forwards a literal `--` on some shells and swallows it on others, so the documented
// `pnpm export -- <path>` would otherwise write to a file named `--` when run from a POSIX shell.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const outputPath = path.resolve(args[0] ?? path.join(repoRoot, "backups", `crossline-${Date.now()}.json`));
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";

mkdirSync(path.dirname(outputPath), { recursive: true });
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
try {
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

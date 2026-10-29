import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadWeeklyCommit } from "../../lib/weekly-commit";
import { linePacks } from "../../lib/lines";
import { CommitBoard } from "./commit-board";
import "../rituals.css";

export const dynamic = "force-dynamic";

/**
 * The weekly commitment (docs/rituals.md). Scene: Sunday evening or Monday, or a week that does not fit — the person decides what this
 * week keeps, pushes and drops, and leaves having confirmed it (one undo). Last week's detail is the weekly review's; why something cannot
 * be placed at all is the plan page's.
 */
export default async function CommitPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const view = loadWeeklyCommit(ctx);
  const labels = Object.fromEntries(linePacks(ctx, { includeArchived: true }).map((pack) => [pack.id, pack.label]));
  return <AppShell active={"本周承诺"} className="subpage rd-page"><div className="rd-inner">
    <CommitBoard view={view} labels={labels} />
  </div></AppShell>;
}

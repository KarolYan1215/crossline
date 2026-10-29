import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadWeeklyCommit } from "../../lib/weekly-commit";
import { CommitBoard } from "./commit-board";
import { tOf } from "../../lib/locale";
import "../rituals.css";

export const dynamic = "force-dynamic";

/** The weekly commitment (docs/rituals.md): the week's hours against its work, each task 保 / 推 / 砍, confirmed in one step. */
export default async function CommitPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const view = loadWeeklyCommit(ctx);
  const t = tOf(ctx);
  return <SubpageShell active={"本周承诺"} title={t("本周承诺")}>
    <CommitBoard view={view} />
  </SubpageShell>;
}

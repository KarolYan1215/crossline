import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadWrap } from "../../lib/wrap";
import { WrapBoard } from "./wrap-board";
import { tOf } from "../../lib/locale";
import "../rituals.css";

export const dynamic = "force-dynamic";

/** The evening wrap-up (docs/rituals.md): today's blocks one tap each, and the day's decisions with a safe default, then 「收工」. */
export default async function WrapPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const view = loadWrap(ctx);
  const t = tOf(ctx);
  return <SubpageShell active={"今日"} title={t("收工")}>
    <WrapBoard view={view} />
  </SubpageShell>;
}

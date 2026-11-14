import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { loadPortrait } from "../../lib/portrait";
import { PortraitView } from "./portrait-view";

export const dynamic = "force-dynamic";

/**
 * The portrait report the interview ends with: a shareable first half (type, portrait, figures), then private detail and guidance. The
 * view draws its own head (2026-10-28 redesign): the share, download, figure and rewrite actions sit beside the title. Not behind the start
 * gate: the interview links here while it runs (「画像已写好，去画像页确认」), and the 2026-11-14 walkthrough bounced back from every link.
 */
export default async function PortraitPage() {
  const ctx = await requireSessionContext();
  // `active` names the view in the frame's own table, not shown text.
  return <AppShell active={"画像"} className="subpage portrait-page"><div className="subpage-inner">
    <PortraitView initial={loadPortrait(ctx)} publicUrl={process.env.CROSSLINE_PUBLIC_URL ?? ""} name="" />
  </div></AppShell>;
}

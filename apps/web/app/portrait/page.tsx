import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { loadPortrait } from "../../lib/portrait";
import { PortraitView } from "./portrait-view";

export const dynamic = "force-dynamic";

/** The portrait report the interview ends with: shareable portrait and insight, then private guidance; exported as PDF or PNG. */
export default async function PortraitPage() {
  const ctx = await requireSessionContext();
  return <SubpageShell active="设置" eyebrow="访谈产出" title="画像报告"
    description="前半部分为个人画像与洞察，可导出分享版；后半部分为现况洞察、可行建议与下一步，仅自己可见。">
    <PortraitView initial={loadPortrait(ctx)} publicUrl={process.env.CROSSLINE_PUBLIC_URL ?? ""} name="" />
  </SubpageShell>;
}

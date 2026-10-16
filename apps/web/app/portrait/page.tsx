import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadPortrait } from "../../lib/portrait";
import { PortraitView } from "./portrait-view";
import { tOf } from "../../lib/locale";

export const dynamic = "force-dynamic";

/** The portrait report the interview ends with: a shareable first half (type, portrait, figures), then private detail and guidance. */
export default async function PortraitPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const t = tOf(ctx);
  return <SubpageShell active={"设置"} eyebrow={t("访谈产出")} title={t("画像报告")}
    description={t("前半部分为思维模式类型、画像与图表，可以分享；后半部分为个人细节与建议，仅自己可见。")}>
    <PortraitView initial={loadPortrait(ctx)} publicUrl={process.env.CROSSLINE_PUBLIC_URL ?? ""} name="" />
  </SubpageShell>;
}

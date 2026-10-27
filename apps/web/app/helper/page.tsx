import type { Metadata } from "next";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { LineColors } from "../line-colors";
import { HelperPocket } from "../helper-pet-client";
import { tFor } from "../../lib/i18n";
import { getLocale } from "../../lib/locale";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("小帮手 · Crossline") };
}

/**
 * The 小帮手 alone, for a small window: the popup a browser without Picture-in-Picture pins, the tray's 「打开小帮手」 and the installed
 * app's shortcut. No frame and no navigation, so it fits 360×520; gated like every working page.
 */
export default async function HelperPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  return <>
    <LineColors />
    <main className="helper-page"><HelperPocket /></main>
  </>;
}

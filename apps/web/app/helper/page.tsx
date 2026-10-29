import type { Metadata } from "next";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { LineColors } from "../line-colors";
import { HelperPocket } from "../helper-pet-client";
import { HelperDesk } from "../helper-desk";
import { tFor } from "../../lib/i18n";
import { getLocale } from "../../lib/locale";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("小帮手 · Crossline") };
}

/**
 * The 小帮手 alone, for a small window: the popup a browser without Picture-in-Picture pins, the tray's 「打开小帮手」 and the installed
 * app's shortcut. No frame and no navigation, so it fits 360×520; gated like every working page.
 *
 * `?pet=1` is the desktop pet (helper-desk.tsx): the figure, its bubble and a small input on a transparent page, drawn by the node's
 * tray in a frameless WebView2 window (installer/node-tray/CrosslineNode.cs). In an ordinary browser tab it works the same, on paper.
 */
export default async function HelperPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const pet = (await searchParams).pet === "1";
  return <>
    <LineColors />
    {pet ? <main className="helper-page helper-desk-page"><HelperDesk /></main> : <main className="helper-page"><HelperPocket /></main>}
  </>;
}

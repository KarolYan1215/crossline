import type { Metadata } from "next";
import { tFor } from "../../../lib/i18n";
import { getLocale } from "../../../lib/locale-server";
import { PairScreen } from "../../../components/pair-screen";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("双人卡 · Crossline 速测"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** Two people's card. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PairScreen token={token} />;
}


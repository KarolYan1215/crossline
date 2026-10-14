import type { Metadata } from "next";
import { PairScreen } from "../../../components/pair-screen";

export const metadata: Metadata = { title: "双人卡 · Crossline 速测", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Two people's card. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PairScreen token={token} />;
}


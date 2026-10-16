import type { Metadata } from "next";
import { tFor } from "../../../lib/i18n";
import { getLocale } from "../../../lib/locale-server";
import { ResultScreen } from "../../../components/result-screen";

/** Capability links: never indexed, never leaked as a referrer. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("我的结果 · Crossline 速测"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** The person's own result; `?delete=1` (the email's 「删除我的结果」 link) opens straight on the confirmation, read in the browser. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ResultScreen token={token} />;
}


import type { Metadata } from "next";
import { tFor } from "../../../lib/i18n";
import { getLocale } from "../../../lib/locale-server";
import { InviteScreen } from "../../../components/invite-screen";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("测测你们是什么关系 · Crossline 速测"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** An invitation: the inviter's type, then the same test carrying the invitation. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteScreen token={token} />;
}


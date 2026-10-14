import type { Metadata } from "next";
import { InviteScreen } from "../../../components/invite-screen";

export const metadata: Metadata = { title: "测测你们是什么关系 · Crossline 速测", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** An invitation: the inviter's type, then the same test carrying the invitation. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteScreen token={token} />;
}


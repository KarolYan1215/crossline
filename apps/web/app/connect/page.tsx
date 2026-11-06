import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { ConnectFlow } from "./connect-flow";
import { tOf } from "../../lib/locale";
import { isHostedBeta } from "../../lib/hosting";
import { redirect } from "next/navigation";
import { sponsoredHere } from "../../lib/invites";
import { startReadiness } from "../../lib/start-gate";
import "./connect.css";

export const dynamic = "force-dynamic";

/**
 * The first page after signing in (decided 2026-10-16): the interview, the report and every plan run on the person's own model — their
 * ChatGPT, or since 2026-10-17 another model's API — so connecting one comes before anything else. An account that is already connected is sent straight on.
 */
export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const ctx = await requireSessionContext();
  const t = tOf(ctx);
  const { next } = await searchParams;
  // Only a path on this site, never another origin (`//host` or a full URL).
  const asked = next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/";
  // Straight to the interview while the account is not ready: Today would only send it there, one more queued page render on the
  // hosted server, and that wait looked like the page had stopped (W-233).
  const target = asked === "/" && !startReadiness(ctx).ready ? "/onboarding" : asked;
  if (sponsoredHere(ctx)) redirect(target);
  return <AppShell active={"设置"} focus corner={false} banner={false}>
    <h1>{t("开始之前：连接模型")}</h1>
    <ConnectFlow next={target} hosted={isHostedBeta()} />
  </AppShell>;
}

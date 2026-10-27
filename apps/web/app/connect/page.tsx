import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { ConnectFlow } from "./connect-flow";
import { tOf } from "../../lib/locale";
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
  const target = next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/";
  return <AppShell active={"设置"} focus corner={false} banner={false}>
    <h1>{t("开始之前：连接模型")}</h1>
    <ConnectFlow next={target} />
  </AppShell>;
}

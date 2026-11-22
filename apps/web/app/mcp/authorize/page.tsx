import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionContext } from "../../../lib/access-guard";
import { checkAuthorize, oauthConfig } from "../../../lib/mcp/oauth";
import { getLocale, localeFor } from "../../../lib/locale";
import { tFor } from "../../../lib/i18n";
import { ConsentForm } from "./consent-form";
import "../../privacy/privacy.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("连接 AI · Crossline") };
}
export const dynamic = "force-dynamic";

/**
 * Where an OAuth sign-in from claude.ai, ChatGPT or another MCP host lands (docs/mcp-server.md §4.3): the person, signed in to this site
 * (the sign-in page brings them back here), sees which address the connection goes back to and what it may do, and allows or refuses.
 * Opening the page grants nothing; only 允许 does. A client or address this site does not know is named here, never redirected to.
 */
export default async function McpAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (typeof value === "string") params.set(key, value);
  const config = oauthConfig();
  const check = config ? checkAuthorize(config, params) : undefined;
  if (check?.kind === "redirect") redirect(check.url);
  const say = tFor(await getLocale());
  if (!check || check.kind === "fatal") {
    return <main className="privacy">
      <h1>{say("连接 AI")}</h1>
      <p className="privacy-lede">{!check ? say("这个 Crossline 没有开放登录连接，请在设置里生成令牌。")
        : check.kind === "fatal" && check.code === "OAUTH_REDIRECT_UNKNOWN" ? say("这个连接请求的返回地址没有登记过，已停止。")
          : say("这个连接请求无法识别，已停止。请回到原来的 AI 重新连接。")}</p>
    </main>;
  }
  const ctx = await requireSessionContext();
  const t = tFor(localeFor(ctx));
  const { request } = check;
  return <main className="privacy">
    <h1>{t("连接 AI")}</h1>
    <p className="privacy-lede">{t("授权后返回到")} <strong>{request.host}</strong></p>
    <ul>
      <li>{t("对方自称：{{name}}", { name: request.client.name || t("（未填写）") })}</li>
      <li>{t("名字是对方自己填的，返回地址才说明是谁；只在认得这个地址时允许。")}</li>
      <li>{t("不能发信、报名、付款或改外部日历；每次写入都出现在最近操作里，注明是哪个 AI，24 小时内可撤销。")}</li>
      <li>{t("随时可以在 设置 → 在其他 AI 里用 Crossline 里撤销。")}</li>
    </ul>
    <ConsentForm query={params.toString()} writeAsked={request.scopes.includes("write")} defaultLabel={request.client.name || request.host} />
  </main>;
}

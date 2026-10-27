import type { Metadata } from "next";
import { inviteForLink } from "../../../lib/invites";
import { DecisionButtons } from "./decision-buttons";
import "../../privacy/privacy.css";
import { getLocale } from "../../../lib/locale";
import { intlLocale, tFor } from "../../../lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: tFor(await getLocale())("模型额度申请 · Crossline") };
}
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "待处理", approved: "已通过，邀请码已发出", rejected: "已拒绝", redeemed: "已通过，邀请码已被使用" };

/**
 * Where the owner decides an application, from the link in the email (lib/invites.ts). Opening the link changes nothing — mail scanners
 * open links — only a press on 通过 or 拒绝 does. No sign-in: the signed link is the authority.
 */
export default async function InviteDecisionPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  // `t` is the signed link's token here; the translator is `say`. Nobody is signed in: the language is the browser's cookie.
  const { t: token = "" } = await searchParams;
  const locale = await getLocale();
  const say = tFor(locale);
  const invite = token ? inviteForLink(token) : undefined;
  return <main className="privacy">
    <h1>{say("开发者模型额度申请")}</h1>
    {!invite ? <p className="privacy-lede">{say("链接无效或已过期（链接 14 天内有效）。")}</p> : <>
      <ul>
        <li>{say("申请人：{{email}}", { email: invite.email })}</li>
        <li>{say("理由：{{reason}}", { reason: invite.reason || say("（未填写）") })}</li>
        <li>{say("申请时间：{{when}}", { when: new Date(invite.createdAt).toLocaleString(intlLocale(locale), { timeZone: "Asia/Shanghai", hour12: false }) })}</li>
        <li>{say("状态：{{status}}", { status: STATUS[invite.status] ? say(STATUS[invite.status]!) : invite.status })}</li>
      </ul>
      {invite.status === "pending" && <DecisionButtons token={token} />}
    </>}
  </main>;
}

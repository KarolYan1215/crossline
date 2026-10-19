import type { Metadata } from "next";
import { inviteForLink } from "../../../lib/invites";
import { DecisionButtons } from "./decision-buttons";
import "../../privacy/privacy.css";

export const metadata: Metadata = { title: "模型额度申请 · Crossline" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "待处理", approved: "已通过，邀请码已发出", rejected: "已拒绝", redeemed: "已通过，邀请码已被使用" };

/**
 * Where the owner decides an application, from the link in the email (lib/invites.ts). Opening the link changes nothing — mail scanners
 * open links — only a press on 通过 or 拒绝 does. No sign-in: the signed link is the authority.
 */
export default async function InviteDecisionPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t = "" } = await searchParams;
  const invite = t ? inviteForLink(t) : undefined;
  return <main className="privacy">
    <h1>开发者模型额度申请</h1>
    {!invite ? <p className="privacy-lede">链接无效或已过期（链接 14 天内有效）。</p> : <>
      <ul>
        <li>申请人：{invite.email}</li>
        <li>理由：{invite.reason || "（未填写）"}</li>
        <li>申请时间：{new Date(invite.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</li>
        <li>状态：{STATUS[invite.status] ?? invite.status}</li>
      </ul>
      {invite.status === "pending" && <DecisionButtons token={t} />}
    </>}
  </main>;
}

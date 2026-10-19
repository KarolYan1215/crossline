"use client";

import { useEffect, useState } from "react";
import "./connect.css";

type InviteState = {
  available: boolean;
  application?: { status: "pending" | "approved" | "rejected" | "redeemed"; createdAt: string };
  sponsored: boolean;
  budget?: { spent: number; cap: number };
};

const post = async (path: string, body: unknown) => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  return await response?.json().catch(() => undefined) as { ok?: boolean; message?: string; state?: InviteState } | undefined;
};

/**
 * The beta invite (lib/invites.ts): apply for a code — the developer approves it by email and the code is mailed back — or type one in.
 * A redeemed code puts the account on the developer's model, capped per month; the panel then only says how much of the month is used.
 * Nothing is shown where invites are not offered (no approver, no mail, or no developer's model on this server).
 */
export function InvitePanel({ plan, onRedeemed, onSponsored, lead }: { plan?: string | undefined; onRedeemed?: () => void;
  /** The account already runs on the developer's model when the panel loads (the connect page moves on by itself then). */
  onSponsored?: () => void; lead?: string }) {
  const [state, setState] = useState<InviteState>();
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/invites", { cache: "no-store" }).then((response) => response.json()).then((body: InviteState) => {
      setState(body);
      if (body.sponsored) onSponsored?.();
    }).catch(() => undefined);
  }, [onSponsored]);
  if (!state) return null;
  if (state.sponsored) return <p className="invite-panel invite-on" role="status">
    已在用开发者提供的模型{state.budget ? `：本月已用 ¥${state.budget.spent.toFixed(2)} / ¥${state.budget.cap}` : ""}。
  </p>;
  if (!state.available) return null;
  const apply = async () => {
    setBusy(true); setStatus("提交中…");
    const body = await post("/api/invites/apply", { reason, ...(plan ? { plan } : {}) });
    setBusy(false);
    if (!body?.ok) { setStatus(body?.message ?? "申请没有成功，请重试。"); return; }
    if (body.state) setState(body.state);
    setStatus("");
  };
  const redeem = async () => {
    setBusy(true); setStatus("核对中…");
    const body = await post("/api/invites/redeem", { code });
    setBusy(false);
    if (!body?.ok) { setStatus(body?.message ?? "邀请码没有生效，请重试。"); return; }
    if (body.state) setState(body.state);
    setStatus("邀请码已生效，访谈改用开发者提供的模型。");
    onRedeemed?.();
  };
  const application = state.application;
  return <div className="invite-panel">
    {lead && <p>{lead}</p>}
    {application?.status === "pending" ? <p role="status">申请已提交，开发者通过后邀请码会发到账号邮箱。</p>
      : application?.status === "approved" ? <p role="status">申请已通过，邀请码已发到账号邮箱，填在下面即可。</p>
      : <details className="invite-apply">
        <summary>申请用开发者的模型（邮件审批）</summary>
        <p className="muted">用自己的 ChatGPT 或 API 不需要申请。这里是申请用开发者提供的模型（硅基流动）：开发者通过后，邀请码会发到账号邮箱，之后访谈和日常使用都走这个模型，每月有用量上限。</p>
        <label>想用 Crossline 做什么（可不填）
          <textarea rows={2} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void apply()}>提交申请</button>
      </details>}
    <form className="invite-redeem" onSubmit={(event) => { event.preventDefault(); if (code.trim()) void redeem(); }}>
      <label>输入邀请码
        <input type="text" value={code} maxLength={40} placeholder="CL-XXXX-XXXX" autoComplete="off" onChange={(event) => setCode(event.target.value)} />
      </label>
      <button type="submit" className="primary-button" disabled={busy || !code.trim()}>使用邀请码</button>
    </form>
    {status && <p role="status">{status}</p>}
  </div>;
}

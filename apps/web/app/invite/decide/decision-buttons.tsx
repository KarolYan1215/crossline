"use client";

import { useState } from "react";

/** 通过 / 拒绝 for one application; the answer says whether the code reached the applicant, and shows it when the mail did not go out. */
export function DecisionButtons({ token }: { token: string }) {
  const [state, setState] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const decide = async (decision: "approve" | "reject") => {
    setState({ busy: true, message: "处理中…" });
    const response = await fetch("/api/invites/decide", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, decision }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string; email?: string; mailed?: boolean; code?: string } | undefined;
    if (!body?.ok) { setState({ busy: false, message: body?.message ?? "没有处理成功，请重试。" }); return; }
    setState({ busy: true, message: decision === "reject" ? "已拒绝。"
      : body.mailed ? `已通过，邀请码已发到 ${body.email}。` : `已通过，但邮件没有发出去。请把邀请码 ${body.code} 转给 ${body.email}。` });
  };
  return <div>
    <p>
      <button type="button" className="primary-button" disabled={state.busy} onClick={() => void decide("approve")}>通过并发送邀请码</button>{" "}
      <button type="button" className="secondary-button" disabled={state.busy} onClick={() => void decide("reject")}>拒绝</button>
    </p>
    {state.message && <p role="status">{state.message}</p>}
  </div>;
}

"use client";

import { useState } from "react";
import { useT } from "../../locale-context";

/** 通过 / 拒绝 for one application; the answer says whether the code reached the applicant, and shows it when the mail did not go out. */
export function DecisionButtons({ token }: { token: string }) {
  const t = useT();
  const [state, setState] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const decide = async (decision: "approve" | "reject") => {
    setState({ busy: true, message: t("处理中…") });
    const response = await fetch("/api/invites/decide", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, decision }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string; email?: string; mailed?: boolean; code?: string } | undefined;
    if (!body?.ok) { setState({ busy: false, message: body?.message ?? t("没有处理成功，请重试。") }); return; }
    setState({ busy: true, message: decision === "reject" ? t("已拒绝。")
      : body.mailed ? t("已通过，邀请码已发到 {{email}}。", { email: body.email }) : t("已通过，但邮件没有发出去。请把邀请码 {{code}} 转给 {{email}}。", { code: body.code, email: body.email }) });
  };
  return <div>
    <p>
      <button type="button" className="primary-button" disabled={state.busy} onClick={() => void decide("approve")}>{t("通过并发送邀请码")}</button>{" "}
      <button type="button" className="secondary-button" disabled={state.busy} onClick={() => void decide("reject")}>{t("拒绝")}</button>
    </p>
    {state.message && <p role="status">{state.message}</p>}
  </div>;
}

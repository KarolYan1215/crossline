"use client";
import { useState } from "react";

/** Revoking needs a written reason for the same purpose blocking does: the ledger records why. */
export function RevokeAcceptance({ workOrderId }: { workOrderId: string }) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "revoke", reason })
    });
    if (response.ok) { location.reload(); return; }
    const failure = await response.json().catch(() => ({})) as { code?: string };
    setStatus(failure.code === "REVOCATION_REASON_REQUIRED" ? "请写明撤销原因。" : "撤销未生效，请刷新查看真实状态。");
    setBusy(false);
  };

  return <span className="revoke-acceptance">
    <label><span className="sr-only">撤销原因</span>
      <input value={reason} maxLength={200} placeholder="撤销原因（必填）" onChange={(event) => setReason(event.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => void revoke()}>撤销验收</button>
    {status && <em role="alert">{status}</em>}
  </span>;
}

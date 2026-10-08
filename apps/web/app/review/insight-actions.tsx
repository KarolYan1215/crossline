"use client";

import { useState } from "react";

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);

/**
 * Every decision on a flywheel insight, in one place (it used to be approve on 待确认 and revoke here): a candidate is approved or
 * rejected, an approved one can be revoked.
 */
export function InsightActions({ eventId, status, candidateKey }: { eventId: string; status: string; candidateKey?: string | undefined }) {
  const [message, setMessage] = useState("");
  const act = async (path: string, body: unknown) => { if (await post(path, body)) location.reload(); else setMessage("未生效，请刷新后重试"); };
  return <span className="review-actions">
    {status === "candidate" && candidateKey && <>
      <button type="button" onClick={() => void act("/api/permission-mode/approve", { key: candidateKey })}>批准</button>
      <button type="button" onClick={() => void act("/api/permission-mode/reject", { key: candidateKey })}>拒绝</button></>}
    {status === "approved" && <button type="button" onClick={() => void act("/api/permission-mode/revoke-insight", { eventId })}>撤销</button>}
    {message && <span role="alert">{message}</span>}
  </span>;
}

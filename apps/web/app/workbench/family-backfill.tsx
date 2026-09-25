"use client";
import { useState } from "react";

/**
 * Seeded and pre-`family` WorkOrders never got the tag personal-history calibration keys off, so they
 * are permanently invisible to it (`apps/web/lib/crossline.ts`'s `resolvedEstimate`). This only helps
 * *this* order's own future completion — one already `accepted` had its one write chance already.
 */
export function FamilyBackfill({ workOrderId }: { workOrderId: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const submit = async (family: string) => {
    if (!family) return;
    setBusy(true); setStatus("");
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/family`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ family })
    }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    setStatus("没有保存成功，请重试。");
    setBusy(false);
  };
  return <p className="family-backfill">
    <span>未标注类型 · 校准对它永远不生效，除非补上</span>
    <select disabled={busy} defaultValue="" onChange={(event) => void submit(event.target.value)}>
      <option value="" disabled>补上类型</option>
      <option value="preparation">准备</option>
      <option value="review">检查/评估</option>
      <option value="deep_work">深度产出</option>
    </select>
    {status && <em role="alert">{status}</em>}
  </p>;
}

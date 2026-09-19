"use client";

import { useState } from "react";

export function RevokeInsight({ eventId }: { eventId: string }) {
  const [message, setMessage] = useState("");
  return <><button type="button" onClick={async () => {
    const response = await fetch("/api/permission-mode/revoke-insight", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId }) }).catch(() => undefined);
    if (response?.ok) location.reload(); else setMessage("撤销未生效，请刷新核对状态");
  }}>撤销洞察</button>{message && <span role="alert">{message}</span>}</>;
}

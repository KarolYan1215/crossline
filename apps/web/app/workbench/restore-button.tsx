"use client";

import { useState } from "react";

/** 恢复 for an archived task or a discarded capture: back to where it was when it left the board. */
export function RestoreButton({ kind, id }: { kind: "work_order" | "capture"; id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  return <button type="button" className="text-button" disabled={state === "busy"} onClick={async () => {
    setState("busy");
    const response = await fetch("/api/restore", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id }) }).catch(() => null);
    if (response?.ok) { location.reload(); return; }
    setState("failed");
  }}>{state === "failed" ? "未恢复，重试" : "恢复"}</button>;
}

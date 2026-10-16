"use client";

import { useState } from "react";
import { useT } from "../locale-context";

/** 恢复 for an archived task or a discarded capture: back to where it was when it left the board. */
export function RestoreButton({ kind, id }: { kind: "work_order" | "capture" | "merge"; id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const t = useT();
  return <button type="button" className="text-button" disabled={state === "busy"} onClick={async () => {
    setState("busy");
    const response = await fetch("/api/restore", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id }) }).catch(() => null);
    if (response?.ok) { location.reload(); return; }
    setState("failed");
  }}>{t(state === "failed" ? "未恢复，重试" : kind === "merge" ? "撤销合并" : "恢复")}</button>;
}

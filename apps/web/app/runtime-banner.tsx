"use client";
import { useEffect, useState } from "react";
import type { RuntimeStatus } from "../lib/runtime-status";

/**
 * An error bar under the header while the background worker is down or its model runtime is signed out: everything automatic has
 * stopped, and the person should know at once rather than find a question about it among the decisions. Rechecked every minute.
 */
export function RuntimeBanner() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => fetch("/api/runtime", { cache: "no-store" }).then((response) => response.json())
      .then((body: { ok?: boolean; status?: RuntimeStatus | null }) => { if (live && body.ok) setStatus(body.status ?? null); }).catch(() => undefined);
    void read();
    const timer = setInterval(read, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return status ? <RuntimeAlert status={status} /> : null;
}

/** The bar itself; exported for its test. */
export function RuntimeAlert({ status }: { status: RuntimeStatus }) {
  return <p className="runtime-banner" role="alert" data-code={status.code}>
    <b>{status.title}</b>{status.message}
    {status.code === "signed_out" && <a href="/settings#calendar">去登录</a>}
  </p>;
}

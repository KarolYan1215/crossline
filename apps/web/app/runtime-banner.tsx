"use client";
import { useEffect, useState } from "react";
import type { RuntimeStatus } from "../lib/runtime-status";
import type { StatusNotice } from "../lib/asks";
import { pollWhileVisible } from "./ui/visible-poll";
import { useT } from "./locale-context";

/**
 * An error bar under the header while the background worker is down or its model runtime is signed out: everything automatic has
 * stopped, and the person should know at once rather than find a question about it among the decisions. Rechecked every minute.
 */
export function RuntimeBanner() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [notices, setNotices] = useState<StatusNotice[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => fetch("/api/runtime", { cache: "no-store" }).then((response) => response.json())
      .then((body: { ok?: boolean; status?: RuntimeStatus | null; notices?: StatusNotice[] }) => {
        if (live && body.ok) { setStatus(body.status ?? null); setNotices(body.notices ?? []); }
      }).catch(() => undefined);
    const stop = pollWhileVisible(read, 60_000);
    return () => { live = false; stop(); };
  }, []);
  if (status) return <RuntimeAlert status={status} />;
  return notices.length ? <>{notices.map((notice) => <StatusLine key={notice.id} notice={notice} />)}</> : null;
}

/**
 * A state that recovers by itself and asks nothing (P4, 2026-11-20): one quiet line, not a question on 待确认 and not in the badge.
 * Exported for its test.
 */
export function StatusLine({ notice }: { notice: StatusNotice }) {
  return <p className="runtime-banner" role="status" data-code="notice">
    <b>{notice.title}</b>{notice.message}
    {notice.href && <a href={notice.href}>{notice.label}</a>}
  </p>;
}

/** The bar itself; exported for its test. */
export function RuntimeAlert({ status }: { status: RuntimeStatus }) {
  const t = useT();
  return <p className="runtime-banner" role={status.code === "sponsor_standin" || status.code === "worker_restarting" ? "status" : "alert"} data-code={status.code}>
    <b>{status.title}</b>{status.message}
    {status.code === "signed_out" && <a href="/settings#model">{t("去连接")}</a>}
    {status.code === "sponsor_waiting" && <a href="/settings#model">{t("连接自己的模型")}</a>}
  </p>;
}

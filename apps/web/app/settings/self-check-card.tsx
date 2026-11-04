"use client";

import { useState } from "react";
import { SELF_CHECK_FEATURES, type CheckResult, type SelfCheckRecord } from "@crossline/core";
import { Tag } from "../ui/tag";
import { useT } from "../locale-context";

const TONE = { ok: "ok", repaired: "info", failing: "risk", skipped: "neutral" } as const;

/**
 * 系统体检's self-check (apps/worker/src/self-check.ts): what each feature found in its last daily check, what was put right by itself and
 * what was not, and a button to check again now. A feature not in use here is not listed.
 */
export function SelfCheckCard({ record }: { record?: SelfCheckRecord | undefined }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const status: Record<CheckResult["status"], string> = { ok: t("正常"), repaired: t("已自动修复"), failing: t("未能自动修复"), skipped: t("未使用") };
  const run = async () => {
    setBusy(true); setNote("");
    const response = await fetch("/api/selfcheck", { method: "POST" }).catch(() => undefined);
    setBusy(false);
    if (!response?.ok) { setNote(t("自检没有运行，后台服务可能不可用，请稍后重试")); return; }
    location.reload();
  };
  const shown = record?.results.filter((result) => result.status !== "skipped") ?? [];
  return <div className="st-selfcheck">
    <div className="st-row"><span className="st-row-label">{t("功能自检")}<small>{record
      ? t("上次 {{at}}", { at: new Date(record.at).toLocaleString() }) : t("每天自动检查一次，修好的只记录，修不好才提醒")}</small></span>
      <button type="button" className="ui-button" disabled={busy} onClick={() => void run()}>{busy ? t("检查中…") : t("立即自检")}</button></div>
    {shown.length > 0 && <ul className="st-selfcheck-list">{shown.map((result) => <li key={result.id}>
      <b>{t(SELF_CHECK_FEATURES[result.id] ?? result.id)}</b> <Tag tone={TONE[result.status]}>{status[result.status]}</Tag>
      {result.detail && <small>{result.detail}</small>}
    </li>)}</ul>}
    {record && !shown.length && <p className="st-note">{t("用到的功能都正常")}</p>}
    {note && <p role="status" className="st-note">{note}</p>}
  </div>;
}

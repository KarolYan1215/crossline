"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useT } from "../locale-context";
import { PENDING_CHANGED } from "../pending-badge";
import type { Translate } from "../../lib/i18n";
import "./answer-all.css";

type Group = { group: "risk" | "missed" | "relation" | "assistant" | "proposal"; count: number };
type Plan = { total: number; groups: Group[] };

/** Each kind as the confirmation names it; exported for its test. */
export function groupText(t: Translate, group: Group): string {
  switch (group.group) {
    case "risk": return t("风险汇总接受 {{count}} 项", { count: group.count });
    case "missed": return t("昨天没开始的顺延 {{count}} 项", { count: group.count });
    case "relation": return t("关系兑现检查下周再问 {{count}} 项", { count: group.count });
    case "assistant": return t("助手成果采纳 {{count}} 项", { count: group.count });
    case "proposal": return t("过期提议归档 {{count}} 项", { count: group.count });
  }
}

/**
 * 「全部按推荐」 (docs/rituals.md): the decisions this week that have a safe default, settled together. The button says how many before it is
 * pressed, the confirmation lists them by kind, and the result offers one 撤销. Shows nothing when there is nothing it may settle.
 */
export function AnswerAll({ head = false }: {
  /** 待确认's page head (2026-10-29): the button reads 「全部按推荐 · N 项」 with the kinds beside it before it is pressed. */
  head?: boolean } = {}) {
  const t = useT();
  const [plan, setPlan] = useState<Plan | undefined>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done: number; failed: number; opId?: string; undone?: boolean } | undefined>();
  const load = async () => {
    const response = await fetch("/api/asks/answer-all", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as (Plan & { ok?: boolean }) | undefined;
    if (body?.ok) setPlan({ total: body.total, groups: body.groups });
  };
  // Read again whenever anything on the page answers a decision (the lists below fetch again on the same event).
  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(PENDING_CHANGED, onChanged);
    return () => window.removeEventListener(PENDING_CHANGED, onChanged);
  }, []);
  const changed = () => window.dispatchEvent(new Event(PENDING_CHANGED));
  const run = async () => {
    setBusy(true);
    const response = await fetch("/api/asks/answer-all", { method: "POST" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; done?: number; failed?: number; op?: { id: string } } | undefined;
    setBusy(false);
    setOpen(false);
    if (!body?.ok) return;
    setResult({ done: body.done ?? 0, failed: body.failed ?? 0, ...(body.op ? { opId: body.op.id } : {}) });
    void load();
    changed();
  };
  const undo = async () => {
    if (!result?.opId) return;
    setBusy(true);
    const response = await fetch("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: result.opId }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { setResult({ ...result, undone: true }); void load(); changed(); }
  };
  if (result) return <div className="answer-all" role="status" aria-live="polite">
    <span>{result.undone ? t("已撤销，按推荐处理的都已恢复。") : result.failed
      ? t("已按推荐处理 {{done}} 项，{{failed}} 项期间有变化未处理。", { done: result.done, failed: result.failed })
      : t("已按推荐处理 {{done}} 项。", { done: result.done })}</span>
    {result.opId && !result.undone && <button type="button" className="text-button" disabled={busy} onClick={() => void undo()}>{t("撤销")}</button>}
  </div>;
  if (!plan?.total) return null;
  return <div className="answer-all" data-head={head || undefined}>
    {!open ? head
      ? <><button type="button" className="primary-button" onClick={() => setOpen(true)}><Sparkles size={18} strokeWidth={1.6} aria-hidden="true" />{t("全部按推荐 · {{count}} 项", { count: plan.total })}</button>
        <small className="answer-all-kinds">{plan.groups.map((group) => groupText(t, group)).join(" · ")} · {t("一次撤销")}</small></>
      : <button type="button" className="secondary-button" onClick={() => setOpen(true)}>{t("全部按推荐（{{count}} 项）", { count: plan.total })}</button>
      : <div className="answer-all-confirm">
        <p>{t("将按每张卡的推荐处理 {{count}} 项：", { count: plan.total })}</p>
        <ul>{plan.groups.map((group) => <li key={group.group}>{groupText(t, group)}</li>)}</ul>
        <p className="muted">{t("不含里程碑草稿、目标、对外动作和需要本人回答的问题。处理后可一次撤销。")}</p>
        <div className="answer-all-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>{busy ? t("处理中…") : t("确认处理")}</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => setOpen(false)}>{t("取消")}</button>
        </div>
      </div>}
  </div>;
}

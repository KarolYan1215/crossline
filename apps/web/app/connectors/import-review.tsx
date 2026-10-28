"use client";
import { useMemo, useState } from "react";
import { IMPORT_DECISION_LABEL, ticked, type ImportBatch, type ImportBatchItem } from "@crossline/core";
import { useT } from "../locale-context";
import { Sheet } from "../ui/overlay";

type Choice = { keep: boolean; lineId: string };
type View = { batches: ImportBatch[]; lines: Array<{ id: string; label: string }> };

/** Items by the line chosen for them, the person's lines in their order, then those with none. */
export function groupByLine(items: ImportBatchItem[], choices: Record<string, Choice>, lines: Array<{ id: string; label: string }>): Array<{ lineId: string; items: ImportBatchItem[] }> {
  const order = [...lines.map((line) => line.id), ""];
  return order.map((lineId) => ({ lineId, items: items.filter((item) => (choices[item.key]?.lineId ?? item.suggestion.lineId ?? "") === lineId) }))
    .filter((group) => group.items.length);
}

/**
 * 「导入核对」: every item of a batch on one screen, grouped by line, the suggestion ticked (kept and merged ones), its reason beside it,
 * and a line picker per item. One button confirms the whole batch; nothing is written before it (docs/personal-agent.md §9).
 */
export function ImportReview({ batchId, view, reload, onClose }: { batchId: string; view: View; reload: () => Promise<unknown>; onClose: (done?: string) => void }) {
  const t = useT();
  const batch = view.batches.find((item) => item.id === batchId);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = useMemo(() => batch?.items ?? [], [batch]);
  if (!batch) return null;
  const choiceOf = (item: ImportBatchItem): Choice => choices[item.key] ?? { keep: ticked(item.suggestion.decision), lineId: item.suggestion.lineId };
  const kept = items.filter((item) => choiceOf(item).keep).length;
  const set = (item: ImportBatchItem, patch: Partial<Choice>) => setChoices((current) => ({ ...current, [item.key]: { ...choiceOf(item), ...patch } }));
  const lineLabel = (id: string) => view.lines.find((line) => line.id === id)?.label ?? t("未归主线");

  const confirm = async () => {
    setBusy(true); setError("");
    const response = await fetch(`/api/import/batches/${encodeURIComponent(batchId)}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ choices: items.map((item) => ({ key: item.key, ...choiceOf(item) })) }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; captured?: number; merged?: number } | undefined;
    setBusy(false);
    if (!body?.ok) { setError(t("没能导入，稍后再试。")); return; }
    await reload();
    onClose(t("已收进 {{captured}} 条，{{merged}} 条并入已有任务；收进的条目正在分析成任务提案。", { captured: body.captured ?? 0, merged: body.merged ?? 0 }));
  };
  const discard = async () => {
    setBusy(true);
    await fetch(`/api/import/batches/${encodeURIComponent(batchId)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ remember: true }) }).catch(() => undefined);
    setBusy(false);
    await reload();
    onClose(t("这批都不要，以后也不再提示。"));
  };

  return <Sheet title={t("导入核对：{{label}}", { label: batch.label })} size="wide" open onOpenChange={(open) => { if (!open) onClose(); }}
    footer={<div className="import-review-actions">
      <button type="button" className="primary-button" disabled={busy || !kept} onClick={() => void confirm()}>{t("确认导入 {{count}} 条", { count: kept })}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void discard()}>{t("都不要")}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onClose()}>{t("稍后再核对")}</button>
    </div>}>
    <p className="muted">{batch.state === "sorting" ? t("正在按主线整理，建议会陆续更新；现在确认也可以，未整理的按「收进来」处理。")
      : batch.sorted ? t("已按主线整理。勾选的收进收集箱，随后分析成任务提案；可以逐条改主线或去掉。")
        : t("没有模型整理这批，只按规则给了建议：已做完的未勾选，其余勾选。可以逐条改主线或去掉。")}
      {batch.more ? ` ${t("另有 {{count}} 条留到下一批。", { count: batch.more })}` : ""}</p>
    {error && <p role="alert" className="muted">{error}</p>}
    {groupByLine(items, choices, view.lines).map((group) => <section key={group.lineId || "none"} className="import-group" data-line={group.lineId || undefined}>
      <h4>{lineLabel(group.lineId)} <small>{t("{{count}} 条", { count: group.items.length })}</small></h4>
      <ul className="import-items">{group.items.map((item) => {
        const choice = choiceOf(item);
        return <li key={item.key} data-kept={choice.keep || undefined}>
          <label className="import-item-main"><input type="checkbox" checked={choice.keep} disabled={busy} onChange={(event) => set(item, { keep: event.target.checked })} />
            <span className="import-item-title">{item.title}</span></label>
          <small className="import-item-meta">
            {t(IMPORT_DECISION_LABEL[item.suggestion.decision])}
            {item.suggestion.duplicateTitle ? ` · ${t("并入「{{title}}」", { title: item.suggestion.duplicateTitle })}` : ""}
            {(item.suggestion.due || item.due) ? ` · ${t("截止 {{day}}", { day: item.suggestion.due || item.due })}` : ""}
            {item.list ? ` · ${item.list}` : ""}
            {item.suggestion.why ? ` · ${item.suggestion.why}` : ""}
          </small>
          <select value={choice.lineId} disabled={busy} aria-label={t("主线")} onChange={(event) => set(item, { lineId: event.target.value })}>
            <option value="">{t("未归主线")}</option>
            {view.lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
          </select>
        </li>;
      })}</ul>
    </section>)}
  </Sheet>;
}

"use client";

import { useState } from "react";
import type { DiffLine } from "@crossline/core";
import type { InstructionsView } from "../../lib/instructions";
import { useT } from "../locale-context";
import { DiffView } from "../ui/diff-view";

type Preview = { label: string; from: string; to: string; consequence: string; diff: DiffLine[] };

const post = (body: unknown) => fetch("/api/design/instructions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as { message?: string; view?: Preview } }))
  .catch(() => ({ ok: false, body: {} as { message?: string; view?: Preview } }));

/**
 * 「给 Crossline 的话」 (apps/web/lib/instructions.ts): one text for the whole system, read by every step as the person's preferences.
 * Saved only after the before/after is shown and confirmed; every version is kept, and any one can be restored (as a new version).
 */
export function InstructionsCard({ view }: { view: InstructionsView }) {
  const t = useT();
  const [draft, setDraft] = useState(view.current.text);
  const [preview, setPreview] = useState<Preview & { revertTo?: number }>();
  const [message, setMessage] = useState("");
  const ask = async (text: string, revertTo?: number) => {
    setMessage("");
    const result = await post({ text, preview: true });
    if (!result.ok || !result.body.view) { setMessage(result.body.message ?? t("预览失败，请稍后重试")); return; }
    setPreview({ ...result.body.view, ...(revertTo !== undefined ? { revertTo } : {}) });
  };
  const confirm = async () => {
    if (!preview) return;
    const result = await post(preview.revertTo !== undefined ? { revertTo: preview.revertTo } : { text: draft });
    setPreview(undefined);
    setMessage(result.ok ? result.body.message ?? t("已保存") : result.body.message ?? t("保存失败"));
    if (result.ok) location.reload();
  };
  return <div className="st-modules">
    <section className="st-card st-card-wide" aria-label={t("给 Crossline 的话")}>
      <header><h3>{t("给 Crossline 的话")}</h3>
        <small>{t("对整个系统的长期偏好：每个环节每次运行都会读到。安全边界和需要你确认的事不受它影响。也可以直接对小帮手说。")}</small></header>
      <textarea className="st-instructions" aria-label={t("给 Crossline 的话")} maxLength={view.max} rows={6} value={draft}
        placeholder={t("例如：回答先给结论再给理由；晚上十点后不要提醒学习的事；称呼我小严")} onChange={(event) => setDraft(event.target.value)} />
      <span className="st-design-actions">
        <small className="muted">{t("{{count}} / {{max}} 字 · 第 {{version}} 版", { count: draft.length, max: view.max, version: view.current.version })}</small>
        <button type="button" className="ui-button" disabled={draft.trim() === view.current.text} onClick={() => void ask(draft)}>{t("预览改动")}</button>
      </span>
      {view.versions.length > 0 && <details className="st-instructions-versions">
        <summary>{t("历史版本（{{count}}）", { count: view.versions.length })}</summary>
        <ol>{view.versions.map((item) => <li key={item.version}>
          <span><b>{t("第 {{version}} 版", { version: item.version })}</b> <small className="muted">{new Date(item.at).toLocaleString()}
            {" · "}{item.by === "assistant" ? t("经小帮手") : t("本人")}{item.revertOf !== undefined ? t(" · 恢复自第 {{version}} 版", { version: item.revertOf }) : ""}</small></span>
          <small className="st-instructions-text">{item.text || t("（空）")}</small>
          {item.version !== view.current.version && <button type="button" className="ui-button" onClick={() => void ask(item.text, item.version)}>{t("恢复这一版")}</button>}
        </li>)}</ol>
      </details>}
    </section>
    {preview && <section className="st-card st-card-wide st-design-preview" role="dialog" aria-label={t("确认改动")}>
      <header><h3>{preview.revertTo !== undefined ? t("恢复到第 {{version}} 版", { version: preview.revertTo }) : preview.label}</h3></header>
      <DiffView diff={preview.diff} />
      <p className="st-note">{preview.consequence}</p>
      <span className="st-design-actions">
        <button type="button" className="ui-button primary" onClick={() => void confirm()}>{t("确认")}</button>
        <button type="button" className="ui-button" onClick={() => setPreview(undefined)}>{t("取消")}</button>
      </span>
    </section>}
    {message && <p role="status" className="st-note">{message}</p>}
  </div>;
}

"use client";

import { useEffect, useState } from "react";
import { TYPE_AXES, TYPE_GROUPS } from "@crossline/core";
import type { AssessOffer } from "../../lib/assess-link";
import { useT } from "../locale-context";

/**
 * The public quick test's result, found under the person's address (decided by the owner 2026-10-15): shown before the interview with its
 * code, name and four axes, and used only after 「使用该结果」. 「不是我的结果」 drops it and the app stops asking; once used, 「移除」 does
 * the same. The test's poster opens from `resultUrl` when the test's server sent one. Nothing shows when the link is off or nothing was found.
 */
export function AssessCard() {
  const t = useT();
  const [offer, setOffer] = useState<AssessOffer | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/onboarding/assess", { cache: "no-store" }).then((response) => response.json()).then((body: AssessOffer) => setOffer(body)).catch(() => undefined);
  }, []);
  const decide = async (decision: "use" | "reject") => {
    setBusy(true);
    const response = await fetch("/api/onboarding/assess", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) })
      .catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as AssessOffer | undefined;
    if (body) setOffer(body);
    setBusy(false);
  };
  if (offer?.state === "used") return <p className="ob-assess-used">
    {t("已带入公开测评结果：")}<b>{offer.result.code} {t(offer.result.typeName)}</b>{t("（只作访谈的参考，画像仍按访谈评分）")}
    <button type="button" className="ob-btn ob-quiet" disabled={busy} onClick={() => void decide("reject")}>{t("不是我 / 移除")}</button>
  </p>;
  // Shown before the interview starts, and also later when the result appears only after it began (taken after signing up).
  if (offer?.state !== "offered") return null;
  const { result } = offer;
  const group = TYPE_GROUPS[result.group];
  return <section className="ob-assess" aria-label={t("公开测评结果")} style={group ? { borderLeftColor: group.tone } : undefined}>
    <b>{t("找到这个邮箱在公开测评里的结果")}</b>
    {(result as { figureUrl?: string }).figureUrl && <img className="ob-assess-figure" src="/api/onboarding/assess/figure" alt={t("{{type}}的形象", { type: t(result.typeName) })} width={96} height={144} />}
    <p className="ob-assess-type"><span className="mono">{result.code}</span> {t(result.typeName)}{group ? <small>{t(group.name)}</small> : null}
      <small>{t("测于 {{day}}", { day: result.takenAt.slice(0, 10) })}</small></p>
    <ul className="ob-assess-axes">{TYPE_AXES.map((axis) => {
      const value = result.axes[axis.id];
      return <li key={axis.id}><span>{t(axis.left.label)}</span>
        <span className="ob-assess-bar" role="img" aria-label={t("{{left}}—{{right}}：{{value}}", { left: t(axis.left.label), right: t(axis.right.label), value })}><i style={{ left: `${value}%` }} /></span>
        <span>{t(axis.right.label)}</span></li>;
    })}</ul>
    {result.resultUrl && <a href={result.resultUrl} target="_blank" rel="noopener noreferrer">{t("查看测评海报 →")}</a>}
    <small className="ob-muted">{t("使用后，访谈把它当作参考来提问；画像的四个维度仍由访谈本身评分，两边结果各自保留。")}</small>
    <div className="ob-assess-actions">
      <button type="button" className="ob-btn ob-primary" disabled={busy} onClick={() => void decide("use")}>{t("使用该结果")}</button>
      <button type="button" className="ob-btn ob-quiet" disabled={busy} onClick={() => void decide("reject")}>{t("不是我的结果")}</button>
    </div>
  </section>;
}

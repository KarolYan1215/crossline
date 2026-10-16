"use client";
import { useState } from "react";
import { RELATION_KIND_LABEL } from "@crossline/core";
import { useT } from "../locale-context";

export type CandidateDetail = {
  id: string;
  highlighted: boolean;
  fromTitle: string; toTitle: string; fromIdentityId: string; toIdentityId: string;
  kind: string; explanation: string | null; refutedWhen: string | null;
  evidence: Array<{ uri: string; source: string; observedAt: string }>;
  targetStalledDays: number; reusesExistingArtifact: boolean; counterexampleCount: number;
  costMinutes: number | null;
};

const kindLabel: Record<string, string> = RELATION_KIND_LABEL;

/**
 * Batch approval for candidate relations, which is the approval mode the policy asks for: these are
 * cheap individually and only mean much compared against each other.
 *
 * Every candidate shows what it claims, what would refute it, and the source it came from. Approving
 * an arrow between two boxes without reading the claim would be a rubber stamp, so the claim is not
 * behind a disclosure.
 */
export function DecideRelations({ candidates }: { candidates: CandidateDetail[] }) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const decide = async (decision: "approved" | "archived") => {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/milestone-relations/decide", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: selected, decision })
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; decided?: string[]; skipped?: string[]; code?: string };
      if (!response.ok || !result.ok) {
        setStatus(result.code === "NO_RELATIONS_SELECTED" ? t("先选中至少一条候选关系。") : t("未生效，请刷新查看真实状态。"));
        setBusy(false);
        return;
      }
      // Skipped ids are reported rather than folded into the success count: a relation that was
      // already decided, or has no evidence to approve on, did not move and saying otherwise would be
      // telling the person their click did something it did not.
      if (result.skipped?.length) {
        setStatus(t("已处理 {{decided}} 条；{{skipped}} 条未变（已被决定过，或没有证据不能批准）。", { decided: result.decided?.length ?? 0, skipped: result.skipped.length }));
        setBusy(false);
        return;
      }
      location.reload();
    } catch {
      setStatus(t("网络不可用，未生效。"));
      setBusy(false);
    }
  };

  if (!candidates.length) return <p className="review-empty">{t("目前没有候选关系。")}</p>;

  return <div className="decide-relations">
    <ul className="review-list">{candidates.map((candidate) => <li key={candidate.id} data-highlighted={candidate.highlighted ? "1" : undefined}>
      <label className="relation-pick">
        <input type="checkbox" checked={selected.includes(candidate.id)} onChange={() => toggle(candidate.id)} />
        <b>{candidate.fromTitle} → {candidate.toTitle}</b>
      </label>
      <small className="relation-kind">
        {kindLabel[candidate.kind] ? t(kindLabel[candidate.kind]!) : candidate.kind}
        {candidate.fromIdentityId && candidate.toIdentityId ? ` · ${candidate.fromIdentityId} → ${candidate.toIdentityId}` : ""}
      </small>
      {candidate.explanation
        ? <p className="relation-claim">{candidate.explanation}</p>
        : <p className="relation-claim relation-claim-missing">{t("这条关系没有记录主张，无法审阅。下一次周复盘会补上依据；在此之前它只是占位，可以先搁置。")}</p>}
      {candidate.refutedWhen && <p className="relation-falsifier">{t("反证条件：{{when}}", { when: candidate.refutedWhen })}</p>}
      {candidate.evidence.length === 0
        ? <small className="relation-evidence-missing">{t("没有来源，不能批准（先勾选并“搁置”，或等周复盘补来源）。")}</small>
        : <ul className="relation-evidence">{candidate.evidence.map((item) => <li key={item.uri}>
          <a href={item.uri} target="_blank" rel="noreferrer noopener">{item.source || item.uri}</a>
          <span>{t(" · 读取于 {{day}}", { day: item.observedAt.slice(0, 10) })}</span>
        </li>)}</ul>}
      <small className="relation-facts">
        {[t("目标停滞 {{days}} 天", { days: candidate.targetStalledDays }),
          candidate.reusesExistingArtifact ? t("复用已有产物") : t("需要新产出"),
          t("反例 {{count}} 条", { count: candidate.counterexampleCount }),
          candidate.costMinutes === null ? t("成本未观测") : t("已花 {{minutes}} 分钟", { minutes: candidate.costMinutes })].join(" · ")}
      </small>
    </li>)}</ul>
    <div className="relation-actions">
      <button type="button" disabled={busy || !selected.length} onClick={() => void decide("approved")}>
        {t("批准选中 {{count}} 条", { count: selected.length })}
      </button>
      <button type="button" className="secondary-button" disabled={busy || !selected.length} onClick={() => void decide("archived")}>
        {t("搁置选中")}
      </button>
      {status && <em role="alert">{status}</em>}
    </div>
  </div>;
}

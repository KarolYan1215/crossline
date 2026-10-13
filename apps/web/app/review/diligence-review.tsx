"use client";
import { useState } from "react";
import type { DiligenceReport, Identity } from "../onboarding/onboarding-types";
import { DiligencePanel } from "../onboarding/diligence-panel";

/**
 * Web research's proposals, decided once a week here rather than counted among the day's decisions (docs/review-2026-10-13.md §11, the
 * person's decision): whether to take one is a judgement about direction, not a fact only the person can give.
 */
export function DiligenceReview({ reports, identities }: { reports: DiligenceReport[]; identities: Identity[] }) {
  const [current, setCurrent] = useState(reports);
  const [busy, setBusy] = useState(false);
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const response = await fetch("/api/diligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    setBusy(false);
    return Boolean(response?.ok);
  };
  const decide = async (reportId: string, proposalId: string, decision: "accepted" | "rejected" | "pending") => {
    if (!await post({ action: "decide", reportId, proposalId, decision })) return;
    setCurrent((reports) => reports.map((report) => report.id !== reportId ? report
      : { ...report, proposals: report.proposals.map((proposal) => proposal.id === proposalId ? { ...proposal, status: decision } : proposal) }));
  };
  return <DiligencePanel reports={current} identities={identities} busy={busy}
    onRun={(identityId) => void post({ action: "run", identityId, force: true }).then(() => location.reload())}
    onDecide={(reportId, proposalId, decision) => void decide(reportId, proposalId, decision)} />;
}

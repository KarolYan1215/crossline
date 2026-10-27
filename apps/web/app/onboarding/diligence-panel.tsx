"use client";

import { useState } from "react";
import { Clamp } from "../ui/clamp";
import { useT } from "../locale-context";
import type { DiligenceReport, Identity } from "./onboarding-types";

const DECISION: Record<string, string> = { pending: "待决定", accepted: "已采纳", rejected: "已拒绝" };
const KIND: Record<string, string> = { milestone: "里程碑", task: "任务", watch: "待观察" };
/** What accepting did, so 「已采纳」 is not the end of the story (2026-10-18 walkthrough). */
const ACCEPTED_NOTE: Record<string, string> = {
  task: "已采纳，已收进待分析，稍后在任务页出现",
  milestone: "已采纳，下次设计这条线的里程碑时用上",
  watch: "已采纳，作为背景记下"
};

/**
 * What the app found out on the web for each line, with the pages it read. A proposal is only ever a proposal:
 * accepting a task writes it down to be analysed into a task; accepting anything else makes it an input to the milestone design. The sources shown are the ones the
 * worker actually opened and checked; the ones that could not be checked were dropped before this was stored.
 */
export function DiligencePanel({ reports, identities, busy, onRun, onDecide }: {
  reports: DiligenceReport[]; identities: Identity[]; busy: boolean;
  onRun: (identityId: string) => void; onDecide: (reportId: string, proposalId: string, decision: "accepted" | "rejected" | "pending") => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | undefined>();
  const latest = new Map<string, DiligenceReport>();
  for (const report of reports) if (!latest.has(report.identityId)) latest.set(report.identityId, report);
  return <section className="ob-diligence" aria-label={t("尽调报告")}>
    <header><b>{t("网上查证")}</b><span className="ob-muted">{t("每条主线先查清事实、给出来源，再提建议；每周自动更新一次。")}</span></header>
    {identities.map((identity) => {
      const report = latest.get(identity.id);
      return <div className="ob-dd-line" key={identity.id}>
        <div className="ob-dd-head">
          <b>{identity.label}</b>
          {report?.status === "running" && <span className="ob-tag" data-kind="pending">{t("查证中…")}</span>}
          {report?.status === "failed" && <span className="ob-tag" data-kind="unsupported">{t("没有成功")}</span>}
          <span className="ob-muted">{report ? t("更新于 {{day}}", { day: report.runAt.slice(0, 10) }) : t("还没有查证")}</span>
          <button type="button" className="ob-btn ob-quiet" disabled={busy || report?.status === "running"} onClick={() => onRun(identity.id)}>
            {report?.status === "done" ? t("重新查证") : t("现在查证")}
          </button>
        </div>
        {report?.status === "failed" && report.note && <p className="ob-muted"><Clamp text={report.note} /></p>}
        {report?.status === "done" && <>
          <p className="ob-muted">{report.question}</p>
          <ul className="ob-dd-proposals">
            {report.proposals.map((proposal) => <li key={proposal.id} data-status={proposal.status}>
              <div className="ob-dd-title"><span className="ob-tag" data-kind="done">{KIND[proposal.kind] ? t(KIND[proposal.kind]!, { context: "kind" }) : proposal.kind}</span><b>{proposal.title}</b>
                {proposal.dueDate && <span className="ob-muted">{t("最晚 {{day}}", { day: proposal.dueDate })}</span>}</div>
              <p><Clamp text={proposal.why} /></p>
              <div className="ob-dd-actions">
                <span className="ob-muted">{t((proposal.status === "accepted" ? ACCEPTED_NOTE[proposal.kind] ?? DECISION.accepted : DECISION[proposal.status]) ?? "")}</span>
                {proposal.status !== "accepted" && <button type="button" className="ob-btn" disabled={busy} onClick={() => onDecide(report.id, proposal.id, "accepted")}>{t("采纳")}</button>}
                {proposal.status !== "rejected" && <button type="button" className="ob-btn ob-quiet" disabled={busy} onClick={() => onDecide(report.id, proposal.id, "rejected")}>{t("不要")}</button>}
                <button type="button" className="ob-text" aria-expanded={open === proposal.id} onClick={() => setOpen(open === proposal.id ? undefined : proposal.id)}>{t("依据")}</button>
              </div>
              {open === proposal.id && <ul className="ob-dd-evidence">
                {proposal.findingIds.map((id) => report.findings.find((finding) => finding.id === id)).filter(Boolean).map((finding) => <li key={finding!.id}>
                  {finding!.claim}
                  <small> {t("失效条件：{{when}}", { when: finding!.staleWhen })}</small>
                  {finding!.sourceIds.map((sourceId) => report.sources.find((source) => source.id === sourceId)).filter(Boolean).map((source) =>
                    <a key={source!.id} href={source!.finalUrl} target="_blank" rel="noreferrer noopener">{t("{{title}}（{{publisher}}，{{day}} 读取）", { title: source!.title, publisher: source!.publisher || new URL(source!.finalUrl).hostname, day: source!.accessedOn })}</a>)}
                </li>)}
              </ul>}
            </li>)}
            {report.proposals.length === 0 && <li className="ob-muted">{t("查到了事实，但还没有据此提出建议。")}</li>}
          </ul>
          {report.note && <p className="ob-muted"><Clamp text={report.note} /></p>}
        </>}
      </div>;
    })}
  </section>;
}

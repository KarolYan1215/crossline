"use client";

import { useState } from "react";
import { Hourglass } from "lucide-react";
import type { TaskDetail } from "../../lib/task-detail";
import type { WaitKind } from "../task/card-model";
import { TaskDialog } from "../task/task-dialog";
import { ICON } from "../ui/icon-button";
import { useT } from "../locale-context";

/**
 * One task under 在等, as a row rather than a card (2026-10-28): its line, its name, what it waits for, and where that is settled. A
 * proposal and an acceptance are decided on 待确认, and so is a waiting item once its day comes (scenarios.md 2, the one home of each); a
 * task sent back opens here, with why. The name opens the task's dialog, which still has every action.
 */
export function WaitRow({ detail, kind, label, today }: { detail: TaskDetail; kind: WaitKind; label: string; today: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const go = kind === "approval" ? { href: "/approvals#proposals", text: t("去待确认批准") }
    : kind === "gate" ? { href: "/approvals", text: t("去待确认验收") }
    : kind === "input" ? { href: "/approvals", text: t("到期后在待确认回答") }
    : undefined;
  return <li id={`work-order-${detail.id}`} className="tk-wait" data-line={detail.identityId} data-kind={kind}>
    <span className="tk-line"><i className="task-card-dot" aria-hidden="true" />{detail.identityLabel}</span>
    <button type="button" className="tk-wait-title" onClick={() => setOpen(true)}>{detail.title}</button>
    <span className="tk-wait-why"><Hourglass {...ICON} size={14} />{label}</span>
    {go ? <a className="tk-wait-go" href={go.href}>{go.text}</a>
      : kind === "returned" ? <button type="button" className="tk-wait-go" onClick={() => setOpen(true)}>{t("查看原因")}</button> : <span />}
    <TaskDialog detail={detail} today={today} open={open} onOpenChange={setOpen} />
  </li>;
}

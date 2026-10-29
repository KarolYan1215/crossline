"use client";

import { Activity, CalendarDays, FolderOpen, Link2, Mail, PenLine, Smartphone, Sparkles, type LucideIcon } from "lucide-react";
import type { ConnectionKind, ConnectionRow } from "../../lib/settings-status";
import { useT } from "../locale-context";

const ICONS: Record<ConnectionKind, LucideIcon> = { calendar: CalendarDays, subscription: Link2, writer: PenLine, mail: Mail, model: Sparkles,
  push: Smartphone, folder: FolderOpen, health: Activity };
const ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true } as const;

/**
 * Every connection as one row (2026-10-28 redesign): what it is, whether it works, when it last worked, what went wrong, and the one
 * button that goes where it is fixed. What needs the person comes first; the rest keep their order (calendars, mail, model, phone).
 */
export function SettingsStatus({ rows }: { rows: ConnectionRow[] }) {
  const t = useT();
  const ordered = [...rows].sort((a, b) => Number(b.state === "warn") - Number(a.state === "warn"));
  const broken = rows.filter((row) => row.state === "warn").length;
  return <section className="st-status" aria-labelledby="st-status-title">
    <header>
      <h2 id="st-status-title">{t("连接状态")}</h2>
      <small>{broken ? t("{{count}} 项需要处理", { count: broken }) : t("全部正常或未设置")}</small>
    </header>
    <ul>{ordered.map((row) => { const Icon = ICONS[row.kind]; return <li key={row.id} data-state={row.state}>
      <span className="st-status-icon"><Icon {...ICON} /></span>
      <span className="st-status-name"><b>{row.label}</b><small>{row.detail}</small></span>
      <span className="st-status-chip" data-state={row.state}>{row.status}</span>
      <span className="st-status-when">{row.lastOk ? t("上次成功 {{when}}", { when: row.lastOk }) : null}</span>
      <span className="st-status-error">{row.error ?? ""}</span>
      <a className="st-status-action" href={row.action.href}>{row.action.label}</a>
    </li>; })}</ul>
  </section>;
}

"use client";

import { useState } from "react";
import { useT } from "../locale-context";
import { CalendarSubscriptions } from "./calendar-subscriptions";
import { CalendarApps } from "./calendar-apps";
import "./calendar-setup-step.css";

/**
 * The calendar step of the interview's preparation page (docs/plans/2026-11-22-interview-and-import-redesign.md §四.7), reusable wherever a
 * calendar is first connected: the subscription link, provider first with its steps in full, and the ChatGPT Google calendar connector
 * that until now only Settings showed. It can be skipped. Nothing here widens a calendar write path: a subscription is read-only, and the
 * connector card only connects; writing through it stays the 写入路径 switch under Settings → 日历与连接, under the boundaries in CLAUDE.md.
 */
export function CalendarSetupStep({ onChanged, onSkip }: { onChanged?: () => void; onSkip?: () => void }) {
  const t = useT();
  const [skipped, setSkipped] = useState(false);
  if (skipped) return <p className="calendar-setup-step muted">{t("已跳过日历，以后可在 设置 → 日历与连接 接入。")}{" "}
    <button type="button" className="ob-btn ob-quiet" onClick={() => setSkipped(false)}>{t("现在接入")}</button></p>;
  return <section className="calendar-setup-step" aria-label={t("日历")}>
    <div className="calendar-setup-step-head">
      <b>{t("日历（可跳过）")}</b>
      <small>{t("接入后，访谈从这一周已有的安排问起。")}</small>
      <button type="button" className="ob-btn ob-quiet" onClick={() => { setSkipped(true); onSkip?.(); }}>{t("跳过")}</button>
    </div>
    <CalendarSubscriptions {...(onChanged ? { onChanged } : {})} />
    <CalendarApps lead={t("连接 Google 日历后，可以在 设置 → 日历与连接 打开「Google 日历（ChatGPT 连接）」写入路径，把排好的时段写进 Google 日历：只写 Crossline 自己建的日程，不动别的。")} />
  </section>;
}

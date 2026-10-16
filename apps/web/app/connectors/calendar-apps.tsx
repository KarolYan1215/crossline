"use client";
import { useEffect, useState } from "react";
import type { CalendarAppStatus } from "@crossline/core";
import { Tag } from "../ui/tag";
import { useT } from "../locale-context";

/**
 * Google and Outlook calendar as ChatGPT connectors of this account's Codex: connected or not, and a button that opens ChatGPT's own
 * page for the app in the person's browser, where they connect it. 「已连接，刷新」 reads the state again at once.
 */
export function CalendarApps() {
  const [apps, setApps] = useState<CalendarAppStatus[] | undefined>();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();

  const load = async () => {
    setBusy(true);
    const response = await fetch("/api/apps/calendar").catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; apps?: CalendarAppStatus[]; code?: string } | undefined;
    if (body?.ok && body.apps) { setApps(body.apps); setProblem(""); }
    else {
      setApps([]);
      setProblem(body?.code === "RUNTIME_UNCONNECTED" ? t("尚未连接模型服务；连接后才能读取外部日历。") : t("连接状态暂时无法读取。"));
    }
    setBusy(false);
  };
  useEffect(() => { void load(); }, []);

  return <CalendarAppsView apps={apps} problem={problem} busy={busy} onRefresh={() => void load()} />;
}

export function CalendarAppsView({ apps, problem, busy, onRefresh }: {
  apps: CalendarAppStatus[] | undefined; problem: string; busy: boolean; onRefresh: () => void;
}) {
  const t = useT();
  return <section className="st-card calendar-apps" aria-label={t("日历连接")}>
    <header><h3>{t("ChatGPT 日历连接器")}</h3><small>{t("只显示连接状态，暂不把日程读入计划；要让日历里的课表进入计划，用「订阅日历」粘贴链接")}</small></header>
    {!apps && <p className="muted">{t("读取中…")}</p>}
    {apps?.map((app) => <div className="st-row" key={app.app}>
      <span className="st-row-label">{t(app.label)}
        {!app.connected && app.installUrl && <small>{t("在 ChatGPT 页面连接后回到这里刷新")}</small>}
      </span>
      {app.connected
        ? <Tag tone={app.callable ? "ok" : "warn"}>{app.callable ? t("已连接") : t("已连接，暂不可用")}</Tag>
        : app.installUrl
          ? <a className="secondary-button" href={app.installUrl} target="_blank" rel="noopener noreferrer">{t("连接{{app}}", { app: t(app.label) })}</a>
          : <Tag tone="neutral">{t("未连接")}</Tag>}
    </div>)}
    {problem && <p role="status">{problem}</p>}
    {apps && apps.some((app) => !app.connected) && !problem && <div className="calendar-sources-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>{busy ? t("读取中…") : t("已连接，刷新")}</button>
    </div>}
  </section>;
}

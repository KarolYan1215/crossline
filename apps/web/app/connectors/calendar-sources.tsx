"use client";
import { useEffect, useState } from "react";
import { useT } from "../locale-context";

type Calendar = { id: string; name: string; isDefault: boolean; selected: boolean };
type Account = { accountId: string; username: string; signedIn: boolean; calendars: Calendar[]; error?: string };

const key = (accountId: string, calendarId: string) => `${accountId}:${calendarId}`;

/**
 * Picks which calendars, in which accounts, the plan reads.
 *
 * It exists because the answer used to be invisible: one account, its default calendar, no way to see
 * that was the rule. An event put on a newly created calendar produced 「日历没有变化」, which was true
 * and told the person nothing. Everything here is a read except the save, which writes one settings row.
 */
export function CalendarSources() {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[] | undefined>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await fetch("/api/calendar/sources").catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; accounts?: Account[]; message?: string } | undefined;
    if (body?.ok && body.accounts) { setAccounts(body.accounts); setStatus(""); return; }
    setAccounts([]);
    setStatus(t("日历列表暂时无法读取。"));
  };
  useEffect(() => { void load(); }, []);

  const toggle = (accountId: string, calendarId: string) => setAccounts((current) => current?.map((account) =>
    account.accountId !== accountId ? account : {
      ...account,
      calendars: account.calendars.map((calendar) =>
        calendar.id === calendarId ? { ...calendar, selected: !calendar.selected } : calendar)
    }));

  const save = async () => {
    setBusy(true);
    const keys = (accounts ?? []).flatMap((account) => account.calendars
      .filter((calendar) => calendar.selected).map((calendar) => key(account.accountId, calendar.id)));
    const response = await fetch("/api/calendar/sources", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys })
    }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; accounts?: Account[]; message?: string } | undefined;
    if (body?.ok && body.accounts) {
      setAccounts(body.accounts);
      // Said plainly: saving changes what the NEXT sync reads; it does not itself pull anything.
      setStatus(t("已保存，下次同步时生效；「计划」页的同步按钮可立即同步。"));
    } else {
      setStatus(t("未保存，请重试。"));
    }
    setBusy(false);
  };

  if (!accounts) return <section className="st-card"><header><h3>{t("读取的日历")}</h3></header><p className="muted">{t("读取中…")}</p></section>;

  return <section className="st-card calendar-sources" aria-label={t("读取的日历")}>
    <header><h3>{t("读取的日历")}</h3><small>{t("勾选的日历作为固定日程进入计划；新账号默认勾选其默认日历")}</small></header>
    {accounts.length === 0 && <p className="muted">{t("尚无已登录的日历账号。")}</p>}
    {accounts.map((account) => <div className="calendar-account" key={account.accountId}>
      <h3>{account.username}</h3>
      {account.error
        ? <p role="status">{t("该账号的日历暂时无法读取；已导入的日程保持不变。")}</p>
        : account.calendars.map((calendar) => <label key={calendar.id}>
          <input type="checkbox" checked={calendar.selected}
            onChange={() => toggle(account.accountId, calendar.id)} />
          <span>{calendar.name}{calendar.isDefault ? t("（默认）") : ""}</span>
        </label>)}
    </div>)}
    {accounts.length > 0 && <div className="calendar-sources-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
        {busy ? t("保存中…") : t("保存选择")}
      </button>
    </div>}
    {status && <p role="status">{status}</p>}
  </section>;
}

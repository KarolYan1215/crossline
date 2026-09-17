"use client";
import { useEffect, useState } from "react";

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
  const [accounts, setAccounts] = useState<Account[] | undefined>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await fetch("/api/calendar/sources").catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; accounts?: Account[]; message?: string } | undefined;
    if (body?.ok && body.accounts) { setAccounts(body.accounts); setStatus(""); return; }
    setAccounts([]);
    setStatus(body?.message ?? "读不到日历列表；worker 可能没在跑，或者还没有账号登录。");
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
      setStatus("已保存。下次同步日历时生效——现在就要看结果的话，去 Plan 页点「立即同步日历」。");
    } else {
      setStatus(body?.message ?? "没能保存，请刷新后重试。");
    }
    setBusy(false);
  };

  if (!accounts) return <article className="status-card"><h2>日历来源</h2><p>正在读取…</p></article>;

  return <article className="status-card calendar-sources">
    <h2>日历来源</h2>
    <p className="review-note">
      只有勾上的日历会进计划的现实轨。没勾的不读，它的块也不会留在计划上。
      新登录的账号会自动勾上它的默认日历，别的日历要自己勾。
    </p>
    {accounts.length === 0 && <p>还没有任何账号登录。用 <code>pnpm exec tsx scripts/graph-add-account.ts</code> 加一个。</p>}
    {accounts.map((account) => <div className="calendar-account" key={account.accountId}>
      <h3>{account.username}</h3>
      {account.error
        ? <p role="status">这个账号读不到日历（{account.error}）；它已有的块保持原样，不会被当成已删除。</p>
        : account.calendars.map((calendar) => <label key={calendar.id}>
          <input type="checkbox" checked={calendar.selected}
            onChange={() => toggle(account.accountId, calendar.id)} />
          <span>{calendar.name}{calendar.isDefault ? "（默认）" : ""}</span>
        </label>)}
    </div>)}
    {accounts.length > 0 && <div className="calendar-sources-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "保存选择"}
      </button>
    </div>}
    {status && <p role="status">{status}</p>}
  </article>;
}

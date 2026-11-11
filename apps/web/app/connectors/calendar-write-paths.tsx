"use client";

import { useState } from "react";
import { useT } from "../locale-context";
import "./calendar-write-paths.css";

export type PathView = { path: "ics" | "imip" | "google" | "graph"; on: boolean; last?: { at: string; text: string }; failure?: { at: string; code: string; message: string } };

const LABEL = { ics: "订阅链接（任何日历应用）", imip: "邮件邀请", google: "Google 日历（ChatGPT 连接）", graph: "Microsoft 日历（Crossline 日历）" } as const;
const HINT = {
  ics: "在日历应用里「通过网址添加/订阅日历」。只含已确认的固定日程和工作块，标题为「主线 · 任务名」，不含备注与材料。拿到链接的人都能看到，可随时换新链接。",
  imip: "从 calendar@mail.crossline.lol 给下面的邮箱发日历邀请；在邮件应用里接受后出现在日历上。时间变了发更新，删除发取消；工作块只发未来 7 天的。",
  google: "通过本人在 ChatGPT 里连接的 Google 日历写入：有名为 Crossline 的日历就写进去，没有就写主日历并在标题前加「Crossline · 」。只改本应用建、本人没动过的日程，只删未来的。",
  graph: "写入微软账号里名为 Crossline 的日历；需要本站配置了 Microsoft 应用并登录写入账号。"
} as const;
const FAILURE: Record<string, string> = {
  CALENDAR_IMIP_NO_MAIL: "本站没有配置 Resend 发信，邮件邀请发不出去",
  CALENDAR_IMIP_NO_RECIPIENT: "还没有收邀请的邮箱",
  CALENDAR_GOOGLE_NOT_CONNECTED: "ChatGPT 里还没连接 Google 日历，或模型连接不是 ChatGPT 登录",
  CALENDAR_GOOGLE_NO_WRITE_TOOLS: "Google 日历连接器没有写入工具",
  CODEX_SUPERVISOR_UNAVAILABLE: "后台服务未运行，恢复后自动重试",
  CALENDAR_WRITE_NOT_AUTHORIZED: "写入账号的登录已过期或未授权，需要本人重新登录",
  GRAPH_NOT_CONFIGURED: "本站没有配置 Microsoft 日历"
};

/** 写入日历: the four paths of the owner's decision of 2026-11-10, each with its switch, last write and last failure. */
export function CalendarWritePaths({ initial, feedUrl, recipient: initialRecipient, graphAvailable }: { initial: PathView[]; feedUrl: string; recipient: string; graphAvailable: boolean }) {
  const t = useT();
  const [paths, setPaths] = useState(initial);
  const [recipient, setRecipient] = useState(initialRecipient);
  const feed = feedUrl;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async (body: object) => {
    setBusy(true);
    const result = await fetch("/api/calendar/write-paths", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((response) => response.json() as Promise<{ ok: boolean; code?: string; paths?: PathView[]; recipient?: string }>).catch(() => null);
    setBusy(false);
    if (result?.paths) setPaths(result.paths);
    // Turning invitations on fills in the account's address on the server; show it.
    if (result?.recipient) setRecipient(result.recipient);
    setNote(!result ? t("没有保存，请重试。") : result.ok ? "" : result.code === "CALENDAR_IMIP_NO_RECIPIENT" ? t("先在下面填写收邀请的邮箱。")
      : result.code === "EMAIL_INVALID" ? t("邮箱地址格式不对。") : t("没有保存，请重试。"));
    return result?.ok === true;
  };
  const reset = async () => {
    if (!window.confirm(t("换新链接后，旧链接立即失效，已订阅的日历要用新链接重新添加。继续吗？"))) return;
    if (await post({ resetToken: true })) location.reload();
  };
  return <section className="st-card" aria-label={t("写入日历")}>
    <header><h3>{t("写入日历")}</h3><small>{t("只写已确认的固定日程和计划里的工作块；邮件里的活动要本人点「去」才会写入。可以同时开几种。")}</small></header>
    {paths.filter((item) => item.path !== "graph" || graphAvailable || item.on).map((item) => <div key={item.path} className="st-row" data-path={item.path}>
      <span className="st-row-label">{t(LABEL[item.path])}<small>{t(HINT[item.path])}</small>
        {item.on && item.last && <small>{t("最近：{{text}}（{{at}}）", { text: item.last.text, at: new Date(item.last.at).toLocaleString() })}</small>}
        {item.on && item.failure && <small role="status" className="st-warn">{t("上次未完成：{{why}}（{{at}}）", { why: FAILURE[item.failure.code] ? t(FAILURE[item.failure.code]!) : item.failure.message || item.failure.code,
          at: new Date(item.failure.at).toLocaleString() })}</small>}
        {item.on && item.path === "ics" && feed && <span className="st-feed">
          <input readOnly value={feed} aria-label={t("订阅链接")} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(feed); setNote(t("已复制。")); }}>{t("复制")}</button>
          <a href={feed.replace(/^https?:/, "webcal:")}>{t("在日历应用中打开")}</a>
          <button type="button" disabled={busy} onClick={() => void reset()}>{t("换新链接")}</button></span>}
        {item.path === "imip" && <span className="st-feed">
          <input type="email" value={recipient} placeholder={t("收邀请的邮箱")} aria-label={t("收邀请的邮箱")} onChange={(event) => setRecipient(event.currentTarget.value)} />
          <button type="button" disabled={busy || !recipient.trim()} onClick={() => void post({ recipient })}>{t("保存邮箱")}</button></span>}
      </span>
      <label className="st-switch"><input type="checkbox" role="switch" checked={item.on} disabled={busy}
        onChange={async (event) => { const on = event.currentTarget.checked; if (await post({ path: item.path, on }) && item.path === "ics" && on && !feed) location.reload(); }} />
        <span>{item.on ? t("已开启") : t("未开启")}</span></label>
    </div>)}
    {note && <p role="status" className="muted">{note}</p>}
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { BROWSER_USE_DOWNLOAD_MB, BROWSER_USE_VERSION, FORM_STATE_LABEL, SLOT_LABEL, STOP_LABEL, type ApplicationSlot, type FormRunState, type FormStop } from "@crossline/core";
import { useT } from "../locale-context";
import { ApplyKitSection } from "./apply-kit-card";
import type { ApplyKit, LoginVaultEntry } from "@crossline/core";

export type ApplyItem = { slot: ApplicationSlot; sensitive: boolean; present: boolean; value?: string; usedBy: Array<{ title: string; at: string }> };
export type ApplyRun = {
  id: string; title: string; host: string; state: FormRunState; pageNo: number; stoppedFor?: FormStop; stopDetail?: string; missingSlot?: ApplicationSlot;
  heldBecause: string[]; checklist: Array<{ field: string; shown: string }>; problems: string[]; injections: number; refused: number;
  shots: number; confirmation?: string; submittedBy?: "system" | "person"; calendar: boolean; updatedAt: string;
};

/**
 * 报名资料卡 (docs/opportunity-agent.md §12–§13): each item the form filler may use, where it came from, which registrations used it,
 * edited and deleted here; a sensitive item is shown only as held, never its value. Below it, every registration being filled or filled,
 * with why it stopped, what is about to be submitted and the screenshots.
 */
export function ApplyCard({ items, runs, screen, kit, logins = [] }: { items: ApplyItem[]; runs: ApplyRun[]; screen: boolean; kit?: ApplyKit | undefined; logins?: LoginVaultEntry[] }) {
  const t = useT();
  const [editing, setEditing] = useState<ApplicationSlot | undefined>();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const post = async (url: string, method: "POST" | "DELETE", body?: unknown) => {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => undefined);
    if (!response?.ok) {
      const code = await response?.json().then((json: { code?: string }) => json.code ?? "").catch(() => "") ?? "";
      setNote(code === "FORM_NEEDS_SCREEN" ? t("没有连上带浏览器的电脑节点，代填要在本人电脑上运行")
        : code === "SENSITIVE_NEEDS_COMPUTER" ? t("敏感项只存在本人电脑上：电脑上的 Crossline 连上后再保存或删除")
        : code === "SENSITIVE_VERIFY_FAILED" ? t("电脑上没有核对通过，没有保存")
        : code.startsWith("PROFILE_") ? t("格式不对，没有保存") : t("没有完成，请重试"));
      return false;
    }
    setNote("");
    window.location.reload();
    return true;
  };
  const save = async (slot: ApplicationSlot) => { if (await post(`/api/apply-profile/${slot}`, "POST", { value: draft })) { setEditing(undefined); setDraft(""); } };

  return <section className="st-card" aria-label={t("报名资料卡")}>
    <header><h3>{t("报名资料卡")}</h3><small>{t("代填报名表时只用这里的内容；敏感项只存在本机密钥库，不进账本、导出和备份")}</small></header>
    {items.map((item) => <div className="st-row" key={item.slot}>
      <span className="st-row-label">{t(SLOT_LABEL[item.slot])}{item.sensitive && <> · {t("敏感")}</>}
        <small>{!item.present ? t("未填") : item.sensitive ? (screen ? t("已保存在本机") : t("已保存在本人电脑上")) : item.value}
          {item.usedBy.length > 0 && <> · {t("用于 {{count}} 次报名：{{titles}}", { count: item.usedBy.length, titles: item.usedBy.slice(0, 3).map((use) => use.title).join("、") })}</>}</small></span>
      {editing === item.slot
        ? <span className="st-inline-form">
            <input aria-label={t(SLOT_LABEL[item.slot])} type={item.sensitive ? "password" : "text"} autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button type="button" className="secondary-button" onClick={() => void save(item.slot)}>{t("保存")}</button>
            <button type="button" className="text-button" onClick={() => { setEditing(undefined); setDraft(""); }}>{t("取消")}</button>
          </span>
        : <span className="st-inline-form">
            <button type="button" className="secondary-button" onClick={() => { setEditing(item.slot); setDraft(item.sensitive ? "" : item.value ?? ""); }}>{item.present ? t("修改") : t("填写")}</button>
            {item.present && <button type="button" className="text-button" onClick={() => void post(`/api/apply-profile/${item.slot}`, "DELETE")}>{t("删除")}</button>}
          </span>}
    </div>)}

    {screen && <LoginVault logins={logins} />}

    {kit && <ApplyKitSection kit={kit} />}

    {screen && <BrowserUseTool />}

    <h4>{t("代填的报名")}</h4>
    {!screen && <p className="muted">{t("托管版在本人电脑的 Crossline 节点浏览器里代填；节点未连接时报名会等它连上")}</p>}
    {runs.length === 0 ? <p className="muted">{t("还没有报名。在机会卡上点「报名」后会出现在这里。")}</p> : runs.map((run) => <article key={run.id} className="st-run">
      <p className="st-run-head"><b>{run.title}</b> · {t(FORM_STATE_LABEL[run.state])}
        {run.state === "waiting_person" && run.stoppedFor && <> · {run.stoppedFor === "missing_slot" && run.missingSlot ? t("缺「{{slot}}」", { slot: t(SLOT_LABEL[run.missingSlot]) }) : t(STOP_LABEL[run.stoppedFor])}</>}</p>
      <p className="muted">{run.host} · {t("第 {{page}} 页", { page: run.pageNo })}{run.stopDetail ? ` · ${run.stopDetail}` : ""}
        {run.injections > 0 && <> · {t("页面里有 {{count}} 处试图指挥代填的文字，已忽略", { count: run.injections })}</>}
        {run.refused > 0 && <> · {t("规则拦下 {{count}} 个动作", { count: run.refused })}</>}</p>
      {run.heldBecause.length > 0 && <p>{t("没有自动提交，因为：{{why}}", { why: run.heldBecause.map((item) => t(item)).join("；") })}</p>}
      {run.problems.length > 0 && <p>{t("提交前总核提出：{{problems}}", { problems: run.problems.join("；") })}</p>}
      {run.checklist.length > 0 && <ul className="st-checklist">{run.checklist.map((item, index) => <li key={index}>{item.field}：{item.shown}</li>)}</ul>}
      {run.confirmation && <p>{t("确认：{{quote}}", { quote: run.confirmation })}{run.calendar ? ` · ${t("已写入日历")}` : ""}</p>}
      {run.shots > 0 && <p><a href={`/api/forms/${run.id}/shot?n=-1`} target="_blank" rel="noreferrer">{t("最近一张截图")}</a></p>}
      <div className="st-inline-form">
        {(run.state === "waiting_person" || run.state === "ready_to_submit") && <>
          <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/front`, "POST")}>{t("显示窗口")}</button>
          {run.state === "waiting_person" && <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/continue`, "POST")}>{t("继续")}</button>}
          <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/submitted`, "POST")}>{t("本人已提交")}</button>
        </>}
        {run.state === "submitted" && <button type="button" className="secondary-button" onClick={() => void post(`/api/forms/${run.id}/confirm`, "POST")}>{t("已收到确认")}</button>}
        {run.state !== "confirmed" && run.state !== "stopped" && <button type="button" className="text-button" onClick={() => void post(`/api/forms/${run.id}/stop`, "POST")}>{t("停止")}</button>}
      </div>
    </article>)}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

/**
 * 网站登录 (docs/plans/harness-1125.md §5, the owner's decision of 2026-11-25): a host, a username and a password the form filler may
 * type on that site's own login page, nothing else. Both go to this computer's secret store; the page lists hosts only and never shows
 * a password again. Payment, captchas and one-time codes stay the person's.
 */
function LoginVault({ logins }: { logins: LoginVaultEntry[] }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const send = async (url: string, method: "POST" | "DELETE", body?: unknown) => {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => undefined);
    if (!response?.ok) {
      setNote(response?.status === 409 ? t("网站登录只能存在本人电脑上的 Crossline 里") : response?.status === 400 ? t("格式不对，没有保存") : t("没有完成，请重试"));
      return;
    }
    setPassword("");
    window.location.reload();
  };
  return <div className="st-row">
    <span className="st-row-label">{t("网站登录")}
      <small>{t("代填遇到这个网站自己的登录页时，由程序填入并登录；密码只存在本机密钥库，不进账本、模型、截图和备份。不用于付款；验证码和二次验证仍交本人。")}</small>
      {logins.length > 0 && <ul className="st-checklist">{logins.map((entry) => <li key={entry.host}>{entry.host}
        <button type="button" className="text-button" onClick={() => void send(`/api/apply-logins/${encodeURIComponent(entry.host)}`, "DELETE")}>{t("删除")}</button></li>)}</ul>}
      {note && <small role="status">{note}</small>}</span>
    {adding
      ? <span className="st-inline-form">
          <input aria-label={t("网站")} placeholder="example.com" autoComplete="off" value={host} onChange={(event) => setHost(event.target.value)} />
          <input aria-label={t("用户名")} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} />
          <input aria-label={t("密码")} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="button" className="secondary-button" onClick={() => void send("/api/apply-logins", "POST", { host, username, password })}>{t("保存")}</button>
          <button type="button" className="text-button" onClick={() => { setAdding(false); setPassword(""); }}>{t("取消")}</button>
        </span>
      : <span className="st-inline-form"><button type="button" className="secondary-button" onClick={() => setAdding(true)}>{t("添加网站登录")}</button></span>}
  </div>;
}

type ToolStatus = { state: "absent" | "installing" | "installed" | "failed"; error?: string };

/**
 * browser-use, the second fallback when a page is too unusual for the filler and Stagehand: not shipped, fetched only on this press,
 * which says where it comes from, how large it is and the Python it needs. It reads a static copy of the page and only proposes fields.
 */
function BrowserUseTool() {
  const t = useT();
  const [status, setStatus] = useState<ToolStatus | undefined>();
  const [note, setNote] = useState("");
  const read = () => fetch("/api/forms/browser-use").then((response) => response.ok ? response.json() as Promise<ToolStatus> : undefined).then(setStatus).catch(() => undefined);
  useEffect(() => { void read(); }, []);
  useEffect(() => {
    if (status?.state !== "installing") return;
    const timer = setInterval(() => void read(), 10_000);
    return () => clearInterval(timer);
  }, [status?.state]);
  const install = async () => {
    const response = await fetch("/api/forms/browser-use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: true }) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("没有开始下载，请重试")); return; }
    setNote("");
    setStatus({ state: "installing" });
  };
  if (!status) return null;
  return <div className="st-row">
    <span className="st-row-label">{t("备用填表引擎 browser-use")}
      <small>{status.state === "installed" ? t("已安装（{{version}}），页面版式特殊时只读页面副本、提出要填的字段", { version: BROWSER_USE_VERSION })
        : status.state === "installing" ? t("正在下载安装，约需几分钟到半小时")
        : status.state === "failed" ? (status.error === "PYTHON_MISSING" ? t("这台电脑没有 Python 3.11 或更新版本，装好后再下载") : t("下载没有完成，可以再试一次"))
        : t("来自 PyPI，约 {{mb}} MB，需要本机有 Python 3.11 或更新版本；下载后才会使用", { mb: BROWSER_USE_DOWNLOAD_MB })}
        {note && <> · {note}</>}</small></span>
    {(status.state === "absent" || status.state === "failed") && <span className="st-inline-form">
      <button type="button" className="secondary-button" onClick={() => void install()}>{t("下载 browser-use")}</button>
    </span>}
  </div>;
}

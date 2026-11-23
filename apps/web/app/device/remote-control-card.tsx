"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { intlLocale } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

type Phone = { id: string; label: string; groups: string; addedAt: string; lastUsedAt?: string };
type AuditEntry = { at: string; event: string; ok: boolean; code?: string; session?: string; phone?: string; detail?: Record<string, unknown> };
type RemoteView = { ok?: boolean; level?: "off" | "remote" | "unattended"; phones: Phone[]; pairing: { code: string; expiresAt: string; candidate?: { id: string; label: string; groups: string } } | null;
  folders: string[]; transcribe: boolean; audit: AuditEntry[]; chain: { ok: boolean; lines: number; brokenAt?: number }; session: { id: string; folder: string } | null; auditFile?: string;
  missing?: Array<{ type: string; at: string; nonce?: string }>; checked?: number; code?: string; message?: string };

/**
 * 「从手机遥控」 on this computer (docs/plans/remote-control-1122.md §5.1, §7.2, §7.3): what only this computer's own page sets — the
 * phones confirmed here (their fingerprint compared with the phone's), the folders a session may work in, 「替手机转写录音」,
 * 「断开遥控」 — and the audit log with its hash chain and 「核对」 against the hosted record.
 */
export function RemoteControlCard() {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<RemoteView | undefined>();
  const [folders, setFolders] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch("/api/device/remote", { cache: "no-store" }).catch(() => undefined);
    if (!response?.ok) { setView(undefined); return; }
    const next = await response.json().catch(() => undefined) as RemoteView | undefined;
    if (next?.phones) { setView(next); setFolders((current) => current || next.folders.join("\n")); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 4_000); return () => clearInterval(timer); }, []);
  if (!view || view.level === "off" || !view.level) return null;
  const act = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    const response = await fetch("/api/device/remote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    const next = await response?.json().catch(() => undefined) as RemoteView | undefined;
    setBusy(false);
    if (!next || next.ok === false) { setNote(next?.message ?? t("没有保存，请重试。")); return; }
    setView(next);
    setNote(done ?? "");
  };
  const time = (iso?: string) => iso ? new Date(iso).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
  return <section className="st-card" aria-label={t("从手机遥控")}>
    <header><h3>{t("从手机遥控")}</h3><small>{t("手机只能执行它签了名的指令；手机、文件夹和开关只在这台电脑上设置，网页版改不了")}</small></header>
    {view.session && <div className="st-row"><span className="st-row-label">{t("进行中的会话")}<small>{view.session.folder}</small></span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ disconnect: true }, t("已断开遥控。"))}>{t("断开遥控")}</button></div>}
    <div className="st-row"><span className="st-row-label">{t("已配对的手机")}<small>{view.phones.length ? t("移除后，那部手机签的指令一律拒绝") : t("还没有配对的手机")}</small></span>
      {!view.pairing && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ pair: "start" })}>{t("添加手机")}</button>}</div>
    {view.phones.map((phone) => <div key={phone.id} className="st-row"><span className="st-row-label">{phone.label}<small>{t("指纹 {{groups}} · {{when}} 添加 · 最近使用 {{used}}", { groups: phone.groups, when: time(phone.addedAt), used: time(phone.lastUsedAt) })}</small></span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ remove: phone.id }, t("已移除。"))}>{t("移除")}</button></div>)}
    {view.pairing && (view.pairing.candidate ? <div className="st-row"><span className="st-row-label">{t("核对指纹")}<small>{t("手机「{{label}}」上显示的数字应为：", { label: view.pairing.candidate.label })}</small>
      <b style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 18, letterSpacing: 2 }}>{view.pairing.candidate.groups}</b></span>
      <span><button type="button" className="primary-button" disabled={busy} onClick={() => void act({ confirm: view.pairing!.candidate!.id }, t("已添加。"))}>{t("一致，确认添加")}</button>{" "}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ pair: "cancel" })}>{t("取消")}</button></span></div>
      : <div className="st-row"><span className="st-row-label">{t("配对码")}<small>{t("在手机上打开网页版「遥控电脑」，填入这个码；{{when}} 前有效", { when: time(view.pairing.expiresAt) })}</small>
        <b style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 24, letterSpacing: 3 }}>{view.pairing.code}</b></span>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ pair: "cancel" })}>{t("取消")}</button></div>)}
    <label className="st-row"><span className="st-row-label">{t("遥控可用的文件夹")}<small>{t("每行一个完整路径。不填时，会话只在自己的临时文件夹里工作")}</small></span>
      <textarea rows={3} value={folders} onChange={(event) => setFolders(event.target.value)} spellCheck={false} /></label>
    <div className="st-row"><span className="st-row-label" /><button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ folders: folders.split("\n") }, t("已保存。"))}>{t("保存文件夹")}</button></div>
    <div className="st-row"><span className="st-row-label">{t("替手机转写录音")}<small>{t("电脑在线时，手机上传的录音在这台电脑上转写，只回文字；关闭时由网页版夜间转写")}</small></span>
      <SegmentedControl label={t("替手机转写录音")} value={view.transcribe ? "on" : "off"} options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]}
        onChange={(next) => void act({ transcribe: next === "on" })} /></div>
    <div className="st-row"><span className="st-row-label">{t("审计日志")}<small>{view.chain.ok ? t("{{count}} 条，哈希链完整；只存在这台电脑上：{{file}}", { count: view.chain.lines, file: view.auditFile ?? "" })
      : t("第 {{line}} 条之后的哈希链对不上：日志被改过", { line: view.chain.brokenAt ?? 0 })}</small></span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ check: true })}>{t("核对")}</button></div>
    {view.missing && <p className="st-note" role="status">{view.missing.length ? t("网页版记录里有 {{count}} 条遥控指令在这台电脑的日志里找不到：{{list}}", { count: view.missing.length, list: view.missing.slice(0, 5).map((item) => `${item.type} ${time(item.at)}`).join("；") })
      : t("最近 7 天网页版记录的 {{count}} 条遥控指令，这台电脑的日志里都有。", { count: view.checked ?? 0 })}</p>}
    <details><summary>{t("最近的记录")}</summary>
      <ul className="cr-audit">{view.audit.slice(0, 40).map((entry, index) => <li key={index}>{time(entry.at)} · {entry.event}{entry.code ? ` · ${entry.code}` : ""}{entry.phone ? ` · ${entry.phone}` : ""}</li>)}</ul></details>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

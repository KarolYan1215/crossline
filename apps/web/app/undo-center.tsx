"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { intlLocale, tFor, type Locale, type Translate } from "../lib/i18n";
import { useLocale, useT } from "./locale-context";

/** `label` is stored as written at the time; one the app wrote in Chinese is a catalogue key and reads in today's language (`t`). */
type Op = { id: string; label: string; at: string };
const FRESH_MS = 20_000;
const SEEN_KEY = "crossline.undo.seen";
const UNDO_CODE: Record<string, string> = {
  OP_NOT_UNDOABLE: "已超过 24 小时或已撤销",
  APPROVAL_ALREADY_ACTED_ON: "任务已开始或已提交，无法撤销批准",
  WORK_ORDER_NOT_RESTORABLE: "当前状态无法恢复"
};

const readSeen = (): string[] => { try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]; } catch { return []; } };
const markSeen = (id: string) => { try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...readSeen(), id].slice(-50))); } catch { /* private mode */ } };

/** `t` is the page's language (`useT()`); Chinese when not given. */
export async function undoOperation(id: string, t: Translate = tFor(undefined)): Promise<{ ok: boolean; message: string }> {
  const response = await fetch("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => null);
  const body = await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
  if (response?.ok && body?.ok) return { ok: true, message: t("已撤销") };
  return { ok: false, message: t(UNDO_CODE[body?.code ?? ""] ?? "未能撤销，请刷新后重试") };
}

const timeOf = (iso: string, locale: Locale) => new Date(iso).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Undo, in the frame of every page: a toast after an operation (pages reload after most actions, so the toast reads the log on load
 * and shows an operation from the last 20 seconds once), a list of the day's operations in the top bar, and Ctrl+Z outside a text
 * field for the newest one.
 */
export function UndoCenter() {
  const t = useT();
  const locale = useLocale();
  const [ops, setOps] = useState<Op[]>([]);
  const [toast, setToast] = useState<Op | null>(null);
  const [status, setStatus] = useState("");
  const menu = `undo-${useId().replace(/:/g, "")}`;

  const load = useCallback(async () => {
    const response = await fetch("/api/ops").catch(() => null);
    const body = await response?.json().catch(() => null) as { ops?: Op[] } | null;
    const list = body?.ops ?? [];
    setOps(list);
    const newest = list[0];
    if (newest && Date.now() - Date.parse(newest.at) < FRESH_MS && !readSeen().includes(newest.id)) { markSeen(newest.id); setToast(newest); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    // Answers on the to-decide list do not reload the page; they announce themselves with `crossline:pending-changed`.
    for (const name of ["crossline:op", "crossline:pending-changed"]) window.addEventListener(name, refresh);
    return () => { for (const name of ["crossline:op", "crossline:pending-changed"]) window.removeEventListener(name, refresh); };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const undo = useCallback(async (op: Op) => {
    setStatus(t("正在撤销…"));
    const result = await undoOperation(op.id, t);
    setStatus(result.ok ? t("已撤销：{{label}}", { label: t(op.label) }) : result.message);
    if (result.ok) setTimeout(() => location.reload(), 500);
  }, [t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const newest = ops[0];
      if (!newest) return;
      event.preventDefault();
      void undo(newest);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ops, undo]);

  return <>
    {ops.length > 0 && <>
      <button type="button" className="undo-trigger" popoverTarget={menu} title={t("最近 24 小时的操作，可撤销（Ctrl+Z 撤销最近一项）")}>{t("撤销")}</button>
      <div id={menu} popover="auto" className="ui-menu undo-menu" role="menu" aria-label={t("最近操作")}>
        {ops.slice(0, 15).map((op) => <button key={op.id} type="button" role="menuitem" onClick={(event) => {
          (event.currentTarget.parentElement as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
          void undo(op);
        }}><span>{t(op.label)}</span><small className="mono">{timeOf(op.at, locale)}</small></button>)}
      </div>
    </>}
    {(toast || status) && <div className="undo-toast" role="status">
      {status ? <span>{status}</span> : toast && <>
        <span>{t(toast.label)}</span>
        <button type="button" onClick={() => void undo(toast)}>{t("撤销")}</button>
        <button type="button" aria-label={t("关闭")} onClick={() => setToast(null)}>×</button>
      </>}
    </div>}
  </>;
}

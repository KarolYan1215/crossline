"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PenLine, RefreshCw, Upload } from "lucide-react";
import { refreshHelper } from "../helper-state";
import { intlLocale, type Locale, type Translate } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

type Figure = { file: string; at: string; kind: "drawn" | "uploaded"; version: number; latest: boolean; current: boolean; url: string };

/** Status lines are kept as their Chinese keys and translated where shown. */
const UPLOAD_CODE: Record<string, string> = { FIGURE_TOO_LARGE: "图片超过 8 MB", FIGURE_NOT_AN_IMAGE: "只接受 PNG、JPEG 或 WebP 图片" };
const labelOf = (figure: Figure, t: Translate) => figure.kind === "uploaded" ? t("本人上传") : t("第 {{version}} 版画像", { version: figure.version });
const dayOf = (iso: string, locale: Locale) => iso ? new Date(iso).toLocaleDateString(intlLocale(locale), { month: "numeric", day: "numeric" }) : "";

/**
 * Which figure the 小帮手 and the portrait show (2026-10-21): every figure drawn before, plus any the person added, each with
 * 「用这一版作小帮手」. A rewritten report keeps the figure; 「重画一版」 asks for a new one and keeps the old ones. Every choice is undoable
 * from the top bar.
 */
export function FigurePicker({ onCurrent, appearance }: { onCurrent: (url: string | null) => void; appearance: { text: string; skipped: boolean } }) {
  const t = useT();
  const locale = useLocale();
  const [figures, setFigures] = useState<Figure[]>([]);
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState(appearance.text);
  const [look, setLook] = useState(appearance.text);
  // Nothing said yet opens the box; a description on record is one line with a pencil.
  const [editing, setEditing] = useState(!appearance.text);
  const [redrawing, setRedrawing] = useState<number | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const body = await fetch("/api/portrait/figures", { cache: "no-store" }).then((response) => response.json()).catch(() => null) as { figures?: Figure[] } | null;
    const list = body?.figures ?? [];
    setFigures(list);
    onCurrent(list.find((figure) => figure.current)?.url ?? null);
    return list;
  }, [onCurrent]);
  useEffect(() => { void load(); }, [load]);

  // After 「重画一版」 the list is read again until a new figure lands (a drawing takes a minute or two), for twenty minutes at most.
  useEffect(() => {
    if (redrawing === null) return;
    const started = Date.now();
    const timer = setInterval(() => void load().then((list) => {
      if (list.length > redrawing) { setRedrawing(null); setStatus("新的一版已画好，可以选用"); }
      else if (Date.now() - started > 20 * 60_000) { setRedrawing(null); setStatus("这次没有画出新的一版，请稍后重试"); }
    }), 8000);
    return () => clearInterval(timer);
  }, [redrawing, load]);

  const changed = async () => { window.dispatchEvent(new Event("crossline:op")); refreshHelper(); await load(); };
  const choose = async (file: string | null) => {
    setStatus("");
    const response = await fetch("/api/portrait/figures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) }).catch(() => null);
    if (response?.ok) await changed(); else setStatus("未能更换，请刷新后重试");
  };
  const add = async (file: File) => {
    setStatus("正在上传…");
    const response = await fetch("/api/portrait/figures/upload", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file }).catch(() => null);
    const body = await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
    if (body?.ok) { setStatus("已上传并用作小帮手"); await changed(); } else setStatus(UPLOAD_CODE[body?.code ?? ""] ?? "上传失败，请重试");
  };
  const redraw = async () => {
    setStatus("");
    const response = await fetch("/api/portrait", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redrawFigure: true }) }).catch(() => null);
    if (response?.ok) { setRedrawing(figures.length); setStatus("正在画新的一版，通常需要一两分钟；之前的各版都保留"); } else setStatus("未能开始重画，请稍后重试");
  };

  const chosen = figures.some((figure) => figure.current && !figure.latest);
  const current = figures.find((figure) => figure.current);
  const saveLook = async (skip: boolean) => {
    setStatus("");
    const response = await fetch("/api/portrait/appearance", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(skip ? { skip: true } : { text: look }) }).catch(() => null);
    if (response?.ok) { setSaved(skip ? "" : look.trim()); setEditing(false); setStatus(skip ? "已记下：用中性形象" : "已记下外形描述；点「重画一版」按新描述画"); }
    else setStatus("没有保存，请重试");
  };
  return <section className="pt-figures" id="pt-figure-card" data-no-export="" aria-labelledby="pt-figure-title">
    <header>{current ? <img src={current.url} alt="" /> : <span className="pt-figure-blank" aria-hidden="true" />}
      <b id="pt-figure-title">{t("小帮手形象")}</b>{figures.length > 0 && <small>{t("{{count}} 版", { count: figures.length })}</small>}</header>
    {/* How the person looks, the one description the figure is drawn from (2026-10-28: here, beside 重画, and no longer asked in the interview again). */}
    <div className="pt-look">
      <small>{t("外形描述（只用来画形象）")}</small>
      {editing ? <form onSubmit={(event) => { event.preventDefault(); if (look.trim()) void saveLook(false); }}>
        <textarea value={look} rows={2} maxLength={200} onChange={(event) => setLook(event.target.value)} aria-label={t("外形描述")}
          placeholder={t("例如：男，狼尾长发，常穿全黑")} />
        <span><button type="submit" className="primary-button" disabled={!look.trim()}>{t("保存")}</button>
          {!saved && <button type="button" className="text-button" onClick={() => void saveLook(true)}>{t("不描述，用中性形象")}</button>}
          {saved && <button type="button" className="text-button" onClick={() => { setLook(saved); setEditing(false); }}>{t("取消")}</button>}</span>
      </form> : <button type="button" className="pt-look-now" onClick={() => setEditing(true)} aria-label={t("修改外形描述")}>
        <span className="gen">{saved}</span><PenLine size={15} strokeWidth={1.75} aria-hidden="true" /></button>}
    </div>
    <div className="pt-figure-actions">
      {chosen && <button type="button" className="secondary-button" onClick={() => void choose(null)}>{t("改用最新画的一版")}</button>}
      <button type="button" className="secondary-button" disabled={redrawing !== null} onClick={() => void redraw()}><RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />{redrawing !== null ? t("重画中…") : t("重画一版")}</button>
      <button type="button" className="secondary-button" onClick={() => upload.current?.click()}><Upload size={15} strokeWidth={1.75} aria-hidden="true" />{t("上传一张")}</button>
      <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void add(file); }} />
    </div>
    {status && <small role="status">{t(status)}</small>}
    {figures.length > 0 && <details className="pt-figure-versions">
    <summary>{t("全部 {{count}} 版", { count: figures.length })}</summary>
    <p className="muted">{t("小帮手和画像使用同一个形象。重新生成画像不会更换形象；只有本人改了外貌描述，或在这里要求重画，才会画新的一版。")}</p>
    <ul className="pt-figure-list">
      {figures.map((figure) => <li key={figure.file} data-current={figure.current ? "" : undefined}>
        <img src={figure.url} alt={labelOf(figure, t)} loading="lazy" />
        <span>{labelOf(figure, t)}{figure.at ? ` · ${dayOf(figure.at, locale)}` : ""}{figure.latest ? ` · ${t("最新")}` : ""}</span>
        {figure.current ? <strong>{t("当前小帮手")}</strong>
          : <button type="button" onClick={() => void choose(figure.file)}>{t("用这一版作小帮手")}</button>}
      </li>)}
    </ul>
    </details>}
  </section>;
}

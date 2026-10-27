"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { DEVICE_LINK_GUIDE } from "../../lib/setup-guides";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Locale, type Translate } from "../../lib/i18n";

type NodeEntryView = { key: string; host: string; role: "device" | "standalone"; capacity: number; state: string; at: string; message?: string };
type NodeView = { available: boolean; enabled: boolean; status: { state: string; host?: string; codex?: string; at: string; message?: string; nodes?: NodeEntryView[] } | null;
  paired?: { host: string; at: string } | null };
type Status = { linked: boolean; lastSeen: { at: string; label?: string } | null; folders: Array<{ id: string; label: string; files: number }>; documents: number };
const time = (iso: string, locale: Locale) => new Date(iso).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 「这台电脑」 (docs/device-mode.md): the person's own computer as a device of this account. A token is made here and pasted on that
 * computer's `/device` page; it reads its screen activity, folders and recordings and sends the results here, while every plan and every
 * model run stays on this site. The token is shown once; making another or 撤销 cuts the old one off at once.
 */
export function DeviceCard({ siteUrl }: { siteUrl: string | null }) {
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<Status | undefined>();
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const load = async () => {
    const response = await fetch("/api/device/token", { cache: "no-store" }).catch(() => undefined);
    if (response?.ok) setStatus(await response.json() as Status);
  };
  useEffect(() => { void load(); }, []);
  const issue = async () => {
    const response = await fetch("/api/device/token", { method: "POST" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { token?: string } | undefined;
    if (!body?.token) { setNote(t("没有生成，请重试")); return; }
    setToken(body.token);
    setNote(t("令牌只显示这一次。旧令牌已失效。"));
    void load();
  };
  const revoke = async () => {
    const response = await fetch("/api/device/token", { method: "DELETE" }).catch(() => undefined);
    setToken("");
    setNote(response?.ok ? t("已撤销：电脑的下一次发送会被拒绝。已收到的内容保留。") : t("没有撤销，请重试"));
    void load();
  };
  return <section className="st-card" aria-label={t("这台电脑")} id="device">
    <header><h3>{t("这台电脑")}</h3><small>{t("本人电脑上的 Crossline 作为这个账号的设备：只读那台电脑的屏幕活动、作息、文件夹和录音，结果发到这里；计划与模型工作只在网页版进行")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("状态")}<small>{!status ? t("读取中") : status.linked
      ? status.lastSeen ? (status.lastSeen.label ? t("最后收到 {{when}}（{{label}}）", { when: time(status.lastSeen.at, locale), label: status.lastSeen.label }) : t("最后收到 {{when}}", { when: time(status.lastSeen.at, locale) }))
        : t("已生成令牌，还没收到过设备数据")
      : t("没有连接设备")}</small></span>
      <span>{status?.linked && <button type="button" className="secondary-button" onClick={() => void revoke()}>{t("撤销")}</button>}{" "}
        <button type="button" className="primary-button" onClick={() => void issue()}>{status?.linked ? t("重新生成令牌") : t("生成设备令牌")}</button></span></div>
    {status?.linked && status.folders.length > 0 && <div className="st-row"><span className="st-row-label">{t("文件夹")}<small>{t("收到 {{count}} 个文件", { count: status.documents })}</small></span>
      <span className="muted">{status.folders.map((folder) => folder.label).join(locale === "en" ? ", " : "、")}</span></div>}
    {token && <div className="st-row"><span className="st-row-label">{t("设备令牌")}<small>{t("复制后粘贴到那台电脑的设备页")}</small></span><code className="mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{token}</code></div>}
    {token && siteUrl && <div className="st-row"><span className="st-row-label">{t("网页版地址")}</span><code className="mono" style={{ userSelect: "all" }}>{siteUrl}</code></div>}
    <ComputeNodeRow />
    {note && <p role="status" className="st-note">{note}</p>}
    <SetupGuide guide={DEVICE_LINK_GUIDE} />
  </section>;
}

const NODE_STATE_WORDS: Record<string, string> = { ready: "在线", connected: "正在准备", offline: "离线", refused: "没有接入" };

/** What the node's last state means for the person (docs/compute-node.md). */
function nodeWords(view: NodeView, t: Translate, locale: Locale): string {
  const at = view.status?.at ? time(view.status.at, locale) : "";
  if (!view.enabled) return t("关闭：模型工作都在服务器上");
  switch (view.status?.state) {
    case "ready": {
      const ready = (view.status.nodes ?? []).filter((node) => node.state === "ready");
      return ready.length > 1 ? t("{{count}} 台电脑在线：本账号的模型工作先交给它们，满了再由服务器接着跑", { count: ready.length })
        : view.status.host ? t("已连接 {{host}}：本账号的模型工作先交给它，满了再由服务器接着跑", { host: view.status.host }) : t("已连接：本账号的模型工作先交给它，满了再由服务器接着跑");
    }
    case "connected": return t("已连上，正在准备");
    case "refused": return t("没有接入（{{at}}）：{{why}}", { at, why: view.status.message ?? t("被拒绝") });
    case "offline": return t("离线（{{at}}起）：模型工作暂在服务器上", { at });
    default: return t("已开启，等那台电脑在设备页也开启「作为算力节点」");
  }
}

/**
 * 「作为算力节点」: the person's linked computer may also run this account's model work with its own Codex, while it is on (docs/compute-node.md).
 * Only the account that owns this server's runtime sees it. Off, or whenever the computer is away, everything runs on the server as before.
 */
function ComputeNodeRow() {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<NodeView | undefined>();
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const load = async () => {
    const response = await fetch("/api/device/compute", { cache: "no-store" }).catch(() => undefined);
    if (response?.ok) setView(await response.json() as NodeView);
  };
  const pair = async () => {
    const response = await fetch("/api/node/pair/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; host?: string; message?: string } | undefined;
    if (!body?.ok) { setNote(body?.message ?? t("没有配对，请重试")); return; }
    setCode("");
    setNote(body.host ? t("已配对 {{host}}：那台电脑几秒内连上，这里会显示。", { host: body.host }) : t("已配对：那台电脑几秒内连上，这里会显示。"));
    void load();
  };
  const unpair = async () => {
    const response = await fetch("/api/node/pair", { method: "DELETE" }).catch(() => undefined);
    setNote(response?.ok ? t("已解除配对：那台电脑 15 秒内断开。") : t("没有解除，请重试"));
    void load();
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 20_000); return () => clearInterval(timer); }, []);
  if (!view?.available) return null;
  const change = async (enabled: boolean) => {
    setView({ ...view, enabled });
    const response = await fetch("/api/device/compute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).catch(() => undefined);
    if (!response?.ok) { setView({ ...view }); setNote(t("未保存，请重试")); return; }
    setView(await response.json() as NodeView);
    setNote(enabled ? t("已开启。那台电脑的设备页也要开启，连上后这里会显示。") : t("已关闭：15 秒内断开，模型工作回到服务器。"));
  };
  return <>
    <div className="st-row"><span className="st-row-label">{t("作为算力节点")}<small>{nodeWords(view, t, locale)}</small></span>
      <SegmentedControl label={t("作为算力节点")} value={view.enabled ? "on" : "off"} options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]}
        onChange={(next) => void change(next === "on")} /></div>
    {(view.status?.nodes ?? []).filter((node) => node.key !== "?").map((node) => <div className="st-row" key={node.key}>
      <span className="st-row-label">{node.host || t("一台电脑")}<small>{`${node.role === "device" ? t("设备模式，优先") : t("独立节点")} · ${t("同时 {{count}} 路", { count: node.capacity })}`}</small></span>
      <span className="muted">{NODE_STATE_WORDS[node.state] ? t(NODE_STATE_WORDS[node.state]!) : node.state}{node.message && node.state !== "ready" ? t("（{{detail}}）", { detail: node.message }) : ""}</span></div>)}
    {view.paired
      ? <div className="st-row"><span className="st-row-label">{t("独立节点")}<small>{t("已配对 {{host}}（{{when}}）", { host: view.paired.host || t("一台电脑"), when: time(view.paired.at, locale) })}</small></span>
        <button type="button" className="secondary-button" onClick={() => void unpair()}>{t("解除配对")}</button></div>
      : <label className="st-row"><span className="st-row-label">{t("独立节点")}<small>{t("在那台电脑上安装「Crossline 节点」，把它显示的配对码填在这里")}</small></span>
        <span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} maxLength={12} style={{ width: "9em" }} />{" "}
          <button type="button" className="primary-button" disabled={code.replace(/[^A-Za-z0-9]/g, "").length !== 8} onClick={() => void pair()}>{t("配对")}</button></span></label>}
    {note && <p role="status" className="st-note">{note}</p>}
  </>;
}

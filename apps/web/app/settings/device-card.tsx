"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { DEVICE_LINK_GUIDE } from "../../lib/setup-guides";

type NodeView = { available: boolean; enabled: boolean; status: { state: string; host?: string; codex?: string; at: string; message?: string } | null;
  paired?: { host: string; at: string } | null };
type Status = { linked: boolean; lastSeen: { at: string; label?: string } | null; folders: Array<{ id: string; label: string; files: number }>; documents: number };
const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 「这台电脑」 (docs/device-mode.md): the person's own computer as a device of this account. A token is made here and pasted on that
 * computer's `/device` page; it reads its screen activity, folders and recordings and sends the results here, while every plan and every
 * model run stays on this site. The token is shown once; making another or 撤销 cuts the old one off at once.
 */
export function DeviceCard({ siteUrl }: { siteUrl: string | null }) {
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
    if (!body?.token) { setNote("没有生成，请重试"); return; }
    setToken(body.token);
    setNote("令牌只显示这一次。旧令牌已失效。");
    void load();
  };
  const revoke = async () => {
    const response = await fetch("/api/device/token", { method: "DELETE" }).catch(() => undefined);
    setToken("");
    setNote(response?.ok ? "已撤销：电脑的下一次发送会被拒绝。已收到的内容保留。" : "没有撤销，请重试");
    void load();
  };
  return <section className="st-card" aria-label="这台电脑" id="device">
    <header><h3>这台电脑</h3><small>本人电脑上的 Crossline 作为这个账号的设备：只读那台电脑的屏幕活动、作息、文件夹和录音，结果发到这里；计划与模型工作只在网页版进行</small></header>
    <div className="st-row"><span className="st-row-label">状态<small>{!status ? "读取中" : status.linked
      ? status.lastSeen ? `最后收到 ${time(status.lastSeen.at)}${status.lastSeen.label ? `（${status.lastSeen.label}）` : ""}` : "已生成令牌，还没收到过设备数据"
      : "没有连接设备"}</small></span>
      <span>{status?.linked && <button type="button" className="secondary-button" onClick={() => void revoke()}>撤销</button>}{" "}
        <button type="button" className="primary-button" onClick={() => void issue()}>{status?.linked ? "重新生成令牌" : "生成设备令牌"}</button></span></div>
    {status?.linked && status.folders.length > 0 && <div className="st-row"><span className="st-row-label">文件夹<small>{`收到 ${status.documents} 个文件`}</small></span>
      <span className="muted">{status.folders.map((folder) => folder.label).join("、")}</span></div>}
    {token && <div className="st-row"><span className="st-row-label">设备令牌<small>复制后粘贴到那台电脑的设备页</small></span><code className="mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{token}</code></div>}
    {token && siteUrl && <div className="st-row"><span className="st-row-label">网页版地址</span><code className="mono" style={{ userSelect: "all" }}>{siteUrl}</code></div>}
    <ComputeNodeRow />
    {note && <p role="status" className="st-note">{note}</p>}
    <SetupGuide guide={DEVICE_LINK_GUIDE} />
  </section>;
}

/** What the node's last state means for the person (docs/compute-node.md). */
function nodeWords(view: NodeView): string {
  const at = view.status?.at ? time(view.status.at) : "";
  if (!view.enabled) return "关闭：模型工作都在服务器上";
  switch (view.status?.state) {
    case "ready": return `已连接${view.status.host ? ` ${view.status.host}` : ""}：本账号的模型工作在那台电脑上跑`;
    case "connected": return "已连上，正在准备";
    case "refused": return `没有接入（${at}）：${view.status.message ?? "被拒绝"}`;
    case "offline": return `离线（${at}起）：模型工作暂在服务器上`;
    default: return "已开启，等那台电脑在设备页也开启「作为算力节点」";
  }
}

/**
 * 「作为算力节点」: the person's linked computer may also run this account's model work with its own Codex, while it is on (docs/compute-node.md).
 * Only the account that owns this server's runtime sees it. Off, or whenever the computer is away, everything runs on the server as before.
 */
function ComputeNodeRow() {
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
    if (!body?.ok) { setNote(body?.message ?? "没有配对，请重试"); return; }
    setCode("");
    setNote(`已配对${body.host ? ` ${body.host}` : ""}：那台电脑几秒内连上，这里会显示。`);
    void load();
  };
  const unpair = async () => {
    const response = await fetch("/api/node/pair", { method: "DELETE" }).catch(() => undefined);
    setNote(response?.ok ? "已解除配对：那台电脑 15 秒内断开。" : "没有解除，请重试");
    void load();
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 20_000); return () => clearInterval(timer); }, []);
  if (!view?.available) return null;
  const change = async (enabled: boolean) => {
    setView({ ...view, enabled });
    const response = await fetch("/api/device/compute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).catch(() => undefined);
    if (!response?.ok) { setView({ ...view }); setNote("未保存，请重试"); return; }
    setView(await response.json() as NodeView);
    setNote(enabled ? "已开启。那台电脑的设备页也要开启，连上后这里会显示。" : "已关闭：15 秒内断开，模型工作回到服务器。");
  };
  return <>
    <div className="st-row"><span className="st-row-label">作为算力节点<small>{nodeWords(view)}</small></span>
      <SegmentedControl label="作为算力节点" value={view.enabled ? "on" : "off"} options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]}
        onChange={(next) => void change(next === "on")} /></div>
    {view.paired
      ? <div className="st-row"><span className="st-row-label">独立节点<small>{`已配对 ${view.paired.host || "一台电脑"}（${time(view.paired.at)}）`}</small></span>
        <button type="button" className="secondary-button" onClick={() => void unpair()}>解除配对</button></div>
      : <label className="st-row"><span className="st-row-label">独立节点<small>在那台电脑上安装「Crossline 节点」，把它显示的配对码填在这里</small></span>
        <span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} maxLength={12} style={{ width: "9em" }} />{" "}
          <button type="button" className="primary-button" disabled={code.replace(/[^A-Za-z0-9]/g, "").length !== 8} onClick={() => void pair()}>配对</button></span></label>}
    {note && <p role="status" className="st-note">{note}</p>}
  </>;
}

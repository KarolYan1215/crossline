"use client";

import { useEffect, useState } from "react";
import { SetupGuide } from "../ui/setup-guide";
import { DEVICE_LINK_GUIDE } from "../../lib/setup-guides";

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
    {note && <p role="status" className="st-note">{note}</p>}
    <SetupGuide guide={DEVICE_LINK_GUIDE} />
  </section>;
}

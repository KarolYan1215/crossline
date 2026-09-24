"use client";
import { useEffect, useState } from "react";

type TailscaleIdentity = { login: string; name?: string };
type TailscaleBinding = { id: string; tailscaleLogin: string; nodeKey?: string; createdAt: string };

/**
 * Purely an audit record — see `apps/web/app/api/connectors/tailscale/route.ts`'s doc comment. Clicking
 * "信任" never grants access by itself; every route still requires the normal Better Auth session it
 * already required. This card only exists so the owner can see and revoke which Tailscale logins they
 * have confirmed, when accessed over `https://<hostname>.ts.net` via `tailscale serve`.
 */
export function TailscaleTrust() {
  const [current, setCurrent] = useState<TailscaleIdentity | null | undefined>(undefined);
  const [bindings, setBindings] = useState<TailscaleBinding[]>([]);
  const [status, setStatus] = useState("");

  const refresh = async () => {
    const response = await fetch("/api/connectors/tailscale").catch(() => undefined);
    if (!response?.ok) { setCurrent(null); return; }
    const body = await response.json() as { current: TailscaleIdentity | null; bindings: TailscaleBinding[] };
    setCurrent(body.current);
    setBindings(body.bindings);
  };
  useEffect(() => { void refresh(); }, []);

  const trust = async () => {
    const response = await fetch("/api/connectors/tailscale", { method: "POST" });
    if (response.ok) { setStatus("已信任"); void refresh(); }
    else setStatus("信任失败，请刷新重试");
  };
  const revoke = async (tailscaleLogin: string) => {
    await fetch("/api/connectors/tailscale", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ tailscaleLogin })
    });
    void refresh();
  };

  return <article className="status-card">
    <span className="status-badge">{current === undefined ? "检查中" : current ? "通过 Tailscale 访问" : "未通过 Tailscale 访问"}</span>
    <h2>Tailscale 身份</h2>
    {current === null && <p>当前不是通过 tailscale serve 访问的（本机 127.0.0.1 属于正常情况）。</p>}
    {current && <>
      <p>本次连接：{current.login}{current.name ? ` (${current.name})` : ""}</p>
      {!bindings.some((item) => item.tailscaleLogin === current.login) &&
        <button type="button" onClick={() => void trust()}>信任这个 Tailscale 身份</button>}
      {status && <small className="muted" role="status">{status}</small>}
    </>}
    {bindings.length > 0 && <ul>{bindings.map((item) => <li key={item.id}>
      {item.tailscaleLogin} · {item.createdAt.slice(0, 10)}
      <button type="button" onClick={() => void revoke(item.tailscaleLogin)}>撤销</button>
    </li>)}</ul>}
    <details><summary>说明</summary><p>仅作记录，不构成登录旁路——任何页面仍然需要正常的账号登录会话。</p></details>
  </article>;
}

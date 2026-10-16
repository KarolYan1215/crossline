"use client";
import { useEffect, useState } from "react";
import { useT } from "../locale-context";

type TailscaleIdentity = { login: string; name?: string };
type TailscaleBinding = { id: string; tailscaleLogin: string; nodeKey?: string; createdAt: string };

/**
 * Purely an audit record — see `apps/web/app/api/connectors/tailscale/route.ts`'s doc comment. Clicking
 * "信任" never grants access by itself; every route still requires the normal Better Auth session it
 * already required. This card only exists so the owner can see and revoke which Tailscale logins they
 * have confirmed, when accessed over `https://<hostname>.ts.net` via `tailscale serve`.
 */
export function TailscaleTrust() {
  const t = useT();
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
    if (response.ok) { setStatus(t("已信任")); void refresh(); }
    else setStatus(t("信任失败，请刷新重试"));
  };
  const revoke = async (tailscaleLogin: string) => {
    await fetch("/api/connectors/tailscale", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ tailscaleLogin })
    });
    void refresh();
  };

  return <section className="st-card" aria-label={t("私有网络身份")}>
    <header><h3>{t("私有网络身份")}</h3><small>{t("仅作记录，不替代登录")}</small></header>
    {current === null && <p className="muted">{t("当前为本机访问。")}</p>}
    {current && <>
      <p>{t("本次连接：{{login}}", { login: current.name ? `${current.login} (${current.name})` : current.login })}</p>
      {!bindings.some((item) => item.tailscaleLogin === current.login) &&
        <button type="button" onClick={() => void trust()}>{t("记录为可信身份")}</button>}
      {status && <small className="muted" role="status">{status}</small>}
    </>}
    {bindings.length > 0 && <ul>{bindings.map((item) => <li key={item.id}>
      {item.tailscaleLogin} · {item.createdAt.slice(0, 10)}
      <button type="button" onClick={() => void revoke(item.tailscaleLogin)}>{t("撤销")}</button>
    </li>)}</ul>}
  </section>;
}

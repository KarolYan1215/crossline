"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Signing in on an installed copy (docs/local-installer.md, 登录): one button, one OpenAI page. The button starts the machine's own
 * Codex ChatGPT sign-in and opens its page in a new tab; this page keeps asking whether Codex now holds an account and, the moment
 * it does, takes the session it stands for. A Codex that is already signed in (a reinstall that kept its data) needs no click.
 */
type Phase = "checking" | "idle" | "waiting" | "starting-codex";

async function trySession(): Promise<{ ok: boolean; code?: string }> {
  const response = await fetch("/api/auth/codex-local/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .catch(() => undefined);
  if (!response) return { ok: false, code: "NETWORK" };
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({})) as { code?: string };
  return { ok: false, ...(body.code ? { code: body.code } : {}) };
}

export function LocalLogin() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = useCallback(async (keepWaiting: boolean) => {
    const result = await trySession();
    if (result.ok) { location.href = "/"; return; }
    // Codex is still starting (first launch builds its home): keep asking quietly.
    if (result.code === "CODEX_UNAVAILABLE" || result.code === "NETWORK") { setPhase((current) => current === "checking" ? "starting-codex" : current); }
    else if (!keepWaiting) setPhase("idle");
    if (result.code === "LOCAL_SIGNIN_LOOPBACK_ONLY") { setMessage("只能在本机地址登录：从托盘图标打开 Crossline。"); setPhase("idle"); return; }
    if (keepWaiting || result.code === "CODEX_UNAVAILABLE" || result.code === "NETWORK") timer.current = setTimeout(() => void poll(keepWaiting), 2000);
  }, []);

  useEffect(() => { void poll(false); return () => clearTimeout(timer.current); }, [poll]);

  const start = async () => {
    setMessage("");
    const response = await fetch("/api/local-auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const body = await response?.json().catch(() => ({})) as { authUrl?: string; code?: string } | undefined;
    if (!response?.ok || !body?.authUrl) { setMessage("Codex 尚未就绪，几秒后再试。"); return; }
    window.open(body.authUrl, "_blank", "noopener");
    setPhase("waiting");
    clearTimeout(timer.current);
    void poll(true);
  };

  const cancel = async () => {
    clearTimeout(timer.current);
    await fetch("/api/local-auth/login", { method: "DELETE" }).catch(() => undefined);
    setPhase("idle");
  };

  return <div className="local-login">
    {phase === "checking" && <p className="muted">正在检查 Codex 的登录状态…</p>}
    {phase === "starting-codex" && <p className="muted">Codex 正在启动，第一次可能需要半分钟…</p>}
    {phase === "idle" && <>
      <p>模型以本人的 ChatGPT 账号运行。登录一次，之后打开即可使用。</p>
      <button type="button" className="primary" onClick={() => void start()}>用 ChatGPT 登录</button>
    </>}
    {phase === "waiting" && <>
      <p>ChatGPT 登录已在新标签页打开。登录完成后，本页自动进入 Crossline。</p>
      <button type="button" onClick={() => void cancel()}>取消</button>
    </>}
    {message && <p role="alert" className="form-error">{message}</p>}
  </div>;
}

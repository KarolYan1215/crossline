"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Signing in on an installed copy (docs/local-installer.md, 登录; look and copy in docs/onboarding-v3.md): one button, one OpenAI page.
 * The button starts the machine's own Codex ChatGPT sign-in and opens its page in a new tab; this page keeps asking whether Codex now
 * holds an account and, the moment it does, takes the session it stands for. A Codex that is already signed in (a reinstall that kept
 * its data) needs no click. The three steps below the button are the whole way in, and the current one moves while it waits.
 */
type Phase = "checking" | "idle" | "waiting" | "starting-codex" | "entering";

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
  const [waited, setWaited] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = useCallback(async (keepWaiting: boolean) => {
    const result = await trySession();
    if (result.ok) { setPhase("entering"); location.href = "/"; return; }
    // Codex is still starting (first launch builds its home): keep asking quietly.
    if (result.code === "CODEX_UNAVAILABLE" || result.code === "NETWORK") { setPhase((current) => current === "checking" ? "starting-codex" : current); }
    else if (!keepWaiting) setPhase("idle");
    if (result.code === "LOCAL_SIGNIN_LOOPBACK_ONLY") { setMessage("只能在本机地址登录：从托盘图标打开 Crossline。"); setPhase("idle"); return; }
    if (keepWaiting || result.code === "CODEX_UNAVAILABLE" || result.code === "NETWORK") timer.current = setTimeout(() => void poll(keepWaiting), 2000);
  }, []);

  useEffect(() => { void poll(false); return () => clearTimeout(timer.current); }, [poll]);
  // How long Codex has been starting, said in seconds rather than a bar that would only pretend to know.
  useEffect(() => {
    if (phase !== "starting-codex") return;
    const started = Date.now();
    const tick = setInterval(() => setWaited(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [phase]);

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

  const ready = phase === "idle" || phase === "waiting";
  const steps: Array<{ title: string; detail: string; state: "done" | "current" | "next"; busy?: boolean }> = [
    { title: "登录 ChatGPT", detail: phase === "waiting" ? "已在新标签页打开；在那里登录后回到这里" : "在新标签页打开 OpenAI 的登录页",
      state: phase === "entering" ? "done" : ready ? "current" : "next", busy: phase === "waiting" },
    { title: "回到这里，自动进入", detail: "不用刷新，登录完成后本页自动继续",
      state: phase === "entering" ? "current" : "next", busy: phase === "entering" },
    { title: "回答几轮问题", detail: "约 30 分钟得到第一版一周安排", state: "next" }
  ];

  return <div className="login-panel-body" aria-live="polite">
    {phase === "waiting"
      ? <button type="button" className="login-cta" onClick={() => void start()}>重新打开 ChatGPT 登录页</button>
      : <button type="button" className="login-cta" disabled={!ready} onClick={() => void start()}>
          {phase === "starting-codex" ? `正在启动 Codex · ${waited} 秒` : phase === "checking" ? "正在检查登录状态" : phase === "entering" ? "正在进入" : "Continue with ChatGPT"}
        </button>}
    {phase === "starting-codex" && <small className="login-privacy">第一次启动约需半分钟，之后打开即可使用。</small>}
    <ol className="login-steps" aria-label="登录步骤">{steps.map((step, index) =>
      <li key={step.title} data-state={step.state} data-busy={step.busy || undefined}>
        <span className="login-step-mark" aria-hidden="true">{step.state === "done" ? "✓" : index + 1}</span>
        <span><b>{step.title}</b><small>{step.detail}</small></span>
      </li>)}</ol>
    {phase === "waiting" && <button type="button" className="login-secondary" onClick={() => void cancel()}>取消登录</button>}
    {message && <p role="alert" className="login-error">{message}</p>}
    <p className="login-privacy">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="6" width="10" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      <span>数据只存在这台电脑；模型用本人的 ChatGPT 额度运行，登录凭据由本机的 Codex 保管，不会上传。</span>
    </p>
  </div>;
}

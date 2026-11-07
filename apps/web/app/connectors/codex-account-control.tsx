"use client";

import { useEffect, useRef, useState } from "react";
import { Tag } from "../ui/tag";
import { Stepper } from "../ui/stepper";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";
import { tFor, type Translate } from "../../lib/i18n";

type Login = {
  state?: "pending" | "completed" | "failed" | "canceled";
  blocker?: { code: string; message: string };
  type?: "chatgpt" | "chatgptDeviceCode" | "apiKey";
  authUrl?: string; verificationUrl?: string; userCode?: string;
};
type AccountState = {
  account?: { type?: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth?: boolean;
  blocker?: { code: string; message: string };
  /** This account runs on its own Codex (not the machine owner's): its login is its own, and it can sign out of it here. */
  guest?: boolean;
  /** Whether this account has any model at all: a sign-in, another model's API, or its own computer as a node. */
  connected?: boolean;
  /** A guest's login in progress (the owner's is under `supervisor`). */
  login?: Login | null;
  supervisor?: {
    blocker?: { code: string; message: string };
    login?: Login | null;
  };
};

const loginOf = (state: AccountState | undefined) => state?.login ?? state?.supervisor?.login ?? undefined;

/** How long reads continue after a sign-in completes while the account is not yet readable (W-233). */
export const CONFIRM_LOGIN_MS = 30_000;

/** Signed in, but the runtime does not yet say who: the page keeps reading and says so, instead of stopping on 「未连接」. */
export function awaitingCodexAccount(state: AccountState | undefined): boolean {
  return loginOf(state)?.state === "completed" && !state?.account && state?.connected !== true;
}

export function shouldPollCodexLogin(loginUrl: string | undefined, state: AccountState | undefined, confirmUntil = 0, now = Date.now()): boolean {
  return Boolean(loginUrl) || loginOf(state)?.state === "pending" || (awaitingCodexAccount(state) && now < confirmUntil);
}

export function reconcileCodexLoginUrl(loginUrl: string | undefined, state: AccountState | undefined): string | undefined {
  const loginState = loginOf(state)?.state;
  return loginState === "completed" || loginState === "failed" || loginState === "canceled" ? undefined : loginUrl;
}

export function visibleCodexBlocker(state: AccountState | undefined, t: Translate = tFor(undefined)): { code: string; message: string } | undefined {
  const blocker = state?.blocker ?? state?.supervisor?.blocker ?? loginOf(state)?.blocker;
  // The worker being down or not configured reaches here as the supervisor's own English; the page says it in words (copy-style).
  return blocker && /SUPERVISOR|CAPABILITY/.test(blocker.code) ? { code: blocker.code, message: t("后台服务没有连上，稍后点「↻ 刷新状态」。") } : blocker;
}

/**
 * The model connection (decided 2026-10-10). The machine owner's account runs on this machine's own Codex. Every other account connects
 * its own: in the browser (only when the page is open on this machine — Codex's sign-in calls back to this computer's localhost), with a
 * device code (from anywhere, a phone included), or with an API key, which goes straight to that account's own runtime and is never
 * kept or shown by the app. On a hosted server (2026-10-16) the owner too is away from the machine Codex runs on, so whoever opens the
 * page anywhere but this computer gets the device code: the browser sign-in would call back to their own localhost:1455 and fail.
 */
/** ChatGPT's own settings page, on its 安全 tab, where the device-code switch is. */
export const CHATGPT_SECURITY_URL = "https://chatgpt.com/#settings/Security";

export function CodexAccountControl({ onConnected }: {
  /** Told after every read whether this account now has a model connection (the interview waits on it). */
  onConnected?: (connected: boolean) => void } = {}) {
  const t = useT();
  const [state, setState] = useState<AccountState>();
  const [loginUrl, setLoginUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [local, setLocal] = useState(false);
  // Set when a sign-in in progress completes: reads go on until the account is readable, at most CONFIRM_LOGIN_MS.
  const [confirmUntil, setConfirmUntil] = useState(0);
  const lastLogin = useRef<string | undefined>(undefined);
  useEffect(() => { setLocal(["127.0.0.1", "localhost"].includes(location.hostname)); }, []);
  const refresh = async () => {
    const response = await fetch("/api/codex/account", { cache: "no-store" });
    const nextState = await response.json() as AccountState;
    setState(nextState);
    setLoginUrl((current) => reconcileCodexLoginUrl(current, nextState));
    onConnected?.(Boolean(nextState.account) || nextState.connected === true);
  };
  useEffect(() => { void refresh(); }, []);
  const loginState = loginOf(state)?.state;
  useEffect(() => {
    if (lastLogin.current === "pending" && loginState === "completed") setConfirmUntil(Date.now() + CONFIRM_LOGIN_MS);
    lastLogin.current = loginState;
  }, [loginState]);
  const confirming = awaitingCodexAccount(state) && Date.now() < confirmUntil;
  useEffect(() => {
    if (!shouldPollCodexLogin(loginUrl, state, confirmUntil)) return;
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 1_000);
    return () => clearInterval(interval);
  }, [loginUrl, loginState, confirming]);
  const post = async (body: Record<string, string>) => {
    setBusy(true);
    const response = await fetch("/api/codex/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json() as Login & { blocker?: { code: string; message: string } };
    if (answer.blocker) setState({ ...state, blocker: answer.blocker });
    else { setLoginUrl(answer.authUrl ?? answer.verificationUrl); await refresh(); }
    setApiKey("");
    setBusy(false);
  };
  const cancelLogin = async () => {
    setBusy(true);
    await fetch("/api/codex/account", { method: "DELETE" });
    setLoginUrl(undefined);
    await refresh();
    setBusy(false);
  };
  const account = state?.account;
  // Served by the person's own computer alone: nothing to sign in to here.
  const viaNode = !account && state?.connected === true && state.guest === true;
  const login = loginOf(state);
  const blocker = visibleCodexBlocker(state, t);
  const guest = state?.guest === true;
  const codeShown = login?.state === "pending" && Boolean(login?.userCode);
  // One click copies the code and opens OpenAI's page, so the code is ready to paste where it is asked for.
  const copyAndOpen = (code: string | undefined, url: string) => {
    if (code) void navigator.clipboard?.writeText(code).catch(() => undefined);
    window.open(url, "_blank", "noopener");
  };
  return <section className="st-card codex-account-card" aria-label={t("模型连接")} id="model">
    <header><h3>{t("模型连接")}</h3><Tag tone={account || viaNode ? "ok" : "warn"}>{account || viaNode ? t("已连接") : state ? t("未连接") : t("检查中")}</Tag></header>
    <div className="st-row"><span className="st-row-label">{account
      ? account.type === "apiKey" ? t("API key（按用量计费，每月上限见「模型额度」）") : account.email ?? t("ChatGPT 账号")
      : !state ? t("正在读取登录状态…") : viaNode ? t("模型在本人的电脑（算力节点）或本人接入的其他模型上运行。") : guest ? t("用本人的 ChatGPT 账号连接：访谈、分析与规划都用这个账号的额度，和其他人的账号互不相通。") : t("分析、拆分与助手功能需要登录 ChatGPT 账号")}
      {confirming && <small role="status">{t("已登录，正在确认连接…")}</small>}
      {blocker && <small role="status">{blocker.message}</small>}</span>
      <span className="st-row-actions">
        {state && !account && !loginUrl && local && <button type="button" className="primary-button" disabled={busy}
          onClick={() => void post({ type: "chatgpt" })}>{busy ? t("启动中…") : t("用 ChatGPT 登录")}</button>}
        {loginUrl && !login?.userCode && <a href={loginUrl} target="_blank" rel="noreferrer">{t("打开登录页 →")}</a>}
        {loginUrl && <button type="button" disabled={busy} onClick={cancelLogin}>{t("取消")}</button>}
        {account && guest && <button type="button" disabled={busy} onClick={() => void post({ action: "logout" })}>{t("退出登录")}</button>}
        <button type="button" onClick={refresh} title={t("重新读取登录状态")}>{t("↻ 刷新状态")}</button>
      </span></div>
    {account && account.type !== "apiKey" && <ModelEffort />}
    {/* The one-time code as steps that follow the sign-in (2026-11-06): where the person is, and each step's own button. OpenAI refuses
        every code until the device-code switch is on, and a code entered before it is spent (owner's run, 2026-10-15). Shown on this
        computer too, under its browser sign-in, except while that sign-in is open (2026-11-06). */}
    {state && !account && !viaNode && !(loginUrl && !login?.userCode) && <DeviceCodeSteps userCode={codeShown ? login!.userCode : undefined} loginUrl={loginUrl} busy={busy}
      onStart={() => void post({ type: "chatgptDeviceCode" })}
      onRenew={() => void (async () => { await cancelLogin(); await post({ type: "chatgptDeviceCode" }); })()}
      onCopy={() => { if (loginUrl) copyAndOpen(login?.userCode, loginUrl); }} />}
    {login?.state === "failed" && !account && <p className="muted" role="status">{t("这串代码没有通过。确认已按第 1 步开启设备代码登录，再点「用一次性代码连接」取一串新代码。")}</p>}
    {!account && guest && <form className="st-row" onSubmit={(event) => { event.preventDefault(); if (apiKey.trim()) void post({ type: "apiKey", apiKey }); }}>
      <label className="st-row-label">{t("或填写 OpenAI API key")}<small>{t("只保存在这个账号自己的模型连接里，本应用不留存、不显示。")}</small>
        <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label>
      <span className="st-row-actions"><button type="submit" disabled={busy || !apiKey.trim()}>{t("保存")}</button></span>
    </form>}
  </section>;
}

/**
 * The one-time code as steps that follow the sign-in (2026-11-06): where the person is, and each step's own button. OpenAI refuses every
 * code until the device-code switch is on, and a code entered before it is spent (owner's run, 2026-10-15), so the switch is step 1 with a
 * link to the page it is on. `userCode` is the code in hand (step 3 is then the current one).
 */
export function DeviceCodeSteps({ userCode, loginUrl, busy, onStart, onRenew, onCopy }: { userCode: string | undefined; loginUrl: string | undefined; busy: boolean;
  onStart: () => void; onRenew: () => void; onCopy: () => void }) {
  const t = useT();
  const shown = Boolean(userCode);
  return <Stepper label={t("用一次性代码连接的步骤")} steps={[
    { title: t("在 ChatGPT 开启「设备代码登录」（只需一次）"), state: shown ? "done" : "current",
      detail: t("ChatGPT 网页版 → 设置 → 安全 →「为 Codex、Excel、PowerPoint 和 Word 启用设备代码登录」"),
      action: <a className="secondary-button" href={CHATGPT_SECURITY_URL} target="_blank" rel="noreferrer">{t("打开 ChatGPT 安全设置 ↗")}</a> },
    { title: t("取一串一次性代码"), state: shown ? "done" : "todo",
      action: !shown && <button type="button" className="primary-button" disabled={busy} onClick={onStart}>{busy ? t("正在取代码…") : t("用一次性代码连接")}</button> },
    { title: t("在 OpenAI 页面登录本人的 ChatGPT，粘贴代码"), state: shown ? "current" : "todo",
      detail: shown ? t("代码只给本人用，不要发给别人。页面提示要先启用设备代码登录时，按第 1 步开启后点「获取新代码」。") : undefined,
      action: shown && <>
        <b className="mono codex-user-code">{userCode}</b>
        {loginUrl && <button type="button" className="primary-button" onClick={onCopy}>{t("复制代码并打开 OpenAI 页面")}</button>}
        <button type="button" disabled={busy} onClick={onRenew}>{t("获取新代码")}</button>
        {/* The address as text too: a person on another device, or one whose pop-ups are blocked, types it in themselves (W-5). */}
        {loginUrl && <small className="codex-verification-url">{t("OpenAI 页面地址：")}<span className="mono">{loginUrl}</span></small>}
      </> },
    { title: t("回到这里，几秒内自动显示「已连接」"), state: "todo" }
  ]} />;
}

const EFFORTS = [
  { value: "lower", label: "省额度", title: "每项工作少想一档，额度用得慢，复杂的规划可能粗一些" },
  { value: "default", label: "标准", title: "按每项工作的难度分配：访谈与规划想得多，读日期、归类想得少" },
  { value: "higher", label: "更强", title: "每项工作多想一档，结果更细，额度用得快、回答更慢；额度紧张时自动按标准" }
] as const;
type Effort = (typeof EFFORTS)[number]["value"];

/** 模型强度 (2026-10-31): only for a ChatGPT sign-in, since a provider's or the developer's model is never moved by it. */
function ModelEffort() {
  const t = useT();
  const [value, setValue] = useState<Effort>();
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  useEffect(() => {
    void fetch("/api/settings/model-effort", { cache: "no-store" }).then((response) => response.json() as Promise<{ effort?: Effort }>)
      .then((answer) => setValue(answer.effort ?? "default")).catch(() => setValue("default"));
  }, []);
  const change = async (next: Effort) => {
    const previous = value;
    setValue(next);
    const response = await fetch("/api/settings/model-effort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ effort: next }) }).catch(() => null);
    if (!response?.ok) setValue(previous);
    setStatus(response?.ok ? "saved" : "failed");
  };
  const title = EFFORTS.find((option) => option.value === value)?.title;
  return <div className="st-row"><span className="st-row-label">{t("模型强度")}<small>{title ? t(title) : t("正在读取…")}{" "}{t("只对 ChatGPT 登录生效。")}</small></span>
    {value && <SegmentedControl label={t("模型强度")} value={value} onChange={(next) => void change(next)}
      options={EFFORTS.map(({ value: v, label, title: tip }) => ({ value: v, label: t(label), title: t(tip) }))} />}
    {status && <small role="status" className={status === "saved" ? "st-ok" : "st-fail"}>{status === "saved" ? t("已保存") : t("未保存")}</small>}
  </div>;
}

"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import { SetupGuide } from "../ui/setup-guide";
import { CALENDAR_WRITER_GUIDE } from "../../lib/setup-guides";

type LoginState = { ok?: boolean; state?: "idle" | "waiting" | "done" | "failed"; userCode?: string; verificationUri?: string; message?: string };

/**
 * 登录写入账号 on the calendar card: asks for a device code and shows it with Microsoft's address; the person signs in there with the
 * account that holds the Crossline calendar. The page only shows the code — it never signs in for them. Once they have, the plan is
 * written to the calendar at once.
 */
export function CalendarWriteLogin({ relogin }: { relogin: boolean }) {
  const t = useT();
  const [login, setLogin] = useState<LoginState>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (login.state !== "waiting") return;
    const timer = window.setInterval(async () => {
      const next = await fetch("/api/calendar/write-login").then((response) => response.json() as Promise<LoginState>).catch(() => null);
      if (!next || next.state === "waiting") return;
      setLogin(next);
      if (next.state === "done") {
        await fetch("/api/calendar/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
        location.reload();
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [login.state]);
  const start = async () => {
    setBusy(true);
    const next = await fetch("/api/calendar/write-login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((response) => response.json() as Promise<LoginState>).catch(() => null);
    setBusy(false);
    setLogin(next ?? { state: "failed", message: t("未能开始登录，请重试。") });
  };
  return <><div className="st-row"><span className="st-row-label">{relogin ? t("重新登录或更换写入账号") : t("登录写入账号")}
    <small>{t("用存放 Crossline 日历的微软账号登录，只授权读取本人信息和读写日历；Crossline 只写名为 Crossline 的日历。")}</small>
    {login.state === "waiting" && <small>{t("在 {{url}} 输入代码 {{code}}，按页面提示登录。登录完成后这里会自动更新。", { url: "\u0000url", code: "\u0000code" })
      .split(/(\u0000url|\u0000code)/).map((part, index) => part === "\u0000url" ? <a key={index} href={login.verificationUri} target="_blank" rel="noreferrer">{login.verificationUri}</a>
        : part === "\u0000code" ? <b key={index} className="mono">{login.userCode}</b> : part)}</small>}
    {login.state === "failed" && <small role="status">{login.message ?? t("登录没有完成，请重试。")}</small>}
    {login.ok === false && !login.state && <small role="status">{login.message ?? t("后台服务未运行，稍后再试。")}</small>}
  </span>
    <button type="button" disabled={busy || login.state === "waiting"} onClick={() => void start()}>{login.state === "waiting" ? t("等待登录…") : t("获取登录代码")}</button>
  </div>
  <SetupGuide guide={CALENDAR_WRITER_GUIDE} {...(login.state === "waiting" ? { open: true } : {})} /></>;
}

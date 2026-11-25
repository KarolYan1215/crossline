"use client";
import { useState } from "react";
import { useT } from "../locale-context";
import { VoiceField } from "../ui/voice/voice-input";

/** J2b: a setback in the person's own words. The worker classifies it (wrong goal, wrong execution, noise); the person decides. */
export function SetbackReport() {
  const t = useT();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const response = await fetch("/api/gates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setback", text }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { setText(""); setStatus(t("记下了。分类出来后放到待确认，由你决定改不改。")); return; }
    setStatus(t("没有记下，请再试一次。"));
  };
  return <div className="rv-setback">
    <label><span className="sr-only">{t("这次挫折是什么")}</span>
      <VoiceField kind="note"><textarea value={text} maxLength={2000} rows={2} placeholder={t("这次挫折是什么（发生了什么，不必写感受）")} onChange={(event) => setText(event.target.value)} /></VoiceField></label>
    <button type="button" disabled={busy || !text.trim()} onClick={() => void send()}>{t("记一次挫折")}</button>
    {status && <em role="status">{status}</em>}
  </div>;
}

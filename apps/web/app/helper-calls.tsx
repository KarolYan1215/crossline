"use client";

import { useEffect, useState } from "react";
import { RemoteLogin, remoteWindowSize } from "./ui/remote-login";
import { Sheet } from "./ui/overlay";
import { enablePush } from "./push-enable";
import { refreshHelper, useHelper } from "./helper-state";
import type { PersonCall } from "../lib/person-calls";

/** Calls the person put off: not shown again for a day (an urgent one is never put off; it ends by itself). Per browser. */
const LATER_KEY = "crossline.helper.later";
const LATER_MS = 24 * 3_600_000;
function laterOf(): Record<string, number> { try { return JSON.parse(window.localStorage.getItem(LATER_KEY) ?? "{}") as Record<string, number>; } catch { return {}; } }
function putOff(id: string): void { try { window.localStorage.setItem(LATER_KEY, JSON.stringify({ ...laterOf(), [id]: Date.now() })); } catch { /* storage blocked: shown again */ } }

/**
 * What only the person can do, from the 小帮手 on any page (lib/person-calls.ts): an urgent one (a site waiting for its verification)
 * opens by itself as the dialog that does it; the others are a badge on the 小帮手 and a short list, each done in place — the server's
 * browser for a login, notifications turned on for this device — or on its settings card.
 */
export function HelperCalls() {
  const { calls } = useHelper();
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<Extract<PersonCall["action"], { kind: "remote" }> | undefined>();
  const [note, setNote] = useState("");
  const [seenUrgent, setSeenUrgent] = useState<string[]>([]);
  const [later, setLater] = useState<Record<string, number>>({});
  useEffect(() => { setLater(laterOf()); }, []);
  const shown = calls.filter((call) => call.urgent || !(later[call.id] && Date.now() - later[call.id]! < LATER_MS));
  // An urgent call opens its dialog at once, on whatever page this is; closed, it is not forced open again (the badge stays).
  const urgent = shown.find((call) => call.urgent && (call.action.kind === "remote" || call.action.kind === "node") && !seenUrgent.includes(call.id));
  useEffect(() => {
    if (!urgent || remote) return;
    setSeenUrgent((ids) => [...ids, urgent.id]);
    if (urgent.action.kind === "remote") setRemote(urgent.action);
    // On the person's computer the window is theirs: the list opens here with the one button to say it is done.
    else setOpen(true);
  }, [urgent, remote]);

  const act = async (call: PersonCall) => {
    const action = call.action;
    if (action.kind === "href") { window.location.href = action.href; return; }
    if (action.kind === "push") { const result = await enablePush(); setNote(result.message); if (result.ok) refreshHelper(); return; }
    if (action.kind === "node") {
      const result = await fetch(`/api/skills/grown/${encodeURIComponent(action.workflowId)}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login_done", service: action.service }) }).then((response) => response.json() as Promise<{ ok: boolean; message?: string }>)
        .catch(() => ({ ok: false, message: "后台服务没有回应。" }));
      setNote(result.ok ? "好的，读取接着往下" : result.message ?? "没有送达");
      if (result.ok) { setOpen(false); refreshHelper(); }
      return;
    }
    if (action.purpose === "login") {
      setNote(`正在打开${action.label}的登录窗口`);
      const result = await fetch(`/api/skills/grown/${encodeURIComponent(action.workflowId)}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login", service: action.service, ...remoteWindowSize(window.innerWidth, window.innerHeight) }) })
        .then((response) => response.json() as Promise<{ ok: boolean; message?: string; remote?: boolean }>).catch(() => ({ ok: false, message: "后台服务没有回应。" }));
      if (!result.ok) { setNote(result.message ?? "没有打开"); return; }
      setNote("");
    }
    setOpen(false);
    setRemote(action);
  };

  if (!shown.length && !remote) return null;
  return <>
    {shown.length > 0 && <button type="button" className={`helper-calls-badge${shown.some((call) => call.urgent) ? " urgent" : ""}`} onClick={() => setOpen(true)}
      aria-label={`有 ${shown.length} 件事需要本人处理`}>{shown.length} 件需要你处理</button>}
    {open && <Sheet title="需要本人处理" open onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <ul className="helper-calls">{shown.map((call) => <li key={call.id} className={call.urgent ? "urgent" : ""}>
        <p>{call.text}</p>
        <span className="helper-calls-actions">
          <button type="button" className="primary-button" onClick={() => { void act(call); }}>
            {call.action.kind === "href" ? call.action.label : call.action.kind === "push" ? "开启推送" : call.action.kind === "node" ? "已在电脑上完成"
              : call.action.purpose === "verify" ? "现在验证" : `登录${call.action.label}`}</button>
          {!call.urgent && <button type="button" className="secondary-button" onClick={() => { putOff(call.id); setLater(laterOf()); }}>明天再说</button>}
        </span>
      </li>)}</ul>
      {note && <p role="status" className="st-note">{note}</p>}
    </Sheet>}
    {remote && <RemoteLogin target={{ workflowId: remote.workflowId, service: remote.service }} label={remote.label}
      onClose={() => { setRemote(undefined); refreshHelper(); }} />}
  </>;
}

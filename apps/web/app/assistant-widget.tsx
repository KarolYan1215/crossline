"use client";

import { useEffect, useState } from "react";
import { Conversation } from "./chat/conversation";
import { HelperFace, helperMood, useHelper } from "./helper-state";

const SEEN_KEY = "crossline-nudge-seen";

/**
 * The site-wide floating 小帮手: a bubble by default, a panel when opened. Once the portrait report has drawn the person's figure, the bubble
 * is that figure — the 分身 that works for them — moving to say what it is doing (helperMood: background stopped, thinking, the
 * assistant at work, a new message); without one it is the text button. It is the one input box's conversation of the day, opened
 * larger (docs/one-input.md): the same messages as Today's box, on every page and device. While a page is visible it says so every
 * minute (`/api/presence`), so the system's own messages are shown here instead of being sent to the desktop and phone; when one
 * arrives with the panel closed, the bubble shows its first line until it is opened.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<{ id: string; text: string } | null>(null);
  const helper = useHelper();
  const mood = helperMood({ down: helper.down, thinking: helper.thinking, working: helper.working, unread: Boolean(latest) });
  const label = { down: "小帮手：后台没在运行", thinking: "小帮手：正在想", working: "小帮手：助手在做事", unread: "小帮手：有新消息", idle: "打开小帮手" }[mood];
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/presence", { method: "POST" }).catch(() => {});
      void fetch("/api/conversation").then((response) => response.ok ? response.json() : null).then((body: { messages?: Array<{ id: string; role: string; card?: { clarify: { question: string; chosen?: number } } }> } | null) => {
        const nudge = [...(body?.messages ?? [])].reverse().find((message) => message.role === "nudge" && message.card?.clarify.chosen === undefined);
        let seen = "";
        try { seen = localStorage.getItem(SEEN_KEY) ?? ""; } catch { /* private browsing */ }
        setLatest(nudge && nudge.id !== seen ? { id: nudge.id, text: nudge.card!.clarify.question.split("\n")[0]!.slice(0, 60) } : null);
      }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 60_000);
    document.addEventListener("visibilitychange", ping);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", ping); };
  }, []);
  const openPanel = () => {
    if (latest) { try { localStorage.setItem(SEEN_KEY, latest.id); } catch { /* private browsing */ } setLatest(null); }
    setOpen(true);
  };
  if (!open) return <div className="assistant-bubble-wrap">
    {latest && <button type="button" className="assistant-nudge-preview" onClick={openPanel}>{latest.text}</button>}
    {helper.avatar
      ? <button type="button" className="assistant-bubble helper-bubble" data-mood={mood} onClick={openPanel} aria-label={label} title={label}>
        <HelperFace src={helper.avatar} size="button" mood={mood} /></button>
      : <button type="button" className="assistant-bubble" data-unread={latest ? "" : undefined} data-mood={mood} onClick={openPanel} aria-label={label}>小帮手</button>}
  </div>;
  return <section className="assistant-panel" aria-label="小帮手">
    <header>
      <span>{helper.avatar && <HelperFace src={helper.avatar} size="reply" />}小帮手</span>
      <button type="button" className="text-button" onClick={() => setOpen(false)} aria-label="收起小帮手">收起</button>
    </header>
    <Conversation variant="panel" />
  </section>;
}

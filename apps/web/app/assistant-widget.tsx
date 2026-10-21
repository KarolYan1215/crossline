"use client";

import { useEffect, useRef, useState } from "react";
import { Conversation } from "./chat/conversation";
import { HelperFace, helperMood, plainText, previewText, useHelper } from "./helper-state";

const SEEN_KEY = "crossline-nudge-seen";
/** The last message the bubble popped out for, so one message pops once, not again on every page it is still unread on. */
const POPPED_KEY = "crossline-nudge-popped";
/** How long a new message's bubble stays out before folding into the dot on the figure. */
const POP_MS = 8_000;
/** Waits this long before popping, so a conversation on the page (Today's box) has drawn the same message first. */
const SETTLE_MS = 1_500;

const readKey = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const writeKey = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private browsing */ } };

/** Whether the page already shows this message in a conversation of its own (Today's box, a task's conversation), outside the widget. */
function shownElsewhere(text: string): boolean {
  const needle = text.replace(/\s+/g, "").slice(0, 40);
  if (!needle) return false;
  return Array.from(document.querySelectorAll(".conversation-log")).some((log) =>
    !log.closest(".assistant-panel") && (log.textContent ?? "").replace(/\s+/g, "").includes(needle));
}

/**
 * The site-wide floating 小帮手: a bubble by default, a panel when opened. Once the portrait report has drawn the person's figure, the bubble
 * is that figure — the 分身 that works for them — moving to say what it is doing (helperMood: background stopped, thinking, the
 * assistant at work, a new message); without one it is the text button. It is the one input box's conversation of the day, opened
 * larger (docs/one-input.md): the same messages as Today's box, on every page and device. While a page is visible it says so every
 * minute (`/api/presence`), so the system's own messages are shown here instead of being sent to the desktop and phone.
 *
 * A new message pops out beside the figure once (to its left, at most 320px and three lines, with a close button), folds into a dot on
 * the figure after eight seconds, and comes back while the figure is hovered or focused. It does not pop at all when the page already
 * shows it in a conversation of its own — Today's box showed the same line twice, and the bubble sat over the cards under it.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<{ id: string; text: string; full: string } | null>(null);
  const [popped, setPopped] = useState(false);
  const [hover, setHover] = useState(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const helper = useHelper();
  const mood = helperMood({ down: helper.down, thinking: helper.thinking, working: helper.working, unread: Boolean(latest) });
  const label = { down: "小帮手：后台没在运行", thinking: "小帮手：正在想", working: "小帮手：助手在做事", unread: "小帮手：有新消息", idle: "打开小帮手" }[mood];
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/presence", { method: "POST" }).catch(() => {});
      void fetch("/api/conversation").then((response) => response.ok ? response.json() : null).then((body: { messages?: Array<{ id: string; role: string; card?: { clarify: { question: string; chosen?: number } } }> } | null) => {
        const nudge = [...(body?.messages ?? [])].reverse().find((message) => message.role === "nudge" && message.card?.clarify.chosen === undefined);
        if (!nudge || nudge.id === readKey(SEEN_KEY)) { setLatest(null); return; }
        const full = plainText(nudge.card!.clarify.question);
        setLatest((current) => current?.id === nudge.id ? current : { id: nudge.id, text: previewText(full), full });
        if (nudge.id === readKey(POPPED_KEY)) return;
        writeKey(POPPED_KEY, nudge.id);
        timers.current.push(setTimeout(() => {
          if (shownElsewhere(full)) return;
          setPopped(true);
          timers.current.push(setTimeout(() => setPopped(false), POP_MS));
        }, SETTLE_MS));
      }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 60_000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
      for (const pending of timers.current) clearTimeout(pending);
    };
  }, []);
  const openPanel = () => {
    if (latest) { writeKey(SEEN_KEY, latest.id); setLatest(null); }
    setPopped(false);
    setOpen(true);
  };
  const shown = Boolean(latest) && (popped || hover);
  if (!open) return <div className="assistant-bubble-wrap" data-popped={shown || undefined}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setHover(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false); }}>
    {latest && shown && <div className="assistant-nudge-preview" role="status">
      <button type="button" className="assistant-nudge-text" onClick={openPanel} title={latest.full}>{latest.text}</button>
      <button type="button" className="assistant-nudge-close" aria-label="收起这条提示" title="收起"
        onClick={() => { setPopped(false); setHover(false); }}>×</button>
    </div>}
    {!helper.known
      // Not yet known whether there is a figure: a quiet circle the figure's size, so nothing jumps when the answer comes.
      ? <button type="button" className="assistant-bubble helper-bubble" data-pending="" onClick={openPanel} aria-label={label} title={label}>
        <span className="helper-face" data-size="button" aria-hidden="true" /></button>
      : helper.avatar
      ? <button type="button" className="assistant-bubble helper-bubble" data-mood={mood} data-unread={latest && !shown ? "" : undefined} onClick={openPanel} aria-label={label} title={label}>
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

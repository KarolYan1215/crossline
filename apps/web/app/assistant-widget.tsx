"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Conversation } from "./chat/conversation";
import { HelperFace, plainText, previewText } from "./helper-state";
import { useT } from "./locale-context";
import { isHelperShortcut, OPEN_HELPER_MESSAGE, POSE_LABEL } from "./helper-pet";
import { HelperPocket, isTypingTarget, openPinnedWindow, PetFace, pinSupport, useLaunchTarget, usePetPose } from "./helper-pet-client";
import { OverlayContainer } from "./ui/overlay";
import { setPinnedVisible } from "./ui/page-visible";
import { isReminderKind } from "./notice-kinds";
import { OPEN_HELPER_EVENT } from "./notice-bell";

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
 *
 * It is also a desktop pet (2026-10-27): the figure leans toward the pointer, bounces when poked and sleeps at night or while the person
 * is away (helper-pet.ts); Alt+Shift+H opens and closes it; the corner can be dragged by it (CornerStack); and 「钉在桌面」 opens the same
 * 小帮手 in a Picture-in-Picture window that stays above every tab and app (or the `/helper` popup). The pinned window belongs to this tab
 * and closes when the tab goes to another page; the popup does not.
 */
export function AssistantWidget() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [latest, setLatest] = useState<{ id: string; text: string; full: string } | null>(null);
  const [popped, setPopped] = useState(false);
  const [hover, setHover] = useState(false);
  const [pin, setPin] = useState<"pip" | "popup" | null>(null);
  const [pinned, setPinned] = useState<Window | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { pose, avatar: figure, known } = usePetPose(root, Boolean(latest));
  const helper = { avatar: figure, known };
  const label = t(POSE_LABEL[pose]);
  useEffect(() => { setPin(pinSupport()); }, []);
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/presence", { method: "POST" }).catch(() => {});
      void fetch("/api/conversation").then((response) => response.ok ? response.json() : null).then((body: { messages?: Array<{ id: string; role: string; card?: { nudgeKind?: string; clarify: { question: string; chosen?: number } } }> } | null) => {
        const nudge = [...(body?.messages ?? [])].reverse().find((message) => message.role === "nudge" && message.card?.clarify.chosen === undefined
          // Reminders that ask nothing pop up under the bell (notice-bell.tsx); the figure speaks only for what wants an answer.
          && !isReminderKind(message.card?.nudgeKind));
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
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const openPanel = () => {
    const waiting = latestRef.current;
    if (waiting) { writeKey(SEEN_KEY, waiting.id); setLatest(null); }
    setPopped(false);
    setOpen(true);
    // Opened from the keyboard or a shortcut: the input box is ready to type in.
    requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
  };
  const openRef = useRef(openPanel);
  openRef.current = openPanel;
  // Alt+Shift+H opens and closes it from anywhere on the page (not while typing); the installed app's 「打开小帮手」 shortcut and a
  // notification about the 小帮手 open it in this window instead of a second one.
  useLaunchTarget(() => openRef.current());
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isHelperShortcut(event) || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      if (openNow.current) { setFull(false); setOpen(false); } else openRef.current();
    };
    const onMessage = (event: MessageEvent) => { if ((event.data as { type?: string } | null)?.type === OPEN_HELPER_MESSAGE) openRef.current(); };
    window.addEventListener("keydown", onKey);
    const onOpen = () => openRef.current();
    window.addEventListener(OPEN_HELPER_EVENT, onOpen);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_HELPER_EVENT, onOpen); navigator.serviceWorker?.removeEventListener("message", onMessage); };
  }, []);
  // 「钉在桌面」: the same 小帮手 in a window that stays above every tab and app (or the `/helper` popup where that is not available).
  const pinToDesktop = async () => {
    if (pinned) return;
    const win = await openPinnedWindow();
    setFull(false);
    setOpen(false);
    if (!win) return;
    setPinnedVisible(true);
    setPinned(win);
    win.addEventListener("pagehide", () => { setPinnedVisible(false); setPinned(null); }, { once: true });
  };
  useEffect(() => () => { pinned?.close(); }, [pinned]);
  const pinnedView = pinned && createPortal(<OverlayContainer.Provider value={pinned.document.body}>
    <HelperPocket onClose={() => pinned.close()} />
  </OverlayContainer.Provider>, pinned.document.body);
  const shown = Boolean(latest) && (popped || hover);
  // The pinned window is drawn first and in the same place whether the panel is open or not, so opening the panel never redraws it.
  return <>{pinnedView}{open ? panelView() : bubbleView()}</>;

  function bubbleView() { return <div ref={root} className="assistant-bubble-wrap" data-popped={shown || undefined}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setHover(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false); }}>
    {latest && shown && <div className="assistant-nudge-preview" role="status">
      <button type="button" className="assistant-nudge-text" onClick={openPanel} title={latest.full}>{latest.text}</button>
      <button type="button" className="assistant-nudge-close" aria-label={t("收起这条提示")} title={t("收起")}
        onClick={() => { setPopped(false); setHover(false); }}>×</button>
    </div>}
    {!helper.known
      // Not yet known whether there is a figure: a quiet circle the figure's size, so nothing jumps when the answer comes.
      ? <button type="button" className="assistant-bubble helper-bubble" data-pending="" onClick={openPanel} aria-label={label} title={label}>
        <span className="helper-face" data-size="button" aria-hidden="true" /></button>
      : helper.avatar
      ? <button type="button" className="assistant-bubble helper-bubble" data-mood={pose} data-drag-handle="" data-unread={latest && !shown ? "" : undefined} onClick={openPanel} aria-label={label} title={label}>
        <PetFace src={helper.avatar} pose={pose} /></button>
      : <button type="button" className="assistant-bubble" data-drag-handle="" data-unread={latest ? "" : undefined} data-mood={pose} onClick={openPanel} aria-label={label}>{t("小帮手")}</button>}
  </div>; }

  function panelView() { return <section ref={panel} className="assistant-panel" aria-label={t("小帮手")} data-full={full || undefined}
    onKeyDown={(event) => { if (event.key === "Escape" && full) { event.stopPropagation(); setFull(false); } }}>
    <header>
      <span>{helper.avatar && <HelperFace src={helper.avatar} size="reply" />}{t("小帮手")}</span>
      <span className="assistant-panel-actions">
        {pin && !pinned && <button type="button" className="text-button" onClick={() => { void pinToDesktop(); }}
          title={t("在单独的小窗口里打开，切到别的标签页或程序时也留在最上层")} aria-label={t("把小帮手钉在桌面")}>{t("钉在桌面")}</button>}
        <button type="button" className="text-button" onClick={() => setFull(!full)} aria-pressed={full}
          aria-label={full ? t("退出全屏对话") : t("全屏对话")}>{full ? t("退出全屏") : t("全屏")}</button>
        <button type="button" className="text-button" onClick={() => { setFull(false); setOpen(false); }} aria-label={t("收起小帮手")}>{t("收起")}</button>
      </span>
    </header>
    <Conversation variant="panel" />
  </section>; }
}

"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Conversation } from "./chat/conversation";
import { HelperCalls } from "./helper-calls";
import { helperMood, plainText, previewText, useHelper } from "./helper-state";
import { useT } from "./locale-context";
import { awayFor, deskBubbleKey, DRAG_THRESHOLD, gazeAt, isNight, LONG_PRESS_MS, petPose, POSE_LABEL, shapeRects, type PetPose } from "./helper-pet";
import { lockOnStart } from "./timeline/block-start";
import type { TimelineItem } from "./timeline/model";
import "./helper-desk.css";

/** The node tray's WebView2 bridge (installer/node-tray/CrosslineNode.cs); absent in an ordinary browser tab. */
type HostBridge = { postMessage: (message: unknown) => void; addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void };
const hostBridge = (): HostBridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { chrome?: { webview?: HostBridge } }).chrome?.webview;

/** Which system message the pet last said, so one is said once (the tab's corner 小帮手 keeps its own). */
const SAID_KEY = "crossline-desk-said";
const readKey = () => { try { return localStorage.getItem(SAID_KEY) ?? ""; } catch { return ""; } };
const writeKey = (value: string) => { try { localStorage.setItem(SAID_KEY, value); } catch { /* private window */ } };

type Said = { id: string; text: string; full: string };
/** What the desktop window is cut to: everything the pet draws. */
const SHAPED = ".desk-panel, .desk-bubble, .desk-menu, .desk-body, .desk-thought, .desk-z, .desk-alert";
type NextBlock = Pick<TimelineItem, "id" | "day" | "start" | "end" | "kind" | "missed"> & { workOrderId: string; title: string; step?: string };

/**
 * The 小帮手 as a desktop pet (`/helper?pet=1`, the node tray's frameless window; docs/compute-node.md 「托盘与桌宠」): the person's whole
 * figure (`currentFigure`, no new drawing) on a transparent page, with a bubble and, on a click, the day's one input box.
 *
 * It is alive without being a game (no points, levels or rewards): it breathes and blinks; looks toward the pointer wherever it is on the
 * screen (the tray reports it); thinks with a thought bubble, works with a quicker sway, hops for a new message, dozes when the computer
 * has had no input for ten minutes or at night, and slumps grey when the background stopped. Every system message the page receives —
 * a block about to start, a timer past its usual minutes, anything that asks — is said once in the bubble. Right click or a long press
 * offers 「开始下一项计时」, 「记一下」 and 「打开今日」. `prefers-reduced-motion` keeps it still.
 */
export function HelperDesk() {
  const t = useT();
  const helper = useHelper();
  const root = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [placeholder, setPlaceholder] = useState<string | undefined>(undefined);
  const [hostIdle, setHostIdle] = useState<number | null>(null);
  const [localIdle, setLocalIdle] = useState(0);
  const [night, setNight] = useState(false);
  const [still, setStill] = useState(false);
  const host = useRef<HostBridge | undefined>(undefined);

  const away = awayFor(hostIdle, localIdle);
  const mood = helperMood({ down: helper.down, thinking: helper.thinking, working: helper.working, unread: Boolean(said?.id) });
  const pose: PetPose = petPose(mood, { night, away });
  const awayRef = useRef(away);
  awayRef.current = away;

  // The tray's reports (pointer anywhere on the screen, the computer's idle time), or this page's own pointer in a tab.
  useEffect(() => {
    host.current = hostBridge();
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const look = (x: number, y: number) => {
      const el = figure.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const gaze = gazeAt(x - (box.left + box.width / 2), y - (box.top + box.height * 0.25));
      el.style.setProperty("--gaze-x", `${gaze.x}px`);
      el.style.setProperty("--gaze-y", `${gaze.y}px`);
    };
    const onHost = (event: { data: unknown }) => {
      const data = event.data as { type?: string; x?: number; y?: number; ms?: number } | null;
      if (data?.type === "pointer" && typeof data.x === "number" && typeof data.y === "number") look(data.x, data.y);
      if (data?.type === "idle" && typeof data.ms === "number") setHostIdle(data.ms);
    };
    const onMove = (event: PointerEvent) => { if (!host.current) look(event.clientX, event.clientY); };
    let last = Date.now();
    const input = () => { last = Date.now(); setLocalIdle(0); };
    const tick = () => { setNight(isNight(new Date().getHours())); setLocalIdle(Date.now() - last); };
    tick();
    const timer = setInterval(tick, 30_000);
    host.current?.addEventListener("message", onHost);
    window.addEventListener("pointermove", onMove, { passive: true });
    for (const name of ["pointerdown", "keydown"] as const) window.addEventListener(name, input, { passive: true });
    host.current?.postMessage({ type: "ready" });
    // The window is only as big as what is drawn (a window region, not a colour key: WebView2 draws through DirectComposition, and
    // a colour-keyed window let every click through to what lies behind). Sent eight times a second while it changes.
    let shape = "";
    const sendShape = () => {
      const boxes = Array.from(root.current?.querySelectorAll<HTMLElement>(SHAPED) ?? []).map((el) => {
        const box = el.getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 };
      });
      const next = JSON.stringify(shapeRects(boxes));
      if (next !== shape) { shape = next; host.current?.postMessage({ type: "shape", rects: JSON.parse(next) as unknown }); }
    };
    const shaping = host.current ? setInterval(sendShape, 125) : undefined;
    return () => {
      clearInterval(timer);
      if (shaping) clearInterval(shaping);
      host.current?.removeEventListener("message", onHost);
      window.removeEventListener("pointermove", onMove);
      for (const name of ["pointerdown", "keydown"] as const) window.removeEventListener(name, input);
    };
  }, []);

  // Says the page is on screen while the person is at the computer, so the system's messages come here instead of the phone; reads the
  // newest unanswered one, reminders included (the pet has no bell).
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      if (!awayRef.current) void fetch("/api/presence", { method: "POST" }).catch(() => {});
      void fetch("/api/conversation").then((response) => response.ok ? response.json() : null)
        .then((body: { messages?: Array<{ id: string; role: string; card?: { clarify: { question: string; chosen?: number } } }> } | null) => {
          const nudge = [...(body?.messages ?? [])].reverse().find((message) => message.role === "nudge" && message.card?.clarify.chosen === undefined);
          if (!nudge || nudge.id === readKey()) { setSaid(null); return; }
          const full = plainText(nudge.card!.clarify.question);
          setSaid((current) => current?.id === nudge.id ? current : { id: nudge.id, text: previewText(full), full });
        }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 60_000);
    document.addEventListener("visibilitychange", ping);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", ping); };
  }, []);
  const dismiss = useCallback(() => {
    if (said?.id) writeKey(said.id);
    setSaid(null);
  }, [said]);
  // What the pet itself answers (「开始计时：…」): said for eight seconds over whatever waits, which comes back after.
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 8_000);
  };

  const openPanel = (hint?: string) => {
    if (said?.id) writeKey(said.id);
    setSaid(null);
    setMenu(false);
    setPlaceholder(hint);
    setOpen(true);
    requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>(".desk-panel textarea")?.focus());
  };

  const goTo = (path: string) => {
    setMenu(false);
    if (host.current) host.current.postMessage({ type: "open", path });
    else window.open(path, "crossline-main");
  };

  const startNext = async () => {
    setMenu(false);
    const body = await fetch("/api/helper/next", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as
      { next?: NextBlock | null } | null;
    const next = body?.next;
    if (!next) { say(t("今天没有排好的下一项。")); return; }
    const refused = await lockOnStart({ ...next, title: next.title } as TimelineItem);
    if (refused) { say(refused); return; }
    const started = await fetch(`/api/work-orders/${encodeURIComponent(next.workOrderId)}/execution`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).catch(() => null);
    say(started?.ok ? t("开始计时：{{title}}", { title: next.title }) : t("没能开始「{{title}}」，在任务页可以看原因。", { title: next.title }));
  };

  // A press on the figure: a click opens the input, a drag moves the window (the tray takes over the move), a long press the menu.
  const press = useRef<{ x: number; y: number; at: number; timer: ReturnType<typeof setTimeout> | null; done: boolean } | null>(null);
  const onDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const timer = setTimeout(() => { if (press.current) { press.current.done = true; setMenu(true); } }, LONG_PRESS_MS);
    press.current = { x: event.clientX, y: event.clientY, at: Date.now(), timer, done: false };
  };
  const onMoveFigure = (event: ReactPointerEvent) => {
    const current = press.current;
    if (!current || current.done) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
    if (current.timer) clearTimeout(current.timer);
    current.done = true;
    host.current?.postMessage({ type: "drag" });
  };
  const onUp = () => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    if (!current.done) { if (open) setOpen(false); else openPanel(); }
  };

  const label = t(POSE_LABEL[pose]);
  const bubbleKey = deskBubbleKey(pose);
  const bubble = note ? { id: null, text: previewText(note), full: note } : said ?? (bubbleKey && !open ? { id: null, text: t(bubbleKey).replace(/^[^：:]+[：:]\s*/, ""), full: t(bubbleKey) } : null);

  return <div ref={root} className="desk" data-pose={pose} data-still={still || undefined} data-open={open || undefined}
    onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}
    onKeyDown={(event) => { if (event.key === "Escape") { setMenu(false); setOpen(false); } }}>
    {open && <section className="desk-panel" aria-label={t("小帮手")}>
      <header>
        <span>{t("小帮手")}</span>
        <span className="desk-panel-actions">
          <HelperCalls />
          <button type="button" className="text-button" onClick={() => setOpen(false)} aria-label={t("收起小帮手")}>{t("收起")}</button>
        </span>
      </header>
      <Conversation variant="inline" {...(placeholder ? { placeholder } : {})} />
    </section>}
    {!open && !menu && bubble && <div className="desk-bubble" role="status" data-message={bubble.id ? "" : undefined}>
      <button type="button" className="desk-bubble-text" onClick={() => openPanel()} title={bubble.full}>{bubble.text}</button>
      {bubble.id && <button type="button" className="desk-bubble-close" aria-label={t("收起这条提示")} title={t("收起")} onClick={dismiss}>×</button>}
    </div>}
    {menu && <div className="desk-menu" role="menu" aria-label={t("小帮手的快捷动作")}>
      <button type="button" role="menuitem" onClick={() => { void startNext(); }}>{t("开始下一项计时")}</button>
      <button type="button" role="menuitem" onClick={() => openPanel(t("记一下：要记的事"))}>{t("记一下")}</button>
      <button type="button" role="menuitem" onClick={() => goTo("/")}>{t("打开今日")}</button>
      {host.current && <button type="button" role="menuitem" onClick={() => { setMenu(false); host.current?.postMessage({ type: "hide" }); }}>
        {t("先藏起来（Ctrl+Alt+H 唤回）")}</button>}
      <button type="button" role="menuitem" className="desk-menu-cancel" onClick={() => setMenu(false)}>{t("取消")}</button>
    </div>}
    <div className="desk-stage">
      {pose === "thinking" && <span className="desk-thought" aria-hidden="true"><i /><i /><i /></span>}
      {pose === "sleep" && <span className="desk-z" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>}
      {pose === "down" && <span className="desk-alert" aria-hidden="true">!</span>}
      <button ref={figure} type="button" className="desk-figure-button" aria-label={label} title={label} aria-haspopup="menu"
        onPointerDown={onDown} onPointerMove={onMoveFigure} onPointerUp={onUp} onPointerCancel={() => { press.current = null; }}
        onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); setMenu(true); } }}
        onClick={(event) => { if (event.detail === 0) openPanel(); }}>
        <span className="desk-gaze">
          <span className="desk-body">
            {helper.avatar
              ? <span className="desk-figure" style={{ backgroundImage: `url("${helper.avatar}")` }} />
              : <span className="desk-figure desk-figure-none">{helper.known ? t("小帮手") : ""}</span>}
          </span>
        </span>
        {said?.id && <span className="desk-dot" aria-hidden="true" />}
      </button>
    </div>
  </div>;
}

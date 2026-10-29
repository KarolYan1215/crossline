"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Conversation } from "./chat/conversation";
import { HelperCalls } from "./helper-calls";
import { HelperFace, helperMood, useHelper } from "./helper-state";
import { useT } from "./locale-context";
import { AWAY_MS, isNight, lookAt, petPose, POSE_LABEL, type PetPose } from "./helper-pet";
import { ArrowUpRight, Minimize2 } from "lucide-react";
import { ICON, IconButton } from "./ui/icon-button";
import { HelperBand, RunningChip, useHelperDay } from "./helper-window";
import "./helper-window.css";

/** The window a node belongs to: the tab, or the pinned Picture-in-Picture window it was drawn into. */
function viewOf(ref: RefObject<HTMLElement | null>): Window | null {
  return ref.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
}

/** Whether a key press happened while the person was typing (a field, an editable area): page-wide shortcuts leave those alone. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable));
}

/**
 * The pose for this moment: the mood, or asleep at night and after `AWAY_MS` with no input in the window the figure is drawn in (the tab,
 * or the pinned window). Away is read from this window only: the browser tells a page nothing about the rest of the computer.
 */
export function usePetPose(ref: RefObject<HTMLElement | null>, unread = false): { pose: PetPose; avatar: string | null; known: boolean } {
  const helper = useHelper();
  const mood = helperMood({ down: helper.down, thinking: helper.thinking, working: helper.working, unread });
  const [night, setNight] = useState(false);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const view = viewOf(ref);
    if (!view) return;
    let last = Date.now();
    const tick = () => { setNight(isNight(new Date().getHours())); setAway(Date.now() - last >= AWAY_MS); };
    const input = () => { last = Date.now(); setAway(false); };
    tick();
    const timer = view.setInterval(tick, 60_000);
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) view.addEventListener(name, input, { passive: true });
    return () => { view.clearInterval(timer); for (const name of events) view.removeEventListener(name, input); };
  }, [ref]);
  return { pose: petPose(mood, { night, away }), avatar: helper.avatar, known: helper.known };
}

/**
 * The figure as a pet: it leans a few px toward the pointer when the pointer comes near (read once a frame at most, never under reduced
 * motion, not while asleep or stopped), and gives a small bounce when hovered or pressed. The mood's own motion stays on the face; the
 * lean and the bounce are layers around it, so the three never fight over one `transform`.
 */
export function PetFace({ src, pose, size = "button" }: { src: string; pose: PetPose; size?: "button" | "reply" }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    const view = viewOf(ref);
    if (!el || !view || pose === "sleep" || pose === "down") return;
    if (view.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let at = { x: 0, y: 0 };
    const apply = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const lean = lookAt(at.x - (box.left + box.width / 2), at.y - (box.top + box.height / 2));
      el.style.setProperty("--look-x", `${lean.x}px`);
      el.style.setProperty("--look-y", `${lean.y}px`);
    };
    const move = (event: PointerEvent) => { at = { x: event.clientX, y: event.clientY }; if (!frame) frame = view.requestAnimationFrame(apply); };
    const leave = () => { el.style.removeProperty("--look-x"); el.style.removeProperty("--look-y"); };
    view.addEventListener("pointermove", move, { passive: true });
    view.document.addEventListener("pointerleave", leave);
    return () => {
      view.removeEventListener("pointermove", move);
      view.document.removeEventListener("pointerleave", leave);
      if (frame) view.cancelAnimationFrame(frame);
      leave();
    };
  }, [pose]);
  const poke = () => {
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-poke");
    void el.offsetWidth; // restart the animation when poked again before it ended
    el.setAttribute("data-poke", "");
  };
  return <span ref={ref} className="helper-pet" data-pose={pose} onPointerEnter={poke} onPointerDown={poke}
    onAnimationEnd={(event) => { if (event.animationName === "helper-poke") ref.current?.removeAttribute("data-poke"); }}>
    <span className="helper-pet-body">{pose === "sleep" ? <HelperFace src={src} size={size} /> : <HelperFace src={src} size={size} mood={pose} />}</span>
  </span>;
}

/** Says every minute that a page is on screen (`/api/presence`), judged by the window this is drawn in, so nudges are shown here. */
export function usePresence(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const view = viewOf(ref);
    if (!view) return;
    const ping = () => { if (view.document.visibilityState === "visible") void fetch("/api/presence", { method: "POST" }).catch(() => {}); };
    ping();
    const timer = view.setInterval(ping, 60_000);
    view.document.addEventListener("visibilitychange", ping);
    return () => { view.clearInterval(timer); view.document.removeEventListener("visibilitychange", ping); };
  }, [ref]);
}

type LaunchQueue = { setConsumer: (consumer: (params: { targetURL?: string }) => void) => void };

/**
 * An installed app opened from its shortcuts focuses the window already open (`launch_handler` in the manifest) instead of starting a
 * second one; the target arrives here. 「打开小帮手」 opens the panel in place (`onHelper`); any other target is gone to.
 */
export function useLaunchTarget(onHelper: () => void, enabled = true): void {
  const handler = useRef(onHelper);
  handler.current = onHelper;
  useEffect(() => {
    if (!enabled) return;
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    queue?.setConsumer((params) => {
      if (!params.targetURL) return;
      const target = new URL(params.targetURL);
      if (target.origin !== location.origin) return;
      if (target.pathname === "/helper") { handler.current(); return; }
      if (target.pathname + target.search !== location.pathname + location.search) location.assign(target.pathname + target.search);
    });
  }, [enabled]);
}

type PipApi = { requestWindow: (options: { width: number; height: number }) => Promise<Window> };
const pipApi = (): PipApi | undefined => (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;

/**
 * How this browser can pin the 小帮手 on the desktop: a Document Picture-in-Picture window (Chromium on a computer), which stays above every
 * tab and app; else a small popup of `/helper` on a computer; on a phone nothing (no button).
 */
export function pinSupport(): "pip" | "popup" | null {
  if (typeof window === "undefined") return null;
  if (pipApi()) return "pip";
  return window.matchMedia("(pointer: fine)").matches ? "popup" : null;
}

export const PINNED_SIZE = { width: 380, height: 560 };

/** The page's stylesheets copied into the pinned window: rules where they can be read, the link where they cannot. */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      to.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.append(link);
    }
  }
  to.documentElement.lang = from.documentElement.lang;
  const theme = from.documentElement.dataset.theme;
  if (theme) to.documentElement.dataset.theme = theme;
  to.title = "小帮手";
}

/**
 * Opens the pinned 小帮手 (must run from a click): the Picture-in-Picture window to draw into, or null when the popup fallback was opened
 * instead (it loads `/helper` on its own).
 */
export async function openPinnedWindow(): Promise<Window | null> {
  const api = pipApi();
  if (api) {
    try {
      const win = await api.requestWindow(PINNED_SIZE);
      copyStyles(document, win.document);
      return win;
    } catch { /* refused (no gesture, policy): the popup below */ }
  }
  window.open("/helper", "crossline-helper", `popup,width=${PINNED_SIZE.width},height=${PINNED_SIZE.height}`);
  return null;
}

/**
 * The 小帮手 on its own, for a narrow window (the 2026-10-28 redesign after `docs/plans/page-drafts-1028/helper.html`; scene: away from
 * Crossline's pages, say a line or glance at the next block). From the top: the figure with what it is doing and how many assistant runs
 * are going, what only the person can do outside the app (`HelperCalls`), 打开 Crossline or 收起; today as one band with the next block;
 * each running assistant task as a chip with its progress and 停止; then the day's whole conversation with search, and the input box.
 * Shown by `/helper` and inside the pinned window; it says the page is present every minute, like the corner widget.
 */
export function HelperPocket({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const { pose, avatar } = usePetPose(ref);
  const day = useHelperDay();
  usePresence(ref);
  // On `/helper` itself 「打开小帮手」 is already here; inside the pinned window the tab's widget takes the launch.
  useLaunchTarget(() => {}, !onClose);
  const running = day?.running ?? [];
  const doing = pose === "idle" ? "" : t(POSE_LABEL[pose]).replace(/^[^：:]+[：:]\s*/, "");
  const status = [doing, running.length ? t("{{count}} 项助手任务在跑", { count: running.length }) : ""].filter(Boolean).join(" · ");
  return <section ref={ref} className="assistant-panel helper-pocket" aria-label={t("小帮手")}>
    <header className="hw-head">
      <span className="helper-pocket-who">
        {avatar && <PetFace src={avatar} pose={pose} size="reply" />}
        <span className="hw-name"><b>{t("小帮手")}</b><small className="helper-pocket-state" role="status" data-pose={pose}>{status || t("在这里")}</small></span>
      </span>
      <span className="assistant-panel-actions">
        <HelperCalls />
        {onClose
          ? <IconButton label={t("收起钉在桌面的小帮手")} icon={<Minimize2 {...ICON} />} onClick={onClose} />
          : <a className="ds-icon" href="/" target="crossline-main" aria-label={t("打开 Crossline")} title={t("打开 Crossline")}><ArrowUpRight {...ICON} /></a>}
      </span>
    </header>
    {day && <div className="hw-today">
      <HelperBand day={day} />
      {running.length > 0 && <ul className="hw-chips" aria-label={t("正在运行的助手任务")}>{running.map((task) => <RunningChip key={task.taskId} task={task} />)}</ul>}
    </div>}
    <Conversation variant="panel" />
  </section>;
}

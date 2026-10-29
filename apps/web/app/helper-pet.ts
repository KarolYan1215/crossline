import type { HelperMood } from "./helper-state";

/**
 * The pure rules behind the 小帮手 as a desktop pet (helper-pet-client.tsx): when it sleeps, how far it looks toward the pointer, where a
 * dragged corner may sit, and which key opens it. Kept apart from the DOM so they are tested without a page.
 */

/** How the figure is drawn: one of the moods, or asleep. */
export type PetPose = HelperMood | "sleep";

/** No input on the page for this long counts as the person being away. */
export const AWAY_MS = 10 * 60_000;

/** Night by the browser's own clock: 23:00 to 07:00. */
export function isNight(hour: number): boolean {
  return hour >= 23 || hour < 7;
}

/**
 * Asleep only when there is nothing to say: at night or while the person is away, and only from `idle`. Every other mood keeps its
 * meaning (the background stopped, thinking, the assistant at work, a new message) whatever the hour.
 */
export function petPose(mood: HelperMood, state: { night: boolean; away: boolean }): PetPose {
  return mood === "idle" && (state.night || state.away) ? "sleep" : mood;
}

/** Inside this distance (px from the figure's centre) the figure turns toward the pointer; beyond it, it looks ahead. */
export const LOOK_RADIUS = 260;
/** The furthest the figure leans toward the pointer, in px. */
export const LOOK_MAX = 4;

/** How far the figure leans toward a pointer `dx`,`dy` px from its centre: toward it by at most `max`, nothing when far or on top of it. */
export function lookAt(dx: number, dy: number, radius = LOOK_RADIUS, max = LOOK_MAX): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 1 || distance > radius) return { x: 0, y: 0 };
  const round = (value: number) => Math.round(value * 10) / 10 || 0;
  return { x: round((dx / distance) * max), y: round((dy / distance) * max) };
}

/** Where the corner sits, as distances from the viewport's right and bottom edges. */
export type Dock = { right: number; bottom: number };

/** The corner kept inside the viewport with `margin` px to spare on every side, whatever size the window became since. */
export function clampDock(dock: Dock, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8): Dock {
  const clamp = (value: number, high: number) => Math.round(Math.min(Math.max(value, margin), Math.max(margin, high)));
  return { right: clamp(dock.right, viewport.width - size.width - margin), bottom: clamp(dock.bottom, viewport.height - size.height - margin) };
}

/** A pointer that moved less than this before letting go was a click, not a drag. */
export const DRAG_THRESHOLD = 6;

/** A remembered corner, or null for anything that is not one (nothing saved, an older shape, a damaged value). */
export function parseDock(raw: string | null): Dock | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Dock>;
    return typeof value.right === "number" && typeof value.bottom === "number" && Number.isFinite(value.right) && Number.isFinite(value.bottom)
      ? { right: value.right, bottom: value.bottom } : null;
  } catch { return null; }
}

/** Alt+Shift+H, with no Ctrl or Meta: the key that opens and closes the 小帮手. `code` so a keyboard layout or IME does not change it. */
export function isHelperShortcut(event: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyH";
}

/**
 * Where the desktop pet looks (helper-desk.tsx): toward the pointer anywhere on the screen (the node's tray reports it), by a few px —
 * more the further the pointer is, never a turn (the tray cuts its window to the figure, so it only moves along the axes); straight
 * ahead when the pointer is on the figure itself.
 */
export function gazeAt(dx: number, dy: number): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 24) return { x: 0, y: 0 };
  const round = (value: number) => Math.round(value * 10) / 10 || 0;
  const reach = Math.min(1, distance / 400);
  return { x: round((dx / distance) * LOOK_MAX * reach), y: round((dy / distance) * (LOOK_MAX / 2) * reach) };
}

/** A press held this long without moving opens the quick actions (a long press is a phone's right click). */
export const LONG_PRESS_MS = 550;

/**
 * Whether the person is away from the computer: the tray reports the whole computer's idle time (`GetLastInputInfo`); in an ordinary tab
 * only this page's own input is known, which is what `localIdleMs` is.
 */
export function awayFor(hostIdleMs: number | null, localIdleMs: number): boolean {
  return (hostIdleMs ?? localIdleMs) >= AWAY_MS;
}

/** What the desktop pet's bubble says when no message waits: its pose in words, and nothing when idle or asleep (the figure shows it). */
export function deskBubbleKey(pose: PetPose): string | null {
  return pose === "idle" || pose === "sleep" ? null : POSE_LABEL[pose];
}

/**
 * The shape the node tray cuts its window to (installer/node-tray/CrosslineNode.cs): one `[x, y, width, height, radius]` per drawn
 * piece in whole CSS px, nothing for a piece with no size. The tray pads each by a few px so the breathing and the hop are not clipped.
 */
export function shapeRects(boxes: Array<{ x: number; y: number; width: number; height: number; radius: number }>): number[][] {
  return boxes.filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width >= 1 && box.height >= 1)
    .map((box) => [Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width), Math.ceil(box.height), Math.max(0, Math.round(box.radius || 0))]);
}

/** What the service worker tells an open window when a notification about the 小帮手 is tapped: open it there instead of a new window. */
export const OPEN_HELPER_MESSAGE = "crossline:open-helper";

/** What the figure's label says for each pose, in the UI's third person. */
export const POSE_LABEL: Record<PetPose, string> = {
  down: "小帮手：后台没在运行",
  thinking: "小帮手：正在想",
  working: "小帮手：助手在做事",
  unread: "小帮手：有新消息",
  idle: "打开小帮手",
  sleep: "小帮手：在休息"
};

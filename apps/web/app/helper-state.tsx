"use client";
import { useEffect, useState } from "react";
import { pollWhileVisible } from "./ui/visible-poll";

/** What the 小帮手 is doing, most pressing first: the background stopped, thinking over a line, the assistant at work, a new message. */
export type HelperMood = "down" | "thinking" | "working" | "unread" | "idle";

export function helperMood(state: { down: boolean; thinking: boolean; working: boolean; unread: boolean }): HelperMood {
  return state.down ? "down" : state.thinking ? "thinking" : state.working ? "working" : state.unread ? "unread" : "idle";
}

/** Fired by the input box around a turn, so the figure shows it is thinking while the model answers. */
export const HELPER_THINKING = "crossline:helper-thinking";
export function announceThinking(thinking: boolean): void {
  window.dispatchEvent(new CustomEvent(HELPER_THINKING, { detail: thinking }));
}

type Shared = { avatar: string | null; working: boolean; down: boolean };
let shared: Shared = { avatar: null, working: false, down: false };
const listeners = new Set<(next: Shared) => void>();
let polling: (() => void) | undefined;

async function refresh(): Promise<void> {
  const body = await fetch("/api/helper", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as
    ({ ok?: boolean } & Shared) | null;
  if (!body?.ok) return;
  shared = { avatar: body.avatar ?? null, working: Boolean(body.working), down: Boolean(body.down) };
  for (const listener of listeners) listener(shared);
}

/**
 * The 小帮手's figure and background state, shared by the floating button and the conversation's avatars: one request every thirty
 * seconds for the whole page, however many places show the figure.
 */
export function useHelper(): Shared & { thinking: boolean } {
  const [state, setState] = useState(shared);
  const [thinking, setThinking] = useState(false);
  useEffect(() => {
    listeners.add(setState);
    if (!polling) polling = pollWhileVisible(refresh, 30_000);
    else setState(shared);
    const onThinking = (event: Event) => setThinking(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(HELPER_THINKING, onThinking);
    return () => {
      listeners.delete(setState);
      window.removeEventListener(HELPER_THINKING, onThinking);
      if (!listeners.size && polling) { polling(); polling = undefined; }
    };
  }, []);
  return { ...state, thinking };
}

/** The upper half of the full-length figure, cropped by the frame (the pose is not looked at): exported for the widget and the replies. */
export function HelperFace({ src, size, mood }: { src: string; size: "button" | "reply"; mood?: HelperMood }) {
  return <span className="helper-face" data-size={size} data-mood={mood} style={{ backgroundImage: `url("${src}")` }} aria-hidden="true" />;
}

/** A message's text without its Markdown marks, for the bubble beside the figure and for finding it elsewhere on the page. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?)/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How much of a message the bubble shows: about three lines at its 320px width. */
export const PREVIEW_CHARACTERS = 60;

/**
 * A message cut for the bubble by characters (not UTF-16 units, so a character is never split), ending in 「…」 when cut. A cut inside a
 * 「」 quote closes it after the ellipsis — the real bubble ended on a bare 「, which read as broken.
 */
export function previewText(text: string, max = PREVIEW_CHARACTERS): string {
  const characters = Array.from(text.trim());
  if (characters.length <= max) return characters.join("");
  let kept = characters.slice(0, max - 1).join("").replace(/[\s，、。；：,.;:]+$/u, "");
  // A cut right after an opening quote leaves nothing quoted: drop the quote instead of showing 「…」.
  kept = kept.replace(/[「『“‘(（]+$/u, "");
  const open = (kept.match(/「/g) ?? []).length - (kept.match(/」/g) ?? []).length;
  return `${kept}…${open > 0 ? "」".repeat(open) : ""}`;
}

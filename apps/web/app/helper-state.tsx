"use client";
import { useEffect, useState } from "react";

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
let polling: ReturnType<typeof setInterval> | undefined;

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
    if (!polling) { void refresh(); polling = setInterval(() => void refresh(), 30_000); }
    else setState(shared);
    const onThinking = (event: Event) => setThinking(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(HELPER_THINKING, onThinking);
    return () => {
      listeners.delete(setState);
      window.removeEventListener(HELPER_THINKING, onThinking);
      if (!listeners.size && polling) { clearInterval(polling); polling = undefined; }
    };
  }, []);
  return { ...state, thinking };
}

/** The upper half of the full-length figure, cropped by the frame (the pose is not looked at): exported for the widget and the replies. */
export function HelperFace({ src, size, mood }: { src: string; size: "button" | "reply"; mood?: HelperMood }) {
  return <span className="helper-face" data-size={size} data-mood={mood} style={{ backgroundImage: `url("${src}")` }} aria-hidden="true" />;
}

"use client";

import Link from "next/link";
import { useEffect, useRef, type ComponentProps } from "react";
import { useAppRouter } from "./use-app-router";

/** How long the pointer rests on a link before its page is fetched: sweeping across the header fetches nothing. */
const DWELL_MS = 120;

/**
 * A link between the app's own views, followed in the page (2026-10-28): only the content is fetched and swapped; the frame, its scripts
 * and styles stay. Its page is fetched ahead once the person shows intent — the pointer resting on it, a touch, keyboard focus — never
 * because it is on screen: every view is rendered for the person on a server with two render slots, and the header alone holds six links.
 *
 * Fetched with the router's own `prefetch(href, { kind: "full" })`: `<Link prefetch>` turned on at hover fetched only the route tree for a
 * dynamic page and the click still waited for the server (measured in Chrome against a production build, Next 16.3). A page fetched ahead
 * is kept 30 seconds (`staleTimes.static` in next.config.mjs). Its page request carries no prefetch header, so in the hosted page line
 * (queue-line.mjs) it waits like a page someone opened; only the route-tree request before it is marked and goes last.
 * Without script it is an ordinary link. `data-soft` keeps the Speculation Rules (app/layout.tsx) from also fetching it as a document.
 */
export function NavLink({ href, onMouseEnter, onMouseLeave, onTouchStart, onFocus, ...rest }: ComponentProps<typeof Link> & { href: string }) {
  const router = useAppRouter();
  const timer = useRef<number | undefined>(undefined);
  const fetched = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const ahead = () => {
    window.clearTimeout(timer.current);
    // Once per kept period: the router keeps it 30 seconds anyway.
    if (!router || Date.now() - fetched.current < 30_000) return;
    fetched.current = Date.now();
    router.prefetch(href, { kind: "full" } as unknown as Parameters<typeof router.prefetch>[1]);
  };
  return <Link {...rest} href={href} data-soft="" prefetch={false}
    onMouseEnter={(event) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(ahead, DWELL_MS); onMouseEnter?.(event); }}
    onMouseLeave={(event) => { window.clearTimeout(timer.current); onMouseLeave?.(event); }}
    onTouchStart={(event) => { ahead(); onTouchStart?.(event); }}
    onFocus={(event) => { ahead(); onFocus?.(event); }} />;
}

"use client";

import { useEffect } from "react";

/**
 * Where a link opens (the owner's rule of 2026-11-03): a page of this app opens in the same tab, a page off the app in a new one.
 * One listener for every link instead of a `target` on each: `same` for an in-app link marked `_blank`, `new` for an off-app web
 * link, `null` to leave the browser alone (mailto:, a download, a link marked `data-new-tab`, anything already right).
 */
export function linkTarget(href: string, target: string, origin: string): "same" | "new" | null {
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const blank = target === "_blank";
  if (url.origin === origin) return blank ? "same" : null;
  return blank ? null : "new";
}

export function LinkTargets() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download") || link.hasAttribute("data-new-tab")) return;
      const where = linkTarget(link.getAttribute("href") ?? "", link.target, window.location.origin);
      if (!where) return;
      event.preventDefault();
      if (where === "same") window.location.assign(link.href);
      else window.open(link.href, "_blank", "noopener,noreferrer");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}

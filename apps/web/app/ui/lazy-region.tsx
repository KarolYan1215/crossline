"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../locale-context";

/**
 * Part of a page read after the page is shown (2026-10-28): `load` is a server action that renders it for the signed-in person. `visible`
 * reads it as it comes within a screen of view, `open` when the fold it sits in is opened (a fold restored open on coming back counts).
 * The content is the same as when it came with the page; only the page itself is lighter (待确认 was 240 KB of HTML on the owner's account).
 * A new `load` (the page was refreshed) reads it again.
 */
export function LazyRegion({ load, when = "visible", minHeight }: { load: () => Promise<ReactNode>; when?: "visible" | "open"; minHeight?: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<ReactNode>();
  const [state, setState] = useState<"waiting" | "loading" | "done" | "failed">("waiting");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let live = true, started = false;
    const start = () => {
      if (started) return;
      started = true;
      setState("loading");
      load().then((value) => { if (live) { setContent(value); setState("done"); } }).catch(() => { if (live) setState("failed"); });
    };
    if (when === "open") {
      const fold = element.closest("details");
      if (!fold || fold.open) { start(); return () => { live = false; }; }
      const onToggle = () => { if (fold.open) start(); };
      fold.addEventListener("toggle", onToggle);
      return () => { live = false; fold.removeEventListener("toggle", onToggle); };
    }
    if (typeof IntersectionObserver === "undefined") { start(); return () => { live = false; }; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); start(); } },
      { rootMargin: "100% 0px" });
    observer.observe(element);
    return () => { live = false; observer.disconnect(); };
  }, [load, when, attempt]);
  return <div ref={ref} className="lazy-region" style={state === "done" || !minHeight ? undefined : { minHeight }}>
    {state === "done" ? content
      : state === "failed" ? <p role="alert">{t("读取失败")} <button type="button" className="text-button" onClick={() => setAttempt((n) => n + 1)}>{t("重试")}</button></p>
      : state === "loading" ? <p role="status" className="muted">{t("正在读取…")}</p> : null}
  </div>;
}

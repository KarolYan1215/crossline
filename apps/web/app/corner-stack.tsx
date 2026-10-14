"use client";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The fixed bottom-right corner (the timer above the 小帮手 bubble). It records how far up the screen it reaches in
 * `--corner-clearance`, and the page keeps that much room at its foot (composer.css), so the last thing on any page can always be
 * scrolled clear of it instead of sitting under the bubble.
 */
export function CornerStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const record = () => {
      const reach = el.childElementCount ? Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top)) : 0;
      document.documentElement.style.setProperty("--corner-clearance", `${reach + 12}px`);
    };
    record();
    const observer = new ResizeObserver(record);
    observer.observe(el);
    window.addEventListener("resize", record);
    return () => { observer.disconnect(); window.removeEventListener("resize", record); };
  }, []);
  return <div ref={ref} className="corner-stack">{children}</div>;
}

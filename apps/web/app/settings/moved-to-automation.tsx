"use client";
import { useEffect } from "react";

/** The settings modules that moved to the 自动化 page (2026-11-10), by the hash old links and messages still carry. */
export const MOVED_TO_AUTOMATION = new Set(["skills", "automations", "opportunity"]);

/**
 * An old link to a module that moved (`/settings#skills`, `#automations`, `#opportunity`) goes on to /automation. The hash never reaches
 * the server, so the page follows it here, on arrival and when it changes.
 */
export function MovedToAutomation() {
  useEffect(() => {
    const follow = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (MOVED_TO_AUTOMATION.has(id)) window.location.replace(`/automation${id === "skills" || id === "opportunity" ? `#${id}` : ""}`);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return null;
}

"use client";

import { useRouter } from "next/navigation";

/**
 * The router, or undefined where there is none (a component rendered on its own, as the unit tests render the frame). Callers fall back to
 * a whole-page load then, which is what they did before moves in the page (2026-10-28). The hook is called on every render either way.
 */
export function useAppRouter(): ReturnType<typeof useRouter> | undefined {
  try { return useRouter(); } catch { return undefined; }
}

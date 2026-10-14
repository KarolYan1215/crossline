/** Browser storage that never throws: a private window, blocked site data or a server render all read as empty. */
type Area = "session" | "local";

const area = (which: Area): Storage | null => {
  try { return typeof window === "undefined" ? null : which === "session" ? window.sessionStorage : window.localStorage; } catch { return null; }
};

export function readStored(which: Area, key: string): string | null {
  try { return area(which)?.getItem(key) ?? null; } catch { return null; }
}

export function writeStored(which: Area, key: string, value: string | null): void {
  try {
    const store = area(which);
    if (!store) return;
    if (value === null) store.removeItem(key); else store.setItem(key, value);
  } catch { /* storage unavailable: the page works without it */ }
}

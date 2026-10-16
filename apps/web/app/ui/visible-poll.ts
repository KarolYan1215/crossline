/**
 * Reads now, then every `ms` while the page is visible; a hidden tab asks nothing, and catches up as soon as it is shown again if a
 * read is due. Several people keeping the app open in a background tab used to poll the server as often as people using it (2026-10-16,
 * hosted beta). Returns the cleanup for `useEffect`.
 */
export function pollWhileVisible(read: () => unknown, ms: number): () => void {
  let last = 0;
  const due = () => {
    if (document.visibilityState !== "visible" || Date.now() - last < ms - 50) return;
    last = Date.now();
    void read();
  };
  last = Date.now();
  void read();
  const timer = setInterval(due, ms);
  document.addEventListener("visibilitychange", due);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", due); };
}

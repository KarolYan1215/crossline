import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** A tab's worth of browser: one address, sessionStorage, a scroll position, and folds in `main`. */
function fakeTab(path: string, navigation = "navigate") {
  const [pathname, search = ""] = path.split("?");
  const store = new Map<string, string>();
  const folds = [{ id: "", open: false, summary: "任务库 12 项" }, { id: "", open: true, summary: "已归档 3 项" }]
    .map((fold) => ({ id: fold.id, open: fold.open, querySelector: () => ({ textContent: fold.summary }) }));
  const main = { querySelectorAll: () => folds };
  const tab = {
    folds, store, scrolledTo: [] as number[],
    window: { scrollY: 640, scrollTo: (_x: number, y: number) => tab.scrolledTo.push(y), setTimeout: (run: () => void) => { run(); return 0; },
      sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } }
  };
  vi.stubGlobal("window", tab.window);
  vi.stubGlobal("location", { pathname, search: search ? `?${search}` : "", origin: "http://127.0.0.1:3210" });
  vi.stubGlobal("document", { querySelector: () => main });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: navigation }] as unknown as PerformanceEntryList);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => { run(); return 0; });
  return tab;
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("coming back to a page", () => {
  test("a page left is restored only when it is returned to: scroll and folds, matched by name not by count", async () => {
    const tab = fakeTab("/workbench?line=research");
    const state = await import("./return-state");
    expect(state.returningSnapshot()).toBeNull();
    tab.folds[0]!.open = true;
    state.saveReturnState();
    expect(state.lastPage()).toBe("/workbench?line=research");
    // Later: the fold counts changed and everything was closed again, and the back button marked this page.
    tab.folds[0]!.open = false;
    tab.folds[0]!.querySelector = () => ({ textContent: "任务库 13 项" });
    tab.folds[1]!.open = false;
    state.markReturning("/workbench?line=research");
    state.forgetReturnDecision();
    const snapshot = state.returningSnapshot();
    expect(snapshot?.scrollY).toBe(640);
    state.restoreFrame(snapshot!);
    expect(tab.folds.map((fold) => fold.open)).toEqual([true, true]);
    expect(tab.scrolledTo).toContain(640);
    // The mark is taken off: a later fresh visit starts at the top.
    expect(tab.store.has("crossline:returning")).toBe(false);
  });

  test("a move in the page: back (a popstate) saves the page left and restores the page returned to; the referrer is the page shown before", async () => {
    const tab = fakeTab("/workbench");
    const listeners = new Map<string, () => void>();
    (tab.window as unknown as { addEventListener: (type: string, run: () => void) => void }).addEventListener = (type, run) => void listeners.set(type, run);
    const state = await import("./return-state");
    expect(state.notePageShown()).toBeUndefined();
    tab.folds[0]!.open = true;
    state.saveReturnState();
    // A link followed in the page: the address changes, no document loads.
    vi.stubGlobal("location", { pathname: "/plan", search: "", origin: "http://127.0.0.1:3210" });
    state.forgetReturnDecision();
    expect(state.notePageShown()).toBe("/workbench");
    expect(state.returningSnapshot()).toBeNull();
    // The browser's back: the router answers it in the page.
    tab.window.scrollY = 120;
    vi.stubGlobal("location", { pathname: "/workbench", search: "", origin: "http://127.0.0.1:3210" });
    listeners.get("popstate")!();
    expect(JSON.parse(tab.store.get("crossline:return:/plan")!).scrollY).toBe(120);
    state.forgetReturnDecision();
    expect(state.returningSnapshot()?.scrollY).toBe(640);
    expect(state.notePageShown()).toBe("/plan");
  });

  test("the browser's own back restores without a mark", async () => {
    const tab = fakeTab("/", "back_forward");
    tab.store.set("crossline:return:/", JSON.stringify({ scrollY: 300, details: {}, extra: { "task-dialog:wo-1:hero": true } }));
    const state = await import("./return-state");
    expect(state.returningSnapshot()?.extra).toEqual({ "task-dialog:wo-1:hero": true });
  });
});

describe("the back button", () => {
  test("goes to the page the task was opened from, keeps it across the task's own subpages, and has none for a direct link", async () => {
    fakeTab("/workbench/wo-1");
    const { resolveOrigin, placeLabel } = await import("./back-link");
    const scope = "/workbench/wo-1";
    expect(resolveOrigin(scope, { referrer: "http://127.0.0.1:3210/milestones", last: "/milestones", stored: null, reload: false })).toBe("/milestones");
    // The address the list had when it was left (a filter chosen after load) wins over the referrer's.
    expect(resolveOrigin(scope, { referrer: "http://127.0.0.1:3210/workbench", last: "/workbench?line=research", stored: null, reload: false })).toBe("/workbench?line=research");
    expect(resolveOrigin(scope, { referrer: "http://127.0.0.1:3210/workbench/wo-1/material?doc=d", last: "/workbench/wo-1/material?doc=d", stored: "/", reload: false })).toBe("/");
    expect(resolveOrigin(scope, { referrer: "", last: "/plan", stored: "/plan", reload: false })).toBeNull();
    expect(resolveOrigin(scope, { referrer: "", last: null, stored: "/approvals", reload: true })).toBe("/approvals");
    expect(resolveOrigin(scope, { referrer: "https://example.com/", last: "/", stored: null, reload: false })).toBeNull();
    expect(["/", "/milestones?open=m1", "/plan?horizon=8", "/approvals#asks", "/workbench", "/elsewhere"].map(placeLabel))
      .toEqual(["今日", "主线", "计划", "待确认", "任务", "上一页"]);
  });
});

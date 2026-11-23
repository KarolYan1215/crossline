import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_OPS, DesktopBridgeError, desktopShell } from "./desktop-bridge";

/** A stand-in for WebView2's `window.chrome.webview` that answers each request with `answer`. */
function fakeWindow(answer: (message: { id: string; op: string; args: Record<string, unknown> }) => object | undefined) {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const posted: Array<{ id: string; op: string; args: Record<string, unknown> }> = [];
  const webview = {
    postMessage: (message: { id: string; op: string; args: Record<string, unknown> }) => {
      posted.push(message);
      const reply = answer(message);
      if (reply) queueMicrotask(() => { for (const listener of [...listeners]) listener({ data: { crossline: "desktop", id: message.id, ...reply } }); });
    },
    addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => { listeners.add(listener); },
    removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => { listeners.delete(listener); }
  };
  return { scope: { chrome: { webview }, crosslineDesktop: { shell: "webview2", version: "0.4.0" } }, posted, listeners };
}

describe("desktopShell", () => {
  it("is absent in a browser, and with WebView2 but no injected marker", () => {
    expect(desktopShell({})).toBeUndefined();
    expect(desktopShell({ chrome: { webview: {} } })).toBeUndefined();
    expect(desktopShell({ crosslineDesktop: { shell: "webview2" } })).toBeUndefined();
  });

  it("returns the folder the person chose, and undefined when they cancelled", async () => {
    const chosen = fakeWindow((message) => message.op === "pickFolder" ? { ok: true, result: { path: "D:\\资料" } } : undefined);
    const shell = desktopShell(chosen.scope)!;
    expect(shell.version).toBe("0.4.0");
    expect(await shell.pickFolder("选择文件夹")).toBe("D:\\资料");
    expect(chosen.posted[0]).toMatchObject({ crossline: "desktop", op: "pickFolder", args: { title: "选择文件夹" } });
    expect(chosen.listeners.size).toBe(0);
    const cancelled = fakeWindow(() => ({ ok: true, result: { cancelled: true } }));
    expect(await desktopShell(cancelled.scope)!.pickFolder()).toBeUndefined();
  });

  it("matches replies by id, ignores other messages and passes the tray's refusal code on", async () => {
    const { scope, listeners, posted } = fakeWindow(() => undefined);
    const opening = desktopShell(scope)!.openFolder("D:\\资料");
    const [listener] = [...listeners];
    listener!({ data: "unrelated" });
    listener!({ data: { crossline: "desktop", id: "someone-else", ok: false, code: "X" } });
    expect(listeners.size).toBe(1);
    listener!({ data: { crossline: "desktop", id: posted.at(-1)!.id, ok: false, code: "DESKTOP_NOT_A_FOLDER" } });
    await expect(opening).rejects.toEqual(new DesktopBridgeError("DESKTOP_NOT_A_FOLDER"));
    expect(listeners.size).toBe(0);
  });

  it("times out a request the tray never answers", async () => {
    vi.useFakeTimers();
    try {
      const { scope } = fakeWindow(() => undefined);
      const opening = desktopShell(scope)!.notify({ title: "Crossline", text: "好了" });
      const caught = opening.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await caught).toEqual(new DesktopBridgeError("DESKTOP_TIMEOUT"));
    } finally { vi.useRealTimers(); }
  });
});

describe("the tray answers exactly the listed requests", () => {
  it("handles every op in DESKTOP_OPS and nothing else", () => {
    const tray = path.resolve(import.meta.dirname, "../../../installer/tray");
    const source = readdirSync(tray).filter((file) => file.endsWith(".cs")).map((file) => readFileSync(path.join(tray, file), "utf8")).join("\n");
    const start = source.indexOf("// bridge-ops:begin"), end = source.indexOf("// bridge-ops:end");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handled = [...source.slice(start, end).matchAll(/case "([A-Za-z]+)":/g)].map((match) => match[1]).sort();
    expect(handled).toEqual([...DESKTOP_OPS].sort());
    // Requests are taken only from this app's own pages.
    expect(source).toMatch(/WebMessageReceived/);
    expect(source).toMatch(/IsOwnOrigin\(e\.Source\)/);
  });
});

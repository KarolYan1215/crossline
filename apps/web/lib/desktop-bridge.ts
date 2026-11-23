"use client";

import { useEffect, useState } from "react";

/**
 * The installed copy's own window (docs/plans/desktop-window-1123.md): the tray `installer/tray/Crossline.cs` shows this app's pages in a
 * WebView2 window and answers a fixed list of requests posted through `window.chrome.webview`. Nothing else crosses: no file is read or
 * written, nothing is run, no address is opened. In a browser (the hosted app, or this app opened in a browser) there is no bridge and
 * every caller keeps what it did before.
 *
 * The tray's `switch` handles exactly `DESKTOP_OPS`; `desktop-bridge.test.ts` reads the C# file and fails if the two lists differ.
 */
export const DESKTOP_OPS = ["info", "pickFolder", "openFolder", "notify"] as const;
export type DesktopOp = (typeof DESKTOP_OPS)[number];

type WebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
};
type Reply = { crossline: "desktop"; id: string; ok: boolean; result?: unknown; code?: string };

export class DesktopBridgeError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type DesktopShell = {
  version: string;
  /** The system's folder dialog; the full path the person chose, or undefined when they cancelled. */
  pickFolder: (title?: string) => Promise<string | undefined>;
  /** Opens an existing folder in File Explorer (folders only: nothing can be run through it). */
  openFolder: (path: string) => Promise<void>;
  /** A tray balloon; a click brings the window back on `path`, one of this app's own pages. */
  notify: (message: { title: string; text: string; path?: string }) => Promise<void>;
};

/** What the tray injects at document creation; present only inside its window. */
type Injected = { shell?: unknown; version?: unknown };

function host(scope: unknown): { webview: WebViewHost; injected: Injected } | undefined {
  const global = scope as { crosslineDesktop?: Injected; chrome?: { webview?: WebViewHost } } | undefined;
  const webview = global?.chrome?.webview;
  if (!global?.crosslineDesktop || global.crosslineDesktop.shell !== "webview2" || !webview) return undefined;
  return { webview, injected: global.crosslineDesktop };
}

const isReply = (data: unknown): data is Reply => typeof data === "object" && data !== null
  && (data as Reply).crossline === "desktop" && typeof (data as Reply).id === "string" && typeof (data as Reply).ok === "boolean";

let counter = 0;

/** One request to the tray; rejects with `DesktopBridgeError` carrying the tray's code, or `DESKTOP_TIMEOUT`. */
export function request(webview: WebViewHost, op: DesktopOp, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  const id = `d${Date.now().toString(36)}-${(counter += 1)}`;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (event: { data: unknown }) => {
      if (!isReply(event.data) || event.data.id !== id) return;
      webview.removeEventListener("message", listener);
      if (timer) clearTimeout(timer);
      if (event.data.ok) resolve(event.data.result);
      else reject(new DesktopBridgeError(event.data.code ?? "DESKTOP_FAILED"));
    };
    webview.addEventListener("message", listener);
    if (timeoutMs) timer = setTimeout(() => { webview.removeEventListener("message", listener); reject(new DesktopBridgeError("DESKTOP_TIMEOUT")); }, timeoutMs);
    webview.postMessage({ crossline: "desktop", id, op, args });
  });
}

/** The window's bridge, or undefined in a browser. `scope` is for tests. */
export function desktopShell(scope: unknown = globalThis): DesktopShell | undefined {
  const found = host(scope);
  if (!found) return undefined;
  const { webview, injected } = found;
  return {
    version: typeof injected.version === "string" ? injected.version : "",
    // The person may take as long as they like in the dialog: no timeout.
    pickFolder: async (title) => {
      const result = await request(webview, "pickFolder", title ? { title } : {}) as { path?: unknown; cancelled?: unknown } | undefined;
      return typeof result?.path === "string" && result.path ? result.path : undefined;
    },
    openFolder: async (path) => { await request(webview, "openFolder", { path }, 10_000); },
    notify: async (message) => { await request(webview, "notify", message, 10_000); }
  };
}

/** The bridge after the page has mounted (undefined on the server and in the first render, so hydration matches). */
export function useDesktopShell(): DesktopShell | undefined {
  const [shell, setShell] = useState<DesktopShell | undefined>();
  useEffect(() => { setShell(desktopShell()); }, []);
  return shell;
}

/** Said when a folder was authorized somewhere else on the page, so every folder card reads the list again. */
export const FOLDERS_CHANGED_EVENT = "crossline:folders-changed";

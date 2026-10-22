import { spawn, type ChildProcess } from "node:child_process";

/**
 * A screen for the server's browser (decided 2026-10-22, the owner: 「服务器上用 Xvfb 跑有界面的 Chromium，不改 user agent」). A headless
 * Chromium tells every site it is HeadlessChrome; the same Chromium with a window, on a virtual screen, is an ordinary browser — nothing
 * about it is disguised. One Xvfb per worker, started the first time a browser opens on the server and kept while the worker runs; it
 * picks its own display number (`-displayfd`), so a lock left by an earlier run never collides. Without Xvfb (a machine that lacks it, or
 * `CROSSLINE_SERVER_DISPLAY=off`) the browser runs headless as before.
 */
export type ServerDisplay = { display: string } | undefined;
type Spawn = (command: string, args: string[]) => ChildProcess;

let current: Promise<ServerDisplay> | undefined;
let child: ChildProcess | undefined;

export function serverDisplay(env: NodeJS.ProcessEnv = process.env, start: Spawn = startXvfb): Promise<ServerDisplay> {
  if (env.CROSSLINE_SERVER_DISPLAY?.trim().toLowerCase() === "off") return Promise.resolve(undefined);
  current ??= open(start).then((display) => { if (!display) current = undefined; return display; });
  return current;
}

/** Launch options that put a browser on the server's screen: a window when there is one, headless otherwise. */
export function onServerScreen(display: ServerDisplay, size: { width: number; height: number }) {
  return display
    ? { headless: false, env: { ...process.env, DISPLAY: display.display }, extraArgs: [`--window-size=${size.width},${size.height}`] }
    : { headless: true, extraArgs: [] as string[] };
}

const startXvfb: Spawn = (command, args) => spawn(command, args, { stdio: ["ignore", "ignore", "ignore", "pipe"] });

function open(start: Spawn): Promise<ServerDisplay> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ServerDisplay) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let process_: ChildProcess;
    try {
      // 24-bit colour so pages render as on a desktop; no TCP listener, only the local socket Chromium connects to.
      process_ = start("Xvfb", ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"]);
    } catch { done(undefined); return; }
    const timer = setTimeout(() => { process_.kill(); done(undefined); }, 10_000);
    process_.on("error", () => done(undefined));
    process_.on("exit", () => { if (child === process_) { child = undefined; current = undefined; } done(undefined); });
    let text = "";
    const fd = process_.stdio[3] as NodeJS.ReadableStream | null | undefined;
    fd?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /(\d+)\s*\n/.exec(text);
      if (match) { child = process_; done({ display: `:${match[1]}` }); }
    });
  });
}

/** Stops the screen (tests, shutdown). */
export function closeServerDisplay(): void {
  child?.kill();
  child = undefined;
  current = undefined;
}

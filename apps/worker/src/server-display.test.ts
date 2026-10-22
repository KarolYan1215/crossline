import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { closeServerDisplay, onServerScreen, serverDisplay } from "./server-display";
import { readerLaunchOptions } from "./browser-launch";

/** The server's browser has a window on a virtual screen (2026-10-22): an ordinary Chromium, not HeadlessChrome. */
afterEach(() => closeServerDisplay());
const fakeXvfb = (number: string | undefined) => {
  const calls: string[][] = [];
  const spawn = (_command: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, new PassThrough()], kill: () => true }) as unknown as ChildProcess;
    if (number) setTimeout(() => (child.stdio[3] as PassThrough).write(`${number}\n`), 5);
    else setTimeout(() => child.emit("error", new Error("ENOENT")), 5);
    return child;
  };
  return { spawn, calls };
};

test("Xvfb picks its own display once; the browser gets a window on it, the same user agent, and no disguise", async () => {
  const xvfb = fakeXvfb("7");
  expect(await serverDisplay({}, xvfb.spawn)).toEqual({ display: ":7" });
  expect(await serverDisplay({}, xvfb.spawn)).toEqual({ display: ":7" });
  expect(xvfb.calls).toHaveLength(1);
  expect(xvfb.calls[0]).toEqual(expect.arrayContaining(["-displayfd", "3", "-nolisten", "tcp"]));
  const options = readerLaunchOptions("", "remote", { display: ":7" });
  expect(options).toMatchObject({ headless: false, env: expect.objectContaining({ DISPLAY: ":7" }), viewport: { width: 1280, height: 800 } });
  expect(JSON.stringify(options)).not.toMatch(/user-?agent|stealth|AutomationControlled/i);
});

test("no Xvfb, or turned off: headless as before", async () => {
  expect(await serverDisplay({}, fakeXvfb(undefined).spawn)).toBeUndefined();
  expect(await serverDisplay({ CROSSLINE_SERVER_DISPLAY: "off" }, fakeXvfb("3").spawn)).toBeUndefined();
  expect(onServerScreen(undefined, { width: 1280, height: 800 })).toEqual({ headless: true, extraArgs: [] });
  expect(readerLaunchOptions("", "local")).toMatchObject({ headless: false, viewport: null });
});

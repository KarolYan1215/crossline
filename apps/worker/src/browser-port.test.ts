import { createServer } from "node:http";
import { expect, test } from "vitest";
import { BROWSER_BAD_PORTS, listenForBrowser } from "./browser-port";

test("a port the browser refuses is closed and another drawn", async () => {
  const drawn = [6665, 6697, 51234];
  const calls: string[] = [];
  let current = 0;
  const server = {
    listen: (_port: number, _host: string, done: () => void) => { current = drawn.shift()!; calls.push(`listen ${current}`); done(); },
    address: () => ({ port: current, address: "127.0.0.1", family: "IPv4" }),
    close: (done: () => void) => { calls.push(`close ${current}`); done(); },
    once: () => undefined,
    off: () => undefined
  };
  expect(await listenForBrowser(server)).toBe(51234);
  expect(calls).toEqual(["listen 6665", "close 6665", "listen 6697", "close 6697", "listen 51234"]);
});

test("a real server ends on a port outside the bad list", async () => {
  const server = createServer((_request, response) => response.end());
  const port = await listenForBrowser(server);
  expect(BROWSER_BAD_PORTS.has(port)).toBe(false);
  expect(BROWSER_BAD_PORTS.has(6665)).toBe(true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

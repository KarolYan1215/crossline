import type { AddressInfo } from "node:net";

/**
 * Ports every browser refuses to open (the Fetch standard's "bad port" list; Chromium's `net/base/port_util.cc`): a page served on one
 * fails with ERR_UNSAFE_PORT before a request is made.
 */
export const BROWSER_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

type Listener = {
  listen(port: number, host: string, done: () => void): unknown;
  address(): AddressInfo | string | null;
  close(done: (error?: Error) => void): unknown;
  once(event: "error", handler: (error: Error) => void): unknown;
  off(event: "error", handler: (error: Error) => void): unknown;
};

/**
 * Listens on a free port a browser will open. Port 0 lets the system pick, and Windows' dynamic range can hand out a bad one: the form
 * engine's tests drew 6665 and every page load failed (2026-11-11). A bad port is closed and another drawn.
 */
export async function listenForBrowser(server: Listener, host = "127.0.0.1", tries = 20): Promise<number> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => { server.off("error", reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    if (!BROWSER_BAD_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`no port a browser will open after ${tries} tries`);
}

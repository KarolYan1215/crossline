/**
 * 「Crossline 节点」 run as it ships (docs/compute-node.md), against a stand-in site on this machine: pairing by code, the token kept with
 * Windows' data protection and read back after a restart, the ChatGPT sign-in started (not completed: no window opens, nobody signs in),
 * and the program's own page. A real Codex in a throwaway home; no model is called and nothing reaches the hosted site.
 *
 *   pnpm exec tsx scripts/node-standalone-check.ts [--codex <codex.exe>] [--main <main.mjs>]
 *
 * With `--main` it runs the packaged, minified program with node; otherwise the source through tsx.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNodeHub } from "../apps/worker/src/node/hub";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const codex = option("codex") ?? path.resolve(repoRoot, "..", "..", "..", "vendor", "codex", "codex-rs", "target", "debug", "codex.exe");
const home = mkdtempSync(path.join(tmpdir(), "crossline-node-standalone-"));
const TOKEN = "standalone-check-token-0123456789";
const started = Date.now();
const say = (step: string, detail: unknown = "") => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${step}`, typeof detail === "string" ? detail : JSON.stringify(detail));
let failed = false;
const check = (ok: boolean, what: string) => { if (!ok) failed = true; say(ok ? `ok: ${what}` : `FAILED: ${what}`); };

// The stand-in site: the pairing routes, and /node handed to a hub on its own port.
const hub = await createNodeHub({ port: 0, authenticate: (token) => token === TOKEN ? "ws" : undefined, allowed: () => true, roots: () => [],
  gateway: () => undefined, serverCodex: () => "", prepare: async () => {} });
let polls = 0;
const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://site");
  response.setHeader("content-type", "application/json");
  if (request.method === "POST" && url.pathname === "/api/node/pair") { response.end(JSON.stringify({ ok: true, id: "pair-id-0123456789abcdefghij", code: "ABCD-EFGH", expiresAt: "" })); return; }
  if (request.method === "GET" && url.pathname === "/api/node/pair") { polls += 1; response.end(JSON.stringify(polls < 2 ? { state: "pending" } : { state: "approved", token: TOKEN })); return; }
  response.statusCode = 404; response.end("{}");
});
site.on("upgrade", (request, socket, head) => {
  const upstream = connect(hub.port, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const main = option("main");
const launch = (): ChildProcess => spawn(main ? process.execPath : path.join(repoRoot, "node_modules", ".bin", "tsx.cmd"),
  [main ?? path.join(repoRoot, "apps", "worker", "src", "node", "standalone.ts"), "--site", siteUrl, "--autostart"],
  { env: { ...process.env, CROSSLINE_NODE_HOME: home, CROSSLINE_NODE_CODEX: codex, CROSSLINE_NODE_NO_BROWSER: "1" }, stdio: "ignore", shell: !main, windowsHide: true });
// (tsx.cmd needs a shell on Windows; every argument here is this script's own.)
const pageOf = () => { try { return (JSON.parse(readFileSync(path.join(home, "node.lock"), "utf8")) as { port: number }).port; } catch { return 0; } };
const view = async () => { const port = pageOf(); return port ? await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => undefined) : undefined; };
async function until<T>(read: () => Promise<T | undefined>, ms = 60_000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 500)); }
  return undefined;
}
const quit = async () => { const port = pageOf(); if (port) await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST", headers: { "x-crossline-node": "1" } }).catch(() => undefined); };

let child = launch();
try {
  const paired = await until(async () => { const v = await view(); return v?.paired ? v : undefined; });
  check(Boolean(paired), "paired by code with the stand-in site");
  say("page", { codex: paired?.codex, accountKnown: paired?.accountKnown, account: paired?.account });
  check(paired?.account === null && paired?.accountKnown === true, "a fresh Codex home reads as not signed in, so the relay waits");
  const port = pageOf();
  check((await fetch(`http://127.0.0.1:${port}/`)).headers.get("content-type")?.includes("text/html") === true, "the page is served");
  check((await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST" })).status === 404, "a POST without the page's header is refused");
  // fetch drops a Host header it is given; a raw request sends it as a rebinding page would.
  const rebound = await new Promise<number>((resolve) => httpRequest({ host: "127.0.0.1", port, path: "/status", headers: { host: "evil.example" } },
    (answer) => { answer.resume(); resolve(answer.statusCode ?? 0); }).on("error", () => resolve(0)).end());
  check(rebound === 421, "another host name is refused");
  const login = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", headers: { "x-crossline-node": "1" } }).then((r) => r.json() as Promise<{ authUrl?: string }>);
  check(/^https:\/\/auth\.openai\.com\//.test(login.authUrl ?? ""), `the ChatGPT sign-in starts (${(login.authUrl ?? "").slice(0, 40)}…)`);
  await quit();
  await until(async () => child.exitCode !== null ? true : undefined, 15_000);
  // Started again: the token comes back from Windows' data protection, no new code is asked for.
  const before = polls;
  child = launch();
  const again = await until(async () => { const v = await view(); return v && pageOf() ? v : undefined; });
  check(again?.paired === true && polls === before, "after a restart the kept token is read back and no new pairing is asked for");
  check(!readFileSync(path.join(home, "token.bin")).toString("latin1").includes(TOKEN), "the token on disk is not readable as text");
} catch (error) {
  failed = true;
  say("error", error instanceof Error ? error.message : String(error));
} finally {
  await quit();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  child.kill();
  await hub.close();
  site.close();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* a Codex process may still hold a file a moment */ }
}
say(failed ? "FAILED" : "all checks passed");
process.exit(failed ? 1 : 0);

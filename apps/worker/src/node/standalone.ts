import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startNodeAgent, type AppServerLines, type NodeAgentStatus } from "./agent";
import { TOKEN_GONE } from "./protocol";

/**
 * 「Crossline 节点」, the standalone compute node (docs/compute-node.md): what the installer ships beside `node.exe` and a release build of
 * Codex, bundled into one minified file by `scripts/package-node.ts`. It pairs with the person's account by a code typed on the hosted
 * 「这台电脑」 card, signs in to the person's own ChatGPT in its own Codex home, and then relays the account's model runs (agent.ts). It
 * keeps no ledger, plans nothing and holds no Crossline logic beyond the relay: the Skills come from the server when it connects.
 *
 * Its one window is a page on this computer (127.0.0.1) that says what is missing and has the buttons; the program itself runs hidden.
 */
const appDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const home = process.env.CROSSLINE_NODE_HOME ?? path.join(process.env.LOCALAPPDATA ?? appDir, "Crossline Node");
const codexExe = process.env.CROSSLINE_NODE_CODEX ?? path.join(appDir, "codex", process.platform === "win32" ? "codex.exe" : "codex");
const codexHome = path.join(home, "codex-home");
const stateFile = path.join(home, "node.json");
const tokenFile = path.join(home, "token.bin");
const lockFile = path.join(home, "node.lock");
const logFile = path.join(home, "logs", "node.log");
const PREFERRED_PORT = 47391;
mkdirSync(path.dirname(logFile), { recursive: true });
mkdirSync(codexHome, { recursive: true });

function log(event: Record<string, unknown>): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > 5 * 1_048_576) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch { /* a log that cannot be written is no reason to stop */ }
}

type State = { site: string; paired?: { at: string; host: string } };
const readState = (): State => { try { return JSON.parse(readFileSync(stateFile, "utf8")) as State; } catch { return { site: "https://app.crossline.lol" }; } };
const writeState = (state: State) => writeFileSync(stateFile, JSON.stringify(state, null, 2));
let state = readState();
if (option("site")) { state = { ...state, site: new URL(option("site")!).origin }; writeState(state); }

// ── The token, kept with Windows' own data protection (only this Windows user can read it) ─────────────────────────────────────────
const DPAPI = (verb: "Protect" | "Unprotect") => `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd());`
  + `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($b,$null,'CurrentUser')))`;
function dpapi(verb: "Protect" | "Unprotect", data: Buffer): Buffer {
  if (process.platform !== "win32") return data;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI(verb)], { input: data.toString("base64"), encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`DPAPI_${verb.toUpperCase()}_FAILED`);
  return Buffer.from(result.stdout.trim(), "base64");
}
/** Read once at start and kept in memory: unprotecting starts PowerShell, and the page asks for the state every few seconds. */
let token: string | undefined = (() => { try { return dpapi("Unprotect", readFileSync(tokenFile)).toString("utf8") || undefined; } catch { return undefined; } })();
const readToken = () => token;
const saveToken = (value: string) => { writeFileSync(tokenFile, dpapi("Protect", Buffer.from(value, "utf8")), { mode: 0o600 }); token = value; };
const forgetToken = () => { rmSync(tokenFile, { force: true }); token = undefined; };

// ── Codex, in this program's own home ───────────────────────────────────────────────────────────────────────────────────────────
function appServer(): AppServerLines {
  const child = spawn(codexExe, ["app-server", "--listen", "stdio://", "--strict-config"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const exits = new Set<() => void>();
  let ended = false;
  const finish = () => { if (ended) return; ended = true; for (const handler of exits) handler(); };
  child.once("error", finish);
  child.once("exit", finish);
  return {
    write: (line) => { if (!ended) child.stdin.write(line.endsWith("\n") ? line : `${line}\n`); },
    onLine: (handler) => { lines.on("line", handler); },
    onExit: (handler) => { exits.add(handler); },
    stop: () => { lines.close(); child.kill(); }
  };
}
const codexVersion = (() => {
  const result = spawnSync(codexExe, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
})();

/** A short-lived runtime for reading and starting the ChatGPT sign-in (the relay's runtime starts only once signed in and paired). */
async function control<T>(work: (request: (method: string, params: unknown) => Promise<Record<string, unknown>>, notified: (method: string) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const runtime = appServer();
  let next = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const waiting = new Map<string, (params: Record<string, unknown>) => void>();
  runtime.onLine((line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "number" && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
    if (typeof message.method === "string" && message.id === undefined) waiting.get(message.method)?.((message.params ?? {}) as Record<string, unknown>);
  });
  const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve((message.result ?? {}) as Record<string, unknown>));
    runtime.write(JSON.stringify({ id, method, params }));
  });
  const notified = (method: string) => new Promise<Record<string, unknown>>((resolve) => waiting.set(method, resolve));
  try {
    await request("initialize", { clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    runtime.write(JSON.stringify({ method: "initialized" }));
    return await work(request, notified);
  } finally { runtime.stop(); }
}

let account: { email?: string; type?: string } | null | undefined;
let login: { state: "pending" | "failed"; authUrl?: string; message?: string } | undefined;
async function readAccount(): Promise<void> {
  account = await control(async (request) => (await request("account/read", { refreshToken: false })).account as typeof account ?? null)
    .catch((error: unknown) => { log({ type: "node.account_read_failed", message: error instanceof Error ? error.message : String(error) }); return account ?? null; });
}
function startLogin(): Promise<string | undefined> {
  return new Promise((resolveUrl) => {
    login = { state: "pending" };
    void control(async (request, notified) => {
      const done = notified("account/login/completed");
      const started = await request("account/login/start", { type: "chatgpt", appBrand: "codex", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true });
      const authUrl = typeof started.authUrl === "string" ? started.authUrl : undefined;
      login = { state: "pending", ...(authUrl ? { authUrl } : {}) };
      resolveUrl(authUrl);
      if (authUrl) openInBrowser(authUrl);
      const finished = await Promise.race([done, new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ success: false, error: "timeout" }), 15 * 60_000))]);
      if (finished.success !== true) throw new Error(String(finished.error ?? "登录没有完成"));
    }).then(async () => { login = undefined; await readAccount(); log({ type: "node.signed_in" }); reconcile(); })
      .catch((error: unknown) => { login = { state: "failed", message: error instanceof Error ? error.message.slice(0, 120) : "登录没有完成" }; resolveUrl(undefined); });
  });
}

function openInBrowser(url: string): void {
  // CROSSLINE_NODE_NO_BROWSER: the smoke check (scripts/node-standalone-check.ts) runs it without opening windows.
  if (!/^https?:\/\//.test(url) || process.env.CROSSLINE_NODE_NO_BROWSER === "1") return;
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

// ── Pairing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let pairing: { code: string; expiresAt: string } | undefined;
let pairingError: string | undefined;
let pairingLoop = false;
async function pair(): Promise<void> {
  if (pairingLoop) return;
  pairingLoop = true;
  try {
    while (!readToken()) {
      const started = await fetch(new URL("/api/node/pair", state.site), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: hostname() }), signal: AbortSignal.timeout(20_000) }).then((response) => response.json() as Promise<{ ok?: boolean; id?: string; code?: string; expiresAt?: string }>)
        .catch(() => undefined);
      if (!started?.ok || !started.id || !started.code) { pairingError = "连不上网页版，稍后自动重试"; pairing = undefined; await sleep(30_000); continue; }
      pairingError = undefined;
      pairing = { code: started.code, expiresAt: started.expiresAt ?? "" };
      log({ type: "node.pair_code" });
      for (;;) {
        await sleep(3_000);
        const answer = await fetch(new URL(`/api/node/pair?id=${encodeURIComponent(started.id)}`, state.site), { signal: AbortSignal.timeout(20_000) })
          .then((response) => response.json() as Promise<{ state?: string; token?: string }>).catch(() => undefined);
        if (answer?.state === "approved" && answer.token) {
          saveToken(answer.token);
          state = { ...state, paired: { at: new Date().toISOString(), host: hostname() } };
          writeState(state);
          pairing = undefined;
          log({ type: "node.paired" });
          break;
        }
        if (answer?.state === "expired") break;
      }
    }
  } finally { pairingLoop = false; }
  reconcile();
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The relay, once paired and signed in ──────────────────────────────────────────────────────────────────────────────────────
let agent: { stop: () => void; status: () => NodeAgentStatus } | undefined;
function reconcile(): void {
  const current = readToken();
  if (!current) { agent?.stop(); agent = undefined; void pair(); return; }
  if (!account) return;
  if (!agent) {
    agent = startNodeAgent({ url: state.site, token: current, dir: path.join(home, "relay"), spawn: appServer, host: hostname(),
      log: (event) => log(event) });
    log({ type: "node.relay_started" });
  }
}
// A token the site no longer accepts (解除配对 there) sends the program back to pairing.
setInterval(() => {
  const status = agent?.status();
  if (status?.state === "refused" && TOKEN_GONE.has(status.code ?? "")) {
    log({ type: "node.token_revoked" });
    agent?.stop(); agent = undefined;
    forgetToken();
    state = { site: state.site }; writeState(state);
    reconcile();
  }
}, 10_000).unref();

// ── The page ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function view() {
  return { site: state.site, host: hostname(), codex: codexVersion, paired: Boolean(readToken()), pairedAt: state.paired?.at ?? null,
    code: pairing?.code ?? null, codeExpires: pairing?.expiresAt ?? null, pairingError: pairingError ?? null,
    account: account ? { email: account.email ?? "", type: account.type ?? "" } : null, accountKnown: account !== undefined,
    login: login ?? null, node: agent?.status() ?? null };
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crossline 节点</title><style>
:root{color-scheme:light dark;--ink:#1c1b19;--muted:#55524d;--paper:#fbfaf7;--line:#d9d5cc;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--ink:#ecebe7;--muted:#b8b4ab;--paper:#171614;--line:#3a3833;--accent:#7fb8a6}}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 Arial,"Microsoft YaHei",sans-serif}
main{max-width:560px;margin:32px auto;padding:0 16px}h1{font-size:20px;margin:0 0 4px}p{margin:4px 0}small,.muted{color:var(--muted);font-size:13px}
section{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0}h2{font-size:15px;margin:0 0 6px}
.code{font:600 32px/1.2 Consolas,monospace;letter-spacing:4px;margin:8px 0}.ok{color:var(--accent);font-weight:600}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--paper)}</style></head><body><main>
<h1>Crossline 节点</h1><p class="muted">这台电脑用本人自己的 ChatGPT，替网页版跑本账号的模型工作。账本和计划都在网页版，这里不保存。</p>
<section><h2>1. 配对</h2><div id="pair"></div></section>
<section><h2>2. 登录 ChatGPT</h2><div id="login"></div></section>
<section><h2>3. 运行状态</h2><div id="node"></div></section>
<p><small id="meta"></small></p><p><button id="quit">退出节点</button></p></main>
<script>
const post=(p)=>fetch(p,{method:"POST",headers:{"x-crossline-node":"1"}}).then(r=>r.json());
const esc=(t)=>String(t??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const $=(id)=>document.getElementById(id);
const words={ready:"已接入：网页版把本账号的模型工作交给这台电脑",connecting:"正在连接网页版",waiting:"连接断开，稍后自动重连",refused:"网页版没有接受",off:"未运行"};
async function load(){const v=await fetch("/status",{cache:"no-store"}).then(r=>r.json()).catch(()=>null);if(!v)return;
$("pair").innerHTML=v.paired?'<p class="ok">已配对</p><p class="muted">在网页版「这台电脑」可以解除。</p><button id="unpair">在这台电脑上解除配对</button>'
:v.code?'<p>在网页版 设置 → 通用 →「这台电脑」的「独立节点」填入：</p><div class="code">'+esc(v.code)+'</div><p class="muted">十分钟内有效，过期自动换新。</p>'
:'<p class="muted">'+esc(v.pairingError||"正在向网页版要配对码……")+'</p>';
$("login").innerHTML=v.account?'<p class="ok">已登录 '+esc(v.account.email)+'</p>':!v.accountKnown?'<p class="muted">正在读取……</p>'
:v.login&&v.login.state==="pending"?'<p>浏览器已打开 ChatGPT 登录页，登录后这里自动更新。</p>'+((v.login.authUrl||"").startsWith("https://")?'<p><a href="'+esc(v.login.authUrl)+'" target="_blank" rel="noreferrer">没打开就点这里</a></p>':'')
:'<p>用本人的 ChatGPT 账号登录，模型工作花的是这个账号的额度。</p>'+(v.login&&v.login.message?'<p class="muted">上次没有完成：'+esc(v.login.message)+'</p>':'')+'<button class="primary" id="signin">登录 ChatGPT</button>';
const n=v.node;$("node").innerHTML=!v.paired||!v.account?'<p class="muted">配对并登录后自动开始。</p>':'<p>'+(n?words[n.state]||n.state:"正在启动")+(n&&n.message?"（"+esc(n.message)+"）":"")+'</p><p class="muted">电脑关机或断网时，模型工作自动回到服务器。</p>';
$("meta").textContent=v.host+" · "+(v.codex||"Codex 未找到")+" · "+v.site;
const s=$("signin");if(s)s.onclick=()=>post("/login").then(load);const u=$("unpair");if(u)u.onclick=()=>post("/unpair").then(load);}
$("quit").onclick=()=>post("/quit").then(()=>{document.body.innerHTML='<main><p>节点已退出。从开始菜单的「Crossline 节点」可以再次启动。</p></main>'});
load();setInterval(load,3000);</script></body></html>`;

let port = 0;
const server = createServer((request, response) => void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end(); }));
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Only this computer's own browser at this exact address: another site cannot drive it, and a rebinding host name is refused.
  if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(421).end(); return; }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
  if (request.method === "GET" && url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(PAGE); return; }
  if (request.method === "GET" && url.pathname === "/status") { json(200, view()); return; }
  if (request.method !== "POST" || request.headers["x-crossline-node"] !== "1") { json(404, {}); return; }
  if (url.pathname === "/login") { json(200, { authUrl: await startLogin() ?? null }); return; }
  if (url.pathname === "/refresh") { await readAccount(); reconcile(); json(200, view()); return; }
  if (url.pathname === "/unpair") {
    agent?.stop(); agent = undefined; forgetToken(); state = { site: state.site }; writeState(state); reconcile();
    json(200, view()); return;
  }
  if (url.pathname === "/quit") { json(200, {}); shutdown(); return; }
  json(404, {});
}

function shutdown(): void {
  agent?.stop();
  try { if ((JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number }).pid === process.pid) rmSync(lockFile, { force: true }); } catch { /* gone */ }
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// One copy at a time: a second start (the shortcut clicked again) only opens the running copy's page.
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
try {
  const held = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number; port?: number };
  if (held.pid && held.pid !== process.pid && alive(held.pid)) {
    if (!flag("autostart") && held.port) openInBrowser(`http://127.0.0.1:${held.port}/`);
    process.exit(0);
  }
} catch { /* no lock: this is the one */ }

await new Promise<void>((resolve) => {
  server.once("error", () => { server.listen(0, "127.0.0.1", resolve); });
  server.listen(PREFERRED_PORT, "127.0.0.1", resolve);
});
port = (server.address() as { port: number }).port;
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port }));
log({ type: "node.started", port, codex: codexVersion, site: state.site });

await readAccount();
reconcile();
// Started by the person (not at sign-in), or with something still to do: the page opens.
if (!flag("autostart") || !readToken() || !account) openInBrowser(`http://127.0.0.1:${port}/`);

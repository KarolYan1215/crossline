// pnpm exec tsx scripts/installer-coexist-check.ts <repo>\dist\installer\stage <empty temporary folder>
//
// WP2/WP3 on this machine: the packaged app (dist/installer/stage), run by its own launcher under a temporary root, beside the
// resident app on 3210/3211. Proves: it starts on its own ports and folders, it signs in only through Codex and only on loopback,
// and the resident app answers the same before, during and after, with its Codex home untouched.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const stage = process.argv[2]!;
const root = process.argv[3]!;
const residentHome = path.join(process.env.LOCALAPPDATA!, "Crossline", "codex-home");
const results: Array<[string, boolean, unknown]> = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers, timeout: 15_000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
    if (options.body) req.write(options.body);
    req.end();
  });
}
const resident = async () => {
  const web = await request("http://127.0.0.1:3210/api/health");
  const sup = await request("http://127.0.0.1:3211/v1/codex/status");
  let boot: unknown; try { boot = (JSON.parse(sup.body) as { supervisorBootId?: string }).supervisorBootId; } catch { /* none */ }
  const auth = path.join(residentHome, "auth.json");
  return { web: web.status, supervisor: sup.status, boot, authMtime: existsSync(auth) ? statSync(auth).mtimeMs : null };
};

const before = await resident();
check("resident app answers before", before.web === 200 && before.supervisor === 200, before);

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const env = { ...process.env, CROSSLINE_LAUNCHER_ROOT: root };
const child = spawn(path.join(stage, "node.exe"), ["--import", "tsx", path.join(stage, "apps", "launcher", "src", "main.ts"), `--app=${stage}`],
  { cwd: path.join(stage, "apps", "launcher"), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const events: Array<Record<string, unknown>> = [];
const ready = new Promise<Record<string, unknown> | undefined>((resolve) => {
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { const event = JSON.parse(line) as Record<string, unknown>; events.push(event); if (event.type === "ready" || event.type === "error") resolve(event); } catch { /* not ours */ }
  });
  child.once("exit", () => resolve(undefined));
  setTimeout(() => resolve(undefined), 6 * 60_000);
});
const started = Date.now();
const outcome = await ready;
check("installed copy reports ready", outcome?.type === "ready", { outcome, seconds: Math.round((Date.now() - started) / 1000), stderr: stderr.slice(-500) });
const config = JSON.parse(readFileSync(path.join(root, "launcher.json"), "utf8")) as { webPort: number; supervisorPort: number; installId: string };
check("its own two ports, not the resident's", ![3210, 3211].includes(config.webPort) && ![3210, 3211].includes(config.supervisorPort)
  && config.webPort !== config.supervisorPort, config);
const url = `http://127.0.0.1:${config.webPort}`;

if (outcome?.type === "ready") {
  check("installed web health", (await request(`${url}/api/health`)).status === 200);
  let codex: { state?: string; contract?: { relationStatus?: string } } = {};
  for (let waited = 0; waited < 180 && codex.state !== "ready"; waited += 3) {
    const status = await request(`http://127.0.0.1:${config.supervisorPort}/v1/codex/status`);
    try { codex = JSON.parse(status.body); } catch { /* not up yet */ }
    if (codex.state !== "ready") await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  check("installed Codex runtime ready and verified", codex.state === "ready" && codex.contract?.relationStatus === "verified", codex.state);
  const login = await request(`${url}/login`);
  check("login page offers only the Codex sign-in", login.status === 200 && login.body.includes("登录 Crossline") && !/type="password"/.test(login.body), login.status);
  const page = await request(`${url}/`);
  check("pages redirect to sign-in without a session", [302, 303, 307, 308].includes(page.status) || page.body.includes("登录"), page.status);
  const session = (headers: Record<string, string>) => request(`${url}/api/auth/codex-local/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  const direct = await session({ host: `127.0.0.1:${config.webPort}`, origin: url });
  check("direct loopback with Codex signed out: refused as not signed in", direct.status === 409 && direct.body.includes("CODEX_NOT_SIGNED_IN"), direct);
  const rebound = await session({ host: `evil.example:${config.webPort}`, origin: "http://evil.example" });
  check("another host name (DNS rebinding) is refused", rebound.status === 403, rebound.status);
  const proxied = await session({ host: `127.0.0.1:${config.webPort}`, "x-forwarded-for": "10.0.0.5" });
  check("a forwarded request is refused", proxied.status === 403, proxied.status);
  const foreign = await session({ host: `127.0.0.1:${config.webPort}`, origin: "https://evil.example" });
  check("a cross-site origin is refused", foreign.status === 403, foreign.status);
  const startLogin = await request(`${url}/api/local-auth/login`, { method: "POST", headers: { host: `evil.example:${config.webPort}` } });
  check("starting the Codex login from another host is refused", startLogin.status === 403, startLogin.status);
  const begin = await request(`${url}/api/local-auth/login`, { method: "POST", headers: { host: `127.0.0.1:${config.webPort}`, origin: url } });
  let authUrl = ""; try { authUrl = String((JSON.parse(begin.body) as { authUrl?: string }).authUrl ?? ""); } catch { /* none */ }
  check("the Codex ChatGPT sign-in starts on loopback and points at OpenAI", begin.status === 200 && new URL(authUrl || "http://x").hostname === "auth.openai.com", authUrl.slice(0, 60));
  const cancel = await request(`${url}/api/local-auth/login`, { method: "DELETE", headers: { host: `127.0.0.1:${config.webPort}`, origin: url } });
  check("a started sign-in can be cancelled", cancel.status === 200, cancel.status);
  const during = await resident();
  check("resident app unchanged while both run", during.web === 200 && during.supervisor === 200 && during.boot === before.boot && during.authMtime === before.authMtime, during);
}
check("installed Codex home in its own state folder", existsSync(path.join(root, "state", "codex-home", "config.toml")));
check("installed ledger in its own data folder", existsSync(path.join(root, "data", "crossline.db")));

child.stdin.write("quit\n");
const exited = await new Promise<boolean>((resolve) => { child.once("exit", () => resolve(true)); setTimeout(() => resolve(false), 30_000); });
check("launcher quits on command", exited);
await new Promise((resolve) => setTimeout(resolve, 3000));
check("installed ports released", (await request(`${url}/api/health`)).status === 0);
const after = await resident();
check("resident app unchanged after", after.web === 200 && after.supervisor === 200 && after.boot === before.boot && after.authMtime === before.authMtime, after);
// The launcher made workspace junctions inside the stage; remove the links (never their targets) so the stage packs as built.
const links = path.join(stage, "node_modules", "@crossline");
if (existsSync(links)) {
  for (const name of readdirSync(links)) if (lstatSync(path.join(links, name)).isSymbolicLink()) rmdirSync(path.join(links, name));
  rmdirSync(links);
}
console.log(JSON.stringify({ passed: results.filter((r) => r[1]).length, failed: results.filter((r) => !r[1]).map((r) => r[0]) }));
process.exit(results.every((r) => r[1]) ? 0 : 1);

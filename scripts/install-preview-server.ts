import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The installed copy's sign-in and interview, for walking their look (docs/onboarding-v3.md): `next dev` in local-install mode on
 * `localhost:3330` against a throwaway data directory, with a stand-in for the Codex supervisor whose account state is set by
 * `PREVIEW_CODEX` — `signed-out` (the default: the sign-in page stays on its first step), `starting` (Codex not answering yet) or
 * `signed-in` (the page signs straight in). No model ever runs; nothing here reaches the real ledger, the resident app or the
 * installed copy.
 *
 *   pnpm exec tsx scripts/install-preview-server.ts
 *
 * `localhost`, never 127.0.0.1: cookies are not kept apart by port, and the resident app and the installed copy both live on 127.0.0.1.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
const dataDir = path.join(tmpdir(), "crossline-install-preview");
if (process.env.PREVIEW_RESET === "1") rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const mode = process.env.PREVIEW_CODEX ?? "signed-out";
const SUPERVISOR_PORT = 3331;

const supervisor = createServer((request, response) => {
  const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (mode === "starting") { send(503, { blocker: { code: "CODEX_RUNTIME_STARTING", message: "starting" } }); return; }
  const route = `${request.method} ${request.url?.split("?")[0]}`;
  if (route === "GET /v1/codex/account") send(200, mode === "signed-in"
    ? { account: { type: "chatgpt", email: "preview@example.com", planType: "plus" }, requiresOpenaiAuth: true }
    : { account: null, requiresOpenaiAuth: true });
  else if (route === "POST /v1/codex/login") send(200, { loginId: "preview", authUrl: "https://auth.openai.com/oauth/authorize?preview=1" });
  else if (route === "POST /v1/codex/login/cancel") send(200, {});
  else if (route === "GET /v1/codex/status") send(200, { state: "ready", supervisorBootId: "install-preview" });
  else send(503, { blocker: { code: "PREVIEW_NO_MODEL", message: "预览环境不运行模型" } });
}).listen(SUPERVISOR_PORT, "127.0.0.1");

const child = spawn(process.execPath, [path.join(webRoot, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "localhost", "--port", "3330"], {
  cwd: webRoot, stdio: "inherit",
  env: { ...process.env, CROSSLINE_INSTALL_MODE: "local", CROSSLINE_DATA_DIR: dataDir, CROSSLINE_NEXT_DIR: ".next-install-preview",
    BETTER_AUTH_SECRET: "install-preview-secret-not-for-production", CROSSLINE_WEB_BASE_URL: "http://localhost:3330",
    CROSSLINE_DEPLOYMENT_MODE: "local", CROSSLINE_TAILSCALE_HOSTNAME: "", CROSSLINE_AUTO_PUBLISH: "off", CROSSLINE_BACKGROUND_SOLVE: "off",
    CROSSLINE_CODEX_SUPERVISOR_URL: `http://127.0.0.1:${SUPERVISOR_PORT}`, CROSSLINE_SUPERVISOR_CAPABILITY_SECRET: "install-preview-capability" }
});
child.on("exit", (code) => { supervisor.close(); process.exit(code ?? 0); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));

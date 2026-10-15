import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrosslineStore } from "../packages/db/src/index";
import { extractText } from "../apps/worker/src/extract";
import { addFolder, previewFolder, removeFolder, setFolderLines, syncFolders } from "../apps/worker/src/source-folders";

/**
 * The installed copy's sign-in and interview, for walking their look (docs/onboarding-v3.md): `next dev` in local-install mode on
 * `localhost:3330` against a throwaway data directory, with a stand-in for the Codex supervisor whose account state is set by
 * `PREVIEW_CODEX` — `signed-out` (the default: the sign-in page stays on its first step), `starting` (Codex not answering yet) or
 * `signed-in` (the page signs straight in). No model ever runs; nothing here reaches the real ledger, the resident app or the
 * installed copy.
 *
 *   pnpm exec tsx scripts/install-preview-server.ts [signed-out | starting | signed-in] [reset]
 *
 * `localhost`, never 127.0.0.1: cookies are not kept apart by port, and the resident app and the installed copy both live on 127.0.0.1.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
const dataDir = path.join(tmpdir(), "crossline-install-preview");
if (process.env.PREVIEW_RESET === "1" || process.argv.includes("reset")) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const mode = process.env.PREVIEW_CODEX ?? process.argv.slice(2).find((arg) => ["signed-out", "starting", "signed-in"].includes(arg)) ?? "signed-out";
const SUPERVISOR_PORT = 3331;

// Authorized folders run for real here (they need no model): the same worker functions, against the preview's own ledger and its one
// workspace, with the worker's own text extraction.
let previewStore: CrosslineStore | undefined;
const storeOf = () => (previewStore ??= new CrosslineStore(path.join(dataDir, "crossline.db")));
const workspaceOf = () => storeOf().listWorkspaces()[0]?.id ?? "";
const folderDeps = { dataDir, home: homedir(), extract: async (workspaceId: string, documentId: string) => {
  const doc = storeOf().listSourceDocuments(workspaceId).find((item) => item.id === documentId);
  if (!doc) return;
  const result = await extractText(new Uint8Array(readFileSync(fileURLToPath(doc.uri))), doc.kind);
  storeOf().setSourceDocumentExtraction(workspaceId, doc.id, { status: result.status, text: result.text, ...(result.note ? { note: result.note } : {}) });
} };
const bodyOf = (request: IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
});
async function folders(route: string, request: IncomingMessage): Promise<unknown | undefined> {
  const workspaceId = workspaceOf();
  const one = /^(POST|DELETE) \/v1\/sources\/folders\/([A-Za-z0-9-]+)(\/lines)?$/.exec(route);
  if (route === "POST /v1/sources/folders/preview") return previewFolder(String((await bodyOf(request)).path ?? ""), folderDeps);
  if (route === "POST /v1/sources/folders") {
    const added = await addFolder(storeOf(), workspaceId, String((await bodyOf(request)).path ?? ""), folderDeps);
    if (added.state === "added") void syncFolders(storeOf(), workspaceId, folderDeps);
    return added;
  }
  if (one?.[1] === "DELETE") return { removed: removeFolder(storeOf(), workspaceId, one[2]!) };
  if (one?.[3]) return { saved: setFolderLines(storeOf(), workspaceId, one[2]!, ((await bodyOf(request)).lines as string[]) ?? []) };
  return undefined;
}

const supervisor = createServer(async (request, response) => {
  const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (mode === "starting") { send(503, { blocker: { code: "CODEX_RUNTIME_STARTING", message: "starting" } }); return; }
  const route = `${request.method} ${request.url?.split("?")[0]}`;
  if (route === "GET /v1/codex/account") send(200, mode === "signed-in"
    ? { account: { type: "chatgpt", email: "preview@example.com", planType: "plus" }, requiresOpenaiAuth: true }
    : { account: null, requiresOpenaiAuth: true });
  else if (route === "POST /v1/codex/login") send(200, { loginId: "preview", authUrl: "https://auth.openai.com/oauth/authorize?preview=1" });
  else if (route === "POST /v1/codex/login/cancel") send(200, {});
  else if (route === "GET /v1/codex/status") send(200, { state: "ready", supervisorBootId: "install-preview" });
  else if (route.includes("/v1/sources/folders")) { try { send(200, (await folders(route, request)) ?? { blocker: { code: "PREVIEW_UNKNOWN" } }); } catch { send(502, {}); } }
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

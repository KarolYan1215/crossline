import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A second, complete Crossline — web, worker and its own Codex supervisor — for walking the app as a beta invitee would (2026-10-15).
 * Nothing it runs touches the resident app: its own data folder, its own build directory (`apps/web/.next-beta`), web on 3350, the
 * supervisor on 3351, its own secrets, and `CROSSLINE_STATE_DIR` inside its data folder, so the owner runtime's Codex home and every guest
 * runtime live there too and never beside `%LOCALAPPDATA%\Crossline`. No example board, no Graph, Google, ChatGPT sign-in or SMTP: mail
 * goes to a test mailbox folder (`<data>\mailbox`). Open it at **localhost:3350**, never 127.0.0.1 (cookies do not keep ports apart).
 *
 *   pnpm exec tsx scripts/beta-instance.ts build    # next build into .next-beta
 *   pnpm exec tsx scripts/beta-instance.ts          # web + worker, kept running
 *   … web | worker                                   # one of them, so the web can be rebuilt and restarted while a model run goes on
 *   BETA_RESET=1 …                                   # start from an empty data folder
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
export const BETA_DATA_DIR = process.env.BETA_DATA_DIR ?? path.join(tmpdir(), "crossline-beta");
const WEB_PORT = 3350, SUPERVISOR_PORT = 3351;

if (process.env.BETA_RESET === "1") rmSync(BETA_DATA_DIR, { recursive: true, force: true });
mkdirSync(BETA_DATA_DIR, { recursive: true });

// Made once and kept, so a restart keeps sessions and the capability tokens the web signs still verify.
const secretsFile = path.join(BETA_DATA_DIR, "beta-secrets.json");
const secrets = existsSync(secretsFile)
  ? JSON.parse(readFileSync(secretsFile, "utf8")) as { auth: string; capability: string }
  : { auth: randomBytes(32).toString("hex"), capability: randomBytes(32).toString("hex") };
writeFileSync(secretsFile, JSON.stringify(secrets));

const base = `http://localhost:${WEB_PORT}`;
// Every key the resident app's `apps/web/.env` and the root `.env.local` set is named here: Next and the worker only fill in what the
// environment leaves undefined, so a key left out would quietly bring the real data folder, Google, SMTP or Graph into this copy.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CROSSLINE_DATA_DIR: BETA_DATA_DIR,
  CROSSLINE_STATE_DIR: path.join(BETA_DATA_DIR, "state"),
  CROSSLINE_AI_OUTPUT_DIR: path.join(BETA_DATA_DIR, "ai-output"),
  CROSSLINE_NEXT_DIR: ".next-beta",
  CROSSLINE_WEB_BASE_URL: base,
  CROSSLINE_WEB_HEALTH_URL: `http://127.0.0.1:${WEB_PORT}/api/health`,
  CROSSLINE_CODEX_SUPERVISOR_URL: `http://127.0.0.1:${SUPERVISOR_PORT}`,
  CROSSLINE_CODEX_SUPERVISOR_PORT: String(SUPERVISOR_PORT),
  CROSSLINE_SUPERVISOR_CAPABILITY_SECRET: secrets.capability,
  BETTER_AUTH_SECRET: secrets.auth,
  CROSSLINE_DEPLOYMENT_MODE: "local",
  CROSSLINE_TAILSCALE_HOSTNAME: "",
  CROSSLINE_AUTH_TEST_MAILBOX_DIR: path.join(BETA_DATA_DIR, "mailbox"),
  CROSSLINE_AUTO_PUBLISH: "off",
  CROSSLINE_SYNC_INTERVAL_MINUTES: "15",
  CROSSLINE_GOOGLE_CLIENT_ID: "", CROSSLINE_GOOGLE_CLIENT_SECRET: "", CROSSLINE_CHATGPT_SIGNIN: "",
  CROSSLINE_SMTP_HOST: "", CROSSLINE_SMTP_PORT: "", CROSSLINE_SMTP_USER: "", CROSSLINE_SMTP_PASSWORD: "", CROSSLINE_SMTP_FROM: "",
  CROSSLINE_MS_CLIENT_ID: "", CROSSLINE_MS_TENANT_ID: "", CROSSLINE_CONTENT_OPS_URL: "", CROSSLINE_CONTENT_OPS_TOKEN: "",
  CROSSLINE_MODEL_ROUTINE: "", CROSSLINE_MODEL_CAPABLE: "", CROSSLINE_TELEMETRY_URL: "",
  // The public quick test's result carried in (apps/web/lib/assess-link.ts): the local test server on 3340, with a secret it is given too.
  ASSESS_BASE_URL: process.env.ASSESS_BASE_URL ?? "http://127.0.0.1:3340", ASSESS_LINK_SECRET: process.env.ASSESS_LINK_SECRET ?? "beta-walkthrough-assess-link"
};
delete env.CROSSLINE_SEED_EXAMPLES;
delete env.CROSSLINE_INSTALL_MODE;

const next = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (process.argv[2] === "build") {
  const build = spawn(process.execPath, [next, "build", "--webpack"], { cwd: webRoot, stdio: "inherit", env });
  build.on("exit", (code) => process.exit(code ?? 0));
} else {
  if (process.argv[2] !== "worker" && !existsSync(path.join(webRoot, ".next-beta", "BUILD_ID"))) throw new Error("Build missing: run `pnpm exec tsx scripts/beta-instance.ts build` first.");
  const logDir = path.join(BETA_DATA_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const only = process.argv[2];
  const children: ChildProcess[] = [
    ...(only === "worker" ? [] : [spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)], { cwd: webRoot, stdio: "inherit", env })]),
    ...(only === "web" ? [] : [spawn(process.execPath, [tsx, "src/index.ts"], { cwd: path.join(repoRoot, "apps", "worker"), stdio: "inherit", env })])
  ];
  console.info(JSON.stringify({ beta: base, data: BETA_DATA_DIR, mailbox: env.CROSSLINE_AUTH_TEST_MAILBOX_DIR }));
  for (const child of children) child.on("exit", (code) => { for (const other of children) other.kill(); process.exit(code ?? 0); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { for (const child of children) child.kill(signal); });
}

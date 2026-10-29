import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { ensureSecrets, layoutFor, prepareConfig, readRelease } from "./config";
import { ensureWorkspaceLinks } from "./links";
import { childSpecs, Supervisor, waitForHealth } from "./supervise";
import { backupData, checkForUpdate, downloadInstaller, type UpdateManifest } from "./update";

/**
 * The installed app's supervisor (docs/local-installer.md). `Crossline.exe` (the tray, `installer/tray`) starts this on the bundled
 * node.exe and talks to it in lines: it writes commands to stdin (`open`, `check-update`, `install-update`, `quit`) and reads one JSON
 * event per line from stdout (`ready`, `open`, `update-available`, …). The tray closing stdin — including the tray being killed —
 * stops everything, so no web or worker is ever left running without a tray to quit it. Run by hand with `--open` it opens the
 * browser itself.
 */
const args = process.argv.slice(2);
const appDir = path.resolve(args.find((arg) => arg.startsWith("--app="))?.slice(6) ?? path.resolve(import.meta.dirname, "../../.."));
const openSelf = args.includes("--open");

const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

const layout = layoutFor(appDir);
ensureWorkspaceLinks(appDir);
const release = readRelease(appDir);
const { config, firstRun, upgradedFrom } = await prepareConfig(layout, release);
const secrets = ensureSecrets(layout.secrets);
const url = `http://127.0.0.1:${config.webPort}`;

const supervisor = new Supervisor(childSpecs(layout, config, secrets, release), layout.logs, (event) => emit(event));
supervisor.start();
emit({ type: "starting", url, firstRun, version: release.version, ...(upgradedFrom ? { upgradedFrom } : {}) });

function openBrowser(): void {
  if (openSelf) spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  emit({ type: "open", url });
}

let quitting = false;
async function quit(code = 0): Promise<void> {
  if (quitting) return;
  quitting = true;
  emit({ type: "stopping" });
  await supervisor.stop();
  process.exit(code);
}

const ready = waitForHealth(`${url}/api/health`).then((healthy) => {
  emit(healthy ? { type: "ready", url } : { type: "error", code: "WEB_NOT_HEALTHY", logs: layout.logs });
  if (healthy && (firstRun || openSelf || upgradedFrom)) openBrowser();
  return healthy;
});

// Updates (update.ts): checked a minute after start and every six hours; the tray asks for the install only on the person's word.
let offered: UpdateManifest | undefined;
let updating = false;
// The full installed copy is no longer published (2026-10-28): its feed's last, signed word is said once per start, never acted on.
let toldDiscontinued = false;
async function check(asked: boolean): Promise<void> {
  if (!release.updateFeed) { if (asked) emit({ type: "update-failed", code: "UPDATE_FEED_NOT_CONFIGURED" }); return; }
  try {
    const found = await checkForUpdate(release.updateFeed, release.version, { product: "crossline" });
    offered = found.kind === "update" ? found.manifest : undefined;
    if (found.kind === "update") emit({ type: "update-available", version: found.manifest.version });
    else if (found.kind === "discontinued") {
      if (asked || !toldDiscontinued) emit({ type: "update-discontinued", notice: found.notice, ...(found.link ? { link: found.link } : {}) });
      toldDiscontinued = true;
    } else if (asked) emit({ type: "update-none" });
  } catch (error) { if (asked) emit({ type: "update-failed", code: error instanceof Error ? error.message : "UPDATE_FAILED" }); }
}
async function installUpdate(): Promise<void> {
  if (updating) return;
  if (!offered) { await check(true); if (!offered) return; }
  updating = true;
  try {
    const installer = await downloadInstaller(offered, layout.root);
    // Nothing may be writing the ledger while it is copied, and the installer replaces files the running app holds open.
    await supervisor.stop();
    const backup = backupData(layout, release.version);
    emit({ type: "update-ready", path: installer, version: offered.version, backup });
  } catch (error) {
    updating = false;
    emit({ type: "update-failed", code: error instanceof Error ? error.message : "UPDATE_FAILED" });
  }
}
setTimeout(() => void check(false), 60_000).unref();
setInterval(() => void check(false), 6 * 3600_000).unref();

const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const command = line.trim();
  if (command === "open") void ready.then(() => openBrowser());
  else if (command === "check-update") void check(true);
  else if (command === "install-update") void installUpdate();
  else if (command === "quit") void quit();
});
// The tray went away (closed or killed): nothing may outlive it. A hand-run launcher (`--open`, a terminal) keeps its stdin open.
commands.on("close", () => { if (!openSelf) void quit(); });
process.on("SIGINT", () => void quit());
process.on("SIGTERM", () => void quit());

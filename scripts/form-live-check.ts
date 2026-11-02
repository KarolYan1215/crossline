/**
 * §14 standard 3 of docs/opportunity-agent.md: the form service end to end on a real free event, with the real Codex, in a visible window
 * of a throwaway profile, on a throwaway ledger. It submits a real registration, so it needs the person's choice of event and their
 * confirmation first; it never runs as a side effect.
 *
 *   pnpm exec tsx scripts/form-live-check.ts --url <event page> --host <registration host> --title <title> --name <full name> --email <email>
 *     [--day YYYY-MM-DD --when "<time as the page says it>"] [--cost-quote "<the page's words that it is free>"] --i-confirm-real-submission
 *
 * The runtime is the machine's own Codex home, shared with the resident worker: set `CROSSLINE_RESTORE_MARKETPLACE` to the resident
 * checkout's `marketplace.json` and the script installs it back at the end. Nothing reaches the live ledger.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { register } from "node:module";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const url = arg("url"), host = arg("host"), title = arg("title"), name = arg("name"), email = arg("email");
if (!url || !host || !title || !name || !email || !process.argv.includes("--i-confirm-real-submission")) {
  console.error("needs --url --host --title --name --email and --i-confirm-real-submission"); // i18n-ignore: a script
  process.exit(2);
}
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-form-live-"));
process.env.CROSSLINE_DATA_DIR = dataDir;

const { CrosslineStore, readFormRuns } = await import("../packages/db/src/index");
const { startCodexSupervisor } = await import("../packages/codex/src/index");
const { createFormService, FORM_FILLER, FORM_CHECKER, FORM_OBSERVER, FORM_BROWSER_AGENT } = await import("../apps/worker/src/form-service");
type Opportunity = import("../packages/core/src/index").Opportunity;

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const ws = store.createPrincipalWithWorkspace("form-live", "form-live").workspace.id;
const secrets = new Map<string, string>();
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3397),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [FORM_FILLER, FORM_CHECKER, FORM_OBSERVER, FORM_BROWSER_AGENT] }
});
const forms = createFormService({ store, cwd: repoRoot, dataDir, client: () => supervisor.client, owner: () => ws, screen: true,
  secrets: { read: async (w, key) => secrets.get(`${w}/${key}`), write: async (w, key, value) => { secrets.set(`${w}/${key}`, value); }, remove: (w, key) => { secrets.delete(`${w}/${key}`); } },
  profilesRoot: () => path.join(dataDir, "profiles"), log: (event) => console.info(JSON.stringify(event)) });

const settled = new Set(["confirmed", "submitted", "ready_to_submit", "waiting_person", "stopped"]);
try {
  for (const [slot, value] of [["full_name", name], ["email", email]] as const) {
    const saved = await forms.handle("POST", `/v1/apply-profile/${slot}`, ws, { value });
    if (saved?.status !== 200) throw new Error(`profile ${slot}: ${JSON.stringify(saved)}`);
  }
  const day = arg("day"), when = arg("when");
  const opportunity = { id: "live-1", key: url, lineId: "startup", kind: "event", title, organizer: "", url, registrationHost: host, deadlines: [],
    ...(day && when ? { startsAt: { day, quote: when } } : {}), cost: arg("cost-quote") ? { amount: 0, currency: "USD", quote: arg("cost-quote") } : null,
    eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: new Date().toISOString() } as unknown as Opportunity;
  const queued = await forms.handle("POST", "/v1/forms/queue", ws, { opportunity, choice: "register" });
  if (queued?.status !== 200) throw new Error(`queue: ${JSON.stringify(queued)}`);
  const end = Date.now() + 20 * 60_000;
  let run = readFormRuns(store, ws)[0];
  while (Date.now() < end && !(run && settled.has(run.state))) { await new Promise((resolve) => setTimeout(resolve, 2000)); run = readFormRuns(store, ws)[0]; }
  console.info(JSON.stringify({ state: run?.state, stoppedFor: run?.stoppedFor, stopDetail: run?.stopDetail, heldBecause: run?.heldBecause,
    confirmation: run?.confirmation, submittedBy: run?.submittedBy, engines: run?.engines,
    pages: run?.pages.map((page) => ({ engine: page.engine, errors: page.errors, injections: page.injections,
      actions: page.actions.map((action) => `${action.verdict} ${action.op} ${action.target} ${action.source ?? ""} ${action.verified ? "verified" : ""}`) })),
    screenshots: run?.screenshots }, null, 1));
  if (run?.state === "waiting_person" || run?.state === "ready_to_submit") {
    console.info("The window stays open for the person for ten minutes."); // i18n-ignore: a script
    await new Promise((resolve) => setTimeout(resolve, 10 * 60_000));
  }
} finally {
  await forms.closeAll();
  const restore = process.env.CROSSLINE_RESTORE_MARKETPLACE;
  if (restore) await supervisor.client.request("plugin/install", { marketplacePath: restore, pluginName: "crossline" }).catch((error) => console.warn("restore failed", error));
  store.close();
  await supervisor.stop();
  console.info(`ledger copy: ${dataDir}`);
}

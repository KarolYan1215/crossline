/**
 * Moves one account to the points rules of the interview (2026-11-12, packages/core/src/profile-points.ts), by the owner's decision for
 * named accounts only; every other account keeps what it has, and new interviews start under the rules.
 *
 *   pnpm exec tsx scripts/points-migrate.ts --email someone@example.com --split [--data /data] [--apply]
 *     The account's main interview runs under the points rules from now on, and its paragraphs (the portrait's sections) are split into
 *     points: the worker's sections lane owes one run for it (`profile.points.split`) and does it with the account's own model, each point
 *     resting on the person's own words. The paragraphs stay as they are.
 *
 *   pnpm exec tsx scripts/points-migrate.ts --email someone@example.com --export <file> [--data /data]
 *     Writes the account's interview (every conversation's messages, the observation ratings) to <file>, outside the ledger, so a replay can
 *     use the person's own words after a reset. Reads only.
 *
 *   pnpm exec tsx scripts/points-migrate.ts --email someone@example.com --reset [--data /data] [--apply]
 *     「清空数据重新开始」 as the settings page does it (`resetWorkspace` with `RESET_KEEPS`, files inside the data directory removed): the
 *     login and the model connection stay, the next page is the interview's opening card.
 *
 * Dry run by default: says which workspace it found and what it would do. Back the ledger up first (deploy/server/backup.sh). Never prints
 * the person's words.
 */
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEP_SECTIONS, POINTS_RULES, SECTION_FIELDS, ONBOARDING_INSIGHTS, readInsightRatings } from "../packages/core/src/index";
import { CrosslineStore, RESET_KEEPS } from "../packages/db/src/index";
import { POINTS_SPLIT_SETTING } from "../apps/worker/src/onboarding-extract";
import { readProfileModel } from "../apps/worker/src/onboarding-persist";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const email = arg("email")?.trim().toLowerCase();
const dataDir = arg("data") ?? process.env.CROSSLINE_DATA_DIR ?? "data";
const apply = process.argv.includes("--apply");
const mode = process.argv.includes("--split") ? "split" : process.argv.includes("--reset") ? "reset" : arg("export") ? "export" : undefined;
if (!email || !mode) throw new Error("usage: --email <address> (--split | --reset | --export <file>) [--data <dir>] [--apply]");

// Finding the account only reads: the address is in Better Auth's database, the account's own workspace in the ledger.
type Reader = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; close: () => void };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => Reader;
const auth = new Database(path.join(dataDir, "auth.db"), { readonly: true, fileMustExist: true });
const user = auth.prepare("SELECT id FROM user WHERE lower(email) = ?").get(email) as { id: string } | undefined;
auth.close();
if (!user) throw new Error("ACCOUNT_NOT_FOUND");
const ledger = new Database(path.join(dataDir, "crossline.db"), { readonly: true, fileMustExist: true });
const found = ledger.prepare(`SELECT p.id AS principalId, wm.workspace_id AS workspaceId FROM principals p
  JOIN workspace_members wm ON wm.principal_id = p.id AND wm.role = 'owner' WHERE p.better_auth_user_id = ?`).get(user.id) as
  { principalId: string; workspaceId: string } | undefined;
ledger.close();
if (!found) throw new Error("WORKSPACE_NOT_FOUND");

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
try {
  const ws = found.workspaceId;
  const sessions = store.listOnboardingSessions(ws);
  const main = [...sessions].reverse().find((session) => !session.id.startsWith("line-") && session.id !== "notes");
  if (mode === "export") {
    const out = arg("export")!;
    const dump = { workspaceId: ws, exportedAt: new Date().toISOString(),
      sessions: sessions.map((session) => ({ id: session.id, state: session.state, coverage: session.coverage, createdAt: session.createdAt,
        messages: store.listOnboardingMessages(ws, session.id).map((message) => ({ seq: message.seq, role: message.role, content: message.content, createdAt: message.createdAt })) })),
      insights: readInsightRatings(store.getSetting(ws, ONBOARDING_INSIGHTS)),
      profileModel: store.getSetting(ws, "profile.model") ? JSON.parse(store.getSetting(ws, "profile.model")!) : null,
      portraitReport: store.getSetting(ws, "portrait.report") ? JSON.parse(store.getSetting(ws, "portrait.report")!) : null };
    writeFileSync(out, JSON.stringify(dump, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...found, exported: out, sessions: dump.sessions.map((session) => ({ id: session.id, messages: session.messages.length })) }));
  } else if (mode === "split") {
    if (!main) throw new Error("NO_MAIN_INTERVIEW");
    const profile = readProfileModel(store, ws);
    // The deep sections that hold something: the ones a run splits into points.
    const sections = DEEP_SECTIONS.filter((section) => SECTION_FIELDS[section].some((field) => {
      const value = profile[field] as unknown;
      return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0;
    }));
    console.log(JSON.stringify({ ...found, session: main.id, rulesAlready: (main.coverage as { rules?: unknown }).rules === POINTS_RULES,
      pointsAlready: profile.points.length, split: sections, apply }));
    if (apply) store.atomically(() => {
      store.saveOnboardingSession({ ...main, coverage: { ...main.coverage, rules: POINTS_RULES }, updatedAt: new Date().toISOString() });
      if (sections.length) store.setSetting(ws, POINTS_SPLIT_SETTING, JSON.stringify(sections));
      store.appendEvent({ ownerId: found.principalId, workspaceId: ws, idempotencyKey: `profile.points.migrated:${ws}:${Date.now()}`,
        type: "profile.points_migrated", entityId: main.id, payload: { split: sections } });
    });
  } else {
    console.log(JSON.stringify({ ...found, sessions: sessions.length, runtimeOwner: store.getSetting(ws, "deployment.runtimeOwner") === "1", apply }));
    if (store.getSetting(ws, "deployment.runtimeOwner") === "1") throw new Error("ACCOUNT_IS_MACHINE_OWNER");
    if (apply) {
      const root = path.resolve(dataDir);
      const inside = (target: string) => { const resolved = path.resolve(target);
        if (resolved === root || !resolved.startsWith(root + path.sep)) return false; rmSync(resolved, { recursive: true, force: true }); return true; };
      const safe = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_");
      const reset = store.resetWorkspace(ws, RESET_KEEPS);
      let files = 0;
      for (const uri of reset.fileUris) { try { if (inside(uri.startsWith("file:") ? fileURLToPath(uri) : uri)) files += 1; } catch { /* unreadable uri */ } }
      for (const id of reset.workOrderIds) if (inside(path.join(root, "materials", id))) files += 1;
      inside(path.join(root, "portrait", safe(ws)));
      inside(path.join(root, "mail-drafts", safe(ws)));
      console.log(JSON.stringify({ type: "account.reset", workspaceId: ws, rows: reset.rows, files }));
    }
  }
} finally { store.close(); }

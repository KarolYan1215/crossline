import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
// Relative, not @crossline/db: the repo root is not a workspace package and has no such dependency.
import { CrosslineStore } from "../packages/db/src/index.js";

/** The ledger the e2e server opened (`CROSSLINE_E2E_DATA_DIR`, stashed by the config so every test worker reaches the same file). */
export function openStore(): CrosslineStore {
  return new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
}

/**
 * `global-setup.ts` signs in the one e2e test account once per run, and its first authenticated request
 * is what creates that account's principal+workspace row (`requireAccessContext`'s
 * `createPrincipalWithWorkspace`) — there is no hardcoded workspace id to read any more, real accounts
 * get a real generated one. A fresh per-run database has exactly one, so the first is the right one.
 */
export function realWorkspaceId(store: CrosslineStore): string {
  const workspace = store.listWorkspaces()[0];
  if (!workspace) throw new Error("No workspace exists yet — did global-setup.ts's sign-in run?");
  return workspace.id;
}

/**
 * Gives the account a portrait report: the fictional stress fixture (`fixtures/portrait-report.json` — adjacent high values, energy
 * activities with identical scores, two pieces of advice on one matrix cell, an axis at 52%). Written only when none exists, so the
 * desktop and phone projects see the same report whichever runs first.
 */
export async function ensurePortrait(page: Page): Promise<void> {
  await page.goto("/settings");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    if (store.getSetting(workspaceId, "portrait.report")) return;
    const report = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "portrait-report.json"), "utf8")) as unknown;
    store.setSetting(workspaceId, "portrait.report", JSON.stringify({ version: 1, at: "2026-10-12T09:00:00.000Z", schema: 2, report }));
  } finally { store.close(); }
}

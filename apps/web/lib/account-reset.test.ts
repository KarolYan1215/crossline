import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DEVICE_TOKEN_SETTING, NODE_COMPUTE_SETTING, NODE_PAIRED_SETTING, NODE_TOKEN_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./auth", () => ({ getAuth: vi.fn() }));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { RESET_KEEPS, deletionRefused, resetAccountData } from "./account-deletion";
import { TEST_CTX } from "./test-support";

let dir: string | undefined;
afterEach(() => {
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined;
});

/** 「清空数据重新开始」 keeps the person's own computer: on the hosted site the node is the model connection (W-227). */
test("a reset keeps the compute node's pairing and the device token, and clears the rest", () => {
  const store = new CrosslineStore(":memory:");
  const ws = "w";
  for (const [key, value] of [[NODE_TOKEN_SETTING, "h"], [NODE_PAIRED_SETTING, "{}"], [NODE_COMPUTE_SETTING, "on"], [DEVICE_TOKEN_SETTING, "d"], ["onboarding.tone", "neutral"]] as const)
    store.setSetting(ws, key, value);
  store.resetWorkspace(ws, RESET_KEEPS);
  expect([NODE_TOKEN_SETTING, NODE_PAIRED_SETTING, NODE_COMPUTE_SETTING, DEVICE_TOKEN_SETTING].map((key) => store.getSetting(ws, key))).toEqual(["h", "{}", "on", "d"]);
  expect(store.getSetting(ws, "onboarding.tone")).toBeUndefined();
  store.close();
});

/**
 * Events already written to the person's calendars must stay known as Crossline's after a reset, or the next plan writes them a second
 * time and nothing ever removes the old ones. The writers' setup and records stay; the hashes that skip an unchanged publish go, so the
 * first pass after the reset publishes the emptied plan and withdraws what is still to come.
 */
test("a reset keeps the calendar writers' setup and records, and forgets the publish hashes", () => {
  const store = new CrosslineStore(":memory:");
  const ws = "w";
  const kept = [["calendar.write.paths", "{\"google\":true,\"imip\":true,\"ics\":true}"], ["calendar.write.account", "a"], ["calendar.published", "{}"],
    ["calendar.published.google", "{\"events\":{}}"], ["calendar.imip.recipient", "r"], ["calendar.imip.sent", "{}"], ["calendar.feed.token", "t"]] as const;
  const dropped = ["calendar.autopublish.hash", "calendar.google.hash", "calendar.fixed.hash", "calendar.subscriptions", "schedule.frozen"];
  for (const [key, value] of kept) store.setSetting(ws, key, value);
  for (const key of dropped) store.setSetting(ws, key, "x");
  store.resetWorkspace(ws, RESET_KEEPS);
  expect(kept.map(([key]) => store.getSetting(ws, key))).toEqual(kept.map(([, value]) => value));
  expect(dropped.map((key) => store.getSetting(ws, key))).toEqual(dropped.map(() => undefined));
  store.close();
});

// 2026-11-28, the owner: the installed copy's account is cleared from Settings like a hosted one, not by reinstalling.
test("an installed copy clears its own account on the typed email and keeps the machine-owner mark", () => {
  const ws = TEST_CTX.workspaceId;
  dir = mkdtempSync(path.join(tmpdir(), "crossline-reset-"));
  vi.stubEnv("CROSSLINE_INSTALL_MODE", "local");
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, "deployment.runtimeOwner", "1");
  store.setSetting(ws, "lines.profiles", "{}");

  expect(resetAccountData(TEST_CTX, { email: "me@example.com" }, "other@example.com")).toEqual({ ok: false, code: "EMAIL_MISMATCH" });
  expect(store.getSetting(ws, "lines.profiles")).toBe("{}");

  expect(resetAccountData(TEST_CTX, { email: "me@example.com" }, " Me@Example.com ")).toMatchObject({ ok: true });
  expect(store.getSetting(ws, "lines.profiles")).toBeUndefined();
  expect(store.getSetting(ws, "deployment.runtimeOwner")).toBe("1");
  // Deleting the account is still refused on an installed copy: that is uninstalling.
  expect(deletionRefused(store, ws)).toBe("ACCOUNT_DELETE_LOCAL");
});

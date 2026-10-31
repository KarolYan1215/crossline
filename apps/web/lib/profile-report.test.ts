import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { PROFILE_CLAIMS_SETTING, PROFILE_INSTRUMENTS_SETTING, PROFILE_ITEMS, exportableClaims, readClaimStatus, readPrivacyChoices,
  PROFILE_CLAIM_STATUS_SETTING, REPORT_PRIVACY_SETTING, type ProfileClaim } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { changeProfileReport, loadProfileReport, readProfileReportChange } from "./profile-report";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;
const at = "2026-10-31T10:00:00.000Z";
const written: ProfileClaim = { id: "c-w1", section: "work_style", statement: "截稿前一晚常通宵", kind: "self_reported", confidence: 0.8,
  basis: [{ sentenceId: 41, quote: "截稿前一晚都会通宵" }] };

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const swls = PROFILE_ITEMS.filter((item) => item.instrument === "swls");
  store.setSetting(ws, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(Object.fromEntries(swls.map((item) => [item.id, { itemId: item.id, score: 2, by: "tapped", at }]))));
  store.setSetting(ws, PROFILE_CLAIMS_SETTING, JSON.stringify({ version: 1, at, claims: [written] }));
  return { store, swls };
}

test("the person's page holds the cards' claims and the writer's, by section, with the items behind them", () => {
  setup();
  const report = loadProfileReport(TEST_CTX);
  expect(report.sections.find((section) => section.section === "lifestyle")!.claims[0]).toMatchObject({ kind: "measured" });
  expect(report.sections.find((section) => section.section === "work_style")!.claims[0]).toMatchObject({ id: "c-w1", shownTo: "agent" });
  expect(report.items).toHaveLength(5);
});

test("a rejected claim stays on the page and leaves the export; a private section leaves it too", () => {
  const { store } = setup();
  expect(changeProfileReport(TEST_CTX, { action: "judge", claimId: "c-w1", status: "rejected" })).toEqual({ ok: true });
  const status = readClaimStatus(store.getSetting(ws, PROFILE_CLAIM_STATUS_SETTING));
  expect(status["c-w1"]).toMatchObject({ status: "rejected", statement: "截稿前一晚常通宵" });
  expect(loadProfileReport(TEST_CTX).sections.find((section) => section.section === "work_style")!.claims[0]).toMatchObject({ personStatus: "rejected" });
  const claims = loadProfileReport(TEST_CTX).sections.flatMap((section) => section.claims);
  expect(exportableClaims(claims, readPrivacyChoices(null), status).map((claim) => claim.section)).toEqual(["lifestyle"]);
  changeProfileReport(TEST_CTX, { action: "privacy", section: "lifestyle", level: "private" });
  expect(exportableClaims(claims, readPrivacyChoices(store.getSetting(ws, REPORT_PRIVACY_SETTING)), status)).toEqual([]);
  expect(changeProfileReport(TEST_CTX, { action: "judge", claimId: "c-nope", status: "confirmed" })).toMatchObject({ ok: false, code: "PROFILE_CLAIM_UNKNOWN" });
});

test("answering an item again replaces what was recorded, a mapping included, and moves the measured claim at once", () => {
  const { swls } = setup();
  const before = loadProfileReport(TEST_CTX).sections.find((section) => section.section === "lifestyle")!.claims[0]!.statement;
  for (const item of swls) changeProfileReport(TEST_CTX, { action: "item", itemId: item.id, score: 5 });
  const after = loadProfileReport(TEST_CTX).sections.find((section) => section.section === "lifestyle")!.claims[0]!.statement;
  expect(before).toMatch(/偏低/);
  expect(after).toMatch(/偏高（100\/100/);
  changeProfileReport(TEST_CTX, { action: "item", itemId: swls[0]!.id, score: null });
  expect(loadProfileReport(TEST_CTX).sections.find((section) => section.section === "lifestyle")!.claims).toEqual([]);
});

test("only well-formed changes are read from a request", () => {
  expect(readProfileReportChange({ action: "privacy", section: "tensions", level: "public" })).toMatchObject({ section: "tensions" });
  expect(readProfileReportChange({ action: "privacy", section: "nope", level: "public" })).toBeNull();
  expect(readProfileReportChange({ action: "item", itemId: "swls-1", score: 6 })).toBeNull();
  expect(readProfileReportChange({ action: "item", itemId: "swls-1", score: null })).toMatchObject({ score: null });
  expect(readProfileReportChange({ action: "judge", claimId: "c-1", status: "maybe" })).toBeNull();
});

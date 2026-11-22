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
  const twivi = PROFILE_ITEMS.filter((item) => item.instrument === "twivi");
  store.setSetting(ws, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(Object.fromEntries(twivi.map((item) => [item.id, { itemId: item.id, score: 2, by: "tapped", at }]))));
  store.setSetting(ws, PROFILE_CLAIMS_SETTING, JSON.stringify({ version: 1, at, claims: [written] }));
  return { store, twivi };
}

test("the person's page holds the cards' claims and the writer's, by section, with the items behind them", () => {
  setup();
  const report = loadProfileReport(TEST_CTX);
  expect(report.sections.find((section) => section.section === "values")!.claims[0]).toMatchObject({ kind: "measured" });
  expect(report.sections.find((section) => section.section === "work_style")!.claims[0]).toMatchObject({ id: "c-w1", shownTo: "agent" });
  expect(report.items).toHaveLength(20);
});

test("a rejected claim stays on the page and leaves the export; a private section leaves it too", () => {
  const { store } = setup();
  expect(changeProfileReport(TEST_CTX, { action: "judge", claimId: "c-w1", status: "rejected" })).toEqual({ ok: true });
  const status = readClaimStatus(store.getSetting(ws, PROFILE_CLAIM_STATUS_SETTING));
  expect(status["c-w1"]).toMatchObject({ status: "rejected", statement: "截稿前一晚常通宵" });
  expect(loadProfileReport(TEST_CTX).sections.find((section) => section.section === "work_style")!.claims[0]).toMatchObject({ personStatus: "rejected" });
  const claims = loadProfileReport(TEST_CTX).sections.flatMap((section) => section.claims);
  expect(exportableClaims(claims, readPrivacyChoices(null), status).map((claim) => claim.section)).toEqual(["values"]);
  changeProfileReport(TEST_CTX, { action: "privacy", section: "values", level: "private" });
  expect(exportableClaims(claims, readPrivacyChoices(store.getSetting(ws, REPORT_PRIVACY_SETTING)), status)).toEqual([]);
  expect(changeProfileReport(TEST_CTX, { action: "judge", claimId: "c-nope", status: "confirmed" })).toMatchObject({ ok: false, code: "PROFILE_CLAIM_UNKNOWN" });
});

test("answering an item again replaces what was recorded, a mapping included, and moves the measured claim at once", () => {
  setup();
  const values = () => loadProfileReport(TEST_CTX).sections.find((section) => section.section === "values")!.claims[0]!.statement;
  // Stimulation's two portraits (6, 16) rated highest: it comes first.
  for (const id of ["twivi-6", "twivi-16"]) changeProfileReport(TEST_CTX, { action: "item", itemId: id, score: 6 });
  expect(values()).toMatch(/^最看重：刺激/);
  // A six on an IPIP item is refused: it has five points.
  expect(changeProfileReport(TEST_CTX, { action: "item", itemId: "neo-1", score: 6 })).toMatchObject({ ok: false, code: "PROFILE_ITEM_SCORE" });
  changeProfileReport(TEST_CTX, { action: "item", itemId: "twivi-6", score: null });
  expect(values()).not.toMatch(/^最看重：刺激/);
});

test("only well-formed changes are read from a request", () => {
  expect(readProfileReportChange({ action: "privacy", section: "tensions", level: "public" })).toMatchObject({ section: "tensions" });
  expect(readProfileReportChange({ action: "privacy", section: "nope", level: "public" })).toBeNull();
  expect(readProfileReportChange({ action: "item", itemId: "twivi-1", score: 7 })).toBeNull();
  expect(readProfileReportChange({ action: "item", itemId: "twivi-1", score: null })).toMatchObject({ score: null });
  expect(readProfileReportChange({ action: "judge", claimId: "c-1", status: "maybe" })).toBeNull();
});

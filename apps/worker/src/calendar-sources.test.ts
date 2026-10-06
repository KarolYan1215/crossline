import { beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { GraphCredentialProvider } from "@crossline/connectors";
import {
  buildSources, calendarLabel, listCatalogue, readSelection, saveSelection, seedNewAccounts, sourceKey
} from "./calendar-sources";

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });

const UW = { id: "uw-home", username: "kyan47@wisc.edu" };
const PERSONAL = { id: "personal-home", username: "karolyan1215@gmail.com" };

/** Two accounts, each with a default calendar plus one the person would not want on their plan. */
const session = (accounts = [UW, PERSONAL]) => ({
  listAccounts: async () => accounts,
  credentialFor: (accountId: string): GraphCredentialProvider =>
    ({ getAccessToken: async () => `token-${accountId}` })
});
const catalogueReader = (byAccount: Record<string, Array<{ id: string; name: string; isDefault: boolean }>>) =>
  (credential: GraphCredentialProvider) => ({
    listCalendars: async (accountId: string) => {
      void credential;
      const rows = byAccount[accountId];
      if (!rows) throw new Error("GRAPH_READ_FAILED:401");
      return rows.map((row) => ({ accountId, ...row }));
    }
  });
const BOTH = {
  "uw-home": [{ id: "uw-default", name: "日历", isDefault: true }, { id: "uw-holidays", name: "中国 节假日", isDefault: false }],
  "personal-home": [{ id: "p-default", name: "日历", isDefault: true }, { id: "p-test", name: "test", isDefault: false }]
};

test("a newly signed-in account arrives with its default calendar ticked and nothing else", async () => {
  const catalogue = await listCatalogue(session(), store, WORKSPACE, catalogueReader(BOTH));
  const selection = seedNewAccounts(store, WORKSPACE, catalogue);

  // Ticking everything would drag 「中国 节假日」 onto the plan; ticking nothing would make signing in
  // look like it did nothing at all.
  expect(selection.map((entry) => entry.calendarId).sort()).toEqual(["p-default", "uw-default"]);
  expect(selection.map((entry) => entry.label).sort()).toEqual(["日历 · karolyan1215", "日历 · kyan47"]);
});

test("seeding never re-ticks a calendar the person unticked", async () => {
  const catalogue = await listCatalogue(session(), store, WORKSPACE, catalogueReader(BOTH));
  seedNewAccounts(store, WORKSPACE, catalogue);

  // The person decides they do not want the UW calendar on the plan at all.
  saveSelection(store, WORKSPACE, readSelection(store, WORKSPACE).filter((entry) => entry.accountId !== "uw-home"));
  // Both accounts are still signed in, so a second seeding pass must not undo that decision.
  const again = seedNewAccounts(store, WORKSPACE, await listCatalogue(session(), store, WORKSPACE, catalogueReader(BOTH)));
  expect(again.map((entry) => entry.accountId)).toEqual(["personal-home"]);
});

test("an account whose calendars cannot be listed is shown as such, not as having none", async () => {
  const catalogue = await listCatalogue(session(), store, WORKSPACE,
    catalogueReader({ "uw-home": BOTH["uw-home"] }));

  expect(catalogue.map((account) => [account.username, account.signedIn]))
    .toEqual([["kyan47@wisc.edu", true], ["karolyan1215@gmail.com", false]]);
  // Reporting it as an account with zero calendars would invite unticking everything and losing blocks.
  expect(catalogue[1]?.error).toBe("GRAPH_READ_FAILED:401");
  // It also must not be seeded: there is no calendar to seed, and guessing one would be a fiction.
  expect(seedNewAccounts(store, WORKSPACE, catalogue).map((entry) => entry.accountId)).toEqual(["uw-home"]);
});

test("the catalogue marks what is already chosen, including a non-default calendar", async () => {
  saveSelection(store, WORKSPACE, [
    { accountId: "personal-home", calendarId: "p-test", label: calendarLabel("test", PERSONAL.username) }
  ]);
  const catalogue = await listCatalogue(session(), store, WORKSPACE, catalogueReader(BOTH));
  const personal = catalogue.find((account) => account.accountId === "personal-home");
  expect(personal?.calendars.map((calendar) => [calendar.name, calendar.selected]))
    .toEqual([["日历", false], ["test", true]]);
});

test("building a tick's sources costs no Graph calls and carries the stored labels", () => {
  saveSelection(store, WORKSPACE, [
    { accountId: "uw-home", calendarId: "uw-default", label: "日历 · kyan47" },
    { accountId: "personal-home", calendarId: "p-test", label: "test · karolyan1215" }
  ]);
  let credentialsAsked = 0;
  const built = buildSources(store, WORKSPACE, {
    listAccounts: async () => { throw new Error("a tick must not list accounts"); },
    credentialFor: (accountId) => { credentialsAsked += 1; return { getAccessToken: async () => accountId }; }
  }, (credential, calendarId) => ({ credential, calendarId }));

  expect(built.map((source) => [source.key, source.label])).toEqual([
    [sourceKey("uw-home", "uw-default"), "日历 · kyan47"],
    [sourceKey("personal-home", "p-test"), "test · karolyan1215"]
  ]);
  expect(credentialsAsked).toBe(2);
});

test("a settings row that no longer parses reads as empty rather than as a guess", () => {
  store.setSetting(WORKSPACE, "calendar.sources", "{ not json");
  // Empty makes the sync say 「没有勾选任何日历」. Guessing a default here would quietly read a calendar
  // the person may have deliberately unticked.
  expect(readSelection(store, WORKSPACE)).toEqual([]);
});

test("Crossline's own calendar can never be chosen as a source, so the plan is not planned around its own output", async () => {
  const catalogue = await listCatalogue(session([UW]), store, WORKSPACE, catalogueReader({
    [UW.id]: [{ id: "main", name: "Calendar", isDefault: true }, { id: "xl", name: "Crossline", isDefault: false }]
  }));
  expect(catalogue[0]!.calendars.map((calendar) => calendar.name)).toEqual(["Calendar"]);
  // Even a selection that somehow names it (an older version of the app, a hand-edited setting) builds no reader.
  saveSelection(store, WORKSPACE, [{ accountId: UW.id, calendarId: "xl", label: calendarLabel("Crossline", UW.username) }, { accountId: UW.id, calendarId: "main", label: calendarLabel("Calendar", UW.username) }]);
  expect(buildSources(store, WORKSPACE, session([UW]), () => ({})).map((source) => source.key)).toEqual([sourceKey(UW.id, "main")]);
});

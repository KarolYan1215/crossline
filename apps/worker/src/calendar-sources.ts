/**
 * Which calendars, in which accounts, the plan's reality lane is read from.
 *
 * This used to be nothing at all: one account, its default calendar, no way to see that was the rule
 * and no way to change it. An event put on a newly created calendar — or on a second account — was
 * invisible, and 「立即同步日历」 answered 「日历没有变化」, which was true and told the person nothing.
 *
 * The selection lives in the ledger, next to the availability pattern and for the same reason: a
 * backup that does not carry it restores a plan whose reality lane cannot be rebuilt. It also carries
 * the display label, so building the sources for a tick costs no Graph calls — the catalogue is only
 * fetched when someone is actually looking at the list.
 */
import { GraphReadSource, type GraphAccount, type GraphCalendar, type GraphCredentialProvider } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import type { CalendarSource } from "./graph-sync";

const SETTING = "calendar.sources";
/**
 * Accounts that have already been offered their default calendar.
 *
 * Separate from the selection on purpose. Deriving "is this account new?" from the selection meant
 * that unticking every calendar of an account made it look new again, and the next pass silently
 * ticked its default calendar back on — undoing a deliberate decision with no trace.
 */
const SEEDED_SETTING = "calendar.sources.seeded";

/** One chosen calendar. `accountId` is MSAL's `homeAccountId`; `calendarId` is Graph's. */
export type SelectedCalendar = { accountId: string; calendarId: string; label: string };

export type CalendarCatalogue = Array<{
  accountId: string;
  username: string;
  signedIn: boolean;
  calendars: Array<{ id: string; name: string; isDefault: boolean; selected: boolean }>;
  /** Present when this account's calendars could not be listed; the rest of the list still renders. */
  error?: string;
}>;

export type GraphSession = {
  listAccounts(): Promise<GraphAccount[]>;
  credentialFor(accountId: string): GraphCredentialProvider;
};

/** `kyan47@wisc.edu` → `kyan47`. Enough to tell two accounts apart without a wall of text on a block. */
const shortName = (username: string) => username.split("@")[0] ?? username;

/** What a block from this calendar says it is, e.g. 「日历 · kyan47」. */
export const calendarLabel = (calendarName: string, username: string) => `${calendarName} · ${shortName(username)}`;

export const sourceKey = (accountId: string, calendarId: string) => `${accountId}:${calendarId}`;

export function readSelection(store: CrosslineStore, workspaceId: string): SelectedCalendar[] {
  const raw = store.getSetting(workspaceId, SETTING);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SelectedCalendar[];
    // A setting that no longer parses is a bug to fix, not a reason to silently read nothing — but
    // reading nothing is still safer than reading a guess, so an unusable value reports as empty and
    // the sync says 「没有勾选任何日历」 rather than quietly emptying the plan.
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry?.accountId === "string" && typeof entry?.calendarId === "string")
        .map((entry) => ({ accountId: entry.accountId, calendarId: entry.calendarId, label: String(entry.label ?? "日历") }))
      : [];
  } catch { return []; }
}

export function saveSelection(store: CrosslineStore, workspaceId: string, selection: SelectedCalendar[]): void {
  store.setSetting(workspaceId, SETTING, JSON.stringify(selection));
}

function seededAccounts(store: CrosslineStore, workspaceId: string): Set<string> {
  const raw = store.getSetting(workspaceId, SEEDED_SETTING);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

/** Every account and calendar the signed-in tokens can see, marked with what is currently chosen. */
export async function listCatalogue(
  session: GraphSession,
  store: CrosslineStore,
  workspaceId: string,
  makeReader: (credential: GraphCredentialProvider) => Pick<GraphReadSource, "listCalendars">
): Promise<CalendarCatalogue> {
  const chosen = new Set(readSelection(store, workspaceId).map((entry) => sourceKey(entry.accountId, entry.calendarId)));
  const catalogue: CalendarCatalogue = [];
  for (const account of await session.listAccounts()) {
    const credential = session.credentialFor(account.id);
    let calendars: GraphCalendar[];
    try {
      calendars = await makeReader(credential).listCalendars(account.id);
    } catch (error) {
      // One account being unreachable must not hide the others, and must not read as "no calendars".
      catalogue.push({
        accountId: account.id, username: account.username, signedIn: false, calendars: [],
        error: error instanceof Error ? error.message : "GRAPH_READ_FAILED"
      });
      continue;
    }
    catalogue.push({
      accountId: account.id, username: account.username, signedIn: true,
      // Crossline's own calendar is never a source of the person's commitments: read back, the plan's blocks would look like meetings
      // the person made, and the scheduler would plan around its own output.
      calendars: calendars.filter((calendar) => calendar.name !== "Crossline").map((calendar) => ({
        id: calendar.id, name: calendar.name, isDefault: calendar.isDefault,
        selected: chosen.has(sourceKey(account.id, calendar.id))
      }))
    });
  }
  return catalogue;
}

/**
 * Gives a brand-new account its default calendar, and nothing else.
 *
 * Ticking everything would drag 「中国 节假日」 and 「生日」 onto the plan, which are not commitments;
 * ticking nothing would mean signing in a second account appeared to do nothing at all. The default
 * calendar is the one answer that is useful without being presumptuous, and it stays editable.
 */
export function seedNewAccounts(store: CrosslineStore, workspaceId: string, catalogue: CalendarCatalogue): SelectedCalendar[] {
  const selection = readSelection(store, workspaceId);
  const seeded = seededAccounts(store, workspaceId);
  // Anything already chosen counts as seeded, so upgrading from the era before this marker existed
  // does not re-offer a default calendar to an account that is plainly already set up.
  for (const entry of selection) seeded.add(entry.accountId);
  let added = false;
  for (const account of catalogue) {
    if (seeded.has(account.accountId) || !account.signedIn) continue;
    const fallback = account.calendars.find((calendar) => calendar.isDefault) ?? account.calendars[0];
    // No calendars at all is not something to record as seeded: the next pass should try again once
    // the account can actually be read.
    if (!fallback) continue;
    selection.push({
      accountId: account.accountId, calendarId: fallback.id,
      label: calendarLabel(fallback.name, account.username)
    });
    seeded.add(account.accountId);
    added = true;
  }
  if (added) {
    saveSelection(store, workspaceId, selection);
    store.setSetting(workspaceId, SEEDED_SETTING, JSON.stringify([...seeded]));
  }
  return selection;
}

/** The readers for one tick. No Graph calls: everything needed is already in the stored selection. */
export function buildSources(
  store: CrosslineStore,
  workspaceId: string,
  session: GraphSession,
  makeReader: (credential: GraphCredentialProvider, calendarId: string) => { pullCalendar(cursor?: string): Promise<never> } | unknown
): CalendarSource[] {
  return readSelection(store, workspaceId).filter((entry) => !entry.label.startsWith("Crossline · ")).map((entry) => ({
    key: sourceKey(entry.accountId, entry.calendarId),
    label: entry.label,
    reader: makeReader(session.credentialFor(entry.accountId), entry.calendarId) as CalendarSource["reader"]
  }));
}

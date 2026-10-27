import { tFor, type Locale } from "@crossline/i18n";
import { PublicClientApplication } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type ExternalItem = {
  provider: string;
  externalId: string;
  iCalUid?: string;
  title: string;
  start?: string;
  end?: string;
  etag?: string;
  /** The source says this is gone. A delta page reports deletions as tombstones, not as absence. */
  removed?: boolean;
};

type ReconciledItem = ExternalItem & { logicalId: string; sources: Array<{ provider: string; externalId: string }> };

const externalKey = (item: ExternalItem) => `${item.provider}:${item.externalId}`;
const normalizedTitle = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

export function reconcileExternalItems(items: ExternalItem[]): {
  items: ReconciledItem[];
  fuzzyGroups: string[][];
  conflicts: Array<{ code: "SOURCE_VERSION_CONFLICT"; externalKey: string; versions: string[] }>;
} {
  const exactGroups = new Map<string, ExternalItem[]>();
  const versions = new Map<string, Set<string>>();
  for (const item of items) {
    const key = item.iCalUid ?? externalKey(item);
    exactGroups.set(key, [...(exactGroups.get(key) ?? []), item]);
    if (item.etag) {
      const itemVersions = versions.get(externalKey(item)) ?? new Set<string>();
      itemVersions.add(item.etag);
      versions.set(externalKey(item), itemVersions);
    }
  }

  const reconciled = [...exactGroups.entries()].map(([logicalId, group]) => {
    const first = group[0]!;
    return {
      ...first,
      logicalId,
      sources: group.map(({ provider, externalId }) => ({ provider, externalId }))
    };
  });
  const fuzzyGroups: string[][] = [];
  for (let left = 0; left < reconciled.length; left += 1) {
    for (let right = left + 1; right < reconciled.length; right += 1) {
      const a = reconciled[left]!;
      const b = reconciled[right]!;
      if (!a.start || !b.start || normalizedTitle(a.title) !== normalizedTitle(b.title)) continue;
      if (Math.abs(Date.parse(a.start) - Date.parse(b.start)) <= 15 * 60_000) {
        fuzzyGroups.push([a.logicalId, b.logicalId]);
      }
    }
  }
  const conflicts = [...versions.entries()]
    .filter(([, itemVersions]) => itemVersions.size > 1)
    .map(([key, itemVersions]) => ({
      code: "SOURCE_VERSION_CONFLICT" as const,
      externalKey: key,
      versions: [...itemVersions]
    }));
  return { items: reconciled, fuzzyGroups, conflicts };
}

export function connectorWritePolicy(_connector: string, _target: string): string {
  if (_connector === "personal_graph" && _target === "calendar:Crossline") return "batch_approval";
  if (_connector === "personal_graph" && _target === "todo:Crossline") return "two_way";
  return "read_only";
}

export function longbridgeToolAllowed(_toolName: string): boolean {
  const name = _toolName.replace(/^mcp__codex_apps__/, "").replace(/^longbridge_/, "");
  return [
    "quote",
    "candlesticks",
    "company",
    "financial_report",
    "financial_report_latest",
    "financial_report_snapshot",
    "financial_statement",
    "filings",
    "news",
    "finance_calendar",
    "trading_days",
    "constituent",
    "calc_indexes",
    "dividend",
    "corp_action"
  ].includes(name);
}

export type PushReceipt = { provider: string; externalId: string; status: string; target?: string };
export type CapabilityReport = { read: boolean; write: boolean; verify: boolean; targets: string[] };
export type PullBatch = { items: ExternalItem[]; cursor?: string };
export type VerifyResult = { verified: boolean; status: string };
export type ConnectorHealth = { status: "healthy" | "degraded" | "unavailable"; checkedAt: string; message?: string };
export type ExternalMutation = { kind: string; payload: unknown; etag?: string };

export interface ConnectorAdapter {
  probe(): Promise<CapabilityReport>;
  pull(cursor?: string): Promise<PullBatch>;
  push(mutation: ExternalMutation, idempotencyKey: string): Promise<PushReceipt>;
  verify(receipt: PushReceipt): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
}

export interface GraphCredentialProvider {
  getAccessToken(): Promise<string | undefined>;
}

/** One signed-in mailbox. `id` is MSAL's `homeAccountId`, which is stable across token refreshes. */
export type GraphAccount = { id: string; username: string };

/** One calendar inside one account. `accountId` is what ties it back to a credential. */
export type GraphCalendar = { accountId: string; id: string; name: string; isDefault: boolean };

export function graphCacheConfiguration(localAppData = process.env.LOCALAPPDATA, stateDir = process.env.CROSSLINE_STATE_DIR?.trim()) {
  // An installed copy's own state folder (CROSSLINE_STATE_DIR, docs/local-installer.md), never a resident app's sign-ins.
  const base = stateDir || (localAppData ? path.win32.join(localAppData, "Crossline") : undefined);
  if (!base) throw new Error("LOCALAPPDATA_UNAVAILABLE");
  return {
    cachePath: path.win32.join(base, "auth", "msal-cache.lock"),
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: "Crossline.Graph",
    accountName: "personal-workspace",
    usePlaintextFileOnLinux: false
  };
}

const GRAPH_READ_SCOPES = ["User.Read", "Calendars.Read", "Tasks.Read"];

/**
 * A single-tenant registration cannot use the /common endpoint: Entra rejects it with AADSTS50194 and
 * tells you to use the tenant-specific one. Defaulting to /common therefore breaks exactly the case a
 * university or work account is in, which is the case this connector exists for.
 */
export function graphAuthority(tenantId?: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const tenant = tenantId?.trim();
  return `https://login.microsoftonline.com/${tenant && tenant !== "common" ? tenant : "common"}`;
}
const GRAPH_WRITE_SCOPES = ["User.Read", "Calendars.ReadWrite", "Tasks.ReadWrite"];
/** What the Crossline calendar needs and nothing more: no tasks, no shared calendars, no mail. */
const GRAPH_CALENDAR_WRITE_SCOPES = ["User.Read", "Calendars.ReadWrite"];

export async function createGraphAuthSession(config: {
  clientId: string;
  /** Required for a single-tenant registration; /common only works for a multi-tenant one. */
  tenantId?: string;
  localAppData?: string;
  authority?: string;
  access?: "read" | "write" | "calendar-write";
}): Promise<GraphCredentialProvider & {
  loginWithDeviceCode(onCode: (info: { userCode: string; verificationUri: string; message: string }) => void): Promise<{ username: string }>;
  /** Every account the persisted cache holds, in the order MSAL returns them. */
  listAccounts(): Promise<GraphAccount[]>;
  /** A credential bound to one account, so two accounts can be read in the same tick. */
  credentialFor(accountId: string): GraphCredentialProvider;
}> {
  if (!config.clientId.trim()) throw new Error("GRAPH_CLIENT_ID_REQUIRED");
  const persistenceConfig = graphCacheConfiguration(config.localAppData);
  mkdirSync(path.dirname(persistenceConfig.cachePath), { recursive: true });
  const persistence = await PersistenceCreator.createPersistence(persistenceConfig);
  const client = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: graphAuthority(config.tenantId, config.authority)
    },
    cache: { cachePlugin: new PersistenceCachePlugin(persistence) }
  });
  const scopes = config.access === "calendar-write" ? GRAPH_CALENDAR_WRITE_SCOPES : config.access === "write" ? GRAPH_WRITE_SCOPES : GRAPH_READ_SCOPES;
  const accountById = async (accountId: string) =>
    (await client.getTokenCache().getAllAccounts()).find((account) => account.homeAccountId === accountId);
  return {
    // Kept for the callers that only ever want "some signed-in account" — the status probe and the
    // single-account write connector. Reading calendars goes through `credentialFor` instead, because
    // "the first account" silently discarded every account after it.
    async getAccessToken() {
      const account = (await client.getTokenCache().getAllAccounts())[0];
      if (!account) return undefined;
      const result = await client.acquireTokenSilent({ account, scopes });
      return result.accessToken;
    },
    async listAccounts() {
      return (await client.getTokenCache().getAllAccounts())
        .map((account) => ({ id: account.homeAccountId, username: account.username }));
    },
    credentialFor(accountId) {
      return {
        async getAccessToken() {
          const account = await accountById(accountId);
          // A signed-out account is not an error the tick should die on: the other accounts still
          // have tokens, and this one simply contributes nothing until it is signed in again.
          if (!account) return undefined;
          const result = await client.acquireTokenSilent({ account, scopes });
          return result.accessToken;
        }
      };
    },
    async loginWithDeviceCode(onCode) {
      const result = await client.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (info) => onCode({ userCode: info.userCode, verificationUri: info.verificationUri, message: info.message })
      });
      if (!result?.account) throw new Error("GRAPH_LOGIN_FAILED");
      return { username: result.account.username };
    }
  };
}

type GraphTarget = { id: string; name: string };
type GraphMutationPayload = {
  approved?: boolean;
  externalId?: string;
  body?: Record<string, unknown>;
};

export class MicrosoftGraphConnector implements ConnectorAdapter {
  readonly #credential: GraphCredentialProvider;
  readonly #calendar: GraphTarget;
  readonly #todoList: GraphTarget;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #writeEnabled: boolean;
  readonly #baseUrl = "https://graph.microsoft.com/v1.0";

  constructor(config: {
    credential: GraphCredentialProvider;
    calendar: GraphTarget;
    todoList: GraphTarget;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    writeEnabled?: boolean;
  }) {
    if (config.calendar.name !== "Crossline" || config.todoList.name !== "Crossline") {
      throw new Error("GRAPH_TARGET_NOT_CROSSLINE");
    }
    this.#credential = config.credential;
    this.#calendar = config.calendar;
    this.#todoList = config.todoList;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? (() => new Date());
    this.#writeEnabled = config.writeEnabled ?? false;
  }

  async #token(): Promise<string> {
    const token = await this.#credential.getAccessToken();
    if (!token) throw new Error("GRAPH_CREDENTIAL_UNAVAILABLE");
    return token;
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.#token();
    return this.#fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    });
  }

  async probe(): Promise<CapabilityReport> {
    await this.#token();
    return {
      read: true,
      write: this.#writeEnabled,
      verify: true,
      targets: ["calendar:Crossline", "todo:Crossline"]
    };
  }

  async pull(cursor?: string): Promise<PullBatch> {
    const now = this.#now();
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCDate(start.getUTCDate() - 90);
    end.setUTCDate(end.getUTCDate() + 30);
    const params = new URLSearchParams({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
    const url = cursor ?? `${this.#baseUrl}/me/calendars/${encodeURIComponent(this.#calendar.id)}/calendarView/delta?${params}`;
    const response = await this.#request(url);
    if (!response.ok) throw new Error(`GRAPH_PULL_FAILED:${response.status}`);
    const body = await response.json() as {
      value?: Array<{ id?: string; iCalUId?: string; subject?: string; start?: { dateTime?: string }; "@odata.etag"?: string }>;
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    return {
      items: (body.value ?? []).filter((item) => item.id).map((item) => ({
        provider: "personal_graph",
        externalId: item.id!,
        ...(item.iCalUId ? { iCalUid: item.iCalUId } : {}),
        title: item.subject ?? "(untitled)",
        ...(item.start?.dateTime ? { start: item.start.dateTime } : {}),
        ...(item["@odata.etag"] ? { etag: item["@odata.etag"] } : {})
      })),
      ...(body["@odata.nextLink"] || body["@odata.deltaLink"]
        ? { cursor: body["@odata.nextLink"] ?? body["@odata.deltaLink"] }
        : {})
    };
  }

  async pullAll(cursors: { calendar?: string; todo?: string } = {}): Promise<{
    items: ExternalItem[];
    cursors: { calendar?: string; todo?: string };
  }> {
    const calendar = await this.pull(cursors.calendar);
    const todoUrl = cursors.todo ?? `${this.#baseUrl}/me/todo/lists/${encodeURIComponent(this.#todoList.id)}/tasks/delta`;
    const response = await this.#request(todoUrl);
    if (!response.ok) throw new Error(`GRAPH_TODO_PULL_FAILED:${response.status}`);
    const body = await response.json() as {
      value?: Array<{ id?: string; title?: string; "@odata.etag"?: string }>;
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    const todoItems: ExternalItem[] = (body.value ?? []).filter((item) => item.id).map((item) => ({
      provider: "personal_graph_todo",
      externalId: item.id!,
      title: item.title ?? "(untitled)",
      ...(item["@odata.etag"] ? { etag: item["@odata.etag"] } : {})
    }));
    const todoCursor = body["@odata.nextLink"] ?? body["@odata.deltaLink"];
    return {
      items: [...calendar.items, ...todoItems],
      cursors: {
        ...(calendar.cursor ? { calendar: calendar.cursor } : {}),
        ...(todoCursor ? { todo: todoCursor } : {})
      }
    };
  }

  async push(mutation: ExternalMutation, idempotencyKey: string): Promise<PushReceipt> {
    if (!this.#writeEnabled) throw new Error("GRAPH_WRITE_SCOPE_NOT_ENABLED");
    const allowedKinds = new Set(["calendar.create", "calendar.update", "todo.create", "todo.update"]);
    if (!allowedKinds.has(mutation.kind)) throw new Error("GRAPH_MUTATION_NOT_ALLOWED");
    const payload = mutation.payload as GraphMutationPayload;
    if (payload.approved !== true) throw new Error("GRAPH_APPROVAL_REQUIRED");
    const updating = mutation.kind.endsWith(".update");
    if (updating && !mutation.etag) throw new Error("GRAPH_ETAG_REQUIRED");
    if (updating && !payload.externalId) throw new Error("GRAPH_EXTERNAL_ID_REQUIRED");

    const isCalendar = mutation.kind.startsWith("calendar.");
    const collectionUrl = isCalendar
      ? `${this.#baseUrl}/me/calendars/${encodeURIComponent(this.#calendar.id)}/events`
      : `${this.#baseUrl}/me/todo/lists/${encodeURIComponent(this.#todoList.id)}/tasks`;
    const url = updating ? `${collectionUrl}/${encodeURIComponent(payload.externalId!)}` : collectionUrl;
    const body = { ...(payload.body ?? {}) };
    if (isCalendar && !updating) body.transactionId = idempotencyKey;
    const response = await this.#request(url, {
      method: updating ? "PATCH" : "POST",
      headers: {
        "content-type": "application/json",
        "x-crossline-idempotency-key": idempotencyKey,
        ...(mutation.etag ? { "if-match": mutation.etag } : {})
      },
      body: JSON.stringify(body)
    });
    if (response.status === 409 || response.status === 412) throw new Error("GRAPH_SOURCE_VERSION_CONFLICT");
    if (!response.ok) throw new Error(`GRAPH_PUSH_FAILED:${response.status}`);
    const result = await response.json() as { id?: string };
    const externalId = result.id ?? payload.externalId;
    if (!externalId) throw new Error("GRAPH_EXTERNAL_ID_MISSING");
    return {
      provider: "personal_graph",
      externalId,
      status: "written",
      target: isCalendar ? "calendar:Crossline" : "todo:Crossline"
    };
  }

  async verify(receipt: PushReceipt): Promise<VerifyResult> {
    if (receipt.provider !== "personal_graph") return { verified: false, status: "provider_mismatch" };
    const collectionUrl = receipt.target === "todo:Crossline"
      ? `${this.#baseUrl}/me/todo/lists/${encodeURIComponent(this.#todoList.id)}/tasks`
      : `${this.#baseUrl}/me/calendars/${encodeURIComponent(this.#calendar.id)}/events`;
    const response = await this.#request(`${collectionUrl}/${encodeURIComponent(receipt.externalId)}`);
    return { verified: response.ok, status: response.ok ? "present" : `http_${response.status}` };
  }

  async health(): Promise<ConnectorHealth> {
    try {
      await this.#token();
      return { status: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "GRAPH_CREDENTIAL_UNAVAILABLE"
      };
    }
  }
}

export class ContentOpsConnector implements ConnectorAdapter {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(config: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {
    this.#baseUrl = config.baseUrl.replace(/\/$/, "");
    this.#token = config.token;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async probe(): Promise<CapabilityReport> {
    return { read: true, write: true, verify: true, targets: ["content_job"] };
  }

  async pull(): Promise<PullBatch> {
    return { items: [] };
  }

  async push(mutation: ExternalMutation, idempotencyKey: string): Promise<PushReceipt> {
    if (mutation.kind !== "content_job") throw new Error("CONTENT_OPS_MUTATION_NOT_ALLOWED");
    const response = await this.#fetch(`${this.#baseUrl}/v1/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey
      },
      body: JSON.stringify(mutation.payload)
    });
    if (!response.ok) throw new Error(`CONTENT_OPS_PUSH_FAILED:${response.status}`);
    const body = await response.json() as { job_id?: string };
    if (!body.job_id) throw new Error("CONTENT_OPS_JOB_ID_MISSING");
    return { provider: "content-ops", externalId: body.job_id, status: "accepted" };
  }

  async verify(receipt: PushReceipt): Promise<VerifyResult> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/jobs/${encodeURIComponent(receipt.externalId)}`, {
      headers: { authorization: `Bearer ${this.#token}` }
    });
    if (!response.ok) return { verified: false, status: `http_${response.status}` };
    const body = await response.json() as { status?: string };
    const status = body.status ?? "unknown";
    return { verified: ["completed", "failed", "blocked"].includes(status), status };
  }

  async health(): Promise<ConnectorHealth> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/health`, {
        headers: { authorization: `Bearer ${this.#token}` }
      });
      return {
        status: response.ok ? "healthy" : "degraded",
        checkedAt: new Date().toISOString(),
        ...(response.ok ? {} : { message: `HTTP ${response.status}` })
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "unknown connector error"
      };
    }
  }
}

export type GraphDeltaPage = {
  items: ExternalItem[];
  /** The `@odata.deltaLink` or `@odata.nextLink` to resume from. Absent means start over next time. */
  cursor?: string;
  /**
   * The server discarded the cursor and replayed the current state instead of the changes since.
   *
   * This matters more than it looks: after a resync, items deleted during the gap do NOT come back as
   * tombstones — they are simply absent. A caller that only applies `removed` flags would keep them
   * forever, so a resync must be treated as "this is the complete set now" and anything local that is
   * missing from it deleted.
   */
  resyncRequired?: boolean;
};

/**
 * Read-only access to the signed-in user's OWN calendar and task lists.
 *
 * Deliberately a separate class from `MicrosoftGraphConnector` rather than a flag on it. That connector
 * is hard-locked to targets literally named `Crossline` because it can write, and the lock is what
 * stops a write ever reaching a real calendar. Reading the user's actual calendar is the opposite job
 * on a different account, and it needs no lock because this class has no way to write at all — the
 * safety property is structural instead of conditional.
 */
/** The marker an event without a subject carries while its series title is looked up; shown, if it stays, in the reader's language. */
const UNTITLED = "(无标题)";
// One lookup per distinct series, capped so a first sync over a busy calendar cannot fan out.
const SERIES_LOOKUP_LIMIT = 50;

export class GraphReadSource {
  readonly #credential: GraphCredentialProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #pastDays: number;
  readonly #futureDays: number;
  readonly #calendarId: string | undefined;
  readonly #baseUrl = "https://graph.microsoft.com/v1.0";
  /** Series titles resolved so far. A long-running worker pays each lookup once. */
  readonly #seriesTitles = new Map<string, string>();
  readonly #t: (key: string) => string;

  constructor(config: {
    credential: GraphCredentialProvider;
    /**
     * Which calendar to read. Omitted means the account's default calendar.
     *
     * One instance reads one calendar, because `calendarView/delta` has no cursor that spans
     * calendars — each needs its own. Reading only the default one is how this class started, and an
     * event put on a newly created calendar was invisible with no way to tell from the outside: the
     * sync answered 「日历没有变化」, which was true and useless.
     */
    calendarId?: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    pastDays?: number;
    futureDays?: number;
    /** The language of the placeholders this reader writes (an untitled event, an unnamed calendar): the workspace's. */
    locale?: Locale;
  }) {
    this.#credential = config.credential;
    this.#t = tFor(config.locale);
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? (() => new Date());
    this.#pastDays = config.pastDays ?? 7;
    this.#futureDays = config.futureDays ?? 30;
    this.#calendarId = config.calendarId;
  }

  /** Every calendar this account can see, so the person can choose rather than guess. */
  async listCalendars(accountId: string): Promise<GraphCalendar[]> {
    const response = await this.#request(`${this.#baseUrl}/me/calendars?$select=id,name,isDefaultCalendar`);
    if (!response.ok) throw new Error(`GRAPH_READ_FAILED:${response.status}`);
    const body = await response.json() as { value?: Array<Record<string, unknown>> };
    return (body.value ?? [])
      .filter((row) => typeof row.id === "string")
      .map((row) => ({
        accountId,
        id: String(row.id),
        name: typeof row.name === "string" && row.name ? row.name : this.#t("(未命名日历)"),
        isDefault: row.isDefaultCalendar === true
      }));
  }

  async #request(url: string): Promise<Response> {
    const token = await this.#credential.getAccessToken();
    if (!token) throw new Error("GRAPH_CREDENTIAL_UNAVAILABLE");
    return this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
  }

  #calendarUrl(): string {
    const now = this.#now();
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCDate(start.getUTCDate() - this.#pastDays);
    end.setUTCDate(end.getUTCDate() + this.#futureDays);
    const params = new URLSearchParams({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
    const scope = this.#calendarId ? `/me/calendars/${encodeURIComponent(this.#calendarId)}` : "/me";
    return `${this.#baseUrl}${scope}/calendarView/delta?${params}`;
  }

  async #deltaWithSeries(url: string, provider: string, read: (row: Record<string, unknown>) => ExternalItem): Promise<GraphDeltaPage> {
    const { page, rows } = await this.#delta(url, provider, read);
    await this.#fillSeriesTitles(page.items, rows);
    for (const item of page.items) if (item.title === UNTITLED) item.title = this.#t(UNTITLED);
    return page;
  }

  async #delta(url: string, provider: string, read: (row: Record<string, unknown>) => ExternalItem): Promise<{ page: GraphDeltaPage; rows: Array<Record<string, unknown>> }> {
    const response = await this.#request(url);
    // 410 is the documented way Graph says "your cursor is too old"; it is a normal outcome of a worker
    // that was off for a while, not an error worth failing the tick over.
    if (response.status === 410) return { page: { items: [], resyncRequired: true }, rows: [] };
    if (!response.ok) throw new Error(`GRAPH_READ_FAILED:${response.status}`);
    const body = await response.json() as {
      value?: Array<Record<string, unknown>>;
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    const cursor = body["@odata.nextLink"] ?? body["@odata.deltaLink"];
    const rows = (body.value ?? []).filter((row) => typeof row.id === "string");
    const page: GraphDeltaPage = {
      items: rows.map((row) => ({
        ...read(row),
        provider,
        externalId: String(row.id),
        // Graph marks a deletion with an `@removed` annotation rather than omitting the row; a cancelled meeting is no commitment either.
        ...(row["@removed"] || row.isCancelled === true || /^\s*(canceled|cancelled|已取消)\s*[:：]/i.test(String(row.subject ?? "")) ? { removed: true } : {})
      })),
      ...(cursor ? { cursor } : {})
    };
    return { page, rows };
  }

  /**
   * Fills in titles for recurring occurrences.
   *
   * `calendarView/delta` returns an occurrence as a partial object — id, seriesMasterId, type, start,
   * end — because everything else is unchanged from its series master. The subject lives on the master.
   * Without this, a calendar made mostly of recurring classes imports as a wall of untitled blocks,
   * which is what a real UW calendar actually looks like: 12 of 21 events on the first real run.
   */
  async #fillSeriesTitles(items: ExternalItem[], rows: Array<Record<string, unknown>>): Promise<void> {
    const masterOf = new Map<string, string>();
    for (const [index, row] of rows.entries()) {
      const id = typeof row.id === "string" ? row.id : undefined;
      const title = items[index]?.title;
      if (id && title && title !== UNTITLED) masterOf.set(id, title);
    }
    const needed = new Map<string, number[]>();
    for (const [index, row] of rows.entries()) {
      const master = typeof row.seriesMasterId === "string" ? row.seriesMasterId : undefined;
      if (!master || items[index]?.title !== UNTITLED) continue;
      needed.set(master, [...(needed.get(master) ?? []), index]);
    }
    for (const [master, indexes] of needed) {
      let title = masterOf.get(master) ?? this.#seriesTitles.get(master);
      if (!title) {
        // Bounded: one lookup per distinct series, and only for series whose title is not already known.
        if (this.#seriesTitles.size >= SERIES_LOOKUP_LIMIT) break;
        try {
          const response = await this.#request(`${this.#baseUrl}/me/events/${encodeURIComponent(master)}?$select=id,subject`);
          if (!response.ok) continue;
          const body = await response.json() as { subject?: unknown };
          title = typeof body.subject === "string" && body.subject ? body.subject : undefined;
        } catch { continue; }
        if (!title) continue;
        this.#seriesTitles.set(master, title);
      }
      for (const index of indexes) {
        const item = items[index];
        if (item) item.title = title;
      }
    }
  }

  /** One page of the user's own calendar view. Pass the previous cursor to get only what changed. */
  async pullCalendar(cursor?: string): Promise<GraphDeltaPage> {
    return this.#deltaWithSeries(cursor ?? this.#calendarUrl(), "graph_calendar", (row) => {
      const start = row.start as { dateTime?: string; timeZone?: string } | undefined;
      const end = row.end as { dateTime?: string; timeZone?: string } | undefined;
      return {
        provider: "graph_calendar", externalId: "",
        title: typeof row.subject === "string" && row.subject ? row.subject : UNTITLED,
        ...(typeof row.iCalUId === "string" ? { iCalUid: row.iCalUId } : {}),
        ...(start?.dateTime ? { start: start.dateTime } : {}),
        ...(end?.dateTime ? { end: end.dateTime } : {}),
        ...(typeof row["@odata.etag"] === "string" ? { etag: row["@odata.etag"] } : {})
      };
    });
  }

  /** One page of a task list. `listId` is required because Graph has no delta over all lists at once. */
  async pullTodo(listId: string, cursor?: string): Promise<GraphDeltaPage> {
    const url = cursor ?? `${this.#baseUrl}/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
    return (await this.#delta(url, "graph_todo", (row) => ({
      provider: "graph_todo", externalId: "",
      title: typeof row.title === "string" && row.title ? row.title : this.#t(UNTITLED),
      ...(typeof row["@odata.etag"] === "string" ? { etag: row["@odata.etag"] } : {})
    }))).page;
  }
}
export * from "./crossline-calendar";
export * from "./web-push";
export * from "./calendar-edits";
export * from "./secret-file";
export * from "./ical";
export * from "./web-search";
export * from "./image-generation";
export * from "./imap-mail";

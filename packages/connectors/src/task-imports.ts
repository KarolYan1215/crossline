/**
 * Reading the person's own lists from Todoist, TickTick and Notion with a token they made for themselves (docs/personal-agent.md §9).
 * Read-only, except one call the person switches on per Todoist account: closing a task Crossline imported once it is finished here.
 * The hosts are fixed (never taken from a request), every answer is size-capped, and a refusal comes back as a typed error whose message
 * is a key of the catalogue, said in the account's language by the caller.
 *
 * - Todoist API v1 (https://developer.todoist.com/api/v1/): `GET /api/v1/tasks` and `/api/v1/projects`, paged by `cursor` →
 *   `{results, next_cursor}`; `POST /api/v1/tasks/{id}/close`. Personal token: Settings → Integrations → Developer.
 * - TickTick Open API (https://developer.ticktick.com/docs/openapi.md): `GET /open/v1/project`, `GET /open/v1/project/{id}/data`
 *   (`inbox` for the inbox). Personal token: Settings → Account → API Token.
 * - Notion API (https://developers.notion.com/reference): `POST /v1/search` for the databases shared with the integration,
 *   `POST /v1/databases/{id}/query` paged by `start_cursor`. Version header 2022-06-28, which Notion still serves for a database
 *   with one data source.
 */
export type ImportFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class TaskImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const TODOIST = "https://api.todoist.com/api/v1";
const TICKTICK = "https://api.ticktick.com/open/v1";
const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
/** Pages read from one service in one go: 50 pages of 200 is ten thousand tasks, more than a person keeps. */
const MAX_PAGES = 50;
const MAX_BYTES = 8_000_000;

const fetcher = (custom?: ImportFetch): ImportFetch => custom ?? ((url, init) => fetch(url, init) as unknown as ReturnType<ImportFetch>);

async function call(fetchImpl: ImportFetch, url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
  let response: Awaited<ReturnType<ImportFetch>>;
  try {
    response = await fetchImpl(url, { method: init.method ?? "GET", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  } catch { throw new TaskImportError("IMPORT_UNREACHABLE", "连不上这个服务，稍后再试。"); }
  if (response.status === 401 || response.status === 403) throw new TaskImportError("IMPORT_TOKEN_REFUSED", "令牌无效或已被撤销，请重新生成后再接入。");
  if (response.status === 404) throw new TaskImportError("IMPORT_NOT_FOUND", "找不到要读的内容：Notion 数据库要先分享给这个集成。");
  if (response.status === 429) throw new TaskImportError("IMPORT_RATE_LIMITED", "这个服务暂时限流，稍后再试。");
  if (!response.ok) throw new TaskImportError("IMPORT_FAILED", "这个服务没有正常回应，稍后再试。");
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new TaskImportError("IMPORT_TOO_LARGE", "读到的内容太大，没有导入。");
  try { return text ? JSON.parse(text) : undefined; } catch { throw new TaskImportError("IMPORT_FAILED", "这个服务没有正常回应，稍后再试。"); }
}
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown) => (Array.isArray(value) ? value : []);

async function todoistPages(fetchImpl: ImportFetch, token: string, path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = record(await call(fetchImpl, `${TODOIST}${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token));
    out.push(...list(answer.results));
    cursor = typeof answer.next_cursor === "string" ? answer.next_cursor : "";
    if (!cursor) break;
  }
  return out;
}

/** The person's open Todoist tasks and their projects. */
export async function readTodoist(token: string, fetchImpl?: ImportFetch): Promise<{ tasks: unknown[]; projects: unknown[] }> {
  const run = fetcher(fetchImpl);
  return { projects: await todoistPages(run, token, "/projects"), tasks: await todoistPages(run, token, "/tasks") };
}

/** Closes one Todoist task (its recurring next date, for a recurring one, as Todoist itself does). */
export async function closeTodoistTask(token: string, id: string, fetchImpl?: ImportFetch): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TaskImportError("IMPORT_FAILED", "这个服务没有正常回应，稍后再试。");
  await call(fetcher(fetchImpl), `${TODOIST}/tasks/${id}/close`, token, { method: "POST" });
}

/** Every TickTick list's undone tasks, the inbox first. */
export async function readTickTick(token: string, fetchImpl?: ImportFetch): Promise<Array<{ name: string; tasks: unknown[] }>> {
  const run = fetcher(fetchImpl);
  const projects = list(await call(run, `${TICKTICK}/project`, token)).map(record).filter((project) => typeof project.id === "string" && project.closed !== true);
  const out: Array<{ name: string; tasks: unknown[] }> = [];
  for (const project of [{ id: "inbox", name: "Inbox" }, ...projects].slice(0, MAX_PAGES)) {
    const data = record(await call(run, `${TICKTICK}/project/${encodeURIComponent(String(project.id))}/data`, token));
    out.push({ name: String(project.name ?? ""), tasks: list(data.tasks) });
  }
  return out;
}

/** The databases shared with the integration, newest edited first: `{id, title}`. */
export async function listNotionDatabases(token: string, fetchImpl?: ImportFetch): Promise<Array<{ id: string; title: string }>> {
  const answer = record(await call(fetcher(fetchImpl), `${NOTION}/search`, token, { method: "POST", headers: { "notion-version": NOTION_VERSION },
    body: { filter: { property: "object", value: "database" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 50 } }));
  return list(answer.results).map(record).filter((item) => typeof item.id === "string").map((item) => ({ id: String(item.id),
    title: list(item.title).map((part) => String(record(part).plain_text ?? "")).join("").trim() || "Untitled" }));
}

/** Every page of one Notion database. */
export async function readNotionDatabase(token: string, databaseId: string, fetchImpl?: ImportFetch): Promise<unknown[]> {
  if (!/^[A-Za-z0-9-]{32,36}$/.test(databaseId)) throw new TaskImportError("IMPORT_NOT_FOUND", "找不到要读的内容：Notion 数据库要先分享给这个集成。");
  const run = fetcher(fetchImpl);
  const out: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = record(await call(run, `${NOTION}/databases/${databaseId}/query`, token, { method: "POST", headers: { "notion-version": NOTION_VERSION },
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }));
    out.push(...list(answer.results));
    cursor = answer.has_more === true && typeof answer.next_cursor === "string" ? answer.next_cursor : "";
    if (!cursor) break;
  }
  return out;
}

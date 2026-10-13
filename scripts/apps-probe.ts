/**
 * What the local Codex runtime's apps (ChatGPT connectors) can read, called deterministically through `mcpServer/tool/call` with no
 * model turn (docs/loop-and-scout.md §13.2), and whether each calendar app is connected with the address to connect it. Read tools only — the allowlist below is the whole set; any other name throws. Output is
 * redacted: e-mail addresses keep their domain, titles become their length, ids keep six characters. The field names and the kinds of
 * values (reply status, organizer, iCalUID, recurring instances' original start, time formats) are kept, since that is what the
 * calendar design needs. Redacted raw answers are saved as fixtures for the apps parser tests.
 *
 *   pnpm exec tsx scripts/apps-probe.ts                 # the machine owner's runtime
 *   pnpm exec tsx scripts/apps-probe.ts --home <dir>    # a guest's runtime (its CODEX_HOME)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startCodexAppServer } from "../packages/codex/src/index";
import { CALENDAR_APPS, calendarAppStatuses } from "../packages/core/src/calendar-apps";

const READ_TOOLS = new Set([
  "google_calendar.get_profile", "google_calendar.list_calendars", "google_calendar.search_events",
  "microsoft_outlook_calendar.get_profile", "microsoft_outlook_calendar.list_calendars", "microsoft_outlook_calendar.list_events"
]);
const homeIndex = process.argv.indexOf("--home");
const home = homeIndex > 0 ? process.argv[homeIndex + 1] : undefined;
const fixtures = path.resolve(import.meta.dirname, "../apps/worker/src/testing/fixtures");

const ID_KEYS = /(^|_)(id|i_?cal_?u_?id|icaluid|series_?master_?id|etag|change_?key)$/i;
// Any key that names free text (title, display_title, summary, subject, name, description, location, preview, content, note) is replaced by its length.
const TEXT_KEYS = /(title|summary|subject|name|description|location|preview|content|note|body)$/i;
function redact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value !== "string") return value;
  // Free text first: a title or an HTML body can hold an address and still be private as a whole.
  if (TEXT_KEYS.test(key)) return `<text ${value.length}>`;
  if (ID_KEYS.test(key)) return `${value.slice(0, 6)}…`;
  if (/@/.test(value)) return value.replace(/[^@\s"]+@([\w.-]+)/g, "<user>@$1");
  if (/^https?:\/\//.test(value)) return `<url ${new URL(value).hostname}>`;
  return value;
}

const server = await startCodexAppServer(home);
const call = (method: string, params: unknown) => server.client.request(method, params);
try {
  const installed = await call("app/installed", { forceRefresh: true }) as { apps?: Array<{ id: string; runtimeName?: string; enabled: boolean; callable?: boolean }> };
  // Connect addresses come from `app/read` by id (packages/core/src/calendar-apps.ts). The directory `app/list` is not called: it meets
  // a Cloudflare challenge (403) on every attempt, and nothing needs it.
  const metadata = await call("app/read", { appIds: CALENDAR_APPS.map((item) => item.connectorId) });
  const calendarish = (installed.apps ?? []).filter((app) => /calendar|gmail|outlook|notion|drive/i.test(app.runtimeName ?? ""));
  console.log("installed:", calendarish.map((app) => `${app.runtimeName} enabled=${app.enabled} callable=${app.callable}`).join(" · ") || "(none)");
  for (const app of calendarAppStatuses(installed, metadata)) {
    console.log(`calendar app ${app.app}: connected=${app.connected} callable=${app.callable} installUrl=${app.installUrl ?? "(none)"}`);
  }

  const status = await call("mcpServerStatus/list", {}) as { data: Array<{ name: string; tools?: Record<string, { inputSchema?: unknown }> }> };
  const tools = status.data.find((item) => item.name === "codex_apps")?.tools ?? {};
  for (const name of READ_TOOLS) console.log(`schema ${name}:`, JSON.stringify((tools[name] as { inputSchema?: { properties?: object } } | undefined)?.inputSchema?.properties ?? "missing"));

  const thread = await call("thread/start", { cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "never", ephemeral: true }) as { thread: { id: string } };
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86_400_000);
  const read = async (tool: string, args: Record<string, unknown>) => {
    if (!READ_TOOLS.has(tool)) throw new Error(`APPS_PROBE_NOT_A_READ_TOOL ${tool}`);
    const started = performance.now();
    try {
      const result = await call("mcpServer/tool/call", { threadId: thread.thread.id, server: "codex_apps", tool, arguments: args }) as { structuredContent?: unknown; isError?: boolean; content?: unknown };
      const ms = Math.round(performance.now() - started);
      const body = redact(result.structuredContent ?? result.content);
      console.log(`${tool} ${result.isError ? "ERROR" : "ok"} ${ms} ms:`, JSON.stringify(body).slice(0, 1500));
      return body;
    } catch (error) {
      console.log(`${tool} FAILED:`, String(error).replace(/[^@\s"]+@([\w.-]+)/g, "<user>@$1").slice(0, 300));
      return undefined;
    }
  };
  await read("google_calendar.get_profile", {});
  await read("google_calendar.list_calendars", {});
  const google = await read("google_calendar.search_events", { time_min: now.toISOString(), time_max: week.toISOString() });
  await read("microsoft_outlook_calendar.list_calendars", {});
  const outlook = await read("microsoft_outlook_calendar.list_events", { start_datetime: now.toISOString(), end_datetime: week.toISOString() });

  mkdirSync(fixtures, { recursive: true });
  writeFileSync(path.join(fixtures, "apps-installed.json"), JSON.stringify(calendarish, null, 1));
  if (google) writeFileSync(path.join(fixtures, "apps-google-search-events.json"), JSON.stringify(google, null, 1));
  if (outlook) writeFileSync(path.join(fixtures, "apps-outlook-list-events.json"), JSON.stringify(outlook, null, 1));
  console.log("fixtures written to", fixtures);
} finally { server.stop(); }

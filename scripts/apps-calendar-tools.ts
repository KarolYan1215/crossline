/**
 * Which tools the calendar apps (ChatGPT connectors) expose to the local Codex runtime, listed only: no tool is called and no thread is
 * started (the owner's decision of 2026-11-10, path (c) of docs/calendar-write-setup.md — probe first, write only if create/update/delete
 * exist). Prints each `google_calendar.*` / `microsoft_outlook_calendar.*` tool's name, annotations, the first line of its description
 * and its argument names, so the writer's tool mapping (`apps/worker/src/google-calendar-writer.ts`) can be checked against it.
 *
 *   pnpm exec tsx scripts/apps-calendar-tools.ts                 # the machine owner's runtime
 *   pnpm exec tsx scripts/apps-calendar-tools.ts --home <dir>    # a guest's runtime (its CODEX_HOME)
 *   pnpm exec tsx scripts/apps-calendar-tools.ts --json <file>   # also save the list (names, annotations, schemas; no account data)
 */
import { writeFileSync } from "node:fs";
import { startCodexAppServer } from "../packages/codex/src/index";

const arg = (flag: string) => { const index = process.argv.indexOf(flag); return index > 0 ? process.argv[index + 1] : undefined; };
const server = await startCodexAppServer(arg("--home"));
try {
  const status = await server.client.request("mcpServerStatus/list", {}) as {
    data: Array<{ name: string; tools?: Record<string, { description?: string; annotations?: unknown; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> }> };
  const tools = status.data.find((item) => item.name === "codex_apps")?.tools ?? {};
  const calendar = Object.entries(tools).filter(([name]) => /^(google_calendar|microsoft_outlook_calendar)[._]/.test(name)).sort(([a], [b]) => a.localeCompare(b));
  if (!calendar.length) console.log("no calendar app tools (is the app connected in ChatGPT and this runtime signed in?)");
  for (const [name, tool] of calendar) {
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    const required = new Set(tool.inputSchema?.required ?? []);
    console.log(`${name}  annotations=${JSON.stringify(tool.annotations ?? null)}\n  ${(tool.description ?? "").split("\n")[0]!.slice(0, 160)}\n  args: ${props.map((p) => required.has(p) ? `${p}*` : p).join(", ") || "(none)"}`);
  }
  const out = arg("--json");
  if (out) writeFileSync(out, JSON.stringify(Object.fromEntries(calendar), null, 1));
} finally { server.stop(); }

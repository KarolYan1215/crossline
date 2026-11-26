/**
 * Every function a model can call in Crossline's own loops, with what it reads and what it does (the owner's decision of 2026-11-25,
 * docs/plans/harness-1125.md §10 「工具模式 Rule of Two」). The Rule of Two is computed from this table only: a run that has read
 * someone else's words (`untrusted`) while holding the person's private data keeps no function whose effect leaves the machine.
 *
 * - `reads`: `untrusted` — text someone else wrote (mail, web pages, a third party's service); `private` — the person's own board, files,
 *   facts or accounts; `none` — nothing beyond the run's own arguments.
 * - `effect`: `none`; `local_write` — files in the run's own task directory; `ledger_write` — the person's ledger (a capture, a message
 *   to them), carried out only after the run finishes; `outbound` — a request leaves the machine (a search query, a connector call).
 *
 * A function missing here is read as `untrusted` + `outbound` (`toolSpecOf`): the strictest reading, so forgetting to list a new
 * function withholds it from every tainted run instead of letting it through.
 */
export type ToolReads = "untrusted" | "private" | "none";
export type ToolEffect = "none" | "local_write" | "ledger_write" | "outbound";
/** `surface`: the loop that offers it — the assistant's tools mode (`apps/worker/src/agent-tools.ts`), the 小帮手's lookups, or the runtime. */
export type ToolSpec = { reads: ToolReads; effect: ToolEffect; surface: "assistant" | "concierge" | "runtime" };

const assistant = (reads: ToolReads, effect: ToolEffect): ToolSpec => ({ reads, effect, surface: "assistant" });
const concierge = (reads: ToolReads): ToolSpec => ({ reads, effect: "none", surface: "concierge" });

export const TOOL_SPEC: Readonly<Record<string, ToolSpec>> = {
  // The assistant's tools mode. Its inputs are classified when the run starts (`untrustedInputs`), so reading them is `private` here.
  list_files: assistant("private", "none"),
  read_file: assistant("private", "none"),
  write_file: assistant("none", "local_write"),
  copy_file: assistant("private", "local_write"),
  move_file: assistant("none", "local_write"),
  delete_file: assistant("none", "local_write"),
  list_documents: assistant("private", "none"),
  // The person's kept files; one that is someone else's words (a saved mail or page, a download) taints the run when read (`untrustedDocument`).
  read_document: assistant("private", "none"),
  list_tasks: assistant("private", "none"),
  read_task: assistant("private", "none"),
  list_facts: assistant("private", "none"),
  calendar: assistant("private", "none"),
  add_to_inbox: assistant("none", "ledger_write"),
  tell_person: assistant("none", "ledger_write"),
  // Search results carry opening lines of the body, so a search taints as a read does.
  mail_search: assistant("untrusted", "none"),
  mail_read: assistant("untrusted", "none"),
  // The runtime's: the web (hosted search, or Crossline's stand-in functions on a provider) and the person's ChatGPT connectors, read-only
  // by the runtime's approval mode, but every call is a request to a third party's service.
  web_search: { reads: "untrusted", effect: "outbound", surface: "runtime" },
  web_fetch: { reads: "untrusted", effect: "outbound", surface: "runtime" },
  connectors: { reads: "private", effect: "outbound", surface: "runtime" },
  // The 小帮手's lookups (`CONCIERGE_TOOL_SPECS`): all read the person's own pack or ledger; its ops are carried out by the web on a click.
  find_tasks: concierge("private"),
  get_task: concierge("private"),
  find_milestones: concierge("private"),
  list_asks: concierge("private"),
  get_plan: concierge("private"),
  list_recent_ops: concierge("private"),
  list_agent_results: concierge("private"),
  get_forecast: concierge("private"),
  find_materials: concierge("private"),
  list_projects: concierge("private"),
  read_material: concierge("private"),
  get_profile_facts: concierge("private"),
  find_system_part: concierge("private"),
  get_instructions: concierge("private"),
  list_settings: concierge("private"),
  ledger_query: concierge("private")
};

const UNLISTED: ToolSpec = { reads: "untrusted", effect: "outbound", surface: "runtime" };
/** A function's entry, or the strictest reading when it has none (fail-closed). */
export const toolSpecOf = (name: string): ToolSpec => Object.hasOwn(TOOL_SPEC, name) ? TOOL_SPEC[name]! : UNLISTED;

/**
 * The Rule of Two over a run's functions: given what it offers and whether it has read someone else's words, the functions it must not
 * keep. Private data + untrusted content + an outbound effect is the one combination refused; the outbound functions go, since they are
 * the channel an injected instruction would use to carry the private data out.
 */
export function withheldByRuleOfTwo(offered: readonly string[], run: { tainted: boolean }): string[] {
  // `tainted` is what the run has read, not what it could read: a mailbox on offer is not yet mail in its context. What the web itself
  // returns is not counted here — the outbound functions are the web, and a hosted search's results never pass through Crossline.
  const holdsPrivate = offered.some((name) => toolSpecOf(name).reads === "private");
  if (!holdsPrivate || !run.tainted) return [];
  return offered.filter((name) => toolSpecOf(name).effect === "outbound");
}

/**
 * Where a capture came from when a model wrote it after reading someone else's words (stored on `capture.created` and copied onto the
 * work order as `payload.provenance`): which run (`run`, the assistant's task id or `mail-triage`), who (`by`), and what it read.
 * Read by `autoApprovalEligible`, which holds such work for the person when it is high-risk (`taintedRisk`).
 */
export type TaintSource = "mail" | "page" | "site" | "document" | "download" | "flow" | "connector";
export type CaptureProvenance = { run: string; by: "assistant" | "mail_triage"; tainted: boolean; sources: TaintSource[] };
const SOURCES: readonly TaintSource[] = ["mail", "page", "site", "document", "download", "flow", "connector"];
export function readProvenance(value: unknown): CaptureProvenance | undefined {
  const raw = value as Partial<CaptureProvenance> | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.tainted !== "boolean") return undefined;
  return { run: typeof raw.run === "string" ? raw.run.slice(0, 80) : "", by: raw.by === "mail_triage" ? "mail_triage" : "assistant", tainted: raw.tainted,
    sources: Array.isArray(raw.sources) ? raw.sources.filter((source): source is TaintSource => SOURCES.includes(source as TaintSource)) : [] };
}

/** Files that are someone else's words: mail and saved web pages (as `classifyAgentRun` reads a shell run's inputs). */
const UNTRUSTED_FILE = /\.(eml|msg|mbox|html?|mhtml?|webarchive|url)$/i;
/** What a file in a run's inputs or the person's kept files is, when it is someone else's words; undefined for the person's own. */
export function untrustedFile(location: string): TaintSource | undefined {
  const normal = location.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)downloads\//.test(normal)) return "download";
  if (UNTRUSTED_FILE.test(normal)) return /\.(eml|msg|mbox)$/.test(normal) ? "mail" : "page";
  return undefined;
}

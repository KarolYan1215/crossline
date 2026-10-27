// i18n-exempt: the ledger lookup answers the model (read_ledger), never the person
import { createHash } from "node:crypto";
import { CONTEXT_BUDGETS, LEDGER_READ_BUDGET } from "@crossline/core";
import type { SkillTools } from "@crossline/codex";

/**
 * Ledger entries as an index plus a lookup (token-economy.md §2, decided 2026-10-21): on a route that calls functions a run is handed
 * one short line per entry — its id, a label and the first `CONTEXT_BUDGETS.ledgerSummary` characters — and reads the ones it needs whole
 * with `read_ledger(ids)`, within `LEDGER_READ_BUDGET` a run. The same idea as the material lookups (`selectMaterial`), for the person's
 * facts and the board's open tasks. A route that cannot call functions keeps getting the entries whole; the caller builds that fallback.
 */
export type LedgerEntry = { id: string; label: string; text: string };

/** One line as the index lists it: whole when it is short, else cut with 「…」 (the sign that `read_ledger` has the rest). */
export function ledgerSummary(text: string, limit: number = CONTEXT_BUDGETS.ledgerSummary): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** A short id that stays the same for the same key across runs (a fact's line, project and slot), so an index reads the same each time. */
export function ledgerId(prefix: string, key: string, taken?: Set<string>): string {
  const hash = createHash("sha256").update(key).digest("hex");
  for (let length = 5; length <= hash.length; length += 1) {
    const id = `${prefix}${hash.slice(0, length)}`;
    if (!taken || !taken.has(id)) { taken?.add(id); return id; }
  }
  return `${prefix}${hash}`;
}

export const READ_LEDGER_INSTRUCTIONS = "Lines that end in 「…」 are cut short. When a cut line could change the plan (a constraint, a target, "
  + "a rule, what an open task already covers), read it whole with read_ledger(ids), several ids in one call. Do not read lines that are "
  + "already whole, and do not read just to be thorough: the lookup has a small budget per run.";

export function ledgerLookup(entries: LedgerEntry[], budget: number = LEDGER_READ_BUDGET) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let chars = 0, calls = 0;
  const read = new Set<string>();
  const tools: SkillTools = {
    specs: [{ name: "read_ledger", description: "Read ledger entries whole by their ids (a fact such as f3a9c1, an open task by its id, a "
      + "profile line such as h2, a cross-line link such as r1). Returns each entry's full text; unknown ids are named as such.",
      inputSchema: { type: "object", additionalProperties: false, required: ["ids"], properties: {
        ids: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 120 } } } } }],
    call: (name, args) => {
      if (name !== "read_ledger") throw new Error(`没有名为 ${name} 的工具`);
      calls += 1;
      const ids = Array.isArray((args as { ids?: unknown } | undefined)?.ids) ? ((args as { ids: unknown[] }).ids).map(String).slice(0, 20) : [];
      if (!ids.length) return "请给出要读取的条目 id。";
      const out: string[] = [];
      for (const id of ids) {
        const entry = byId.get(id.trim());
        if (!entry) { out.push(`${id}：没有这个 id 的条目。`); continue; }
        const text = `${entry.id} ${entry.label}：${entry.text}`;
        if (chars + text.length > budget) {
          out.push(`本次读取已到上限（约 ${Math.round(budget / 1000)} 千字）。用已读到的内容完成；仍需要而没读到的，按索引里的摘要处理。`);
          break;
        }
        chars += text.length;
        read.add(entry.id);
        out.push(text);
      }
      return out.join("\n");
    }
  };
  return { tools, stats: () => ({ readCalls: calls, readChars: chars, readIds: read.size }) };
}

/** Two sets of tools offered as one (a run's optional lookups are one `SkillTools`). */
export function mergeTools(...sets: SkillTools[]): SkillTools {
  const owner = new Map<string, SkillTools>();
  for (const set of sets) for (const spec of set.specs) if (!owner.has(spec.name)) owner.set(spec.name, set);
  return { specs: sets.flatMap((set) => set.specs.filter((spec) => owner.get(spec.name) === set)),
    call: (name, args) => { const set = owner.get(name); if (!set) throw new Error(`没有名为 ${name} 的工具`); return set.call(name, args); } };
}

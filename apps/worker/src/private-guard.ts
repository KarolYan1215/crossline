import type { PrivateGuard } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import { pinyin } from "pinyin-pro";
import { profileValues } from "./form-profile";

/**
 * The person's private strings for the outbound search checks (docs/plans/harness-1125.md §10; `webQueryProblem` in core), read from the
 * ledger and the profile card's secret store for each check and handed back in memory only: never stored, logged or sent anywhere.
 *
 * - `terms`: what identifies the person — the profile card's name, preferred name, email (and its local part, often reused as a handle),
 *   personal site and GitHub, the sensitive items this worker holds (phone, birth date, student id, address, id and passport numbers), and
 *   the same kinds of confirmed facts the interview kept (`name`, `email`, …); a Chinese name also as its pinyin (`nameRomanizations`).
 * - `passages`: what the portrait, the profile model and the confirmed facts say, refused when a query copies a long run of one.
 */
const IDENTIFYING_SLOTS = new Set(["full_name", "preferred_name", "email", "website", "github"]);
const IDENTIFYING_FACTS = /^(apply\.)?(full_name|preferred_name|name|english_name|email|phone|student_id|address|website|github|wechat|qq)$/;
const NAME_SLOTS = /^(apply\.)?(full_name|preferred_name|name)$/;
const HAN_NAME = /^[\p{Script=Han}]{2,4}$/u;

/**
 * A Chinese full name as it is written in Latin letters (gap of 2026-11-25, harness-1125.md §17): the syllables spaced, surname first and
 * surname last, the surname read as a surname (单 shan, 曾 zeng), split after one character and, for three or more, after two (欧阳);
 * ü as v, u and yu. Only the whole name: one syllable or the given name alone is too common to refuse (「Yan」, 「Ming」).
 */
export function nameRomanizations(name: string): string[] {
  const han = name.replace(/[\s·・]/gu, "");
  if (!HAN_NAME.test(han)) return [];
  const syllables = pinyin(han, { toneType: "none", type: "array", surname: "head" });
  if (syllables.length !== han.length) return [];
  const out = new Set<string>();
  for (const split of han.length >= 3 ? [1, 2] : [1]) {
    const surname = syllables.slice(0, split), given = syllables.slice(split);
    for (const order of [[...surname, ...given], [...given, ...surname]]) {
      const spaced = order.join(" ");
      for (const u of ["v", "u", "yu"]) out.add(spaced.replace(/ü/g, u));
    }
  }
  return [...out];
}

/** Every string leaf of a JSON value, for a portrait or a profile model whose shape changes by version. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") { if (value.trim()) out.push(value); }
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, out);
  return out;
}
const settingJson = (store: CrosslineStore, workspaceId: string, key: string): unknown => {
  try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null"); } catch { return null; }
};

export async function privateGuardFor(store: CrosslineStore, secrets: SecretStore | undefined, workspaceId: string): Promise<PrivateGuard> {
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed");
  const terms: string[] = [];
  const names: string[] = [];
  for (const fact of facts) if (IDENTIFYING_FACTS.test(fact.slot)) { terms.push(fact.value); if (NAME_SLOTS.test(fact.slot)) names.push(fact.value); }
  if (secrets) {
    const values = profileValues(store, secrets, workspaceId, "here");
    for (const slot of IDENTIFYING_SLOTS) {
      const value = await values.get(slot as never).catch(() => undefined);
      if (value) { terms.push(value); if (slot !== "email" && slot !== "website" && slot !== "github") names.push(value); }
    }
    for (const held of await values.sensitive().catch(() => [])) terms.push(held.value);
  }
  for (const name of names) terms.push(...nameRomanizations(name));
  for (const email of terms.filter((term) => /^[^@\s]+@[^@\s]+$/.test(term.trim()))) {
    const local = email.trim().split("@")[0]!;
    if (local.length >= 6) terms.push(local);
  }
  // Short confirmed values that are not identifiers (a school, an employer, a city, a year): two of them together narrow a search to the
  // person (`details`). Assumptions and the long answers kept under a question are not details.
  const details = facts.filter((fact) => !IDENTIFYING_FACTS.test(fact.slot) && !fact.slot.startsWith("person_answer_") && !fact.value.startsWith("假设")) // i18n-ignore
    .map((fact) => fact.value.trim()).filter((value) => value.length >= 2 && value.length <= 24 && !/[,，；;。]/.test(value));
  const passages = [...facts.map((fact) => fact.value), ...stringLeaves(settingJson(store, workspaceId, "portrait.report")),
    ...stringLeaves(settingJson(store, workspaceId, "profile.model"))];
  return { terms: [...new Set(terms.map((term) => term.trim()).filter(Boolean))], passages, details: [...new Set(details)] };
}

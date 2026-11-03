/**
 * Visa checks for the time–space engine (docs/opportunity-agent.md §17.6, track ②). A small Skill (`crossline-visa-finder`) finds the
 * official page for the person's confirmed citizenship and the destination and copies its sentences; code opens the page, finds each quote
 * in it, and works out the lead time from the processing-time sentence itself. The model never states a number of days. An answer that
 * cannot be checked falls back to `VISA_LEAD_FALLBACK_DAYS`, unverified.
 */
import { VISA_CACHE_DAYS, VISA_LEAD_FALLBACK_DAYS, type VisaCheck } from "./opportunity-watch";
import { countryKey } from "./feasibility";

export const VISA_CACHE_SETTING = "visa.cache";
/** Days added to a stated processing time for booking an appointment and the passport's return. */
export const VISA_MARGIN_DAYS = 14;

export type VisaPage = { url: string; needed: "yes" | "no" | "unknown"; quote: string; processingQuote: string };
export type VisaReading = { pages: VisaPage[] };
export const VISA_READING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pages"], properties: {
    pages: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["url", "needed", "quote", "processingQuote"], properties: {
      url: { type: "string", maxLength: 400 },
      needed: { type: "string", enum: ["yes", "no", "unknown"] },
      quote: { type: "string", maxLength: 400 },
      processingQuote: { type: "string", maxLength: 400 } } } } }
} as const;

/** The shape code can check: https pages on an official host, each with its quote; a verdict needs its sentence. An empty list is valid. */
export function validateVisaReading(output: VisaReading): VisaReading {
  const problems: string[] = [];
  for (const page of output.pages ?? []) {
    let host = "";
    try { const url = new URL(page.url); host = url.protocol === "https:" ? url.hostname : ""; } catch { /* below */ }
    if (!host) problems.push(`${page.url}: not an https address`);
    else if (!officialVisaHost(host)) problems.push(`${page.url}: not a government host; give only official pages, or none`);
    if (page.needed !== "unknown" && !page.quote.trim()) problems.push(`${page.url}: needed is ${page.needed} without the sentence that says so`);
  }
  if (problems.length) throw new Error(`VISA_READING_INVALID: ${problems.join("; ")}`);
  return output;
}

/**
 * A government page: a government or intergovernmental suffix (`.gov`, `.gov.cn`, `.gouv.fr`, `.go.jp`, `.gc.ca`, `.admin.ch`,
 * `europa.eu`, `.int`) or a foreign ministry's known host. An embassy or a visa centre on a commercial domain is not taken as official.
 */
// i18n-ignore-start: host patterns
const OFFICIAL = /(^|\.)(gov|gouv|go|gob|gv|govt|gc|admin|bund|regjeringen)\.[a-z]{2}$|(^|\.)gov$|(^|\.)europa\.eu$|(^|\.)[a-z-]+\.int$|(^|\.)(auswaertiges-amt|diplo|mfa|mofa|state)\.(de|gov|go\.kr|gov\.cn|gov\.sg)$|(^|\.)canada\.ca$|(^|\.)ind\.nl$|(^|\.)migrationsverket\.se$|(^|\.)netherlandsworldwide\.nl$|(^|\.)bmeia\.gv\.at$/i;
// i18n-ignore-end
export const officialVisaHost = (host: string): boolean => OFFICIAL.test(host.toLowerCase());

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
/**
 * The days a processing-time sentence states, worst case: 「15 working days」 → 21, 「up to 8 weeks」 → 56, 「3 个月」 → 90, 「10 个工作日」 → 14.
 * A range takes its upper end. Undefined when the sentence gives no time.
 */
export function processingDays(quote: string): number | undefined {
  const text = quote.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty)\b/g, (word) => String(WORDS[word]));
  let worst: number | undefined;
  // i18n-ignore: units read from official pages
  const pattern = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to|至|到|~)\s*(\d+(?:\.\d+)?))?\s*(?:个)?\s*(working days?|business days?|calendar days?|days?|weeks?|months?|工作日|天|日|周|星期|个月|月)/g;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[2] ?? match[1]);
    const unit = match[3]!;
    const days = /working|business|工作日/.test(unit) ? Math.ceil(amount * 7 / 5) : /week|周|星期/.test(unit) ? amount * 7 : /month|月/.test(unit) ? amount * 30 : amount;
    if (days > 0 && days <= 365) worst = Math.max(worst ?? 0, Math.ceil(days));
  }
  return worst;
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const inPage = (quote: string, page: string) => Boolean(quote.trim()) && squash(page).includes(squash(quote));

/**
 * One page's verdict, as code: official host, the quote found in the page's text, and the lead worked out from the processing sentence.
 * `needed: no` with its quote found is verified with no lead; `yes` with a processing time found is verified with that time plus the
 * margin; `yes` without one keeps the source but the fallback lead, unverified.
 */
export function visaCheckFrom(page: VisaPage, pageText: string, checkedAt: string): VisaCheck | undefined {
  let host = "";
  try { host = new URL(page.url).hostname; } catch { return undefined; }
  if (!officialVisaHost(host) || !inPage(page.quote, pageText)) return undefined;
  const base = { sourceUrl: page.url, quote: page.quote.trim().slice(0, 300), checkedAt };
  if (page.needed === "no") return { ...base, needed: false, leadDays: 0, verified: true };
  if (page.needed !== "yes") return undefined;
  const days = inPage(page.processingQuote, pageText) ? processingDays(page.processingQuote) : undefined;
  return days !== undefined ? { ...base, needed: true, leadDays: days + VISA_MARGIN_DAYS, verified: true }
    : { ...base, needed: true, leadDays: VISA_LEAD_FALLBACK_DAYS, verified: false };
}

export const visaKey = (citizenship: string, destination: string) => `${countryKey(citizenship)}>${countryKey(destination)}`;
export type VisaCache = Record<string, VisaCheck>;
export function readVisaCache(raw: string | null | undefined): VisaCache {
  try { const parsed = JSON.parse(raw ?? "{}") as VisaCache; return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
/** A cached reading still in force: a verified one for `VISA_CACHE_DAYS`, an unverified one for a week before it is looked up again. */
export function freshVisa(cache: VisaCache, citizenship: string, destination: string, now: Date): VisaCheck | undefined {
  const entry = cache[visaKey(citizenship, destination)];
  if (!entry) return undefined;
  const age = (now.getTime() - Date.parse(entry.checkedAt)) / 86_400_000;
  return age <= (entry.verified ? VISA_CACHE_DAYS : 7) ? entry : undefined;
}

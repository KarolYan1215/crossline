/**
 * The inferences a portrait rests on (contract B of the interview redesign, 2026-11-12), shared by the interview's extraction, which keeps
 * the hypothesis log in `profile.model`, and the portrait report, which closes on them. Kept apart from both so neither imports the other.
 *
 * The ten dimensions (research-portrait-framework, 2026-11-12): McAdams's three layers plus the situation, with the if-then signatures and
 * the goal–progress–emotion loop running through them, closed by a case formulation (D9).
 */
export const DIMENSION_IDS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] as const;
export type DimensionId = (typeof DIMENSION_IDS)[number];
export const PORTRAIT_DIMENSION_LABEL: Record<DimensionId, string> = {
  D0: "背景与约束", D1: "行为签名", D2: "内隐动机", D3: "基本需求", D4: "价值与三观",
  D5: "理想与应该自我", D6: "核心信念", D7: "情绪模式", D8: "叙事身份", D9: "维持循环"
};
export const HYPOTHESIS_STATUSES = ["open", "supported", "refuted", "undecided"] as const;
export const BASIS_KINDS = ["quote", "behavior", "external"] as const;
/**
 * One inference about the person: the extraction rewrites the whole list every run, keeping each id across runs. `basis` is what it rests
 * on — the person's words (`quote`, verbatim in the reply or file `ref` names), what they did (`behavior`), or outside data (`external`,
 * `ref` a URL). `reference` is data on people like them, only with a URL. `rated` is the person's 准/不准, filled in by code, never by
 * the model.
 */
export type Hypothesis = {
  id: string;
  dimension: DimensionId;
  statement: string;
  basis: Array<{ kind: (typeof BASIS_KINDS)[number]; text: string; ref: string }>;
  falsifier: string;
  alternative: string;
  status: (typeof HYPOTHESIS_STATUSES)[number];
  reference?: { text: string; url: string };
  rated?: "fits" | "off" | "partial";
  /**
   * The observation card that asked the person about it (`session#seq`, 2026-11-12: every card is one hypothesis of this log) and, when
   * they said 「准」 or 「部分对」, the point it put in the ledger. A hypothesis the person rated 准 or 不准 on a card is theirs: the
   * extraction no longer rewrites it.
   */
  cardKey?: string;
  pointId?: string;
};
/**
 * A career direction drawn from the portrait: the role, why (citing hypothesis ids), how often public job ads ask for each requirement
 * against the person's evidence (`sources` the ads' URLs), and a 2–4 week trial that can refute it, hung on one of their lines.
 *
 * Two layers since 2026-11-12 (replay 5 listed 四大审计寒假实习 and 四大审计日常实习 as two directions): the direction is an industry and
 * a function under a stable `id`; the ways in (a winter internship, a part-time one, graduate hiring) are its `entries`. A run changes a
 * direction by its id and says why (`change`); a new one says how it differs from the others (`differs`), and one whose industry and
 * function are already on record joins that one. `log` is each change with its reason. All optional: a direction written before has none.
 */
export type CareerOption = {
  id?: string;
  industry?: string;
  function?: string;
  entries?: string[];
  change?: string;
  differs?: string;
  log?: Array<{ at: string; why: string }>;
  role: string;
  why: string;
  hypothesisIds: string[];
  requirements: Array<{ requirement: string; share: string; has: "yes" | "partial" | "no"; evidence: string }>;
  sources: string[];
  trial: { weeks: number; task: string; supportsIf: string; refutesIf: string };
  lineId: string;
};
export type DimensionNote = { id: DimensionId; summary: string; evidenced: boolean };

/** A URL a person can open: http or https, nothing else. */
export const isWebUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return false;
  try { return Boolean(new URL(value.trim()).hostname); } catch { return false; }
};
export const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => (values as readonly string[]).includes(String(value));
const str = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
/** Letters and digits only, for comparing a quote with its source (a quote survives a line break or Markdown around it). */
const loose = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");
const HYPOTHESIS_ID = /^[a-zA-Z0-9_-]{1,12}$/;

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max }) as const;
export const URL_FIELD = { type: "string", minLength: 8, maxLength: 500 } as const;
export const DIMENSION_FIELD = { type: "string", enum: [...DIMENSION_IDS] } as const;
const HYPOTHESIS_REF = { type: "string", minLength: 1, maxLength: 12 } as const;
export const HYPOTHESIS_ITEM_FIELD = object({
  id: HYPOTHESIS_REF, dimension: DIMENSION_FIELD, statement: text(400),
  basis: { type: "array", maxItems: 8, items: object({ kind: { type: "string", enum: [...BASIS_KINDS] }, text: text(300), ref: text(500) }) },
  falsifier: text(300), alternative: { type: "string", maxLength: 300 }, status: { type: "string", enum: [...HYPOTHESIS_STATUSES] },
  reference: { anyOf: [object({ text: text(300), url: URL_FIELD }), { type: "null" }] }
});
/** A career direction; `line` is the field a line id is written in (an enum of the person's lines when the caller knows them). */
export const careerItemSchema = (line: unknown = { type: "string", maxLength: 80 }) => object({
  id: { type: "string", maxLength: 12 }, industry: { type: "string", maxLength: 60 }, function: { type: "string", maxLength: 60 },
  entries: { type: "array", maxItems: 6, items: text(120) }, change: { type: "string", maxLength: 300 }, differs: { type: "string", maxLength: 300 },
  role: text(120), why: text(600), hypothesisIds: { type: "array", maxItems: 8, items: HYPOTHESIS_REF },
  requirements: { type: "array", maxItems: 12, items: object({ requirement: text(200), share: { type: "string", maxLength: 40 },
    has: { type: "string", enum: ["yes", "partial", "no"] }, evidence: { type: "string", maxLength: 300 } }) },
  sources: { type: "array", maxItems: 10, items: URL_FIELD },
  trial: object({ weeks: { type: "integer", minimum: 2, maximum: 4 }, task: text(400), supportsIf: text(300), refutesIf: text(300) }),
  lineId: line
});
export const DIMENSION_NOTE_FIELD = object({ id: DIMENSION_FIELD, summary: { type: "string", maxLength: 400 }, evidenced: { type: "boolean" } });

// ── Keeping what holds ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The hypotheses that are what they claim; never a refusal, an item that does not hold is dropped and the rest kept. Each needs a stable
 * id (once), a known dimension and status, a statement and a falsifier. A `basis` item is kept only when it holds: a `quote` verbatim in
 * the text its `ref` names (`textOf`; when the caller has no texts, `undefined` keeps every quote), an `external` one with a web URL as
 * `ref`; a hypothesis with no basis left goes. A `reference` without a web URL goes. `rated` comes from the caller's record (`ratedOf`),
 * never from the model.
 */
export function cleanHypotheses(list: unknown[], textOf?: (ref: string) => string | undefined, ratedOf?: (id: string) => Hypothesis["rated"]): Hypothesis[] {
  const ids = new Set<string>();
  return list.flatMap((raw): Hypothesis[] => {
    const item = raw as Partial<Hypothesis> | null;
    const id = str(item?.id, 12);
    const statement = str(item?.statement, 400), falsifier = str(item?.falsifier, 300);
    if (!HYPOTHESIS_ID.test(id) || ids.has(id) || !statement || !falsifier || !oneOf(DIMENSION_IDS, item?.dimension) || !oneOf(HYPOTHESIS_STATUSES, item?.status)) return [];
    const basis = (Array.isArray(item?.basis) ? item!.basis : []).flatMap((entry) => {
      const kind = entry?.kind, quote = str(entry?.text, 300), ref = str(entry?.ref, 500);
      if (!quote || !oneOf(BASIS_KINDS, kind)) return [];
      if (kind === "quote" && textOf) { const source = textOf(ref); if (source === undefined || !loose(quote) || !loose(source).includes(loose(quote))) return []; }
      if (kind === "external" && !isWebUrl(ref)) return [];
      return [{ kind, text: quote, ref }];
    });
    if (!basis.length) return [];
    ids.add(id);
    const reference = item?.reference && isWebUrl(item.reference.url) && str(item.reference.text, 300)
      ? { text: str(item.reference.text, 300), url: item.reference.url.trim() } : undefined;
    const rated = ratedOf?.(id);
    return [{ id, dimension: item!.dimension!, statement, basis, falsifier, alternative: str(item?.alternative, 300), status: item!.status!,
      ...(reference ? { reference } : {}), ...(rated ? { rated } : {}) }];
  });
}

/**
 * The career directions that hold: a role and a trial; only web URLs in `sources`, and with none the requirement matrix goes too (a share
 * no job ad stands behind is invented). Hypothesis ids only those in `hypothesisIds`; a line not in `lines` leaves it unattached (`lineId` "").
 */
export function cleanCareers(list: unknown[], hypothesisIds: ReadonlySet<string>, lines: ReadonlySet<string>): CareerOption[] {
  return list.flatMap((raw): CareerOption[] => {
    const item = raw as Partial<CareerOption> | null;
    const role = str(item?.role, 120);
    if (!role || !item?.trial || typeof item.trial !== "object") return [];
    const urls = [...new Set((Array.isArray(item.sources) ? item.sources : []).filter(isWebUrl).map((url) => url.trim()))];
    const requirements = urls.length ? (Array.isArray(item.requirements) ? item.requirements : []).flatMap((entry) => {
      const requirement = str(entry?.requirement, 200);
      return requirement && oneOf(["yes", "partial", "no"] as const, entry?.has)
        ? [{ requirement, share: str(entry.share, 40), has: entry.has, evidence: str(entry.evidence, 300) }] : [];
    }) : [];
    const id = str(item.id, 12), industry = str(item.industry, 60), func = str(item.function, 60), change = str(item.change, 300), differs = str(item.differs, 300);
    const entries = [...new Set((Array.isArray(item.entries) ? item.entries : []).map((entry) => str(entry, 120)).filter(Boolean))].slice(0, 6);
    return [{ ...(HYPOTHESIS_ID.test(id) ? { id } : {}), ...(industry ? { industry } : {}), ...(func ? { function: func } : {}), ...(entries.length ? { entries } : {}),
      ...(change ? { change } : {}), ...(differs ? { differs } : {}), role, why: str(item.why, 600), hypothesisIds: (Array.isArray(item.hypothesisIds) ? item.hypothesisIds : []).filter((id) => hypothesisIds.has(id)),
      requirements, sources: urls,
      trial: { weeks: Math.max(2, Math.min(4, Math.round(Number(item.trial.weeks) || 2))), task: str(item.trial.task, 400),
        supportsIf: str(item.trial.supportsIf, 300), refutesIf: str(item.trial.refutesIf, 300) },
      lineId: typeof item.lineId === "string" && lines.has(item.lineId) ? item.lineId : "" }];
  });
}

/** Dimension notes with known ids, each once, in the dimensions' order. */
export function cleanDimensionNotes(list: unknown[]): DimensionNote[] {
  const byId = new Map<DimensionId, DimensionNote>();
  for (const raw of list) {
    const item = raw as Partial<DimensionNote> | null;
    if (oneOf(DIMENSION_IDS, item?.id) && !byId.has(item!.id!)) byId.set(item!.id!, { id: item!.id!, summary: str(item!.summary, 400), evidenced: item!.evidenced === true });
  }
  return DIMENSION_IDS.flatMap((id) => byId.get(id) ?? []);
}

// ── Merging a run's changes ──────────────────────────────────────────────────────────────────────────────────────────

/** Whether the person settled a hypothesis on its card (准 or 不准): the extraction leaves it as it is. */
export const settledOnCard = (item: Pick<Hypothesis, "cardKey" | "rated">): boolean => Boolean(item.cardKey && (item.rated === "fits" || item.rated === "off"));

/**
 * A run's changes merged into what is on record (2026-11-12): the extraction writes only the hypotheses, careers and dimension notes that
 * are new or changed, instead of the whole lists every run (a run rewrote 40 hypotheses and every requirement matrix to change one or two;
 * replay 3 spent 27 minutes and 26k output tokens on one run). A hypothesis replaces the one with its id, or joins the end; the person's
 * rating and its card stay with the id, and one they settled on its card is not rewritten (`settledOnCard`). A dimension note replaces the
 * one with its id. What the run did not name stays as it was.
 *
 * A career is matched by its id, else by its industry and function, else by its role (letters and digits compared): a match is replaced
 * only with a reason (`change`, kept in its `log`), and keeps its id and every entry either side named; without a reason only the entries
 * are added. No match joins the end under a new id (`k<n>`), with `differs` as its first log line. A direction on record without an id is
 * given one here. `dropCareers` removes by id or role.
 */
export function mergeProfileInsights(
  onRecord: { hypotheses?: Hypothesis[]; careers?: CareerOption[]; dimensions?: DimensionNote[] },
  changes: { hypotheses?: Hypothesis[]; careers?: CareerOption[]; dimensions?: DimensionNote[]; dropCareers?: string[] },
  at: string = new Date().toISOString()
): { hypotheses: Hypothesis[]; careers: CareerOption[]; dimensions: DimensionNote[] } {
  const hypotheses = [...(onRecord.hypotheses ?? [])];
  for (const item of changes.hypotheses ?? []) {
    const index = hypotheses.findIndex((other) => other.id === item.id);
    const old = index >= 0 ? hypotheses[index]! : undefined;
    if (old && settledOnCard(old)) continue;
    const next = { ...item, ...(old?.rated ? { rated: old.rated } : {}), ...(old?.cardKey ? { cardKey: old.cardKey } : {}), ...(old?.pointId ? { pointId: old.pointId } : {}) };
    if (old) hypotheses[index] = next; else hypotheses.push(next);
  }
  const role = (value: string | undefined) => loose(value ?? "").toLowerCase();
  const keyOf = (item: CareerOption) => role(item.industry) && role(item.function) ? `${role(item.industry)}|${role(item.function)}` : "";
  let last = Math.max(0, ...(onRecord.careers ?? []).map((item) => Number(/^k(\d+)$/.exec(item.id ?? "")?.[1] ?? 0)));
  const dropped = new Set((changes.dropCareers ?? []).map(role));
  const careers = (onRecord.careers ?? []).map((item) => item.id ? item : { ...item, id: `k${++last}` })
    .filter((item) => !dropped.has(role(item.role)) && !dropped.has(role(item.id)));
  for (const raw of changes.careers ?? []) {
    const { change, differs, ...item } = raw;
    const index = [(other: CareerOption) => Boolean(item.id) && other.id === item.id, (other: CareerOption) => Boolean(keyOf(item)) && keyOf(other) === keyOf(item),
      (other: CareerOption) => role(other.role) === role(item.role)].map((match) => careers.findIndex(match)).find((found) => found >= 0) ?? -1;
    if (index < 0) {
      careers.push({ ...item, id: `k${++last}`, ...(differs ? { differs } : {}), log: [{ at, why: differs || item.why.slice(0, 300) }] });
      continue;
    }
    const old = careers[index]!;
    const entries = [...new Set([...(old.entries ?? []), ...(item.entries ?? [])])].slice(0, 8);
    careers[index] = change?.trim()
      ? { ...item, id: old.id!, ...(entries.length ? { entries } : {}), ...(old.differs ? { differs: old.differs } : {}), log: [...(old.log ?? []), { at, why: change.trim() }] }
      : { ...old, ...(entries.length ? { entries } : {}) };
  }
  const notes = new Map((onRecord.dimensions ?? []).map((item) => [item.id, item]));
  for (const item of changes.dimensions ?? []) notes.set(item.id, item);
  return { hypotheses, careers, dimensions: DIMENSION_IDS.flatMap((id) => notes.get(id) ?? []) };
}

/**
 * The 申请资料包 (owner's decision 2026-11-10, docs/opportunity-agent.md §18.3): what the form filler may reuse across sign-ups beside the
 * profile's fields — short answers the person wrote or approved (「一句话介绍自己」, 「为什么参加」) and documents on this computer (résumé,
 * transcript, portfolio). Editable, versioned: every change raises `version` and leaves one line in `history`, and a run records which
 * version it took its drafts from. A short answer reaches a form only as an approved draft (`judgeAction` already allows a long answer
 * from approved drafts only), so a run that uses one never submits by itself (`autoSubmitProblems`: 「有文书字段」) — the gates stay as
 * they are. Pure; the ledger side is in packages/db/src/form-runs.ts.
 */
import { APPLICATION_SLOTS, isSensitiveSlot, type ApplicationSlot, type Opportunity } from "./opportunity";
import { DIM_SLOT } from "./opportunity-discovery";
import type { ProfileItem } from "./form-fill";

export const APPLY_KIT_SETTING = "apply.kit";
export const KIT_DOCUMENT_KINDS = ["resume", "transcript", "portfolio", "letter", "other"] as const;
export type KitDocumentKind = (typeof KIT_DOCUMENT_KINDS)[number];
export const KIT_DOCUMENT_LABEL: Record<KitDocumentKind, string> = { resume: "简历", transcript: "成绩单", portfolio: "作品集", letter: "推荐信", other: "其他文件" };

export type KitAnswer = { id: string; prompt: string; text: string; updatedAt: string };
export type KitDocument = { id: string; kind: KitDocumentKind; label: string; path: string; updatedAt: string };
export type ApplyKit = { version: number; answers: KitAnswer[]; documents: KitDocument[]; history: Array<{ version: number; at: string; change: string }> };

export const KIT_ANSWERS_MAX = 12;
export const KIT_DOCUMENTS_MAX = 12;
export const KIT_ANSWER_CHARS = 4000;
const HISTORY_KEPT = 60;

export const emptyKit = (): ApplyKit => ({ version: 0, answers: [], documents: [], history: [] });
export function readApplyKit(raw: string | null | undefined): ApplyKit {
  try {
    const value = raw ? JSON.parse(raw) as Partial<ApplyKit> : {};
    return { version: Number(value.version) || 0, answers: Array.isArray(value.answers) ? value.answers : [], documents: Array.isArray(value.documents) ? value.documents : [],
      history: Array.isArray(value.history) ? value.history : [] };
  } catch { return emptyKit(); }
}

export type KitEdit =
  | { op: "answer"; id?: string | undefined; prompt: string; text: string }
  | { op: "remove_answer"; id: string }
  | { op: "document"; id?: string | undefined; kind: KitDocumentKind; label: string; path: string }
  | { op: "remove_document"; id: string };

/**
 * One edit, as a new version. `change` is the history line in the person's words (the caller translates it). An edit that changes
 * nothing, or one past the caps, returns the kit as it was with `changed: false`.
 */
export function editKit(kit: ApplyKit, edit: KitEdit, input: { at: string; newId: () => string; change: (edit: KitEdit, title: string) => string }): { kit: ApplyKit; changed: boolean; id?: string } {
  const bump = (next: Omit<ApplyKit, "version" | "history">, title: string, id?: string) => {
    const version = kit.version + 1;
    return { kit: { ...next, version, history: [...kit.history, { version, at: input.at, change: input.change(edit, title) }].slice(-HISTORY_KEPT) }, changed: true, ...(id ? { id } : {}) };
  };
  const same = { kit, changed: false };
  switch (edit.op) {
    case "answer": {
      const prompt = edit.prompt.trim().slice(0, 200), text = edit.text.trim().slice(0, KIT_ANSWER_CHARS);
      if (!prompt || !text) return same;
      const existing = edit.id ? kit.answers.find((item) => item.id === edit.id) : undefined;
      if (existing && existing.prompt === prompt && existing.text === text) return same;
      if (!existing && kit.answers.length >= KIT_ANSWERS_MAX) return same;
      const id = existing?.id ?? input.newId();
      const answer: KitAnswer = { id, prompt, text, updatedAt: input.at };
      return bump({ answers: existing ? kit.answers.map((item) => item.id === id ? answer : item) : [...kit.answers, answer], documents: kit.documents }, prompt, id);
    }
    case "remove_answer": {
      const existing = kit.answers.find((item) => item.id === edit.id);
      return existing ? bump({ answers: kit.answers.filter((item) => item.id !== edit.id), documents: kit.documents }, existing.prompt) : same;
    }
    case "document": {
      const label = edit.label.trim().slice(0, 120), file = edit.path.trim().slice(0, 500);
      if (!label || !file || !(KIT_DOCUMENT_KINDS as readonly string[]).includes(edit.kind)) return same;
      const existing = edit.id ? kit.documents.find((item) => item.id === edit.id) : undefined;
      if (existing && existing.label === label && existing.path === file && existing.kind === edit.kind) return same;
      if (!existing && kit.documents.length >= KIT_DOCUMENTS_MAX) return same;
      const id = existing?.id ?? input.newId();
      const document: KitDocument = { id, kind: edit.kind, label, path: file, updatedAt: input.at };
      return bump({ answers: kit.answers, documents: existing ? kit.documents.map((item) => item.id === id ? document : item) : [...kit.documents, document] }, label, id);
    }
    case "remove_document": {
      const existing = kit.documents.find((item) => item.id === edit.id);
      return existing ? bump({ answers: kit.answers, documents: kit.documents.filter((item) => item.id !== edit.id) }, existing.label) : same;
    }
  }
}

/** The kit's short answers as a run's approved drafts (`kit-<id>`), each naming the kit version it came from; at most `max`. */
export function kitDrafts(kit: ApplyKit, max = 6): Record<string, { text: string; version: string }> {
  return Object.fromEntries(kit.answers.slice(0, max).map((answer) => [`kit-${answer.id}`, { text: answer.text, version: `kit v${kit.version} · ${answer.prompt.slice(0, 60)}` }]));
}

// ── The per-field preview before a run (§18.3) ─────────────────────────────────────────────────────────────────────

export type PreviewRow = {
  key: string;
  /** What the field is, in the person's words (a slot label key or the page's own words; translated where shown). */
  label: string;
  source: "profile" | "kit_answer" | "kit_document" | "consent";
  /** `ready` has a value to show, `held` is a sensitive item kept in the secret store (never shown), `missing` stops the run there. */
  state: "ready" | "held" | "missing";
  value?: string | undefined;
  slot?: ApplicationSlot | undefined;
  /** Why it is expected: always asked, the page's materials, an eligibility term. */
  why: "always" | "materials" | "eligibility" | "consent";
};

// i18n-ignore-start: words matched against a page's materials, never shown
const MATERIAL_SLOT: Array<[RegExp, ApplicationSlot]> = [
  [/phone|mobile|手机|电话/i, "phone"], [/student id|学号/i, "student_id"], [/birth|date of birth|出生/i, "birth_date"], [/address|地址/i, "address"],
  [/passport|护照/i, "passport_number"], [/github/i, "github"], [/website|portfolio site|homepage|主页|个人网站/i, "website"], [/school|university|学校|院校/i, "school"],
  [/major|field of study|专业/i, "major"], [/graduat|毕业/i, "graduation_year"], [/\bcity\b|城市/i, "city"]
];
const MATERIAL_DOC: Array<[RegExp, string]> = [[/resume|cv\b|简历/i, "resume"], [/transcript|成绩单/i, "transcript"], [/portfolio|作品集/i, "portfolio"],
  [/recommendation|reference letter|推荐信/i, "letter"]];
const WRITTEN = /statement|essay|why|short answer|cover letter|bio|introduc|motivation|personal|文书|陈述|自我介绍|简介|动机|为什么/i;
// i18n-ignore-end
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{3,}|[㐀-鿿]{2}/g) ?? []);
const shared = (a: string, b: string) => { const left = words(a); return [...words(b)].filter((word) => left.has(word)).length; };

/**
 * What the form filler is expected to use for one opportunity, field by field, before it starts (§18.3): name and email always, the
 * profile items its materials and eligibility terms name, a kit document for each document it asks for, the best-matching short answer
 * for each written answer it asks for, and the consents the 报名 covers. Expected, not known: the form itself is read only when the run
 * opens it. A sensitive item is only ever `held` or `missing`.
 */
export function previewFields(opportunity: Pick<Opportunity, "materials" | "consents" | "eligibility">, profile: readonly ProfileItem[], kit: ApplyKit): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const bySlot = new Map(profile.map((item) => [item.slot, item]));
  const addSlot = (slot: ApplicationSlot, why: PreviewRow["why"]) => {
    if (rows.some((row) => row.slot === slot)) return;
    const item = bySlot.get(slot);
    const sensitive = isSensitiveSlot(slot);
    rows.push({ key: `slot:${slot}`, label: slot, source: "profile", slot, why,
      state: !item?.present ? "missing" : sensitive ? "held" : "ready", ...(item?.present && !sensitive && item.value ? { value: item.value } : {}) });
  };
  addSlot("full_name", "always");
  addSlot("email", "always");
  for (const term of opportunity.eligibility) {
    const slot = term.dim === "other" ? undefined : DIM_SLOT[term.dim];
    if (slot && slot in APPLICATION_SLOTS) addSlot(slot as ApplicationSlot, "eligibility");
  }
  for (const material of opportunity.materials) {
    const doc = MATERIAL_DOC.find(([pattern]) => pattern.test(material))?.[1];
    if (doc) {
      const found = kit.documents.find((item) => item.kind === doc);
      rows.push({ key: `doc:${material}`, label: material, source: "kit_document", why: "materials", state: found ? "ready" : "missing", ...(found ? { value: found.label } : {}) });
      continue;
    }
    const slot = MATERIAL_SLOT.find(([pattern]) => pattern.test(material))?.[1];
    if (slot) { addSlot(slot, "materials"); continue; }
    if (WRITTEN.test(material)) {
      const best = [...kit.answers].sort((a, b) => shared(material, b.prompt) - shared(material, a.prompt))[0];
      rows.push({ key: `answer:${material}`, label: material, source: "kit_answer", why: "materials", state: best ? "ready" : "missing",
        ...(best ? { value: best.text.slice(0, 80) } : {}) });
    }
  }
  for (const consent of opportunity.consents) rows.push({ key: `consent:${consent.slice(0, 40)}`, label: consent, source: "consent", why: "consent", state: "ready" });
  return rows;
}

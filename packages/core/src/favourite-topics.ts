/**
 * The person's favourites, organised a topic a day and through the night (decided 2026-10-22, the owner: 「把所有收藏按标题分成不同话题和类别，然后优先把一整个
 * 话题整理出来……按话题分类、每天整理一个完整话题，默认上限 50 篇，单个话题超过 50 篇则分几天整理，另外在用户当地时间 2–8 点持续整理」).
 *
 * - The whole favourites list is read once for its titles (the page's own list answers; no note is opened for it), and every title is put
 *   under a topic by a small model run (`crossline-favourite-topics`, `FAVOURITE_TOPICS_SCHEMA`), a batch at a time, the topics already
 *   made handed back so later batches extend them. New favourites are listed and classified the same way on later nights.
 * - Two separate measures, both the person's to change (the owner, the same day: 「每天 50 篇上限和每天 2–8am 整理是分开的两个指标，并且
 *   用户可以自己修正」):
 *   - by day: one topic a day, the first in `order` with notes unread, at most `perDay` (50) of its notes; a larger topic takes several
 *     days, and a topic finished early leaves the rest of the day's share unused;
 *   - by night: between `window.from` and `window.to` in the person's own zone (02–08 by default; `from === to` turns it off) reading
 *     goes on at a person's pace with no count, topic after topic in order, until the window ends. What the night reads does not use the
 *     day's share.
 * - The assistant then organises what each run read into its topics' documents (the workflow's own Skill).
 * Pure here; the worker reads the site and runs the models (apps/worker/src/favourites-topics.ts).
 */
export type FavouriteTopic = { id: string; name: string; why: string; notes: string[] };
export type FavouriteTopicPlan = {
  topics: FavouriteTopic[];
  /** Topic ids in the order they are read. */
  order: string[];
  /** Notes already put under a topic. */
  classified: string[];
  perDay: number;
  window: { from: number; to: number };
  /** Per local day (`YYYY-MM-DD`): the day's topic and the notes read for it outside the night window. */
  days: Record<string, { topicId: string; read: string[] }>;
};

export const DEFAULT_PER_DAY = 50;
export const DEFAULT_WINDOW = { from: 2, to: 8 } as const;
/** Titles shown to one classification run; the topics made so far go with every run. */
export const TITLES_PER_RUN = 400;
export const MAX_TOPICS = 40;
const NAME_MAX = 16;

export function emptyTopicPlan(): FavouriteTopicPlan {
  return { topics: [], order: [], classified: [], perDay: DEFAULT_PER_DAY, window: { ...DEFAULT_WINDOW }, days: {} };
}

/** A stored plan (the setting `collect.topics.<workflow>`), or undefined when the workflow is not in topic mode. */
export function parseTopicPlan(raw: string | null | undefined): FavouriteTopicPlan | undefined {
  if (!raw) return undefined;
  try { return { ...emptyTopicPlan(), ...(JSON.parse(raw) as Partial<FavouriteTopicPlan>) }; } catch { return undefined; }
}
export const topicPlanKey = (workflowId: string) => `collect.topics.${workflowId}`;

/** The person's own settings, checked: a share of 1–500 notes a day, whole hours 0–23 for the window (equal hours turn the night off). */
export function withTopicSettings(plan: FavouriteTopicPlan, change: { perDay?: number; from?: number; to?: number }): FavouriteTopicPlan {
  const hour = (value: number | undefined, fallback: number) => Number.isInteger(value) && value! >= 0 && value! <= 23 ? value! : fallback;
  return { ...plan, perDay: Number.isInteger(change.perDay) && change.perDay! >= 1 && change.perDay! <= 500 ? change.perDay! : plan.perDay,
    window: { from: hour(change.from, plan.window.from), to: hour(change.to, plan.window.to) } };
}

const int = { type: "integer" };
const str = { type: "string" };
/** One run's answer: topics by name, each with the numbers (`n`) of the titles that belong to it. */
export const FAVOURITE_TOPICS_SCHEMA = { type: "object", additionalProperties: false, required: ["topics"], properties: {
  topics: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "why", "notes"],
    properties: { name: str, why: str, notes: { type: "array", items: int } } } } } } as const;
export type FavouriteTopicsAnswer = { topics: Array<{ name: string; why: string; notes: number[] }> };

export type FavouriteTopicsContext = {
  version: "crossline.favourite-topics.v1";
  /** The person's lines (id, name, long-term goal): topics are named for what the person would use them for. */
  lines: Array<{ id: string; name: string; goal: string }>;
  /** The topics made so far, largest first: a title that fits one goes under it by the same name. */
  existing: Array<{ name: string; why: string; count: number }>;
  /** This run's titles, numbered from 1. */
  titles: Array<{ n: number; title: string; author: string; type: string }>;
};

/** Keeps what can be used: known numbers, each title once, at most `MAX_TOPICS` topics overall, names cut to a short label. */
export function validateFavouriteTopics(value: unknown, count: number, existing = 0): FavouriteTopicsAnswer {
  const answer = value as FavouriteTopicsAnswer | undefined;
  if (!answer || !Array.isArray(answer.topics)) throw new Error("FAVOURITE_TOPICS_INVALID");
  const used = new Set<number>();
  const topics: FavouriteTopicsAnswer["topics"] = [];
  for (const topic of answer.topics) {
    const name = String(topic?.name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    if (!name) continue;
    const notes = (Array.isArray(topic?.notes) ? topic.notes : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= count && !used.has(n) && Boolean(used.add(n)));
    if (!notes.length) continue;
    const same = topics.find((item) => item.name === name);
    if (same) same.notes.push(...notes);
    else topics.push({ name, why: String(topic.why ?? "").trim().slice(0, 120), notes });
  }
  if (!topics.length && count) throw new Error("FAVOURITE_TOPICS_EMPTY");
  if (existing + topics.length > MAX_TOPICS + 5) throw new Error("FAVOURITE_TOPICS_TOO_MANY");
  return { topics };
}

/** Puts one run's answer into the plan: a name already used extends that topic; a new one is read after the existing ones. */
export function mergeTopics(plan: FavouriteTopicPlan, answer: FavouriteTopicsAnswer, ids: readonly string[]): FavouriteTopicPlan {
  const topics = plan.topics.map((topic) => ({ ...topic, notes: [...topic.notes] }));
  const order = [...plan.order];
  const classified = new Set(plan.classified);
  for (const item of answer.topics) {
    const noteIds = item.notes.map((n) => ids[n - 1]).filter((id): id is string => Boolean(id) && !classified.has(id!));
    if (!noteIds.length) continue;
    noteIds.forEach((id) => classified.add(id));
    const same = topics.find((topic) => topic.name === item.name);
    if (same) { same.notes.push(...noteIds); continue; }
    const id = `t${topics.length + 1}`;
    topics.push({ id, name: item.name, why: item.why, notes: noteIds });
    order.push(id);
  }
  return { ...plan, topics, order, classified: [...classified] };
}

/** The local day of a moment, whether it is inside the night window, and when the window ends. */
export function nightOf(now: Date, zone: string, window: { from: number; to: number }): { day: string; inWindow: boolean; endsAt: Date } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) + Number(parts.minute) / 60;
  const inWindow = window.from === window.to ? false : window.from < window.to ? hour >= window.from && hour < window.to : hour >= window.from || hour < window.to;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const hoursLeft = ((window.to - hour) + 24) % 24 || 24;
  return { day, inWindow, endsAt: new Date(now.getTime() + Math.round(hoursLeft * 3_600_000)) };
}

const unreadOf = (topic: FavouriteTopic, read: ReadonlySet<string>) => topic.notes.filter((id) => !read.has(id));
const ordered = (plan: FavouriteTopicPlan) => { const byId = new Map(plan.topics.map((topic) => [topic.id, topic]));
  return plan.order.map((id) => byId.get(id)).filter((topic): topic is FavouriteTopic => Boolean(topic)); };

/**
 * The day's reading: the topic the day already started, else the first in order with notes unread; and its next unread notes up to what
 * is left of the day's `perDay`. `read` holds every note ever read.
 */
export function dayBatch(plan: FavouriteTopicPlan, day: string, read: ReadonlySet<string>): { topic?: FavouriteTopic; ids: string[]; left: number } {
  const today = plan.days[day];
  const left = Math.max(0, plan.perDay - (today?.read.length ?? 0));
  const topic = today ? plan.topics.find((item) => item.id === today.topicId) : ordered(plan).find((item) => unreadOf(item, read).length);
  if (!topic) return { ids: [], left };
  return { topic, ids: unreadOf(topic, read).slice(0, left), left };
}

/** The night's reading: every unread note, topic after topic in order; the window's end stops it wherever it is. */
export function nightBatch(plan: FavouriteTopicPlan, read: ReadonlySet<string>): string[] {
  return ordered(plan).flatMap((topic) => unreadOf(topic, read));
}

/** A person's pace between two notes, by day and by night alike: one to three minutes. */
export const NOTE_GAP_MS: readonly [number, number] = [60_000, 180_000];

/** The topic each note is under. */
export function topicOfNote(plan: FavouriteTopicPlan): Map<string, FavouriteTopic> {
  return new Map(plan.topics.flatMap((topic) => topic.notes.map((id) => [id, topic] as const)));
}

/** Topics with how far each is read, for the person and for the organiser. */
export function topicProgress(plan: FavouriteTopicPlan, read: ReadonlySet<string>): Array<{ id: string; name: string; total: number; read: number }> {
  return plan.order.map((id) => plan.topics.find((topic) => topic.id === id)!).filter(Boolean)
    .map((topic) => ({ id: topic.id, name: topic.name, total: topic.notes.length, read: topic.notes.filter((id) => read.has(id)).length }));
}

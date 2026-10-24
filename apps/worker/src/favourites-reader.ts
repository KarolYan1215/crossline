import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOTE_GONE_TEXT, XHS_COLLECT_PATH, XHS_FEED_PATH, XHS_HOME, XHS_SELF_PATH, judgeXhsApi, notesFromLinks, noteFromDom, parseCollectPage, parseFeedResponse,
  parseInitialStateNote, selfIdFromResponse, workflowAccess, xhsCaptured, xhsFavouritesUrl, xhsNoteUrl, type GrownSkillRecord, type ListedNote, type NoteDetail,
  type WorkflowAccess
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { readerLaunch, restoreSessionCookies } from "./browser-launch";
import { holdSite, judgePage, siteHold, type SiteHold } from "./site-reader";
import { castContext, publicUrlAllowed, type RemotePage, type Viewport } from "./remote-browser";
import { driveContext } from "./node/browser";
import type { NodeBrowserLink } from "./node/hub";

/**
 * Reading the person's Xiaohongshu favourites in full (docs/skills-library.md 「收藏全量读取」, the owner's decision of 2026-10-22: 「收藏全部
 * 读完……第一次运行就全部取全，后续新增的再按人的速度来读」). A worker job, not a model turn: the first run reads ~1000 notes over hours,
 * which a tool loop inside one turn could not do without the 20-minute stall check ending it; the assistant afterwards only organises the
 * files this writes.
 *
 * - The browser is the person's own Crossline profile, visible, as they logged in. Nothing is disguised: no fingerprint, no stealth
 *   patches, no proxy. The site's API is never called by us: the page fetches its own data while it is opened and scrolled, and the
 *   reader keeps those answers (`responses`), then the page's rendered state, then its visible text.
 * - First run (catch-up): the favourites list is scrolled to its end and every note not read before is opened, one at a time, a few
 *   seconds apart (`CATCH_UP_GAP_MS`), with no cap. Later runs (incremental): the list until it reaches notes already read, then at most
 *   `INCREMENTAL_BATCH` new notes at a person's pace (`INCREMENTAL_GAP_MS`). A catch-up that stopped part way is continued as catch-up.
 * - Each note is read once (`collect.notes.<workflow>`), marked as soon as its files are written, so a stop keeps everything read.
 * - A security check or a rate-limit answer stops the run at once, closes the browser and keeps the site closed until the person starts
 *   the workflow again (`siteHold`, the same key `site_read` obeys), with what the site answered kept; a login page stops the run and
 *   asks the person to log in.
 */
export const CATCH_UP_GAP_MS: readonly [number, number] = [6_000, 10_000];
export const INCREMENTAL_GAP_MS: readonly [number, number] = [30_000, 120_000];
export const INCREMENTAL_BATCH = 15;
/** Each picture or video file at most this large; a larger one is recorded as not saved. */
export const MEDIA_MAX_BYTES = 500 * 1024 * 1024;
/** A bound on the list scroll only: ~30 notes load per screen or two, so this covers well past ten thousand favourites. */
export const LIST_SCROLLS_MAX = 600;
/**
 * The list at a person's reading pace (the owner, 2026-10-23, after 2.5–4 s a screen was answered HTTP 461 at screen 120, 1170 listed in
 * 6.5 minutes): 6–10 s a screen, and a rest of one to two minutes every 30 screens. About 20–30 minutes for 1200 favourites.
 */
export const LIST_SCREEN_GAP_MS: readonly [number, number] = [6_000, 10_000];
export const LIST_REST_EVERY = 30;
export const LIST_REST_MS: readonly [number, number] = [60_000, 120_000];
/** A list that brings nothing new for this many screens in a row has ended. */
const LIST_QUIET_SCREENS = 3;
const MEDIA_GAP_MS: readonly [number, number] = [400, 1_200];
const XHS_HOST = "xiaohongshu.com";

export type CapturedResponse = { url: string; status: number; json: unknown };
export type MediaFetch = { state: "ok"; bytes: Buffer; contentType: string } | { state: "too_large"; bytes: number } | { state: "failed"; status: number; message?: string };
/** What the job needs from a browser: the real one is Playwright on the person's profile (`openCollectBrowser`); tests give their own. */
export type CollectDriver = {
  goto: (url: string) => Promise<number>;
  pause: (ms: number) => Promise<void>;
  wheel: () => Promise<void>;
  snapshot: () => Promise<{ url: string; title: string; text: string; links: Array<{ text: string; href: string }> }>;
  /** The page's own API answers since the last call (drained). */
  responses: () => Promise<CapturedResponse[]>;
  /** `window.__INITIAL_STATE__.note.noteDetailMap` as plain data, or null. */
  noteState: () => Promise<unknown>;
  /** Who is signed in, from the page: the state's user id, or the 「我」 link's profile address. */
  selfProfile: () => Promise<{ userId?: string; href?: string }>;
  /** A picture or video through the browser's own request context (its cookies), with the note as referer. */
  fetchMedia: (url: string, referer: string, maxBytes: number) => Promise<MediaFetch>;
  /** How large the page has grown (its JavaScript heap in MB, its element count): logged while the list scrolls. */
  metrics?: () => Promise<{ heapMb: number; nodes: number }>;
  /**
   * This page lent to the dialog for the site's verification (the person passes it there): pictures load again while it is lent, since a
   * verification is made of them. Only where the page can be shown (the server's browser).
   */
  lend?: () => Promise<{ page: RemotePage; viewport: Viewport; back: () => void }>;
  /** The window brought to the front of the person's screen (a browser on their own computer). */
  front?: () => Promise<void>;
  /** Pictures shown again while a person looks at the page (a browser on their own computer, for a verification). */
  showMedia?: (on: boolean) => Promise<void> | void;
  close: () => Promise<void>;
};

export type CollectMode = "catch_up" | "incremental";
export type CollectLedger = {
  read: Record<string, { at: string; state: "read" | "gone" }>;
  /** Set once a catch-up reached the end of the list with every note read: later runs are incremental. */
  caughtUpAt?: string;
  selfId?: string;
  /** Read, and not yet handed to the assistant to organise. */
  unorganised: string[];
  /**
   * Every note the list showed, with what the list says of it (title, the token its page needs, type, author): what the topics are made
   * from and how a night's notes are opened without scrolling the list again (favourites-topics.ts).
   */
  listed?: Record<string, { title: string; xsecToken: string; type: string; author?: string }>;
  listedAt?: string;
  /**
   * The list stopped at the memory line before its end (the page grows with every screen): the notes past it are not reached on this
   * machine, and the list counts as read for the topics and the catch-up. Kept so the person is told once and the cause is on record.
   */
  listCapped?: { at: string; listed: number; memory: string; why?: string };
  /** Where the list was stopped by the site (a check, or no more pages), the last few: two at about the same depth cap the list. */
  listStops?: Array<{ at: string; listed: number }>;
};
const ledgerKey = (workflowId: string) => `collect.notes.${workflowId}`;
export function readCollectLedger(store: CrosslineStore, workspaceId: string, workflowId: string): CollectLedger {
  try {
    const raw = JSON.parse(store.getSetting(workspaceId, ledgerKey(workflowId)) ?? "null") as Partial<CollectLedger> | null;
    return { read: raw?.read ?? {}, unorganised: raw?.unorganised ?? [], ...(raw?.caughtUpAt ? { caughtUpAt: raw.caughtUpAt } : {}), ...(raw?.selfId ? { selfId: raw.selfId } : {}),
      ...(raw?.listed ? { listed: raw.listed } : {}), ...(raw?.listedAt ? { listedAt: raw.listedAt } : {}), ...(raw?.listCapped ? { listCapped: raw.listCapped } : {}),
      ...(raw?.listStops ? { listStops: raw.listStops } : {}) };
  } catch { return { read: {}, unorganised: [] }; }
}
export function writeCollectLedger(store: CrosslineStore, workspaceId: string, workflowId: string, ledger: CollectLedger): void {
  store.setSetting(workspaceId, ledgerKey(workflowId), JSON.stringify(ledger));
}
/** The notes the assistant organised: they leave the to-organise list. */
export function markOrganised(store: CrosslineStore, workspaceId: string, workflowId: string, ids: string[]): void {
  const ledger = readCollectLedger(store, workspaceId, workflowId);
  writeCollectLedger(store, workspaceId, workflowId, { ...ledger, unorganised: ledger.unorganised.filter((id) => !ids.includes(id)) });
}

/** The site's stop after a check or a broken run, while the person has not started it again. */
export function collectHold(store: CrosslineStore, workspaceId: string, now = new Date()): SiteHold | undefined {
  return siteHold(store, workspaceId, XHS_HOST, now);
}
/** A run that broke on our side (the page crashed, the browser would not open) holds the site too, until the person starts it again. */
export function holdAfterFailure(store: CrosslineStore, workspaceId: string, why: string, now = new Date()): void {
  holdSite(store, workspaceId, XHS_HOST, { at: now.toISOString(), where: "读取出错", why: why.slice(0, 160) });
}

/** The Xiaohongshu login a workflow declared, when the workflow is about the person's favourites. */
export function favouritesAccess(record: GrownSkillRecord): WorkflowAccess | undefined {
  const words = `${record.manifest.summary ?? ""} ${record.name ?? ""} ${record.description ?? ""}`;
  return workflowAccess(record).access.find((item) => item.login && /(^|\.)xiaohongshu\.com$/i.test(hostOf(item.site)) && /收藏/.test(`${words} ${item.how}`));
}
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

export type SavedMedia = { index: number; url: string; file?: string; problem?: string };
export type NoteFile = {
  id: string; readAt: string; listed: ListedNote; detail: NoteDetail;
  images: SavedMedia[]; livePhotos: SavedMedia[]; video?: SavedMedia;
  /** The answers the page received, kept as they came (the second source is kept only when the first was missing). */
  raw: { api?: unknown; state?: unknown };
  /** Set once its pictures were described and its video heard (`note-media.ts`). */
  describedAt?: string;
};
export const noteDir = (folder: string, id: string) => path.join(folder, "notes", id);
export const noteJsonPath = (folder: string, id: string) => path.join(noteDir(folder, id), "note.json");
export function readNoteFile(folder: string, id: string): NoteFile | undefined {
  try { return JSON.parse(readFileSync(noteJsonPath(folder, id), "utf8")) as NoteFile; } catch { return undefined; }
}
export function writeNoteFile(folder: string, note: NoteFile): void {
  mkdirSync(noteDir(folder, note.id), { recursive: true });
  writeFileSync(noteJsonPath(folder, note.id), JSON.stringify(note, null, 2));
}

export type CollectResult = {
  /** `memory`: the run stopped itself at the memory line (or found no room to open the browser); nothing broke, the next run continues.
   *  `handover`: stopped between two notes on request (`CollectOptions.handover`); the caller reads the rest elsewhere. */
  state: "done" | "check" | "login" | "paused" | "no_profile" | "failed" | "memory" | "handover";
  mode: CollectMode;
  /** Notes the list showed this run, and whether it was read to its end. */
  listed: number; listEnded: boolean;
  /** The list stopped at the memory line before its end; what it showed so far is kept and read. */
  listCapped?: boolean;
  read: string[]; gone: string[];
  /** Notes listed and still unread after this run (the next run continues). */
  pending: number;
  message?: string;
  /** What made a check: where it stopped and what the site answered (status, code, message, address). */
  trigger?: string;
};

export type CollectOptions = {
  store: CrosslineStore; workspaceId: string; workflowId: string; folder: string; driver: CollectDriver;
  /** Forced mode (the trial script); otherwise catch-up until the ledger says caught up. */
  mode?: CollectMode;
  /** At most this many notes opened (the trial script). */
  limit?: number;
  /** Read the list only (to its end in `catch_up`, until notes already listed in `incremental`) and keep it; open no note. */
  listOnly?: boolean;
  /** Open these notes, in this order, without scrolling the list: their tokens come from the list kept earlier (`ledger.listed`). */
  targets?: string[];
  /** The wait before each note given how many are left (spreading a night's notes over the window); `CATCH_UP_GAP_MS` otherwise. */
  gapMs?: (remaining: number) => number;
  /** No note is started that would not finish before this moment (the end of the night's window). */
  deadline?: Date;
  sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
  /**
   * Asked before each note of a `targets` run: true stops the run cleanly between two notes (state `handover`, nothing lost, the ledger
   * already holds every note read) so the caller can carry on with the rest somewhere else (the person's own computer, once its browser is
   * ready). The notes are opened one by one from their kept tokens, so the rest of the run needs nothing from this browser.
   */
  handover?: () => boolean;
  /** The worker's memory line (memory.ts `createCollectMemory`): past it the run stops where it is, and downloads are held to the room left. */
  memory?: { over: () => boolean; mediaBytes: (wanted: number) => number; describe: () => string };
  /**
   * The site asked for a verification (HTTP 461/471, or the list stopped loading): the person is asked to pass it on this very page, and
   * the run goes on from where it is when they did (true), or stops as before (false). Absent where the page cannot be shown.
   */
  verify?: (where: string) => Promise<boolean>;
};
/** Verifications one run asks for before it stops anyway: a site that keeps asking is not read on. */
export const VERIFICATIONS_PER_RUN = 3;

const MIME_EXT: Array<[RegExp, string]> = [[/png/, "png"], [/jpe?g/, "jpg"], [/webp/, "webp"], [/gif/, "gif"], [/avif/, "avif"], [/hei[cf]/, "heic"], [/mp4/, "mp4"], [/quicktime/, "mov"], [/webm/, "webm"]];
/** The file's real kind from its first bytes, else the content type, else the fallback. */
export function mediaExtension(bytes: Buffer, contentType: string, fallback: string): string {
  if (bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.toString("latin1", 0, 3) === "GIF") return "gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (bytes.toString("latin1", 4, 8) === "ftyp") {
    const brand = bytes.toString("latin1", 8, 12);
    return brand.startsWith("avi") ? "avif" : /^hei|^mif/.test(brand) ? "heic" : brand === "qt  " ? "mov" : "mp4";
  }
  return MIME_EXT.find(([pattern]) => pattern.test(contentType.toLowerCase()))?.[1] ?? fallback;
}

/**
 * One run over the favourites: list, then each unread note, then its pictures and video into the note's folder. Never throws for what
 * the site answers; a browser error ends the run as `failed` with what was read kept.
 */
export async function collectFavourites(options: CollectOptions): Promise<CollectResult> {
  const { store, workspaceId, workflowId, folder, driver } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  const ledger = readCollectLedger(store, workspaceId, workflowId);
  const mode: CollectMode = options.mode ?? (ledger.caughtUpAt ? "incremental" : "catch_up");
  const result: CollectResult = { state: "done", mode, listed: 0, listEnded: false, read: [], gone: [], pending: 0 };
  const save = () => writeCollectLedger(store, workspaceId, workflowId, ledger);
  const between = (range: readonly [number, number]) => range[0] + random() * (range[1] - range[0]);
  const held = collectHold(store, workspaceId, now());
  if (held) return { ...result, state: "paused", message: "小红书读取已停下，等本人点「立即运行」再继续。" };

  /** What the site answered that made the check (kept with the hold and the run's event). */
  let trigger = "";
  const stopAtCheck = (where: string) => {
    holdSite(store, workspaceId, XHS_HOST, { at: now().toISOString(), where, ...(trigger ? { why: trigger } : {}) });
    log({ type: "collect.check", workflowId, where, trigger });
    return { ...result, state: "check" as const, ...(trigger ? { trigger: `${where}：${trigger}` } : { trigger: where }),
      message: `读取${where}时遇到了小红书的安全验证或限流${trigger ? `（${trigger}）` : ""}，已停下。` };
  };
  /**
   * The list stopped by the site. Twice at about the same depth (within 5%) is as far as the site serves the list, whatever the pace
   * (2026-10-23/24: HTTP 461 at screen ~120 with ~1200 listed, at 2.5–4 s and at 8 s a screen alike): what was listed then counts as the
   * list, so the next run reads the notes instead of scrolling to the same wall again. The site is held all the same.
   */
  const listStop = (where: string): CollectResult => {
    keepListed();
    // The depth is how far this run got down the list; the ledger also holds what earlier runs listed.
    const total = Object.keys(ledger.listed ?? {}).length;
    const depth = listed.size;
    const previous = ledger.listStops?.at(-1);
    ledger.listStops = [...(ledger.listStops ?? []), { at: now().toISOString(), listed: depth }].slice(-5);
    if (previous && depth > 0 && Math.abs(depth - previous.listed) <= Math.max(20, previous.listed * 0.05)) {
      ledger.listedAt = now().toISOString();
      ledger.listCapped = { at: now().toISOString(), listed: total, memory: "", why: `小红书两次都在约 ${total} 条处不再给出收藏列表` };
      result.listCapped = true;
      log({ type: "collect.list_depth_capped", workflowId, listed: total, depth, previous: previous.listed });
    }
    save();
    return { ...stopAtCheck(where), listed: total };
  };
  /** Asks the person to pass the site's verification on this page; true when they did and the run may go on. */
  let verifications = 0;
  const askVerify = async (where: string): Promise<boolean> => {
    if (!options.verify || verifications >= VERIFICATIONS_PER_RUN) return false;
    verifications += 1;
    keepListed(); save();
    log({ type: "collect.verify_asked", workflowId, where, trigger });
    const passed = await options.verify(where).catch(() => false);
    log({ type: "collect.verify_answered", workflowId, where, passed });
    if (!passed) return false;
    trigger = "";
    await driver.responses();
    return true;
  };
  /** A page-level check: the address and status are what is known. */
  const pageCheck = (url: string, status: number) => { trigger ||= `页面 HTTP ${status} ${url.slice(0, 120)}`; };
  /** The page's own answers since the last look: a check or a login out of them, the list pages, the note details, who is signed in. */
  const listed = new Map<string, ListedNote>();
  let hasMore: boolean | undefined;
  let knownPage = false;
  const details = new Map<string, unknown>();
  const take = async (): Promise<"check" | "login" | "ok"> => {
    for (const response of await driver.responses()) {
      if (!xhsCaptured(response.url)) continue;
      const verdict = judgeXhsApi(response.status, response.json);
      if (verdict === "check") {
        const body = (response.json ?? {}) as { code?: unknown; msg?: unknown; message?: unknown };
        trigger = `HTTP ${response.status} code ${String(body.code ?? "")} ${String(body.msg ?? body.message ?? "").slice(0, 60)} ${response.url.replace(/\?.*$/, "").slice(0, 100)}`.replace(/\s+/g, " ").trim();
      }
      if (verdict !== "ok") return verdict;
      if (XHS_COLLECT_PATH.test(response.url)) {
        const page = parseCollectPage(response.json);
        if (page.hasMore !== undefined) hasMore = page.hasMore;
        if (page.notes.length && page.notes.every((note) => ledger.read[note.id] || (options.listOnly && ledger.listed?.[note.id]))) knownPage = true;
        for (const note of page.notes) if (!listed.has(note.id) || !listed.get(note.id)!.xsecToken) listed.set(note.id, note);
      } else if (XHS_FEED_PATH.test(response.url)) details.set(response.url + details.size, response.json);
      else if (XHS_SELF_PATH.test(response.url)) { const id = selfIdFromResponse(response.json); if (id) ledger.selfId = id; }
    }
    return "ok";
  };

  try {
    if (options.targets) return await readNotes(options.targets.flatMap((id): ListedNote[] => {
      const known = ledger.listed?.[id];
      return known && !ledger.read[id] ? [{ id, xsecToken: known.xsecToken, title: known.title, type: known.type }] : [];
    }), options.targets.length);
    // Who is signed in: remembered from an earlier run, else from the home page the person would open first.
    if (!ledger.selfId) {
      const status = await driver.goto(XHS_HOME);
      await driver.pause(3_000 + random() * 1_500);
      const shown = await driver.snapshot();
      // The home feed's words are other people's notes: only the address, the status, the title and the page's own answers are judged.
      const answered = await take();
      const verdict = answered !== "ok" ? answered : judgePage(shown.url, shown.title, "", status);
      if (verdict === "check") { pageCheck(shown.url, status); return stopAtCheck("首页"); }
      if (verdict === "login") return { ...result, state: "login", message: "需要登录小红书。" };
      if (!ledger.selfId) {
        const self = await driver.selfProfile();
        const found = self.userId || /\/user\/profile\/([0-9a-z]+)/i.exec(self.href ?? "")?.[1];
        if (found) ledger.selfId = found;
      }
      if (!ledger.selfId) return { ...result, state: "no_profile", message: "没找到本人的主页：可能还没登录小红书。" };
      save();
      await sleep(between(CATCH_UP_GAP_MS));
    }

    // The favourites list, scrolled until it says it has no more, stops bringing anything, or (incremental) reaches notes already read.
    const status = await driver.goto(xhsFavouritesUrl(ledger.selfId));
    await driver.pause(3_000 + random() * 1_500);
    let shown = await driver.snapshot();
    const first = await take();
    const pageVerdict = judgePage(shown.url, shown.title, "", status);
    if (first === "check" || pageVerdict === "check") { pageCheck(shown.url, status); if (!(await askVerify("收藏列表"))) return listStop("收藏列表"); }
    if (first === "login" || pageVerdict === "login") return { ...result, state: "login", message: "小红书要求登录。" };
    const fromDom = (links: Array<{ text: string; href: string }>) => { for (const note of notesFromLinks(links)) if (!listed.has(note.id)) listed.set(note.id, note); };
    fromDom(shown.links);
    let quiet = 0;
    let capped = false;
    for (let screen = 0; screen < LIST_SCROLLS_MAX; screen += 1) {
      // A list that stops loading without saying it ended is often the site waiting for a verification on the page.
      if (quiet >= LIST_QUIET_SCREENS && hasMore !== false && !(mode === "incremental" && knownPage) && await askVerify(`收藏列表（已列出 ${listed.size} 条后停止加载）`)) quiet = 0;
      if (hasMore === false || quiet >= LIST_QUIET_SCREENS || (mode === "incremental" && knownPage)) break;
      // The page holds every card it has shown: past the memory line the list stops here rather than the kernel killing the page.
      if (options.memory?.over()) {
        capped = true;
        log({ type: "collect.list_capped", workflowId, screen, listed: listed.size, memory: options.memory.describe() });
        break;
      }
      const before = listed.size;
      await driver.wheel();
      await driver.pause(between(LIST_SCREEN_GAP_MS));
      const verdict = await take();
      shown = await driver.snapshot();
      if (verdict === "check" || judgePage(shown.url, shown.title, "", 200) === "check") {
        pageCheck(shown.url, 200);
        if (await askVerify(`收藏列表第 ${screen + 1} 屏`)) { quiet = 0; continue; }
        return listStop(`收藏列表第 ${screen + 1} 屏`);
      }
      if (verdict === "login" || judgePage(shown.url, shown.title, "", 200) === "login") return { ...result, state: "login", message: "小红书要求登录。" };
      fromDom(shown.links);
      quiet = listed.size > before ? 0 : quiet + 1;
      if ((screen + 1) % LIST_REST_EVERY === 0) { keepListed(); save(); await sleep(between(LIST_REST_MS)); }
      // Kept as it grows: a page that dies part way (2026-10-23: 「Target crashed」 after 17 minutes) loses nothing listed so far.
      if (screen % 5 === 4) {
        keepListed(); save();
        // What grows while the list scrolls (the page process was killed at ~370 MB with ~520 listed, 2026-10-23).
        const size = await driver.metrics?.().catch(() => undefined);
        log({ type: "collect.list_progress", workflowId, screen: screen + 1, listed: listed.size, ...(size ?? {}) });
      }
    }
    // Only the list's own answer says it ended. Screens that bring nothing while it never said so is the site no longer serving the list
    // (2026-10-23: one page, then nothing, an hour after a 461 — and it was taken as the end, so the list counted as complete): held like
    // a check, so nothing reads on as though the list were whole.
    result.listEnded = hasMore === false;
    result.listed = listed.size;
    keepListed();
    if (!result.listEnded && !capped && quiet >= LIST_QUIET_SCREENS && !(mode === "incremental" && knownPage)) {
      trigger ||= `连续 ${LIST_QUIET_SCREENS} 屏没有新内容，接口没有说已到底（疑似限流）`;
      log({ type: "collect.list_stalled", workflowId, listed: listed.size });
      return listStop(`收藏列表（已列出 ${listed.size} 条）`);
    }
    if (capped) {
      result.listCapped = true;
      ledger.listCapped = { at: now().toISOString(), listed: listed.size, memory: options.memory?.describe() ?? "" };
    } else if (result.listEnded) delete ledger.listCapped;
    // An incremental look that reached notes already listed has seen everything new: the list is up to date. Without this the weekly
    // refresh never counted as done and opened the favourites page again on every tick of the night.
    const upToDate = mode === "incremental" && knownPage;
    if (result.listEnded || capped || upToDate || !options.listOnly) ledger.listedAt = now().toISOString();
    save();
    if (options.listOnly) { log({ type: "collect.listed", workflowId, mode, listed: listed.size, ended: result.listEnded, listOnly: true }); return result; }

    const unread = [...listed.values()].filter((note) => !ledger.read[note.id]);
    const cap = Math.min(options.limit ?? Infinity, mode === "incremental" ? INCREMENTAL_BATCH : Infinity);
    log({ type: "collect.listed", workflowId, mode, listed: listed.size, unread: unread.length, reading: Math.min(unread.length, cap), ended: result.listEnded });
    return await readNotes(unread.slice(0, cap), unread.length);
  } catch (error) {
    save();
    return { ...result, state: "failed", message: `浏览器出错：${error instanceof Error ? error.message.slice(0, 200) : "未知错误"}` };
  }

  /** The notes the list showed, with their titles and tokens, into the ledger. */
  function keepListed() {
    ledger.listed = { ...(ledger.listed ?? {}) };
    for (const note of listed.values()) ledger.listed[note.id] = { title: note.title, xsecToken: note.xsecToken || ledger.listed[note.id]?.xsecToken || "", type: note.type,
      ...(note.author?.name ? { author: note.author.name } : {}) };
  }

  /** Opens each note in turn and keeps what it shows; `total` is how many were waiting (for `pending`). */
  async function readNotes(toRead: ListedNote[], total: number): Promise<CollectResult> {
  try {
    const gap = mode === "incremental" ? INCREMENTAL_GAP_MS : CATCH_UP_GAP_MS;
    const unread = { length: total };
    for (const [index, note] of toRead.entries()) {
      if (options.handover?.()) {
        save();
        log({ type: "collect.handover_asked", workflowId, read: result.read.length });
        return { ...result, state: "handover", pending: unread.length - result.read.length - result.gone.length };
      }
      const wait = options.gapMs ? options.gapMs(toRead.length - index) : between(gap);
      if (options.deadline && now().getTime() + wait + 60_000 > options.deadline.getTime()) break;
      if (options.memory?.over()) {
        log({ type: "collect.memory_stop", workflowId, read: result.read.length, memory: options.memory.describe() });
        save();
        return { ...result, state: "memory", pending: unread.length - result.read.length - result.gone.length,
          message: `服务器内存到了上限（${options.memory.describe()}），读到第 ${result.read.length} 条时停下，下次接着读。` };
      }
      await sleep(wait);
      details.clear();
      const url = xhsNoteUrl(note.id, note.xsecToken);
      const noteStatus = await driver.goto(url);
      await driver.pause(2_000 + random() * 1_500);
      const verdict = await take();
      const page = await driver.snapshot();
      // Passed on the page: this note stays unread for the next run, and the reading goes on with the next one.
      if (verdict === "check") { if (await askVerify("笔记")) continue; return { ...stopAtCheck("笔记"), pending: unread.length - result.read.length - result.gone.length }; }
      if (verdict === "login") return { ...result, state: "login", message: "小红书要求登录。", pending: unread.length - result.read.length - result.gone.length };
      let apiJson: unknown;
      let detail: NoteDetail | undefined;
      for (const json of details.values()) { detail = parseFeedResponse(json, note.id); if (detail) { apiJson = json; break; } }
      let stateJson: unknown;
      if (!detail) { stateJson = await driver.noteState(); detail = parseInitialStateNote(stateJson, note.id); }
      // The URL and status say a check or a login whatever the note is about; the page's words are judged only when it gave no note,
      // since a note about verification codes would otherwise close the site for a week.
      const urlVerdict = judgePage(page.url, "", "", noteStatus);
      const textVerdict = detail ? "ok" : judgePage(page.url, page.title, page.text, noteStatus);
      if (urlVerdict === "check" || textVerdict === "check") {
        pageCheck(page.url, noteStatus);
        if (await askVerify("笔记")) continue;
        return { ...stopAtCheck("笔记"), pending: unread.length - result.read.length - result.gone.length };
      }
      if (urlVerdict === "login" || textVerdict === "login") return { ...result, state: "login", message: "小红书要求登录。", pending: unread.length - result.read.length - result.gone.length };
      if (!detail && NOTE_GONE_TEXT.test(page.text)) {
        ledger.read[note.id] = { at: now().toISOString(), state: "gone" };
        result.gone.push(note.id);
        save();
        continue;
      }
      detail ??= noteFromDom(note.id, page.title || note.title, page.text);
      if (!detail.title && note.title) detail = { ...detail, title: note.title };
      const saved = await saveMedia(driver, folder, detail, url, () => sleep(between(MEDIA_GAP_MS)), options.memory);
      writeNoteFile(folder, { id: note.id, readAt: now().toISOString(), listed: note, detail, ...saved,
        raw: { ...(apiJson !== undefined ? { api: apiJson } : stateJson !== undefined ? { state: stateJson } : {}) } });
      ledger.read[note.id] = { at: now().toISOString(), state: "read" };
      if (!ledger.unorganised.includes(note.id)) ledger.unorganised.push(note.id);
      result.read.push(note.id);
      save();
      log({ type: "collect.note_read", workflowId, id: note.id, source: detail.source, images: saved.images.length, video: Boolean(saved.video?.file) });
    }
    result.pending = unread.length - result.read.length - result.gone.length;
    if (mode === "catch_up" && (result.listEnded || result.listCapped) && result.pending === 0 && !options.limit && !options.targets) ledger.caughtUpAt = now().toISOString();
    save();
    return result;
  } catch (error) {
    save();
    return { ...result, state: "failed", message: `浏览器出错：${error instanceof Error ? error.message.slice(0, 200) : "未知错误"}` };
  }
  }
}

/** Every picture (and live photo) and the video of a note, through the browser's own requests, into the note's folder. */
async function saveMedia(driver: CollectDriver, folder: string, detail: NoteDetail, referer: string, rest: () => Promise<void>,
  memory?: CollectOptions["memory"]): Promise<Pick<NoteFile, "images" | "livePhotos" | "video">> {
  const dir = noteDir(folder, detail.id);
  mkdirSync(dir, { recursive: true });
  const one = async (urls: string[], index: number, stem: string, fallback: string): Promise<SavedMedia> => {
    let problem = urls.length ? "" : "页面没有给出地址";
    for (const url of urls) {
      await rest();
      // A file is held whole in memory while it is saved: no larger than the room the memory line leaves.
      const max = memory ? memory.mediaBytes(MEDIA_MAX_BYTES) : MEDIA_MAX_BYTES;
      const fetched = await driver.fetchMedia(url, referer, max).catch((error): MediaFetch => ({ state: "failed", status: 0, message: error instanceof Error ? error.message : "" }));
      if (fetched.state === "too_large") return { index, url, problem: max < MEDIA_MAX_BYTES
        ? `服务器内存只够下载 ${Math.round(max / 1048576)} MB（文件 ${Math.round(fetched.bytes / 1048576)} MB），没有保存`
        : `文件超过 ${Math.round(MEDIA_MAX_BYTES / 1048576)} MB（${Math.round(fetched.bytes / 1048576)} MB），没有保存` };
      if (fetched.state === "failed") { problem = `下载失败（${fetched.status || fetched.message || "无响应"}）`; continue; }
      const file = `${stem}.${mediaExtension(fetched.bytes, fetched.contentType, fallback)}`;
      writeFileSync(path.join(dir, file), fetched.bytes);
      return { index, url, file };
    }
    return { index, url: urls[0] ?? "", problem };
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const images: SavedMedia[] = [];
  const livePhotos: SavedMedia[] = [];
  for (const image of detail.images) {
    images.push(await one(image.urls, image.index, `img-${pad(image.index)}`, "jpg"));
    if (image.livePhotoUrls.length) livePhotos.push(await one(image.livePhotoUrls, image.index, `live-${pad(image.index)}`, "mp4"));
  }
  const video = detail.video ? await one(detail.video.urls, 1, "video", "mp4") : undefined;
  return { images, livePhotos, ...(video ? { video } : {}) };
}

// ── The real browser ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Playwright on the person's Crossline profile, visible, with no disguise of any kind. Responses the page receives from the site's own
 * API are kept as JSON; nothing is ever requested from that API by this code. Pictures and videos come through the context's own
 * request (the same cookies the page holds, the note as referer).
 */
export async function openCollectBrowser(profileDir: string, executablePath: string, options: { listOnly?: boolean } = {}): Promise<CollectDriver> {
  const { chromium } = await import("playwright-core");
  // Visible on the person's computer, on the server's virtual screen on a server; the login's session cookies put back (browser-launch.ts).
  const context = await chromium.launchPersistentContext(profileDir, await readerLaunch(executablePath));
  await restoreSessionCookies(context, profileDir);
  // Reading the list only needs its titles, which come in the page's own answers: its pictures and videos are not loaded. A list of
  // ~2000 favourites scrolled with them grew the page past the worker's memory and it crashed (2026-10-23). Every request goes only to
  // public https hosts (as the login browser's do), so a page lent to the person cannot reach the server's own.
  const driver = await driveContext(context, { capture: xhsCaptured, allow: publicUrlAllowed, ...(options.listOnly ? { listOnly: true } : {}) });
  const page = context.pages()[0]!;
  return { ...driver,
    lend: async () => {
      driver.showMedia(true);
      const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
      return { page: await castContext(context, viewport, true), viewport, back: () => driver.showMedia(false) };
    } };
}

/** The page answers kept by a reader on the person's computer: the same URLs as `xhsCaptured`. */
const CAPTURED_SOURCES = [XHS_COLLECT_PATH.source, XHS_FEED_PATH.source, XHS_SELF_PATH.source];

/**
 * The favourites read in a browser on the person's own computer (a node that offers one, docs/compute-node.md): the same driver, each
 * operation sent over the node's connection. The window is visible on their screen, logged in there, so a verification or login is done
 * in it; nothing of the server's memory goes to the page.
 */
export async function openNodeCollectBrowser(link: NodeBrowserLink, options: { listOnly?: boolean } = {}): Promise<CollectDriver & { host: string }> {
  const call = <T>(request: Record<string, unknown>, timeoutMs?: number) => link.call(request, timeoutMs) as Promise<T>;
  await call({ op: "open", site: XHS_HOME, capture: CAPTURED_SOURCES, ...(options.listOnly ? { listOnly: true } : {}) }, 120_000);
  return {
    host: link.host,
    goto: (url) => call<number>({ op: "goto", url }, 90_000),
    pause: (ms) => call<void>({ op: "pause", ms }, ms + 60_000),
    wheel: () => call<void>({ op: "wheel" }, 60_000),
    snapshot: () => call({ op: "snapshot" }, 60_000),
    responses: async () => (await call<CapturedResponse[] | null>({ op: "responses" }, 60_000)) ?? [],
    noteState: () => call({ op: "noteState" }, 60_000),
    selfProfile: async () => (await call<{ userId?: string; href?: string } | null>({ op: "selfProfile" }, 60_000)) ?? {},
    fetchMedia: (url, referer, maxBytes) => call<MediaFetch>({ op: "fetchMedia", url, referer, maxBytes }, 16 * 60_000),
    metrics: async () => (await call<{ heapMb: number; nodes: number } | null>({ op: "metrics" }, 60_000)) ?? { heapMb: 0, nodes: 0 },
    front: () => call<void>({ op: "front" }, 60_000),
    showMedia: (on: boolean) => call<void>({ op: "showMedia", on }, 60_000),
    close: () => call<void>({ op: "close" }, 60_000).catch(() => undefined)
  } as CollectDriver & { host: string };
}

/** The folder a workflow's notes accumulate in, run after run (the assistant gets it read-only). */
export const collectFolder = (outputRoot: string, workflowId: string) => path.join(outputRoot, `collect-${workflowId.replace(/^flow-/, "")}`);
export const collectFolderExists = (folder: string) => existsSync(path.join(folder, "notes"));

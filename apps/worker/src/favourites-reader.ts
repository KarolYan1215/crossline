import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOTE_GONE_TEXT, XHS_COLLECT_PATH, XHS_FEED_PATH, XHS_HOME, XHS_SELF_PATH, judgeXhsApi, notesFromLinks, noteFromDom, parseCollectPage, parseFeedResponse,
  parseInitialStateNote, selfIdFromResponse, workflowAccess, xhsCaptured, xhsFavouritesUrl, xhsNoteUrl, type GrownSkillRecord, type ListedNote, type NoteDetail,
  type WorkflowAccess
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { readerLaunchOptions, restoreSessionCookies } from "./browser-launch";
import { breakerKey, judgePage } from "./site-reader";

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
 * - A security check or a rate-limit answer stops the run at once, closes the browser and keeps the site closed for
 *   `COLLECT_BREAKER_DAYS` (the same key `site_read` obeys); a login page stops the run and asks the person to log in.
 */
export const CATCH_UP_GAP_MS: readonly [number, number] = [6_000, 10_000];
export const INCREMENTAL_GAP_MS: readonly [number, number] = [30_000, 120_000];
export const INCREMENTAL_BATCH = 15;
export const COLLECT_BREAKER_DAYS = 7;
/** Each picture or video file at most this large; a larger one is recorded as not saved. */
export const MEDIA_MAX_BYTES = 500 * 1024 * 1024;
/** A bound on the list scroll only: ~30 notes load per screen or two, so this covers well past ten thousand favourites. */
export const LIST_SCROLLS_MAX = 600;
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
};
const ledgerKey = (workflowId: string) => `collect.notes.${workflowId}`;
export function readCollectLedger(store: CrosslineStore, workspaceId: string, workflowId: string): CollectLedger {
  try {
    const raw = JSON.parse(store.getSetting(workspaceId, ledgerKey(workflowId)) ?? "null") as Partial<CollectLedger> | null;
    return { read: raw?.read ?? {}, unorganised: raw?.unorganised ?? [], ...(raw?.caughtUpAt ? { caughtUpAt: raw.caughtUpAt } : {}), ...(raw?.selfId ? { selfId: raw.selfId } : {}) };
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

/** The site's pause after a check, as an ISO time, when it is still in force. */
export function collectPausedUntil(store: CrosslineStore, workspaceId: string, now = new Date()): string | undefined {
  const until = store.getSetting(workspaceId, breakerKey(XHS_HOST));
  return until && Date.parse(until) > now.getTime() ? until : undefined;
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
  state: "done" | "check" | "login" | "paused" | "no_profile" | "failed";
  mode: CollectMode;
  /** Notes the list showed this run, and whether it was read to its end. */
  listed: number; listEnded: boolean;
  read: string[]; gone: string[];
  /** Notes listed and still unread after this run (the next run continues). */
  pending: number;
  message?: string; until?: string;
};

export type CollectOptions = {
  store: CrosslineStore; workspaceId: string; workflowId: string; folder: string; driver: CollectDriver;
  /** Forced mode (the trial script); otherwise catch-up until the ledger says caught up. */
  mode?: CollectMode;
  /** At most this many notes opened (the trial script). */
  limit?: number;
  sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
};

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
  const paused = collectPausedUntil(store, workspaceId, now());
  if (paused) return { ...result, state: "paused", until: paused, message: `小红书在 ${paused.slice(0, 16).replace("T", " ")} 前暂停读取（之前遇到了安全验证）。` };

  const stopAtCheck = (where: string) => {
    const until = new Date(now().getTime() + COLLECT_BREAKER_DAYS * 86_400_000).toISOString();
    store.setSetting(workspaceId, breakerKey(XHS_HOST), until);
    log({ type: "collect.check", workflowId, where });
    return { ...result, state: "check" as const, until, message: `读取${where}时遇到了小红书的安全验证或限流，已停下，${COLLECT_BREAKER_DAYS} 天内不再读取。` };
  };
  /** The page's own answers since the last look: a check or a login out of them, the list pages, the note details, who is signed in. */
  const listed = new Map<string, ListedNote>();
  let hasMore: boolean | undefined;
  let knownPage = false;
  const details = new Map<string, unknown>();
  const take = async (): Promise<"check" | "login" | "ok"> => {
    for (const response of await driver.responses()) {
      if (!xhsCaptured(response.url)) continue;
      const verdict = judgeXhsApi(response.status, response.json);
      if (verdict !== "ok") return verdict;
      if (XHS_COLLECT_PATH.test(response.url)) {
        const page = parseCollectPage(response.json);
        if (page.hasMore !== undefined) hasMore = page.hasMore;
        if (page.notes.length && page.notes.every((note) => ledger.read[note.id])) knownPage = true;
        for (const note of page.notes) if (!listed.has(note.id) || !listed.get(note.id)!.xsecToken) listed.set(note.id, note);
      } else if (XHS_FEED_PATH.test(response.url)) details.set(response.url + details.size, response.json);
      else if (XHS_SELF_PATH.test(response.url)) { const id = selfIdFromResponse(response.json); if (id) ledger.selfId = id; }
    }
    return "ok";
  };

  try {
    // Who is signed in: remembered from an earlier run, else from the home page the person would open first.
    if (!ledger.selfId) {
      const status = await driver.goto(XHS_HOME);
      await driver.pause(3_000 + random() * 1_500);
      const shown = await driver.snapshot();
      // The home feed's words are other people's notes: only the address, the status, the title and the page's own answers are judged.
      const answered = await take();
      const verdict = answered !== "ok" ? answered : judgePage(shown.url, shown.title, "", status);
      if (verdict === "check") return stopAtCheck("首页");
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
    if (first === "check" || pageVerdict === "check") return stopAtCheck("收藏列表");
    if (first === "login" || pageVerdict === "login") return { ...result, state: "login", message: "小红书要求登录。" };
    const fromDom = (links: Array<{ text: string; href: string }>) => { for (const note of notesFromLinks(links)) if (!listed.has(note.id)) listed.set(note.id, note); };
    fromDom(shown.links);
    let quiet = 0;
    for (let screen = 0; screen < LIST_SCROLLS_MAX; screen += 1) {
      if (hasMore === false || quiet >= LIST_QUIET_SCREENS || (mode === "incremental" && knownPage)) break;
      const before = listed.size;
      await driver.wheel();
      await driver.pause(2_500 + random() * 1_500);
      const verdict = await take();
      shown = await driver.snapshot();
      if (verdict === "check" || judgePage(shown.url, shown.title, "", 200) === "check") return stopAtCheck("收藏列表");
      if (verdict === "login" || judgePage(shown.url, shown.title, "", 200) === "login") return { ...result, state: "login", message: "小红书要求登录。" };
      fromDom(shown.links);
      quiet = listed.size > before ? 0 : quiet + 1;
    }
    result.listEnded = hasMore === false || quiet >= LIST_QUIET_SCREENS;
    result.listed = listed.size;

    const unread = [...listed.values()].filter((note) => !ledger.read[note.id]);
    const cap = Math.min(options.limit ?? Infinity, mode === "incremental" ? INCREMENTAL_BATCH : Infinity);
    const toRead = unread.slice(0, cap);
    const gap = mode === "incremental" ? INCREMENTAL_GAP_MS : CATCH_UP_GAP_MS;
    log({ type: "collect.listed", workflowId, mode, listed: listed.size, unread: unread.length, reading: toRead.length, ended: result.listEnded });

    for (const note of toRead) {
      await sleep(between(gap));
      details.clear();
      const url = xhsNoteUrl(note.id, note.xsecToken);
      const noteStatus = await driver.goto(url);
      await driver.pause(2_000 + random() * 1_500);
      const verdict = await take();
      const page = await driver.snapshot();
      if (verdict === "check") return { ...stopAtCheck("笔记"), pending: unread.length - result.read.length - result.gone.length };
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
      if (urlVerdict === "check" || textVerdict === "check") return { ...stopAtCheck("笔记"), pending: unread.length - result.read.length - result.gone.length };
      if (urlVerdict === "login" || textVerdict === "login") return { ...result, state: "login", message: "小红书要求登录。", pending: unread.length - result.read.length - result.gone.length };
      if (!detail && NOTE_GONE_TEXT.test(page.text)) {
        ledger.read[note.id] = { at: now().toISOString(), state: "gone" };
        result.gone.push(note.id);
        save();
        continue;
      }
      detail ??= noteFromDom(note.id, page.title || note.title, page.text);
      if (!detail.title && note.title) detail = { ...detail, title: note.title };
      const saved = await saveMedia(driver, folder, detail, url, () => sleep(between(MEDIA_GAP_MS)));
      writeNoteFile(folder, { id: note.id, readAt: now().toISOString(), listed: note, detail, ...saved,
        raw: { ...(apiJson !== undefined ? { api: apiJson } : stateJson !== undefined ? { state: stateJson } : {}) } });
      ledger.read[note.id] = { at: now().toISOString(), state: "read" };
      if (!ledger.unorganised.includes(note.id)) ledger.unorganised.push(note.id);
      result.read.push(note.id);
      save();
      log({ type: "collect.note_read", workflowId, id: note.id, source: detail.source, images: saved.images.length, video: Boolean(saved.video?.file) });
    }
    result.pending = unread.length - result.read.length - result.gone.length;
    if (mode === "catch_up" && result.listEnded && result.pending === 0 && !options.limit) ledger.caughtUpAt = now().toISOString();
    save();
    return result;
  } catch (error) {
    save();
    return { ...result, state: "failed", message: `浏览器出错：${error instanceof Error ? error.message.slice(0, 200) : "未知错误"}` };
  }
}

/** Every picture (and live photo) and the video of a note, through the browser's own requests, into the note's folder. */
async function saveMedia(driver: CollectDriver, folder: string, detail: NoteDetail, referer: string, rest: () => Promise<void>):
  Promise<Pick<NoteFile, "images" | "livePhotos" | "video">> {
  const dir = noteDir(folder, detail.id);
  mkdirSync(dir, { recursive: true });
  const one = async (urls: string[], index: number, stem: string, fallback: string): Promise<SavedMedia> => {
    let problem = urls.length ? "" : "页面没有给出地址";
    for (const url of urls) {
      await rest();
      const fetched = await driver.fetchMedia(url, referer, MEDIA_MAX_BYTES).catch((error): MediaFetch => ({ state: "failed", status: 0, message: error instanceof Error ? error.message : "" }));
      if (fetched.state === "too_large") return { index, url, problem: `文件超过 ${Math.round(MEDIA_MAX_BYTES / 1048576)} MB（${Math.round(fetched.bytes / 1048576)} MB），没有保存` };
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
export async function openCollectBrowser(profileDir: string, executablePath: string): Promise<CollectDriver> {
  const { chromium } = await import("playwright-core");
  // Visible on the person's computer, headless on a server; the login's session cookies put back (browser-launch.ts).
  const context = await chromium.launchPersistentContext(profileDir, readerLaunchOptions(executablePath));
  await restoreSessionCookies(context, profileDir);
  // Functions handed to the page name nothing (tsx's `__name` wrapper would throw there); see `openBrowser` in site-reader.ts.
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((target) => target);" });
  const page = context.pages()[0] ?? await context.newPage();
  const queue: CapturedResponse[] = [];
  const pending = new Set<Promise<void>>();
  page.on("response", (response) => {
    const url = response.url();
    if (!xhsCaptured(url)) return;
    const done = response.json().then((json: unknown) => { queue.push({ url, status: response.status(), json }); },
      () => { queue.push({ url, status: response.status(), json: null }); }).finally(() => pending.delete(done));
    pending.add(done);
  });
  return {
    goto: async (url) => (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status() ?? 0,
    pause: (ms) => page.waitForTimeout(ms),
    wheel: () => page.mouse.wheel(0, 900),
    snapshot: async () => ({ url: page.url(), ...(await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 60_000),
      links: [...document.querySelectorAll("a[href]")].slice(0, 3_000).map((anchor) => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        href: (anchor as HTMLAnchorElement).href })) }))) }),
    responses: async () => { await Promise.allSettled([...pending]); return queue.splice(0, queue.length); },
    noteState: () => page.evaluate(() => {
      const plain = (value: unknown) => { try { return JSON.parse(JSON.stringify(value ?? null)) as unknown; } catch { return null; } };
      const state = (globalThis as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: unknown } } }).__INITIAL_STATE__;
      return plain(state?.note?.noteDetailMap ?? null);
    }),
    selfProfile: () => page.evaluate(() => {
      const state = (globalThis as unknown as { __INITIAL_STATE__?: { user?: { userInfo?: Record<string, unknown> } } }).__INITIAL_STATE__;
      const info = state?.user?.userInfo as Record<string, unknown> | undefined;
      const inner = (info && typeof info === "object" && "_value" in info ? info._value : info?.value ?? info) as Record<string, unknown> | undefined;
      const userId = typeof inner?.userId === "string" ? inner.userId : typeof inner?.user_id === "string" ? inner.user_id : undefined;
      const me = [...document.querySelectorAll("a[href*='/user/profile/']")].find((anchor) => (anchor.textContent ?? "").trim() === "我") as HTMLAnchorElement | undefined;
      return { ...(userId ? { userId } : {}), ...(me ? { href: me.href } : {}) };
    }),
    fetchMedia: async (url, referer, maxBytes) => {
      const headers = { referer };
      const head = await page.request.head(url, { headers, timeout: 60_000 }).catch(() => undefined);
      const declared = Number(head?.headers()["content-length"] ?? 0);
      if (declared > maxBytes) return { state: "too_large", bytes: declared };
      const response = await page.request.get(url, { headers, timeout: 15 * 60_000 });
      if (!response.ok()) return { state: "failed", status: response.status() };
      const bytes = await response.body();
      if (bytes.length > maxBytes) return { state: "too_large", bytes: bytes.length };
      return { state: "ok", bytes, contentType: response.headers()["content-type"] ?? "" };
    },
    close: () => context.close().catch(() => undefined)
  };
}

/** The folder a workflow's notes accumulate in, run after run (the assistant gets it read-only). */
export const collectFolder = (outputRoot: string, workflowId: string) => path.join(outputRoot, `collect-${workflowId.replace(/^flow-/, "")}`);
export const collectFolderExists = (folder: string) => existsSync(path.join(folder, "notes"));

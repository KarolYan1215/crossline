import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { parseCollectPage, parseFeedResponse, parseInitialStateNote, type GrownSkillRecord } from "@crossline/core";
import {
  CATCH_UP_GAP_MS, INCREMENTAL_BATCH, LIST_REST_EVERY, LIST_REST_MS, INCREMENTAL_GAP_MS, MEDIA_MAX_BYTES, collectFavourites, favouritesAccess, mediaExtension, readCollectLedger, writeCollectLedger,
  readNoteFile, type CapturedResponse, type CollectDriver, type MediaFetch
} from "./favourites-reader";
import { describeNotes, type PictureToDescribe } from "./note-media";
import { breakerKey, releaseSite, siteHold } from "./site-reader";

// Whole collections of 70 to 100 notes, each written to disk: on a busy machine one can take longer than vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", name), "utf8")) as unknown;

let store: CrosslineStore;
let ws: string;
let folder: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  folder = mkdtempSync(path.join(tmpdir(), "crossline-collect-"));
});
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });

test("the three sources read the same note fields: the API's answer, the page state, and the list", () => {
  const video = parseFeedResponse(fixture("xhs-feed-video.json"), "66aa00000000000000000002")!;
  expect(video).toMatchObject({ type: "video", title: "三分钟学会手冲咖啡（虚构样例）", tags: ["咖啡", "手冲"], author: { id: "5f0000000000000000000abc", name: "样例咖啡师" },
    ipLocation: "浙江", counts: { liked: "1.2万", collected: "8034", comment: "321", share: "77" }, source: "api" });
  expect(video.time).toBe(new Date(1790000000000).toISOString());
  expect(video.video).toEqual({ durationSeconds: 183, urls: ["https://sns-video-bd.xhscdn.com/stream/sample_h264.mp4", "https://sns-video-hw.xhscdn.com/stream/sample_h264.mp4",
    "https://sns-video-bd.xhscdn.com/stream/sample_h265.mp4", "https://sns-video-bd.xhscdn.com/pre_post/sample-origin-key"] });
  // The full-size scene first, every address kept.
  expect(video.images[0]!.urls[0]).toContain("nd_dft");
  expect(video.images[0]!.urls).toContain("https://sns-webpic-qc.xhscdn.com/sample/cover!nd_prv_wlteh_webp_3");
  expect(parseFeedResponse(fixture("xhs-feed-video.json"), "another")).toBeUndefined();

  const state = parseInitialStateNote(fixture("xhs-initial-state-note.json"), "66aa00000000000000000001")!;
  expect(state).toMatchObject({ type: "normal", title: "周末徒步路线整理（虚构样例）", author: { name: "样例山友" }, counts: { collected: "1024" }, source: "state" });
  expect(state.images).toHaveLength(2);
  expect(state.images[1]!.livePhotoUrls).toEqual(["https://sns-video-bd.xhscdn.com/live/sample_b.mp4"]);
  expect(state.video).toBeUndefined();
  // The state the page holds may wrap its map in a Vue ref.
  expect(parseInitialStateNote({ note: { noteDetailMap: { _value: fixture("xhs-initial-state-note.json") } } }, "66aa00000000000000000001")?.title).toBe(state.title);

  const page = parseCollectPage(fixture("xhs-collect-page.json"));
  expect(page).toMatchObject({ hasMore: true, cursor: "66aa00000000000000000002" });
  expect(page.notes.map((note) => [note.id, note.xsecToken, note.type])).toEqual([["66aa00000000000000000001", "ABsampleToken1=", "normal"], ["66aa00000000000000000002", "ABsampleToken2=", "video"]]);
});

const idOf = (n: number) => `66aa${String(n).padStart(20, "0")}`;
const COLLECT = "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=";
const FEED = "https://edith.xiaohongshu.com/api/sns/web/v1/feed";
type Script = {
  /** The favourites, newest first. */
  total: number;
  /** Notes whose page answers with a check / a login / gone. */
  check?: Set<string>; login?: Set<string>; gone?: Set<string>;
  /** Notes read from the page state instead of a feed answer. */
  stateOnly?: Set<string>;
  bigVideo?: boolean;
  /** The list stops loading after this many more pages without saying it ended (the site holding back). */
  stallAfter?: number;
  /** The list answers HTTP 461 from this page on until a verification is passed (`unblock`). */
  blockAfter?: number;
};
/** A fake site: the list comes 30 a screen as the page's own answers, each note page fires its own feed answer, media come back as bytes. */
function fakeSite(script: Script) {
  const log: string[] = [];
  let queue: CapturedResponse[] = [];
  let page = { url: "", title: "", text: "" };
  let listPage = 0;
  let onList = false;
  let current = "";
  let blocked = script.blockAfter !== undefined;
  const listPageJson = (index: number) => {
    // Newest first: note `total` was saved last.
    const ids = Array.from({ length: script.total }, (_, i) => idOf(script.total - i)).slice(index * 30, index * 30 + 30);
    return { code: 0, success: true, data: { cursor: ids.at(-1) ?? "", has_more: (index + 1) * 30 < script.total,
      notes: ids.map((id) => ({ note_id: id, xsec_token: `tok-${id.slice(-3)}`, display_title: `笔记 ${Number(id.slice(4))}`, type: Number(id.slice(4)) % 2 ? "normal" : "video",
        user: { user_id: "u-author", nickname: "作者" } })) } };
  };
  const card = (id: string) => ({ note_id: id, type: Number(id.slice(4)) % 2 ? "normal" : "video", title: `笔记 ${Number(id.slice(4))}`, desc: `正文 ${id}`, time: 1790000000000,
    user: { user_id: "u-author", nickname: "作者" }, interact_info: { liked_count: "1", collected_count: "2", comment_count: "3", share_count: "4" }, tag_list: [{ name: "样例" }],
    image_list: [{ url_default: `https://sns-webpic-qc.xhscdn.com/${id}/1`, info_list: [] }, { url_default: `https://sns-webpic-qc.xhscdn.com/${id}/2`, info_list: [] }],
    ...(Number(id.slice(4)) % 2 ? {} : { video: { capa: { duration: 30 }, media: { stream: { h264: [{ master_url: `https://sns-video-bd.xhscdn.com/${id}.mp4` }] } } } }) });
  const driver: CollectDriver = {
    goto: async (url) => {
      log.push(`goto ${url}`);
      const parsed = new URL(url);
      onList = parsed.pathname.startsWith("/user/profile/");
      if (parsed.pathname === "/explore") { page = { url, title: "小红书", text: "发现" }; queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v2/user/me", status: 200, json: { code: 0, data: { user_id: "me-1" } } }); return 200; }
      if (onList) { listPage = 0; queue.push({ url: COLLECT, status: 200, json: listPageJson(0) }); page = { url, title: "我的主页", text: "收藏" }; return 200; }
      current = parsed.pathname.split("/").pop()!;
      if (script.check?.has(current)) { page = { url: "https://www.xiaohongshu.com/website-login/captcha?redirect=x", title: "安全验证", text: "请完成验证" }; return 200; }
      if (script.login?.has(current)) { queue.push({ url: FEED, status: 200, json: { code: -100, success: false, msg: "登录已过期" } }); page = { url, title: "", text: "" }; return 200; }
      if (script.gone?.has(current)) { page = { url, title: "小红书", text: "当前笔记暂时无法浏览" }; return 200; }
      // A note about verification codes is a note, not a check.
      page = { url, title: `笔记 - 小红书`, text: "本文教你怎样收验证码" };
      if (!script.stateOnly?.has(current)) queue.push({ url: FEED, status: 200, json: { code: 0, success: true, data: { items: [{ id: current, note_card: card(current) }] } } });
      return 200;
    },
    pause: async () => {},
    wheel: async () => {
      log.push("wheel");
      if (!onList) return;
      if (script.stallAfter !== undefined && listPage >= script.stallAfter) return;
      if (blocked && listPage >= script.blockAfter!) { queue.push({ url: COLLECT, status: 461, json: { code: 0 } }); return; }
      listPage += 1;
      if (listPage * 30 < script.total) queue.push({ url: COLLECT, status: 200, json: listPageJson(listPage) });
    },
    snapshot: async () => ({ ...page, links: [] }),
    responses: async () => { const out = queue; queue = []; return out; },
    noteState: async () => (script.stateOnly?.has(current) ? { [current]: { note: { ...card(current), noteId: current } } } : null),
    selfProfile: async () => ({}),
    fetchMedia: async (url): Promise<MediaFetch> => {
      log.push(`media ${url}`);
      if (url.endsWith(".mp4")) return script.bigVideo ? { state: "too_large", bytes: MEDIA_MAX_BYTES + 1 } : { state: "ok", bytes: Buffer.from("....ftypisom"), contentType: "video/mp4" };
      return { state: "ok", bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), contentType: "image/webp" };
    },
    close: async () => { log.push("close"); }
  };
  return { driver, log, unblock: () => { blocked = false; } };
}
const run = (driver: CollectDriver, extra: Partial<Parameters<typeof collectFavourites>[0]> = {}) => {
  const gaps: number[] = [];
  const result = collectFavourites({ store, workspaceId: ws, workflowId: "flow-xhs", folder, driver, sleep: async (ms) => { gaps.push(ms); }, random: () => 0.5,
    now: () => new Date("2026-10-22T03:00:00Z"), ...extra });
  return { result, gaps };
};

test("the first run reads the whole list to its end and every note in it, a few seconds apart; the next run reads none twice", async () => {
  const site = fakeSite({ total: 70 });
  const first = run(site.driver);
  const result = await first.result;
  expect(result).toMatchObject({ state: "done", mode: "catch_up", listed: 70, listEnded: true, pending: 0 });
  expect(result.read).toHaveLength(70);
  // Two scrolls bring pages two and three, and the page said there is no more.
  expect(site.log.filter((line) => line === "wheel")).toHaveLength(2);
  const noteGaps = first.gaps.filter((ms) => ms >= CATCH_UP_GAP_MS[0]);
  expect(noteGaps.length).toBeGreaterThanOrEqual(70);
  expect(noteGaps.every((ms) => ms <= CATCH_UP_GAP_MS[1])).toBe(true);
  const ledger = readCollectLedger(store, ws, "flow-xhs");
  expect(ledger.caughtUpAt).toBe("2026-10-22T03:00:00.000Z");
  expect(ledger.selfId).toBe("me-1");
  expect(ledger.unorganised).toHaveLength(70);
  // Each note: its detail from the page's own answer, both pictures, and the video for a video note.
  const note = readNoteFile(folder, idOf(2))!;
  expect(note.detail).toMatchObject({ source: "api", desc: `正文 ${idOf(2)}` });
  expect(note.images.map((image) => image.file)).toEqual(["img-01.webp", "img-02.webp"]);
  expect(note.video?.file).toBe("video.mp4");
  expect(existsSync(path.join(folder, "notes", idOf(2), "video.mp4"))).toBe(true);
  expect(note.raw.api).toBeTruthy();

  const again = fakeSite({ total: 70 });
  const second = await run(again.driver).result;
  expect(second).toMatchObject({ mode: "incremental", read: [] });
  expect(again.log.filter((line) => line.includes("/explore/"))).toHaveLength(0);
  // Incremental stops scrolling at the first page whose notes were all read; who is signed in is not looked up again.
  expect(again.log.filter((line) => line === "wheel")).toHaveLength(0);
  expect(again.log.some((line) => line === "goto https://www.xiaohongshu.com/explore")).toBe(false);
});

test("later runs read only new notes, a few at a time at a person's pace", async () => {
  await run(fakeSite({ total: 40 }).driver).result;
  // 25 new favourites arrive on top of the list (41..65).
  const site = fakeSite({ total: 65 });
  const later = run(site.driver);
  const result = await later.result;
  expect(result.mode).toBe("incremental");
  expect(result.read.length).toBeLessThanOrEqual(INCREMENTAL_BATCH);
  expect(result.read.every((id) => Number(id.slice(4)) > 40)).toBe(true);
  expect(result.pending).toBe(25 - result.read.length);
  const noteGaps = later.gaps.filter((ms) => ms >= INCREMENTAL_GAP_MS[0]);
  expect(noteGaps).toHaveLength(result.read.length);
  expect(noteGaps.every((ms) => ms <= INCREMENTAL_GAP_MS[1])).toBe(true);
});

test("a security check stops the run, keeps what was read and what the site answered, and holds the site until the person restarts it", async () => {
  const site = fakeSite({ total: 10, check: new Set([idOf(7)]) });
  const result = await run(site.driver).result;
  expect(result).toMatchObject({ state: "check", read: [idOf(10), idOf(9), idOf(8)] });
  expect(result.trigger).toContain("笔记");
  expect(siteHold(store, ws, "xiaohongshu.com")).toMatchObject({ where: "笔记" });
  expect(readCollectLedger(store, ws, "flow-xhs").caughtUpAt).toBeUndefined();

  const paused = fakeSite({ total: 10 });
  expect(await run(paused.driver).result).toMatchObject({ state: "paused" });
  expect(paused.log).toHaveLength(0);
  // Time does not lift it.
  expect(await run(fakeSite({ total: 10 }).driver, { now: () => new Date("2026-12-01T00:00:00Z") }).result).toMatchObject({ state: "paused" });
  // Once the person starts it again, the catch-up resumes from the note it stopped on.
  releaseSite(store, ws, "xiaohongshu.com");
  const resumed = await run(fakeSite({ total: 10 }).driver).result;
  expect(resumed).toMatchObject({ state: "done", mode: "catch_up" });
  expect(resumed.read[0]).toBe(idOf(7));
  expect(resumed.read).toHaveLength(7);
});

test("an expired login stops the run without closing the site; a gone note is marked and never opened again; the page state stands in for a missing answer", async () => {
  const site = fakeSite({ total: 6, login: new Set([idOf(2)]), gone: new Set([idOf(5)]), stateOnly: new Set([idOf(4)]) });
  const result = await run(site.driver).result;
  expect(result).toMatchObject({ state: "login", read: [idOf(6), idOf(4), idOf(3)], gone: [idOf(5)] });
  expect(store.getSetting(ws, breakerKey("xiaohongshu.com"))).toBeUndefined();
  expect(readNoteFile(folder, idOf(4))!.detail.source).toBe("state");
  const next = fakeSite({ total: 6 });
  const resumed = await run(next.driver).result;
  expect(resumed.read).toEqual([idOf(2), idOf(1)]);
  expect(next.log.some((line) => line.includes(`/explore/${idOf(5)}`))).toBe(false);
});

test("a file over the size cap is not saved and says so; the limit of the trial reads only a few", async () => {
  const site = fakeSite({ total: 4, bigVideo: true });
  const result = await run(site.driver, { limit: 2 }).result;
  expect(result.read).toEqual([idOf(4), idOf(3)]);
  expect(readNoteFile(folder, idOf(4))!.video).toMatchObject({ problem: expect.stringContaining("超过 500 MB") });
  // A trial with a limit never counts as caught up.
  expect(readCollectLedger(store, ws, "flow-xhs").caughtUpAt).toBeUndefined();
  expect(mediaExtension(Buffer.from("\u0000\u0000\u0000\u0018ftypavif"), "", "jpg")).toBe("avif");
  expect(mediaExtension(Buffer.from("xx"), "image/jpeg", "bin")).toBe("jpg");
});

test("a list that stops loading without saying it ended is held like a check, not taken as complete", async () => {
  const site = fakeSite({ total: 300, stallAfter: 1 });
  const result = await run(site.driver, { listOnly: true, mode: "catch_up" }).result;
  expect(result).toMatchObject({ state: "check", listEnded: false, listed: 60 });
  expect(result.trigger).toContain("没有新内容");
  const ledger = readCollectLedger(store, ws, "flow-xhs");
  expect(ledger.listedAt).toBeUndefined();
  expect(Object.keys(ledger.listed ?? {})).toHaveLength(60);
  expect(siteHold(store, ws, "xiaohongshu.com")).toMatchObject({ where: expect.stringContaining("60 条") });
});

test("a verification the person passes on the page lets the list go on from where it stopped; one not passed stops it", async () => {
  const site = fakeSite({ total: 300, blockAfter: 4 });
  const asked: string[] = [];
  const result = await run(site.driver, { listOnly: true, mode: "catch_up", verify: async (where) => { asked.push(where); site.unblock(); return true; } }).result;
  expect(asked).toEqual(["收藏列表第 5 屏"]);
  expect(result).toMatchObject({ state: "done", listEnded: true, listed: 300 });
  expect(siteHold(store, ws, "xiaohongshu.com")).toBeUndefined();
  const refused = fakeSite({ total: 300, blockAfter: 4 });
  writeCollectLedger(store, ws, "flow-xhs", { read: {}, unorganised: [] });
  const stopped = await run(refused.driver, { listOnly: true, mode: "catch_up", verify: async () => false }).result;
  expect(stopped).toMatchObject({ state: "check", listEnded: false });
});

test("a list the site stops at the same depth twice counts as the whole list, and the next run reads instead of scrolling again", async () => {
  const first = await run(fakeSite({ total: 300, stallAfter: 1 }).driver, { listOnly: true, mode: "catch_up" }).result;
  expect(first.listCapped).toBeUndefined();
  releaseSite(store, ws, "xiaohongshu.com");
  const second = await run(fakeSite({ total: 300, stallAfter: 1 }).driver, { listOnly: true, mode: "catch_up" }).result;
  expect(second).toMatchObject({ state: "check", listCapped: true, listed: 60 });
  const ledger = readCollectLedger(store, ws, "flow-xhs");
  expect(ledger.listedAt).toBeDefined();
  expect(ledger.listCapped?.why).toContain("60 条");
  // A stop much earlier than the last says nothing about the depth: no cap from it.
  writeCollectLedger(store, ws, "flow-xhs", { read: {}, unorganised: [], listStops: [{ at: "x", listed: 1170 }] });
  releaseSite(store, ws, "xiaohongshu.com");
  expect((await run(fakeSite({ total: 300, stallAfter: 1 }).driver, { listOnly: true, mode: "catch_up" }).result).listCapped).toBeUndefined();
});

test("the list is scrolled at a person's pace, with a rest every 30 screens", async () => {
  const site = fakeSite({ total: 1_000 });
  const listing = run(site.driver, { listOnly: true, mode: "catch_up" });
  const result = await listing.result;
  expect(result.listEnded).toBe(true);
  const screens = site.log.filter((line) => line === "wheel").length;
  const rests = listing.gaps.filter((ms) => ms >= LIST_REST_MS[0] && ms <= LIST_REST_MS[1]);
  expect(rests).toHaveLength(Math.floor(screens / LIST_REST_EVERY));
});

test("the list alone: read to its end once, then a weekly look that reaches notes already listed counts as up to date", async () => {
  const first = await run(fakeSite({ total: 65 }).driver, { listOnly: true, mode: "catch_up" }).result;
  expect(first).toMatchObject({ state: "done", listed: 65, listEnded: true, read: [] });
  expect(readCollectLedger(store, ws, "flow-xhs").listedAt).toBe("2026-10-22T03:00:00.000Z");
  // A week later, five new favourites on top: the second page holds only listed notes, so the look stops there and is done.
  const site = fakeSite({ total: 70 });
  const later = await run(site.driver, { listOnly: true, mode: "incremental", now: () => new Date("2026-10-29T03:00:00Z") }).result;
  expect(later).toMatchObject({ state: "done", listEnded: false, read: [] });
  expect(site.log.filter((line) => line === "wheel")).toHaveLength(1);
  const ledger = readCollectLedger(store, ws, "flow-xhs");
  expect(ledger.listedAt).toBe("2026-10-29T03:00:00.000Z");
  expect(Object.keys(ledger.listed ?? {})).toHaveLength(70);
});

test("past the memory line the list stops where it is: what it showed is kept, counted as listed and read, and nothing is held", async () => {
  const site = fakeSite({ total: 100 });
  let wheels = 0;
  let told = false;
  const wheel = site.driver.wheel;
  site.driver.wheel = async () => { wheels += 1; await wheel(); };
  // Full once, after two more screens of the list (the page holds every card it has shown); then room again for the notes.
  const memory = { over: () => (wheels === 2 && !told ? (told = true) : false), mediaBytes: (wanted: number) => wanted, describe: () => "1220 / 1350 MB" };
  const result = await run(site.driver, { memory }).result;
  expect(result).toMatchObject({ state: "done", listed: 90, listEnded: false, listCapped: true, pending: 0 });
  expect(result.read).toHaveLength(90);
  const ledger = readCollectLedger(store, ws, "flow-xhs");
  expect(ledger.listCapped).toEqual({ at: "2026-10-22T03:00:00.000Z", listed: 90, memory: "1220 / 1350 MB" });
  expect(ledger.listedAt).toBe("2026-10-22T03:00:00.000Z");
  // The notes past the line cannot be reached here: the catch-up counts as done, so later runs are incremental instead of scrolling to the line again.
  expect(ledger.caughtUpAt).toBe("2026-10-22T03:00:00.000Z");
  expect(siteHold(store, ws, "xiaohongshu.com")).toBeUndefined();
});

test("past the memory line between notes the run stops itself, keeps what it read and does not hold the site; the next run goes on", async () => {
  let reads = 0;
  const memory = { over: () => reads >= 3, mediaBytes: (wanted: number) => wanted, describe: () => "1230 / 1350 MB" };
  const site = fakeSite({ total: 8 });
  const writeNote = site.driver.fetchMedia;
  site.driver.fetchMedia = async (url, referer, max) => { if (url.endsWith("/2")) reads += 1; return writeNote(url, referer, max); };
  const result = await run(site.driver, { memory }).result;
  expect(result).toMatchObject({ state: "memory", read: [idOf(8), idOf(7), idOf(6)], pending: 5 });
  expect(result.message).toContain("1230 / 1350 MB");
  expect(siteHold(store, ws, "xiaohongshu.com")).toBeUndefined();
  expect(readCollectLedger(store, ws, "flow-xhs").caughtUpAt).toBeUndefined();
  const next = await run(fakeSite({ total: 8 }).driver).result;
  expect(next).toMatchObject({ state: "done", mode: "catch_up", pending: 0 });
  expect(next.read).toEqual([idOf(5), idOf(4), idOf(3), idOf(2), idOf(1)]);
});

test("a download is held to the room the memory line leaves, and the note says why it was not saved", async () => {
  const site = fakeSite({ total: 2 });
  const asked: number[] = [];
  site.driver.fetchMedia = async (url, _referer, max): Promise<MediaFetch> => {
    asked.push(max);
    return url.endsWith(".mp4") && max < 50 * 1_048_576 ? { state: "too_large", bytes: 50 * 1_048_576 } : { state: "ok", bytes: Buffer.from("RIFF0000WEBP"), contentType: "image/webp" };
  };
  const memory = { over: () => false, mediaBytes: () => 20 * 1_048_576, describe: () => "" };
  await run(site.driver, { memory }).result;
  expect(asked.every((max) => max === 20 * 1_048_576)).toBe(true);
  expect(readNoteFile(folder, idOf(2))!.video).toMatchObject({ problem: expect.stringContaining("服务器内存只够下载 20 MB") });
});

test("notes become Markdown: pictures and video stills described in batches, the video heard, and an index", async () => {
  await run(fakeSite({ total: 3 }).driver).result;
  const batches: PictureToDescribe[][] = [];
  const heard: string[] = [];
  const written = await describeNotes(folder, {
    describe: async (pictures) => { batches.push(pictures); return pictures.map((picture) => ({ id: picture.id, description: `${picture.kind} ${picture.position} 的描述`, text: "图里的字" })); },
    transcribe: async (wav) => { heard.push(wav); return { text: "[00:01] 大家好" }; },
    ffmpeg: { audio: async (_video, wav) => { writeFileSync(wav, "RIFF"); return true; },
      frames: async (_video, dir) => { const files = [1, 2].map((n) => path.join(dir, `frame-0${n}.jpg`)); for (const file of files) writeFileSync(file, "jpg"); return files; },
      toJpeg: async () => false }
  });
  expect(written.described).toHaveLength(3);
  // 2 + 4 + 2 pictures: whole notes to a run, at most twelve pictures.
  expect(batches.map((batch) => batch.length)).toEqual([8]);
  expect(heard).toHaveLength(1);
  const video = readFileSync(path.join(folder, `note-${idOf(2)}.md`), "utf8");
  for (const part of ["# 笔记 2", "image 1 的描述", "图中文字：图里的字", "[00:01] 大家好", "### 帧 2", "frame 2 的描述", `https://www.xiaohongshu.com/explore/${idOf(2)}`])
    expect(video).toContain(part);
  expect(readFileSync(path.join(folder, "index.md"), "utf8")).toContain("共 3 条");
  expect(readNoteFile(folder, idOf(1))!.describedAt).toBeTruthy();

  // Described notes are not sent again; a failed run leaves the notes undescribed, their Markdown saying why.
  await run(fakeSite({ total: 4 }).driver).result;
  const failed = await describeNotes(folder, { describe: async () => { throw new Error("quota"); } });
  expect(failed.described).toEqual([]);
  expect(readFileSync(path.join(folder, `note-${idOf(4)}.md`), "utf8")).toContain("图片描述这次没有完成");
  expect(readNoteFile(folder, idOf(4))!.describedAt).toBeUndefined();
});

test("only a workflow about Xiaohongshu favourites behind a login goes to the collector", () => {
  const record = (summary: string, site = "https://www.xiaohongshu.com/", login = true) => ({ id: "flow-x", name: "x", description: "", manifest: { summary,
    access: [{ service: "小红书", site, login, how: "读收藏页" }], risks: [] } }) as unknown as GrownSkillRecord;
  expect(favouritesAccess(record("每周整理小红书收藏"))?.service).toBe("小红书");
  expect(favouritesAccess(record("每周整理收藏", "https://www.zhihu.com/"))).toBeUndefined();
  expect(favouritesAccess(record("每周整理收藏", "https://www.xiaohongshu.com/", false))).toBeUndefined();
});

test("a run over given notes stops cleanly between two notes when asked to hand over: what was read is kept, nothing is held, and the same notes carry on elsewhere", async () => {
  const listing = fakeSite({ total: 6 });
  await run(listing.driver, { listOnly: true }).result;
  const targets = Array.from({ length: 6 }, (_, i) => idOf(6 - i));
  const site = fakeSite({ total: 6 });
  let asked = 0;
  const first = await run(site.driver, { targets, handover: () => { asked += 1; return asked > 3; } }).result;
  expect(first).toMatchObject({ state: "handover", pending: 3 });
  expect(first.read).toEqual(targets.slice(0, 3));
  expect(readCollectLedger(store, ws, "flow-xhs").unorganised).toEqual(targets.slice(0, 3));
  expect(siteHold(store, ws, "xiaohongshu.com")).toBeUndefined();
  // The notes already read are not opened again by whoever takes over.
  const other = fakeSite({ total: 6 });
  const rest = await run(other.driver, { targets }).result;
  expect(rest).toMatchObject({ state: "done" });
  expect(rest.read).toEqual(targets.slice(3));
  expect(other.log.filter((line) => line.startsWith("goto") && line.includes("/explore/"))).toHaveLength(3);
});

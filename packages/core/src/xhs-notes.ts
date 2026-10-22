/**
 * Xiaohongshu notes as Crossline reads them (docs/skills-library.md 「收藏全量读取」, the owner's decision of 2026-10-22): the favourites
 * reader (`apps/worker/src/favourites-reader.ts`) opens the person's own favourites in a visible browser on their own login and keeps
 * what the page itself fetched. Three sources, in order of how much they carry:
 *
 * 1. the JSON the page's own requests returned (`page.on("response")`): the favourites list (`/api/sns/web/v2/note/collect/page`, 30 a
 *    page with `cursor` and `has_more`) and a note's detail (`/api/sns/web/v1/feed`, `items[0].note_card`), snake_case;
 * 2. the note page's server-rendered state, `window.__INITIAL_STATE__.note.noteDetailMap[<id>].note`, the same note in camelCase;
 * 3. the page's visible text, when neither is there.
 *
 * Nothing here asks the site for anything: these functions only read what the browser already received. Field names are those used by
 * xpzouying/xiaohongshu-mcp (`types.go`, `feed_detail.go`) and NanmiCoder/MediaCrawler (`media_platform/xhs/client.py`,
 * `store/xhs/__init__.py`), read on 2026-10-22; both spellings are accepted everywhere because the two sources differ only in case.
 */

/** The page's own requests worth keeping: the favourites list, a note's detail, and who is signed in. */
export const XHS_COLLECT_PATH = /\/api\/sns\/web\/v\d+\/note\/collect\/page\b/;
export const XHS_FEED_PATH = /\/api\/sns\/web\/v\d+\/feed\b/;
export const XHS_SELF_PATH = /\/api\/sns\/web\/v\d+\/user\/(me|selfinfo)\b/;
export const xhsCaptured = (url: string) => XHS_COLLECT_PATH.test(url) || XHS_FEED_PATH.test(url) || XHS_SELF_PATH.test(url);

export const XHS_HOME = "https://www.xiaohongshu.com/explore";
export const xhsNoteUrl = (id: string, xsecToken = "") =>
  `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_collect` : ""}`;
/** The favourites tab is opened by its address: clicking the tab in script does not load its data (third-party notes, 2026-10). */
export const xhsFavouritesUrl = (userId: string) => `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}?tab=fav&subTab=note`;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** The first of several spellings that is present (snake_case from the API, camelCase from the page state). */
const pick = (source: Json, ...names: string[]): unknown => { for (const name of names) if (source[name] !== undefined && source[name] !== null) return source[name]; return undefined; };
const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
/** A Vue ref the page state may wrap a value in. */
const unref = (value: unknown): unknown => { const o = obj(value); return "_value" in o ? o._value : "value" in o && Object.keys(o).length <= 3 ? o.value : value; };

export type ListedNote = { id: string; xsecToken: string; title: string; type: string; author?: { id: string; name: string } };

/** One page of the favourites list as the page fetched it: its notes, whether more follow, and the cursor it would ask with next. */
export function parseCollectPage(json: unknown): { notes: ListedNote[]; hasMore?: boolean; cursor?: string } {
  const data = obj(obj(json).data);
  const notes = arr(data.notes).flatMap((item): ListedNote[] => {
    const note = obj(item);
    const id = str(pick(note, "note_id", "noteId", "id"));
    if (!id) return [];
    const user = obj(note.user);
    const authorId = str(pick(user, "user_id", "userId"));
    return [{ id, xsecToken: str(pick(note, "xsec_token", "xsecToken")), title: str(pick(note, "display_title", "displayTitle", "title")), type: str(note.type),
      ...(authorId ? { author: { id: authorId, name: str(pick(user, "nickname", "nick_name", "nickName")) } } : {}) }];
  });
  const more = pick(data, "has_more", "hasMore");
  const cursor = str(data.cursor);
  return { notes, ...(typeof more === "boolean" ? { hasMore: more } : {}), ...(cursor ? { cursor } : {}) };
}

/** Notes named by the links a list page shows, with the token the link carries: what the list gives when no response was kept. */
export function notesFromLinks(links: Array<{ text: string; href: string }>): ListedNote[] {
  const found = new Map<string, ListedNote>();
  for (const link of links) {
    let url: URL;
    try { url = new URL(link.href); } catch { continue; }
    if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) continue;
    const match = /^\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]{24})\/?$/i.exec(url.pathname);
    if (!match || found.has(match[1]!)) continue;
    found.set(match[1]!, { id: match[1]!, xsecToken: url.searchParams.get("xsec_token") ?? "", title: link.text.slice(0, 120), type: "" });
  }
  return [...found.values()];
}

/** Who is signed in, from the page's own `user/me` or `selfinfo` answer. */
export function selfIdFromResponse(json: unknown): string | undefined {
  const data = obj(obj(json).data);
  return str(pick(data, "user_id", "userId")) || str(pick(obj(data.basic_info), "user_id", "red_id")) || undefined;
}

export type NoteImage = { index: number; width?: number; height?: number; urls: string[]; livePhotoUrls: string[] };
export type NoteDetail = {
  id: string; title: string; desc: string;
  /** `normal` is a picture note, `video` a video note; anything else is kept as the site wrote it. */
  type: string;
  tags: string[];
  author: { id: string; name: string };
  /** ISO times (the site gives milliseconds). */
  time?: string; lastUpdate?: string; ipLocation?: string;
  counts: { liked: string; collected: string; comment: string; share: string };
  images: NoteImage[];
  video?: { durationSeconds?: number; urls: string[] };
  /** Where this reading came from: the page's own request, its rendered state, or only its visible text. */
  source: "api" | "state" | "dom";
};

const iso = (value: unknown) => { const ms = Number(value); return Number.isFinite(ms) && ms > 0 ? new Date(ms < 1e12 ? ms * 1000 : ms).toISOString() : undefined; };
// The page keys streams by codec, and not only h264/h265: on the real account (2026-10-22) they were EF4 (a muxed .mp4) and EF5/EF6 (DASH
// .m4s, video only). Every key is read; a muxed .mp4 goes first because it carries the sound the transcript needs.
const streamUrls = (stream: Json) => Object.values(stream).flatMap((list) => arr(list)).map(obj)
  .sort((a, b) => Number(/\.mp4(\?|$)/.test(str(pick(b, "master_url", "masterUrl")))) - Number(/\.mp4(\?|$)/.test(str(pick(a, "master_url", "masterUrl")))))
  .flatMap((item) => [str(pick(item, "master_url", "masterUrl")), ...arr(pick(item, "backup_urls", "backupUrls")).map(str)].filter(Boolean));
const unique = (list: string[]) => [...new Set(list.filter(Boolean))];

/** A note card (the API's `note_card` or the page state's `note`) as one shape. */
export function noteFromCard(card: unknown, source: "api" | "state", fallbackId = ""): NoteDetail | undefined {
  const note = obj(card);
  const id = str(pick(note, "note_id", "noteId", "id")) || fallbackId;
  if (!id) return undefined;
  const user = obj(note.user);
  const interact = obj(pick(note, "interact_info", "interactInfo"));
  const images = arr(pick(note, "image_list", "imageList")).map((entry, index): NoteImage => {
    const image = obj(entry);
    // The full-size scene first (WB_DFT), then the default and preview addresses; every address the page had is kept.
    const scenes = arr(pick(image, "info_list", "infoList")).map(obj)
      .sort((a, b) => Number(str(pick(b, "image_scene", "imageScene")).includes("DFT")) - Number(str(pick(a, "image_scene", "imageScene")).includes("DFT")))
      .map((scene) => str(scene.url));
    const width = Number(image.width), height = Number(image.height);
    return { index: index + 1, ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}),
      urls: unique([...scenes, str(pick(image, "url_default", "urlDefault")), str(image.url), str(pick(image, "url_pre", "urlPre"))]),
      livePhotoUrls: pick(image, "live_photo", "livePhoto") ? unique(streamUrls(obj(image.stream))) : [] };
  });
  const video = obj(note.video);
  const originKey = str(pick(obj(video.consumer), "origin_video_key", "originVideoKey"));
  const videoUrls = unique([...streamUrls(obj(obj(video.media).stream)), ...(originKey ? [`https://sns-video-bd.xhscdn.com/${originKey}`] : [])]);
  const duration = Number(pick(obj(video.capa), "duration") ?? pick(obj(obj(video.media).video), "duration"));
  const time = iso(note.time), lastUpdate = iso(pick(note, "last_update_time", "lastUpdateTime"));
  const ip = str(pick(note, "ip_location", "ipLocation"));
  return {
    id, title: str(pick(note, "title", "display_title", "displayTitle")), desc: str(note.desc), type: str(note.type) || (videoUrls.length ? "video" : "normal"),
    tags: unique(arr(pick(note, "tag_list", "tagList")).map((tag) => str(obj(tag).name))),
    author: { id: str(pick(user, "user_id", "userId")), name: str(pick(user, "nickname", "nick_name", "nickName")) },
    ...(time ? { time } : {}), ...(lastUpdate ? { lastUpdate } : {}), ...(ip ? { ipLocation: ip } : {}),
    counts: { liked: str(pick(interact, "liked_count", "likedCount")), collected: str(pick(interact, "collected_count", "collectedCount")),
      comment: str(pick(interact, "comment_count", "commentCount")), share: str(pick(interact, "share_count", "shareCount")) },
    images, ...(videoUrls.length || video.media ? { video: { urls: videoUrls, ...(duration > 0 ? { durationSeconds: duration } : {}) } } : {}),
    source
  };
}

/** A note's detail out of the page's own `feed` answer, when it is the note asked for. */
export function parseFeedResponse(json: unknown, id: string): NoteDetail | undefined {
  for (const item of arr(obj(obj(json).data).items)) {
    const entry = obj(item);
    const card = obj(pick(entry, "note_card", "noteCard"));
    const found = noteFromCard(card, "api", str(entry.id));
    if (found && found.id === id) return found;
  }
  return undefined;
}

/** The note out of the page state's `note.noteDetailMap` (the map, or the whole state). */
export function parseInitialStateNote(state: unknown, id: string): NoteDetail | undefined {
  const whole = obj(unref(state));
  const map = obj(unref(obj(unref(whole.note)).noteDetailMap ?? whole.noteDetailMap ?? whole));
  const entry = obj(unref(map[id]));
  const card = entry.note ?? (pick(entry, "noteId", "note_id") ? entry : undefined);
  return card ? noteFromCard(unref(card), "state", id) : undefined;
}

/** What only the visible page says: the title and the text, nothing structured. */
export function noteFromDom(id: string, title: string, text: string): NoteDetail {
  return { id, title: title.replace(/\s*-\s*小红书.*$/, "").trim(), desc: text.slice(0, 20_000), type: "", tags: unique([...text.matchAll(/#([^#\s[\]]{1,30})/g)].map((match) => match[1]!)),
    author: { id: "", name: "" }, counts: { liked: "", collected: "", comment: "", share: "" }, images: [], source: "dom" };
}

/** A note that cannot be read any more (deleted, private, blocked): it is marked and not opened again. Words from xiaohongshu-mcp. */
export const NOTE_GONE_TEXT = /当前笔记暂时无法浏览|该内容因违规已被删除|该笔记已被删除|内容不存在|笔记不存在|已失效|私密笔记|仅作者可见|因用户设置，你无法查看|因违规无法查看/;

/**
 * What one of the page's own answers says about the account: a rate limit or a check (stop, and do not come back for days), a login
 * that ran out (stop), or nothing. Status 461/471 and codes 3000xx are how the site answers 「访问频次异常」 and the like.
 */
export function judgeXhsApi(status: number, json: unknown): "check" | "login" | "ok" {
  const body = obj(json);
  const code = Number(body.code), message = str(pick(body, "msg", "message"));
  if (status === 461 || status === 471 || status === 429 || (code >= 300011 && code <= 300019) || /频繁|频次|访问异常|环境异常|安全验证|验证码|滑块|captcha/i.test(message)) return "check";
  if (status === 401 || code === -100 || code === -101 || /登录已过期|请先登录|未登录/.test(message)) return "login";
  return "ok";
}

// ── What the person reads ────────────────────────────────────────────────────────────────────────────────────────────

export type MediaText = { file?: string; description?: string; text?: string; problem?: string };
export type NoteMedia = {
  images: MediaText[];
  video?: { file?: string; problem?: string; transcript?: string; transcriptProblem?: string; frames: MediaText[] };
};

const TYPE_LABEL: Record<string, string> = { normal: "图文", video: "视频" };
const SOURCE_LABEL: Record<NoteDetail["source"], string> = { api: "页面自身请求的数据", state: "页面内嵌数据", dom: "页面可见文字（无结构数据）" };
const counted = (label: string, value: string) => (value ? `${label} ${value}` : "");
const mediaLines = (label: string, item: MediaText) => [
  `### ${label}${item.file ? `（${item.file}）` : ""}`,
  ...(item.problem ? [`未保存：${item.problem}`] : []),
  ...(item.description ? [item.description.trim()] : item.problem ? [] : ["（没有描述）"]),
  ...(item.text?.trim() ? ["", `图中文字：${item.text.trim()}`] : []), ""];

/** One note as a Markdown file: everything the note carries, its pictures described and its video heard, and where it came from. */
export function noteMarkdown(note: NoteDetail, media: NoteMedia): string {
  const link = xhsNoteUrl(note.id);
  const counts = [counted("赞", note.counts.liked), counted("收藏", note.counts.collected), counted("评论", note.counts.comment), counted("分享", note.counts.share)].filter(Boolean).join(" · ");
  const lines = [
    `# ${note.title || "（无标题）"}`, "",
    `- 链接：${link}`,
    `- 作者：${note.author.name || "（未知）"}${note.author.id ? `（${note.author.id}）` : ""}`,
    `- 类型：${TYPE_LABEL[note.type] ?? (note.type || "未知")}`,
    ...(note.time ? [`- 发布：${note.time.slice(0, 16).replace("T", " ")}${note.lastUpdate && note.lastUpdate !== note.time ? `（更新 ${note.lastUpdate.slice(0, 16).replace("T", " ")}）` : ""}`] : []),
    ...(note.ipLocation ? [`- IP 属地：${note.ipLocation}`] : []),
    ...(counts ? [`- 互动：${counts}`] : []),
    ...(note.tags.length ? [`- 标签：${note.tags.map((tag) => `#${tag}`).join(" ")}`] : []),
    `- 读取来源：${SOURCE_LABEL[note.source]}`, "",
    "## 正文", "", note.desc.trim() || "（无正文）", ""];
  if (media.images.length) lines.push("## 图片", "", ...media.images.flatMap((image, index) => mediaLines(`图 ${index + 1}`, image)));
  if (media.video) {
    const video = media.video;
    lines.push("## 视频", "", `- 文件：${video.file ?? `未保存（${video.problem ?? "没有可用地址"}）`}`,
      ...(note.video?.durationSeconds ? [`- 时长：${Math.round(note.video.durationSeconds)} 秒`] : []), "",
      "### 转写", "", video.transcript?.trim() || `（${video.transcriptProblem ?? "没有听到说话"}）`, "");
    if (video.frames.length) lines.push("### 关键帧", "", ...video.frames.flatMap((frame, index) => mediaLines(`帧 ${index + 1}`, frame)));
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export type IndexEntry = { id: string; title: string; author: string; type: string; time?: string; file: string; readAt: string };

/** The folder's contents page: every note read so far, newest read first, each linked to its own file. */
export function notesIndexMarkdown(entries: IndexEntry[], heading = "小红书收藏"): string {
  const cell = (text: string) => text.replace(/\|/g, "／").replace(/\s+/g, " ").trim();
  const rows = [...entries].sort((a, b) => b.readAt.localeCompare(a.readAt) || a.id.localeCompare(b.id))
    .map((entry) => `| [${cell(entry.title || "（无标题）")}](${entry.file}) | ${cell(entry.author)} | ${TYPE_LABEL[entry.type] ?? cell(entry.type || "—")} | ${entry.time?.slice(0, 10) ?? "—"} | ${xhsNoteUrl(entry.id)} |`);
  return [`# ${heading}`, "", `共 ${entries.length} 条。`, "", "| 标题 | 作者 | 类型 | 发布 | 链接 |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

// ── Pictures into words (Skill `crossline-media-describer`) ──────────────────────────────────────────────────────────

/** At most this many pictures go to one run, whole notes together: the model keeps them apart by their order and ids. */
export const DESCRIBE_IMAGES_PER_RUN = 12;

export const MEDIA_DESCRIPTION_SCHEMA = { type: "object", additionalProperties: false, required: ["images"], properties: {
  images: { type: "array", minItems: 1, maxItems: DESCRIBE_IMAGES_PER_RUN, items: { type: "object", additionalProperties: false, required: ["id", "description", "text"], properties: {
    id: { type: "string", minLength: 1, maxLength: 40 },
    description: { type: "string", minLength: 1, maxLength: 1200 },
    text: { type: "string", maxLength: 4000 } } } } } } as const;

export type MediaDescription = { id: string; description: string; text: string };

/** Every picture sent is answered once, by its own id, and nothing else: anything else is sent back. */
export function validateMediaDescriptions(output: unknown, ids: string[]): MediaDescription[] {
  const answered = arr(obj(output).images).map((item) => { const entry = obj(item); return { id: str(entry.id), description: str(entry.description).trim(), text: str(entry.text).trim() }; });
  const fail = (detail: string) => Object.assign(new Error("MEDIA_DESCRIPTION_INVALID"), { code: "MEDIA_DESCRIPTION_INVALID", detail });
  const unknown = answered.filter((item) => !ids.includes(item.id)).map((item) => item.id);
  if (unknown.length) throw fail(`这些 id 不是给出的图片：${unknown.join("、")}`);
  const missing = ids.filter((id) => !answered.some((item) => item.id === id && item.description));
  if (missing.length) throw fail(`这些图片没有描述：${missing.join("、")}`);
  const twice = ids.filter((id) => answered.filter((item) => item.id === id).length > 1);
  if (twice.length) throw fail(`这些图片描述了不止一次：${twice.join("、")}`);
  return ids.map((id) => answered.find((item) => item.id === id)!);
}

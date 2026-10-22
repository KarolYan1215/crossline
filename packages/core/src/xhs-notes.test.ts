import { expect, test } from "vitest";
import {
  judgeXhsApi, noteFromCard, noteFromDom, noteMarkdown, notesFromLinks, notesIndexMarkdown, parseCollectPage, selfIdFromResponse, validateMediaDescriptions, xhsCaptured,
  xhsFavouritesUrl, xhsNoteUrl, type NoteDetail
} from "./xhs-notes";

test("only the page's own list, detail and self answers are kept", () => {
  expect(xhsCaptured("https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=&user_id=u")).toBe(true);
  expect(xhsCaptured("https://edith.xiaohongshu.com/api/sns/web/v1/feed")).toBe(true);
  expect(xhsCaptured("https://edith.xiaohongshu.com/api/sns/web/v2/user/me")).toBe(true);
  expect(xhsCaptured("https://edith.xiaohongshu.com/api/sns/web/v1/homefeed")).toBe(false);
  expect(xhsCaptured("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page")).toBe(false);
});

test("a list page without has_more says nothing about the end; links give notes with their token", () => {
  expect(parseCollectPage({ data: { notes: [{ note_id: "a1" }] } })).toEqual({ notes: [{ id: "a1", xsecToken: "", title: "", type: "" }] });
  expect(parseCollectPage({ data: { notes: [], has_more: false } }).hasMore).toBe(false);
  const links = notesFromLinks([
    { text: "徒步", href: "https://www.xiaohongshu.com/user/profile/5f00/66aa00000000000000000001?xsec_token=T1&xsec_source=pc_collect" },
    { text: "咖啡", href: "https://www.xiaohongshu.com/explore/66aa00000000000000000002?xsec_token=T2" },
    { text: "导航", href: "https://www.xiaohongshu.com/explore" },
    { text: "别处", href: "https://evil.example/explore/66aa00000000000000000003" }]);
  expect(links.map((note) => [note.id, note.xsecToken])).toEqual([["66aa00000000000000000001", "T1"], ["66aa00000000000000000002", "T2"]]);
  expect(xhsNoteUrl("66aa00000000000000000001", "A=B")).toBe("https://www.xiaohongshu.com/explore/66aa00000000000000000001?xsec_token=A%3DB&xsec_source=pc_collect");
  expect(xhsFavouritesUrl("u1")).toBe("https://www.xiaohongshu.com/user/profile/u1?tab=fav&subTab=note");
  expect(selfIdFromResponse({ data: { user_id: "u1", nickname: "x" } })).toBe("u1");
});

test("rate limits and checks stop, an expired login asks to log in, anything else is fine", () => {
  expect(judgeXhsApi(461, null)).toBe("check");
  expect(judgeXhsApi(200, { code: 300013, success: false, msg: "访问频次异常，请勿频繁操作" })).toBe("check");
  expect(judgeXhsApi(200, { code: -100, success: false, msg: "登录已过期" })).toBe("login");
  expect(judgeXhsApi(200, { code: 0, success: true, data: {} })).toBe("ok");
});

test("a note's Markdown carries everything it was given, and says what could not be saved", () => {
  const note: NoteDetail = { id: "n1", title: "标题", desc: "正文第一行", type: "video", tags: ["咖啡"], author: { id: "u1", name: "作者" }, time: "2026-09-21T10:00:00.000Z",
    counts: { liked: "1.2万", collected: "8", comment: "", share: "" }, images: [], video: { urls: ["https://v"], durationSeconds: 183 }, source: "api" };
  const text = noteMarkdown(note, { images: [{ file: "notes/n1/img-01.webp", description: "一杯咖啡", text: "92°C" }, { problem: "下载失败（403）" }],
    video: { file: "notes/n1/video.mp4", transcript: "[00:01] 先把水烧到九十二度", frames: [{ file: "notes/n1/frame-01.jpg", description: "注水" }] } });
  for (const part of ["# 标题", "https://www.xiaohongshu.com/explore/n1", "作者（u1）", "类型：视频", "赞 1.2万 · 收藏 8", "#咖啡", "页面自身请求的数据", "正文第一行",
    "### 图 1（notes/n1/img-01.webp）", "一杯咖啡", "图中文字：92°C", "未保存：下载失败（403）", "时长：183 秒", "先把水烧到九十二度", "### 帧 1（notes/n1/frame-01.jpg）", "注水"])
    expect(text).toContain(part);
  const dom = noteFromDom("n2", "看海 - 小红书", "去海边 #旅行 #夏天");
  expect(dom).toMatchObject({ title: "看海", tags: ["旅行", "夏天"], source: "dom" });
  expect(noteMarkdown(dom, { images: [] })).toContain("页面可见文字（无结构数据）");
  const index = notesIndexMarkdown([{ id: "n1", title: "标|题", author: "作者", type: "video", file: "note-n1.md", readAt: "2026-10-22T01:00:00Z" },
    { id: "n2", title: "", author: "", type: "", file: "note-n2.md", readAt: "2026-10-22T02:00:00Z" }]);
  expect(index).toContain("共 2 条");
  expect(index.indexOf("note-n2.md")).toBeLessThan(index.indexOf("note-n1.md"));
  expect(index).toContain("[标／题](note-n1.md)");
});

test("every picture sent is described once by its own id", () => {
  expect(validateMediaDescriptions({ images: [{ id: "a", description: "图", text: "" }, { id: "b", description: "图二", text: "字" }] }, ["a", "b"]).map((item) => item.id)).toEqual(["a", "b"]);
  expect(() => validateMediaDescriptions({ images: [{ id: "a", description: "图", text: "" }] }, ["a", "b"])).toThrow("MEDIA_DESCRIPTION_INVALID");
  expect(() => validateMediaDescriptions({ images: [{ id: "a", description: "图", text: "" }, { id: "x", description: "图", text: "" }] }, ["a"])).toThrow();
  expect(() => validateMediaDescriptions({ images: [{ id: "a", description: "图", text: "" }, { id: "a", description: "图", text: "" }] }, ["a"])).toThrow();
});

test("a video's streams are read under every codec key, the muxed .mp4 first (the real page keys them EF4/EF5/EF6)", () => {
  const note = noteFromCard({ noteId: "n1", type: "video", title: "t", desc: "", imageList: [], video: { media: { stream: {
    EF5: [{ masterUrl: "http://v.example/a_3090.m4s?sign=1", backupUrls: ["http://b.example/a_3090.m4s"] }],
    EF4: [{ masterUrl: "http://v.example/b_259.mp4?sign=2", backupUrls: [] }], EF6: [] } } } }, "state");
  expect(note?.video?.urls[0]).toBe("http://v.example/b_259.mp4?sign=2");
  expect(note?.video?.urls).toContain("http://v.example/a_3090.m4s?sign=1");
});

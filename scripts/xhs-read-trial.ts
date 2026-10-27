/**
 * A trial of the Xiaohongshu favourites reader (apps/worker/src/favourites-reader.ts) on this machine, with the profile the person logged
 * in with for their favourites workflow. It opens that profile in a visible browser, reads the favourites list and the first N notes the
 * same way the worker would, saves pictures and videos, writes each note's Markdown, and prints what each source gave. Nothing is
 * described by a model; videos are heard only with `--media` (ffmpeg on the PATH, and the recordings' Whisper model already downloaded).
 *
 *   pnpm exec tsx scripts/xhs-read-trial.ts --workspace <id> [--notes 5] [--catch-up] [--media] [--data <dir>] [--workflow <flow-id>]
 *
 * Runs on a copy of the ledger in a temporary folder, so the live workflow's read-once record is untouched and its first real run is
 * still a full catch-up; only a security check is copied back to the live ledger (the site is then not read for seven days, by the trial
 * or the worker). Without `--catch-up` it opens `--notes` notes (default 5) at the catch-up pace; with it, every unread note.
 * Close any login window of that workflow first: the profile can be open in one browser at a time.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const repoRoot = path.resolve(import.meta.dirname, "..");
const workspaceId = arg("workspace");
if (!workspaceId) { console.error("用法：pnpm exec tsx scripts/xhs-read-trial.ts --workspace <id> [--notes N] [--catch-up] [--media]"); process.exit(2); }
const dataDir = path.resolve(arg("data") ?? process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const catchUp = flag("catch-up");
const notes = catchUp ? undefined : Math.max(1, Number(arg("notes") ?? 5));
const out = mkdtempSync(path.join(tmpdir(), "crossline-xhs-trial-"));

const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(dataDir, "crossline.db"), { readonly: true });
await live.backup(path.join(out, "crossline.db"));
live.close();

const { CrosslineStore, readGrownSkills } = await import("../packages/db/src/index");
const { workflowAccess } = await import("../packages/core/src/index");
const { accessProfileDir, browserProfilesRoot, loginBrowser } = await import("../apps/worker/src/workflow-smith");
const { collectFavourites, collectHold, favouritesAccess, openCollectBrowser, readNoteFile } = await import("../apps/worker/src/favourites-reader");
const { describeNotes, ffmpegAvailable, realVideoTools } = await import("../apps/worker/src/note-media");
const { breakerKey } = await import("../apps/worker/src/site-reader");

const store = new CrosslineStore(path.join(out, "crossline.db"));
const records = readGrownSkills(store, workspaceId);
const record = records.find((item) => item.id === arg("workflow")) ?? records.find((item) => favouritesAccess(item));
const access = record ? favouritesAccess(record) : undefined;
if (!record || !access) {
  console.error(`这个 workspace 没有读小红书收藏的工作流。已有：${records.map((item) => `${item.id}（${item.manifest.summary}；${workflowAccess(item).access.map((a) => a.service).join("、") || "不读网站"}）`).join("；") || "无"}`);
  process.exit(1);
}
const held = collectHold(store, workspaceId);
if (held) { console.error(`小红书读取已停下（${held.where} ${held.why ?? ""}），等本人在设置里点「立即运行」，这次不读。`); process.exit(1); }
const profile = accessProfileDir(browserProfilesRoot(workspaceId), access);
const browser = record.loginBrowsers?.[access.service] || loginBrowser() || "";
console.log(JSON.stringify({ workflow: record.id, summary: record.manifest.summary, profile, browser, out, mode: catchUp ? "catch_up" : `first ${notes}` }, null, 2));

const folder = path.join(out, "notes-folder");
const driver = await openCollectBrowser(profile, browser);
let result;
try {
  result = await collectFavourites({ store, workspaceId, workflowId: record.id, folder, driver, mode: "catch_up", ...(notes ? { limit: notes } : {}),
    log: (event) => console.log(JSON.stringify(event)) });
} finally { await driver.close(); }
console.log(JSON.stringify({ result: { ...result, read: result.read.length, gone: result.gone.length } }, null, 2));

if (result.state === "check") {
  // The site's hold goes back to the live ledger, so the worker does not read until the person starts it again.
  const liveStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
  liveStore.setSetting(workspaceId, breakerKey("xiaohongshu.com"), store.getSetting(workspaceId, breakerKey("xiaohongshu.com"))!);
  liveStore.close();
  console.log(`已写入实时账本：小红书停读，等本人点「立即运行」（${result.trigger ?? ""}）。`);
}

// What each source gave, note by note.
for (const id of result.read) {
  const note = readNoteFile(folder, id)!;
  const d = note.detail;
  console.log(JSON.stringify({ id, source: d.source, type: d.type, title: d.title, descChars: d.desc.length, tags: d.tags, author: d.author, time: d.time, ip: d.ipLocation,
    counts: d.counts, images: note.images.map((image) => image.file ?? image.problem), livePhotos: note.livePhotos.map((item) => item.file ?? item.problem),
    video: note.video ? note.video.file ?? note.video.problem : undefined, videoUrls: d.video?.urls.length ?? 0, rawKept: Object.keys(note.raw) }));
}

const media = flag("media") && await ffmpegAvailable();
if (flag("media") && !media) console.log("没有找到 ffmpeg（PATH 或 CROSSLINE_FFMPEG），视频不转写。");
let transcribe: ((wav: string) => Promise<{ text?: string; problem?: string }>) | undefined;
if (media) {
  const { createTranscriber, createWhisperEngine, modelsDirectory } = await import("../apps/worker/src/transcribe");
  const transcriber = createTranscriber({ ...createWhisperEngine(modelsDirectory(dataDir)), modelsDir: modelsDirectory(dataDir) });
  transcribe = async (wav) => {
    const heard = await transcriber.transcribeSpeech(readFileSync(wav), "audio.wav");
    return heard.state === "transcribed" ? { text: heard.text } : { problem: heard.state === "failed" ? heard.message : heard.state };
  };
}
await describeNotes(folder, { ...(media ? { ffmpeg: realVideoTools } : {}), ...(transcribe ? { transcribe } : {}) }, result.read);
store.close();
console.log(`笔记文件：${folder}（index.md 与 note-<id>.md；原图与视频在 notes/<id>/）。图片没有经过模型描述。`);

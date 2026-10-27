import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DESCRIBE_IMAGES_PER_RUN, MEDIA_DESCRIPTION_SCHEMA, noteMarkdown, notesIndexMarkdown, validateMediaDescriptions, type IndexEntry, type MediaDescription,
  type MediaText, type NoteMedia, tFor, type Locale
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { noteDir, readNoteFile, writeNoteFile, type NoteFile } from "./favourites-reader";

/**
 * A read note's pictures and video into text (docs/skills-library.md 「收藏全量读取」): pictures and video stills go to Skill
 * `crossline-media-describer` (low tier) as images, several notes to a run; the video's sound is extracted by ffmpeg and transcribed on
 * this machine by the recordings' own transcriber. Each note then gets `note-<id>.md`, and the folder an `index.md`.
 */
export const MEDIA_DESCRIBER = "crossline:crossline-media-describer";
/** Stills taken from a video, spread over its length. */
export const VIDEO_FRAMES = 4;
/** Pictures the model reads as they are; anything else (AVIF, HEIC) is turned into JPEG first. */
const READABLE = /\.(png|jpe?g|gif|webp)$/i;

export type PictureToDescribe = { id: string; file: string; note: string; kind: "image" | "frame"; position: number };
export type NoteMediaDeps = {
  /** Undefined when no model can read pictures: notes are written without descriptions and described on a later run. */
  describe?: (pictures: PictureToDescribe[], notes: Array<{ id: string; title: string; desc: string; tags: string[] }>) => Promise<MediaDescription[]>;
  /** A 16 kHz mono WAV in, the transcript out (or why not). */
  transcribe?: (wavFile: string) => Promise<{ text?: string; problem?: string }>;
  ffmpeg?: VideoTools;
  log?: (event: Record<string, unknown>) => void;
  /** The workspace's language: why a picture or a video was left out is written in it. */
  locale?: Locale;
};
export type VideoTools = {
  audio: (video: string, wav: string) => Promise<boolean>;
  frames: (video: string, dir: string, count: number, durationSeconds: number) => Promise<string[]>;
  toJpeg: (input: string, output: string) => Promise<boolean>;
};

type NoteWork = { note: NoteFile; media: NoteMedia; pictures: Array<PictureToDescribe & { slot: { list: "images" | "frames"; index: number } }> };

/**
 * Describes every note in `ids` (default: every note in the folder not described yet) and writes its Markdown, then the index. A note
 * whose pictures could not be described (no model, a failed run) is written with what there is and left undescribed, so a later run
 * tries again; nothing here throws for one note's trouble.
 */
export async function describeNotes(folder: string, deps: NoteMediaDeps, ids?: string[]): Promise<{ written: string[]; described: string[] }> {
  const log = deps.log ?? (() => {});
  const all = listNoteIds(folder);
  const chosen = (ids ?? all).map((id) => readNoteFile(folder, id)).filter((note): note is NoteFile => Boolean(note) && !note!.describedAt);
  const work: NoteWork[] = [];
  for (const note of chosen) work.push(await prepareNote(folder, note, deps));
  const written: string[] = [], described: string[] = [];
  // Whole notes to a run, at most DESCRIBE_IMAGES_PER_RUN pictures; a note with more pictures than that goes alone, in parts.
  const batches: NoteWork[][] = [];
  for (const item of work) {
    const last = batches.at(-1);
    const size = (batch: NoteWork[]) => batch.reduce((sum, entry) => sum + entry.pictures.length, 0);
    if (last && size(last) + item.pictures.length <= DESCRIBE_IMAGES_PER_RUN) last.push(item); else batches.push([item]);
  }
  for (const batch of batches) {
    const pictures = batch.flatMap((item) => item.pictures);
    let ok = true;
    if (pictures.length) {
      if (!deps.describe) ok = false;
      else {
        try {
          const notes = batch.map((item) => ({ id: item.note.id, title: item.note.detail.title, desc: item.note.detail.desc.slice(0, 1_500), tags: item.note.detail.tags }));
          for (let start = 0; start < pictures.length; start += DESCRIBE_IMAGES_PER_RUN) {
            const part = pictures.slice(start, start + DESCRIBE_IMAGES_PER_RUN);
            const answers = await deps.describe(part.map(({ slot: _slot, ...picture }) => picture), notes);
            for (const answer of answers) {
              const picture = part.find((item) => item.id === answer.id);
              const item = batch.find((entry) => entry.note.id === picture?.note);
              if (!picture || !item) continue;
              const target = picture.slot.list === "images" ? item.media.images[picture.slot.index] : item.media.video?.frames[picture.slot.index];
              if (target) { target.description = answer.description; target.text = answer.text; }
            }
          }
        } catch (error) {
          ok = false;
          log({ type: "collect.describe_failed", notes: batch.map((item) => item.note.id), message: error instanceof Error ? error.message.slice(0, 200) : "" });
        }
      }
    }
    for (const item of batch) {
      if (!ok && item.pictures.length) for (const picture of item.pictures) {
        const target = picture.slot.list === "images" ? item.media.images[picture.slot.index] : item.media.video?.frames[picture.slot.index];
        if (target && !target.description) target.problem = deps.describe ? tFor(deps.locale)("图片描述这次没有完成，下次运行再试") : tFor(deps.locale)("还没有能看图的模型连接，图片未描述");
      }
      writeFileSync(path.join(folder, `note-${item.note.id}.md`), noteMarkdown(item.note.detail, item.media));
      written.push(item.note.id);
      if (ok) { writeNoteFile(folder, { ...item.note, describedAt: new Date().toISOString() }); described.push(item.note.id); }
    }
  }
  writeIndex(folder);
  return { written, described };
}

export const listNoteIds = (folder: string): string[] => {
  try { return readdirSync(path.join(folder, "notes"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return []; }
};

/** The index of everything read so far, rebuilt from the notes' own files. */
export function writeIndex(folder: string, heading?: string): void {
  const entries: IndexEntry[] = listNoteIds(folder).flatMap((id) => {
    const note = readNoteFile(folder, id);
    return note ? [{ id, title: note.detail.title, author: note.detail.author.name, type: note.detail.type, ...(note.detail.time ? { time: note.detail.time } : {}),
      file: `note-${id}.md`, readAt: note.readAt }] : [];
  });
  writeFileSync(path.join(folder, "index.md"), notesIndexMarkdown(entries, heading));
}

/** A note's video heard and its stills taken; its pictures (and stills) listed for the describer, with where each answer goes. */
async function prepareNote(folder: string, note: NoteFile, deps: NoteMediaDeps): Promise<NoteWork> {
  const t = tFor(deps.locale);
  const dir = noteDir(folder, note.id);
  const pictures: NoteWork["pictures"] = [];
  const images: MediaText[] = [];
  for (const [index, saved] of note.images.entries()) {
    if (!saved.file) { images.push({ problem: saved.problem ?? t("没有保存") }); continue; }
    images.push({ file: `notes/${note.id}/${saved.file}` });
    const readable = await readableCopy(path.join(dir, saved.file), deps.ffmpeg);
    if (readable) pictures.push({ id: `${note.id}-i${index + 1}`, file: readable, note: note.id, kind: "image", position: index + 1, slot: { list: "images", index } });
    else images[index]!.problem = t("图片格式读不了，未描述");
  }
  let video: NoteMedia["video"];
  if (note.detail.video || note.video) {
    const file = note.video?.file;
    video = { frames: [], ...(file ? { file: `notes/${note.id}/${file}` } : { problem: note.video?.problem ?? t("没有可用地址") }) };
    if (file) {
      const source = path.join(dir, file);
      if (!deps.ffmpeg) video.transcriptProblem = t("这台电脑上没有 ffmpeg，视频未转写");
      else {
        const wav = path.join(dir, "audio.wav");
        // A transcript made on an earlier run (whose pictures were not described yet) is kept, not heard again.
        const kept = path.join(dir, "transcript.txt");
        const extracted = existsSync(kept) || existsSync(wav) || await deps.ffmpeg.audio(source, wav).catch(() => false);
        if (existsSync(kept)) video.transcript = readFileSync(kept, "utf8");
        else if (!extracted) video.transcriptProblem = t("视频里没有可提取的声音");
        else if (!deps.transcribe) video.transcriptProblem = t("这台电脑没有语音识别，视频未转写");
        else {
          const heard: { text?: string; problem?: string } = await deps.transcribe(wav)
            .catch((error: unknown) => ({ problem: error instanceof Error ? error.message.slice(0, 120) : t("转写失败") }));
          const text = heard.text?.trim();
          if (text) { video.transcript = text; writeFileSync(kept, text); } else video.transcriptProblem = heard.problem ?? t("没有听到说话");
        }
        const existing = readdirSync(dir).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort().map((name) => path.join(dir, name));
        const frames = existing.length ? existing : await deps.ffmpeg.frames(source, dir, VIDEO_FRAMES, note.detail.video?.durationSeconds ?? 0).catch(() => [] as string[]);
        for (const [index, frame] of frames.entries()) {
          video.frames.push({ file: `notes/${note.id}/${path.basename(frame)}` });
          pictures.push({ id: `${note.id}-f${index + 1}`, file: frame, note: note.id, kind: "frame", position: index + 1, slot: { list: "frames", index } });
        }
      }
    }
  }
  return { note, media: { images, ...(video ? { video } : {}) }, pictures };
}

/** The file as the model can read it: itself when PNG/JPEG/GIF/WebP, else a JPEG made by ffmpeg beside it. */
async function readableCopy(file: string, ffmpeg?: VideoTools): Promise<string | undefined> {
  if (READABLE.test(file)) return file;
  if (!ffmpeg) return undefined;
  const out = file.replace(/\.[^.]+$/, "") + ".view.jpg";
  return existsSync(out) || await ffmpeg.toJpeg(file, out).catch(() => false) ? out : undefined;
}

// ── Real tools ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ffmpegBinary = () => process.env.CROSSLINE_FFMPEG || "ffmpeg";
function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBinary(), ["-nostdin", "-v", "error", "-y", ...args], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false)).on("close", (code) => resolve(code === 0));
  });
}
/** Whether ffmpeg answers at all on this machine (it is on the PATH of the owner's machine through winget; `CROSSLINE_FFMPEG` overrides). */
export const ffmpegAvailable = () => runFfmpeg(["-version"]);

export const realVideoTools: VideoTools = {
  audio: async (video, wav) => await runFfmpeg(["-i", video, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav]) && existsSync(wav),
  frames: async (video, dir, count, durationSeconds) => {
    const every = Math.max(1, Math.round((durationSeconds > 0 ? durationSeconds : 60) / (count + 1)));
    mkdirSync(dir, { recursive: true });
    const ok = await runFfmpeg(["-ss", String(Math.min(every, 5)), "-i", video, "-vf", `fps=1/${every},scale=720:-2`, "-frames:v", String(count), path.join(dir, "frame-%02d.jpg")]);
    return ok ? readdirSync(dir).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort().map((name) => path.join(dir, name)) : [];
  },
  toJpeg: async (input, output) => await runFfmpeg(["-i", input, "-frames:v", "1", output]) && existsSync(output)
};

/**
 * The describer on the account's own Codex: one structured run per batch, the pictures attached in the order the input lists them.
 * Low tier; the answer must name every picture once (`validateMediaDescriptions`).
 */
export function createMediaDescriber(client: CodexRpcBoundary, cwd: string): NonNullable<NoteMediaDeps["describe"]> {
  return async (pictures, notes) => {
    const ids = pictures.map((picture) => picture.id);
    const input = { version: "crossline.media-describer.v1", images: pictures.map(({ id, note, kind, position }) => ({ id, note, kind, position })),
      notes: notes.filter((note) => pictures.some((picture) => picture.note === note.id)) };
    const result = await runCodexSkill<MediaDescription[]>(client, input, {
      skillName: MEDIA_DESCRIBER, cwd, images: pictures.map((picture) => picture.file), outputSchema: MEDIA_DESCRIPTION_SCHEMA,
      developerInstructions: "Describe each attached picture as the Skill describes, in the order given. Return raw JSON only.",
      prepareInput: () => input, validateOutput: (output) => validateMediaDescriptions(output, ids), onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) throw new Error(result.blocker.message || result.blocker.code);
    return result.output;
  };
}

/** A note's file as it stands, for scripts that print what was captured. */
export const readNoteMarkdown = (folder: string, id: string) => { try { return readFileSync(path.join(folder, `note-${id}.md`), "utf8"); } catch { return undefined; } };

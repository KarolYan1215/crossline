import "server-only";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIGURE_FILE, figureVersionOf, nextUploadedFigureFile, PORTRAIT_FIGURE_SETTING, type AccessContext } from "@crossline/core";
import { dataDirectory, getStore } from "./crossline";
import { withUndo } from "./undo";

/**
 * The person's figure (2026-10-21): the one they picked from the figures drawn before or added themselves (`portrait.figure`), else the
 * latest drawing (`portrait.images`). The 小帮手, the portrait page and the portrait preview on 待决事项 all show this one.
 */
export type Figure = { file: string; at: string };
export type FigureEntry = Figure & { kind: "drawn" | "uploaded"; version: number; latest: boolean; current: boolean };

/** Figures larger than this are not taken (a drawn one is about 1.3 MB). */
export const FIGURE_MAX_BYTES = 8 * 1024 * 1024;

export function figureFolder(workspaceId: string): string {
  return path.join(dataDirectory(), "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

function readJson<T>(raw: string | undefined): T | undefined {
  try { return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; }
}

/** The latest drawing, whatever report version drew it — an older figure is still the person. */
export function latestFigure(ctx: AccessContext): Figure | null {
  const drawn = readJson<{ images?: Record<string, { file?: string; at?: string }> }>(getStore().getSetting(ctx.workspaceId, "portrait.images"));
  const character = drawn?.images?.character;
  return character?.file ? { file: character.file, at: character.at ?? character.file } : null;
}

/** The figure the person picked, while its file is still there. */
export function chosenFigure(ctx: AccessContext): Figure | null {
  const chosen = readJson<Partial<Figure>>(getStore().getSetting(ctx.workspaceId, PORTRAIT_FIGURE_SETTING));
  if (!chosen?.file || !FIGURE_FILE.test(chosen.file) || !existsSync(path.join(figureFolder(ctx.workspaceId), chosen.file))) return null;
  return { file: chosen.file, at: chosen.at ?? chosen.file };
}

export function currentFigure(ctx: AccessContext): Figure | null {
  return chosenFigure(ctx) ?? latestFigure(ctx);
}

/** Addressed by file and time, so a new choice is fetched once and an old one stays cached. */
export function figureUrl(figure: Figure): string {
  return `/api/portrait/image/character?file=${encodeURIComponent(figure.file)}&v=${encodeURIComponent(figure.at)}`;
}

/** Every figure in the workspace's folder, newest first. */
export function listFigures(ctx: AccessContext): FigureEntry[] {
  const folder = figureFolder(ctx.workspaceId);
  let files: string[] = [];
  try { files = readdirSync(folder).filter((file) => FIGURE_FILE.test(file)); } catch { /* no folder yet */ }
  const latest = latestFigure(ctx), current = currentFigure(ctx);
  return files.map((file) => {
    const parsed = figureVersionOf(file)!;
    let at = "";
    try { at = statSync(path.join(folder, file)).mtime.toISOString(); } catch { /* gone */ }
    return { file, at, kind: parsed.kind, version: parsed.number, latest: latest?.file === file, current: current?.file === file };
  }).sort((a, b) => b.at.localeCompare(a.at) || b.file.localeCompare(a.file));
}

/** Picks the figure the 小帮手 shows (`null`: back to the latest drawing). Undoable. */
export async function chooseFigure(ctx: AccessContext, file: string | null): Promise<{ ok: boolean; code?: string; op?: { id: string; label: string } }> {
  if (file !== null && (!FIGURE_FILE.test(file) || !existsSync(path.join(figureFolder(ctx.workspaceId), file)))) return { ok: false, code: "FIGURE_NOT_FOUND" };
  return withUndo(ctx, file ? "更换小帮手形象" : "小帮手改用最新形象", () => {
    if (file) getStore().setSetting(ctx.workspaceId, PORTRAIT_FIGURE_SETTING, JSON.stringify({ file, at: new Date().toISOString() }));
    else getStore().deleteSetting(ctx.workspaceId, PORTRAIT_FIGURE_SETTING);
    return { ok: true };
  });
}

/** What kind of picture the bytes are, by their opening; null for anything else. */
export function imageKind(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * A figure the person adds themselves (a picture of an earlier figure, say), kept beside the drawn ones as `u<n>-character.png` and picked
 * at once. The image route sends it with its real type, whatever the name says, as it already does for Ark's JPEGs.
 */
export async function addFigure(ctx: AccessContext, bytes: Uint8Array): Promise<{ ok: boolean; code?: string; file?: string; op?: { id: string; label: string } }> {
  if (bytes.byteLength > FIGURE_MAX_BYTES) return { ok: false, code: "FIGURE_TOO_LARGE" };
  if (!imageKind(bytes)) return { ok: false, code: "FIGURE_NOT_AN_IMAGE" };
  const folder = figureFolder(ctx.workspaceId);
  mkdirSync(folder, { recursive: true });
  const file = nextUploadedFigureFile(readdirSync(folder));
  writeFileSync(path.join(folder, file), bytes);
  const chosen = await chooseFigure(ctx, file);
  return { ...chosen, file };
}

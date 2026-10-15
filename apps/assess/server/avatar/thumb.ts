import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { dataDir } from "../config";
import { writeFileAtomic } from "./files";
import { imageType } from "./provider";
import { templatesDir } from "./templates";

/**
 * A figure shrunk for the pages that show it small (the invitation, the pair page): a template or a drawn figure is 1024×1536 and about
 * 1.8 MB, and a phone on a mobile network should not fetch two of those to show two 120-pixel pictures. The width is fixed so a cached
 * file serves everyone. Templates are cached on disk (32 files, shared by every result); a drawn figure is the person's own and is
 * shrunk on each request instead, so deleting a result leaves no copy of it behind.
 */
export const THUMB_WIDTH = 360;

/** resvg reads PNG and JPEG only: anything else is answered as it is, full size, rather than as a blank picture. */
function shrink(bytes: Buffer): Buffer {
  const mime = imageType(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg") return bytes;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><image href="data:${mime};base64,${bytes.toString("base64")}" width="1024" height="1536" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: THUMB_WIDTH }, font: { loadSystemFonts: false } }).render().asPng());
}

export function thumbnail(file: string, bytes: Buffer): Buffer {
  const fromTemplates = path.resolve(file).startsWith(path.resolve(templatesDir()) + path.sep);
  if (!fromTemplates) return shrink(bytes);
  const cached = path.join(dataDir(), "thumbs", `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}-${THUMB_WIDTH}.png`);
  try {
    return fs.readFileSync(cached);
  } catch { /* not made yet */ }
  const png = shrink(bytes);
  writeFileAtomic(cached, png);
  return png;
}

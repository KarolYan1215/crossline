import { readFileSync } from "node:fs";
import type { Figure } from "./render";

/**
 * The figure for a poster as a data URI: only ever the person's own drawn figure. A drawn figure is saved as `.png` whatever the image
 * model sent back, so the type is read off the file's first bytes: PNG and JPEG go in as they are. With no drawn figure — still being
 * drawn, over a limit, or failed — the panel shows the type's code on the group's tint instead (decided 2026-10-16: the type's shared
 * template on someone's own poster read as "not me" and people left; a clean code tile does not pretend to be them).
 */
export function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** The drawn figure at `file` ("" for none), or no figure when there is none or it cannot be read. */
export function figureFrom(file: string): Figure {
  if (!file) return { dataUri: null };
  try {
    const bytes = readFileSync(file);
    const mime = imageMime(bytes);
    return mime ? { dataUri: `data:${mime};base64,${bytes.toString("base64")}` } : { dataUri: null };
  } catch {
    return { dataUri: null };
  }
}

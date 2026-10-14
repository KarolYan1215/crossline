import { readFileSync } from "node:fs";
import { templateImagePath } from "../avatar";
import type { Figure } from "./render";

/**
 * The figure for a poster as a data URI. A drawn figure is saved as `.png` whatever the image model sent back, so the type is read off
 * the file's first bytes: PNG and JPEG go in as they are; anything else (WebP, which satori 0.33 does not decode) gives way to the
 * type's template, and with no readable template the disc shows the type's code.
 */
export function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

function read(file: string): Figure | null {
  try {
    const bytes = readFileSync(file);
    const mime = imageMime(bytes);
    return mime ? { dataUri: `data:${mime};base64,${bytes.toString("base64")}` } : null;
  } catch {
    return null;
  }
}

export function figureFrom(file: string, code: string): Figure {
  const own = read(file);
  if (own) return own;
  try {
    return read(templateImagePath(code)) ?? { dataUri: null };
  } catch {
    return { dataUri: null };
  }
}

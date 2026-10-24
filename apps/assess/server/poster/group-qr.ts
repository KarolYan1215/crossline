import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The WeChat group's QR code printed in the poster's bottom-right corner (the owner, 2026-10-24): a PNG of the code's modules on a
 * transparent background, so it sits on the paper without a box. A group code expires (WeChat's lasts seven days), so it is a file,
 * swapped without a code change: `ASSESS_GROUP_QR_FILE`, else `assets/group-qr.png` beside the app (copied beside the standalone server
 * by the Dockerfile). Re-read when the file changes; no file, no corner. `ASSESS_GROUP_QR_CAPTION` changes the line beside it.
 */
export type GroupQr = { dataUri: string; caption: string };

export const GROUP_QR_CAPTION = "拿完整版内测名额";

function groupQrFile(): string | undefined {
  const candidates = [process.env.ASSESS_GROUP_QR_FILE, path.join(process.cwd(), "assets", "group-qr.png"), path.join(process.cwd(), "apps", "assess", "assets", "group-qr.png")];
  return candidates.find((file): file is string => Boolean(file) && existsSync(file!));
}

let cached: { file: string; mtime: number; dataUri: string } | undefined;

export function groupQr(): GroupQr | null {
  const file = groupQrFile();
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  if (cached?.file !== file || cached.mtime !== mtime) cached = { file, mtime, dataUri: `data:image/png;base64,${readFileSync(file).toString("base64")}` };
  return { dataUri: cached.dataUri, caption: process.env.ASSESS_GROUP_QR_CAPTION?.trim() || GROUP_QR_CAPTION };
}

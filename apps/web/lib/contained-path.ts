import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * `relative` inside `directory`, by where it really is on disk: both sides go through `realpath` before the prefix check, so a link
 * the run left in its directory (a symlink or junction to the home folder, the ledger, another account's files) cannot be followed out
 * of it. Undefined for anything absolute, missing, or outside.
 */
export function containedPath(directory: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  try {
    const root = realpathSync(directory);
    const full = realpathSync(path.resolve(root, relative));
    return full.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`) ? full : undefined;
  } catch {
    return undefined;
  }
}

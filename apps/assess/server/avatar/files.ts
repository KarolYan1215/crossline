import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Writes a file so a reader sees either the old content or the new, never half: a temporary file beside it, then a rename. */
export function writeFileAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

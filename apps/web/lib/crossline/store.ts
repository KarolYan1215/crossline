import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";

declare global {
  // eslint-disable-next-line no-var
  var crosslineStore: CrosslineStore | undefined;
}

/** Where this installation keeps everything it owns: the ledger, and now the files people give it. */
export function dataDirectory(): string {
  return process.env.CROSSLINE_DATA_DIR
    ? path.resolve(process.env.CROSSLINE_DATA_DIR)
    : path.resolve(process.cwd(), "../../data");
}

export function getStore(): CrosslineStore {
  if (globalThis.crosslineStore) return globalThis.crosslineStore;
  const dataDir = dataDirectory();
  mkdirSync(dataDir, { recursive: true });
  globalThis.crosslineStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
  return globalThis.crosslineStore;
}

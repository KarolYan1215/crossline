import "server-only";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { APP_PAGES, pageTemplate } from "@crossline/core";
import { isLocalInstall } from "./install-mode";

/** Where page views wait for the worker's sender (`apps/worker/src/telemetry.ts`), which reads and empties it every 15 minutes. */
export function pageOutbox(dataDir = process.env.CROSSLINE_DATA_DIR ?? path.resolve(process.cwd(), "../../data")): string {
  return path.join(dataDir, "telemetry", "pages.jsonl");
}

/** Records one view of `pathname` as its template, on an installed copy only; anything that is not one of the app's pages is ignored. */
export function recordPageView(pathname: string, at = new Date()): boolean {
  if (!isLocalInstall()) return false;
  const page = pageTemplate(pathname, APP_PAGES);
  if (!page) return false;
  const file = pageOutbox();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ page, at: at.toISOString() })}\n`);
  return true;
}

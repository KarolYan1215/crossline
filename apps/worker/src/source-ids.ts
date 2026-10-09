import { documentsByRef } from "@crossline/core";
import type { StoredSourceDocument } from "@crossline/db";

/**
 * A stable id per document for the life of the workspace: `src-1`, `src-2`, … in upload order. Models cite
 * these and validators check them, so they must not move when another file is added later — and the
 * onboarding interview and the date extractor must agree on them, which is why this lives in one place.
 */
export function sourceIds(docs: StoredSourceDocument[]): Map<string, StoredSourceDocument> {
  return documentsByRef(docs);
}

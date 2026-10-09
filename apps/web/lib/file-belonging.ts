import "server-only";
import type { AccessContext } from "@crossline/core";
import { unfiledFilesIn, type UnfiledFile } from "@crossline/db";
import { getStore } from "./crossline";
import { identityLines } from "./lines";

export type { UnfiledFile };

/** The uploaded files whose project only the person can tell (see `unfiledFilesIn`). */
export const unfiledFiles = (ctx: AccessContext, today: string): UnfiledFile[] =>
  unfiledFilesIn(getStore(), ctx.workspaceId, { today, lineNames: identityLines(ctx).flatMap((line) => [line.id, line.label]) });

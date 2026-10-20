import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAIL_REPLY_DRAFTS_SETTING, type AccessContext, type MailReplyDraft } from "@crossline/core";
import { closeMailReply, readReplyDrafts } from "@crossline/db";
import { dataDirectory, getStore } from "./crossline";

/**
 * Reply drafts on the web side (docs/personal-agent.md §3.1): the worker writes them into `<data>/mail-drafts/<workspace>/`; the web reads
 * one for the material page and 「复制草稿」, closes one when the person says 已回复 or 不用回, and turns drafting on or off. Nothing here
 * can send: there is no sending path in Crossline.
 */
export const validDraftId = (id: string) => /^rd-[a-f0-9-]{1,40}$/.test(id);

export function draftOf(ctx: AccessContext, id: string): { draft: MailReplyDraft; text: string } | undefined {
  if (!validDraftId(id)) return undefined;
  const draft = readReplyDrafts(getStore(), ctx.workspaceId).find((item) => item.id === id);
  if (!draft || !/^rd-[a-f0-9-]{1,40}\.md$/.test(draft.file)) return undefined;
  const folder = path.join(dataDirectory(), "mail-drafts", ctx.workspaceId.replace(/[^A-Za-z0-9_-]/g, "_"));
  try { return { draft, text: readFileSync(path.join(folder, draft.file), "utf8") }; } catch { return undefined; }
}

export function closeDraft(ctx: AccessContext, id: string, how: "replied" | "dismissed"): boolean {
  return validDraftId(id) && closeMailReply(getStore(), ctx.workspaceId, id, how, "person");
}

export function setReplyDrafts(ctx: AccessContext, on: boolean): void {
  getStore().setSetting(ctx.workspaceId, MAIL_REPLY_DRAFTS_SETTING, on ? "on" : "off");
}

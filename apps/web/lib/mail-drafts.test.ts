import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAIL_REPLIES_SETTING, MAIL_REPLY_DRAFTS_SETTING, draftFileText, type MailReplyDraft } from "@crossline/core";
import { CrosslineStore, mailReplyClosures } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "./test-support";
vi.mock("./access-guard", async () => ({ resolveAccessContext: async () => ({ ctx: (await import("./test-support")).TEST_CTX }) }));
import { decideCard } from "./conversation";

const ws = TEST_CTX.workspaceId;
const NOW = "2026-10-19T15:00:00.000Z";
let dir: string;
let store: CrosslineStore;
const draft: MailReplyDraft = { id: "rd-1a2b3c4d-5e6", accountId: "acc-1", uid: 1, uidValidity: "1", messageId: "<m1@uni.edu>", from: "Prof Lin <lin@uni.edu>",
  fromAddress: "lin@uni.edu", subject: "测量数据", date: "2026-10-19T08:00:00Z", why: "导师要周五前的数据", points: ["确认周五前发数据"], replyBy: "2026-10-23",
  file: "rd-1a2b3c4d-5e6.md", createdAt: NOW, notifiedAt: NOW, messageIds: ["msg-1"] };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-mail-drafts-web-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, MAIL_REPLIES_SETTING, JSON.stringify([draft]));
  mkdirSync(path.join(dir, "mail-drafts", ws), { recursive: true });
  writeFileSync(path.join(dir, "mail-drafts", ws, draft.file), draftFileText(draft, { subject: "", body: "林老师好，数据周五前发您。" }));
  const conversation = store.conversationFor(ws, "2026-10-19");
  store.appendConversationMessage({ id: "msg-1", workspaceId: ws, conversationId: conversation.id, role: "nudge", text: "", createdAt: NOW,
    payload: { nudge: { kind: "mail_reply", fingerprint: `mail-reply:${draft.id}`, urgent: false, counted: true, delivery: "pending" },
      card: { actions: [], items: [], confidence: "high", nudgeKind: "mail_reply", mailReplyId: draft.id, clarify: { question: "Prof Lin 来信", options: [
        { label: "看草稿", actions: [], kind: "href", href: "/materials/view" }, { label: "复制草稿", actions: [], kind: "copy", href: `/api/mail/drafts/${draft.id}/file?part=body` },
        { label: "已回复", actions: [], kind: "ack", close: "replied" }, { label: "不用回", actions: [], kind: "ack", close: "dismissed" }, { label: "少问这类", actions: [], kind: "mute" }] } } } });
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("a draft is served from the account's own folder: the body alone for 复制草稿, the material page for a link, nothing for an unknown id", async () => {
  const { GET } = await import("../app/api/mail/drafts/[id]/file/route");
  const body = await GET(new Request(`http://localhost/api/mail/drafts/${draft.id}/file?part=body`), params(draft.id));
  expect(await body.text()).toBe("林老师好，数据周五前发您。");
  const page = await GET(new Request(`http://localhost/api/mail/drafts/${draft.id}/file`, { headers: { "sec-fetch-dest": "document" } }), params(draft.id));
  expect(page.status).toBe(303);
  expect(page.headers.get("location")).toContain(encodeURIComponent(`/api/mail/drafts/${draft.id}/file`));
  expect((await GET(new Request("http://localhost/x"), params("rd-ffff"))).status).toBe(404);
  expect((await GET(new Request("http://localhost/x"), params("../../crossline.db"))).status).toBe(404);
});

test("已回复 on the message closes the draft once; 复制 is not an answer; the switch is a setting", async () => {
  expect(await decideCard(TEST_CTX, "msg-1", { option: 1 })).toMatchObject({ ok: false, code: "OPTION_NOT_AVAILABLE" });
  expect(await decideCard(TEST_CTX, "msg-1", { option: 2 })).toMatchObject({ ok: true });
  expect(mailReplyClosures(store, ws).get(draft.id)).toMatchObject({ how: "replied", by: "person" });
  expect((store.getConversationMessage(ws, "msg-1")!.payload.nudge as { delivery: string }).delivery).toBe("closed");
  const { POST: close } = await import("../app/api/mail/replies/[id]/route");
  const again = await close(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ how: "dismissed" }) }), params(draft.id));
  expect(await again.json()).toEqual({ ok: false });
  const { POST: toggle } = await import("../app/api/mail/replies/route");
  expect((await toggle(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ on: false }) }))).status).toBe(200);
  expect(store.getSetting(ws, MAIL_REPLY_DRAFTS_SETTING)).toBe("off");
  expect((await toggle(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ on: "yes" }) }))).status).toBe(400);
});

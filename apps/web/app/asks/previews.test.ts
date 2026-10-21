import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { Ask } from "@crossline/core";

vi.mock("server-only", () => ({}));
const CTX = { principalId: "o", workspaceId: "ws", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "o" }, authMethod: "session" as const, requestId: "r" };

let store: CrosslineStore;
beforeEach(() => { vi.stubEnv("CROSSLINE_SEED_EXAMPLES", ""); store = new CrosslineStore(":memory:"); globalThis.crosslineStore = store; });
afterEach(() => { vi.unstubAllEnvs(); store.close(); globalThis.crosslineStore = undefined; });

const ask = (id: string, preview: Ask["preview"], over: Partial<Ask> = {}): Ask => ({ id, kind: "interview_question", entityId: "e", title: "t", why: "w",
  urgency: "later", raisedAt: "", fingerprint: "f", options: [], ...(preview ? { preview } : {}), ...over });

test("a preview is a summary of the thing the ask is about, read from the ledger; one that cannot be found is left out", async () => {
  const { loadAskPreviews } = await import("./previews");
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId: "ws", kind: "text", fileName: "syllabus.txt", mediaType: "text/plain", sha256: "s1",
    uri: "file://doc-1", extractedText: "ECE 555   Schedule\n\nWeek 1 intro", extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  store.setSetting("ws", "portrait.report", JSON.stringify({ version: 2, report: { cover: { portrait: "边做边改的人。", coreConflict: "", keywords: ["跨界", "实证"], tagline: "边做边改" },
    type: { breadth: 70, evidence: 40, making: 30, planning: 60, evidence_text: {} } } }));
  store.setSetting("ws", "portrait.images", JSON.stringify({ version: 2, images: { character: { file: "v2-character.png", at: "2026-10-14" } } }));
  const previews = loadAskPreviews(CTX, [
    ask("file", { kind: "file", href: "/api/source-documents/doc-1/file", label: "syllabus" }),
    ask("portrait", { kind: "portrait", href: "/portrait", label: "当前画像" }),
    ask("gone", { kind: "task", href: "/workbench/missing", label: "任务" }),
    ask("none", undefined)
  ]);
  expect(previews.file).toEqual({ kind: "file", fileName: "syllabus.txt", excerpt: "ECE 555 Schedule Week 1 intro" });
  expect(previews.portrait).toMatchObject({ kind: "portrait", image: "/api/portrait/image/character?file=v2-character.png&v=2026-10-14", tagline: "边做边改", keywords: ["跨界", "实证"] });
  expect(Object.keys(previews).sort()).toEqual(["file", "portrait"]);
});

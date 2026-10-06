import { afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../lib/test-support";
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));
import WorkbenchPage from "./page";
import { OfflineCaptureForm } from "../offline-command-forms";
import { addCapturedTaskWithId } from "../../lib/crossline";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
test("manual capture is visible with explicit Analyze; Capture form has only text and attachment fields", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  addCapturedTaskWithId(TEST_CTX, { title: "An unclassified thought" }, "capture-1", "capture-1");
  const html = renderToStaticMarkup(await WorkbenchPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("An unclassified thought");
  expect(html).toContain("分析");
  expect(html).toContain("未分类 · 未估时");
  const form = renderToStaticMarkup(<OfflineCaptureForm ownerId={TEST_CTX.principalId} workspaceId={TEST_CTX.workspaceId} />);
  expect([...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1])).toEqual(["title", "context", "attachments"]);
});

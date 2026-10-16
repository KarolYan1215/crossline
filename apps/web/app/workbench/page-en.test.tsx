import { afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../lib/test-support";
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => ({ ...TEST_CTX, locale: "en" }) }));
import WorkbenchPage from "./page";
import { addCapturedTaskWithId } from "../../lib/crossline";
import { LocaleProvider } from "../locale-context";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
test("the Tasks page reads in English for an English request; what the person wrote stays as written", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  addCapturedTaskWithId(TEST_CTX, { title: "读完第三章" }, "capture-1", "capture-1");
  // The root layout hands the language to client components; the page itself reads it from the request.
  const html = renderToStaticMarkup(<LocaleProvider locale="en">{await WorkbenchPage({ searchParams: Promise.resolve({}) })}</LocaleProvider>);
  expect(html).toContain("读完第三章");
  expect(html).toContain("Not sorted · not estimated · original text kept for you to handle");
  expect(html).toContain(">Analyze<");
  expect(html).toContain("Create by hand instead →");
  expect(html).not.toMatch(/未分类|改为手工创建|丢弃/);
});

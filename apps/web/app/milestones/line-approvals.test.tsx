import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {} }) }));
import { LineApprovals } from "./milestone-timeline";
import type { BoardMilestone } from "../../lib/milestone-board";

const draft = (id: string, line: string, risks: BoardMilestone["risks"]) => ({ id, identityId: line, title: id, status: "draft", risks }) as unknown as BoardMilestone;

test("按主线: a row per line with its drafts' count, their risks as glyphs with counts, and its own approve button", () => {
  const html = renderToStaticMarkup(<LineApprovals id="x" lineOrder={["research", "media"]} labels={{ research: "研究者", media: "创作者" }} drafts={[
    draft("m1", "media", []),
    draft("r1", "research", [{ level: "high", kind: "time", note: "" }]), draft("r2", "research", [{ level: "medium", kind: "capacity", note: "" }])]} />);
  // Lines in the page's order, research first.
  expect(html.indexOf("研究者")).toBeLessThan(html.indexOf("创作者"));
  expect(html).toContain("2 个");
  expect(html).toContain("高风险 1、中风险 1、低风险 0");
  expect(html).toContain("无风险");
  expect(html.match(/批准这条主线/g)).toHaveLength(2);
});

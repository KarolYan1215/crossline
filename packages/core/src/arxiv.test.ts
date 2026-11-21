import { expect, test } from "vitest";
import { arxivQueryUrl, parseArxivFeed } from "./arxiv";
import { classifyFind, pushable } from "./opportunity-tags";

const NOW = new Date("2026-11-21T00:00:00.000Z");

test("the feed's recent entries become https abstract links with their authors; entities are decoded; old or malformed entries are left out", () => {
  const xml = `<feed><entry><id>http://arxiv.org/abs/2611.1v1</id><published>2026-11-20T00:00:00Z</published><title>Fast
    &amp; Sparse</title><summary> Abstract text. </summary><author><name>Ada</name></author><author><name>Lin</name></author></entry>
    <entry><id>http://arxiv.org/abs/2601.2v1</id><published>2026-01-01T00:00:00Z</published><title>Old</title></entry>
    <entry><id>not-a-link</id><published>2026-11-20T00:00:00Z</published><title>Broken</title></entry></feed>`;
  expect(parseArxivFeed(xml, NOW)).toEqual([{ url: "https://arxiv.org/abs/2611.1v1", title: "Fast & Sparse", authors: ["Ada", "Lin"], published: "2026-11-20", summary: "Abstract text." }]);
  expect(arxivQueryUrl("all:\"spiking\" AND cat:cs.NE")).toContain("search_query=all%3A%22spiking%22%20AND%20cat%3Acs.NE");
});

test("news and a paper reach the person only when a line's tag rests on a milestone; an opportunity needs only the relevance", () => {
  const lines = [{ id: "r", name: "研究者", goal: "成为神经形态计算方向的研究者", milestones: [{ id: "m1", title: "完成脉冲神经网络芯片实验" }], watches: [] }];
  const tag = (type: string, anchors: string[]) => classifyFind({ type, reason: "", lines: [{ lineId: "r", confidence: 0.9, reason: "", anchors }] },
    { lines, title: "Spiking neural network chip 脉冲神经网络芯片实验", organizer: "" });
  const row = (classified: ReturnType<typeof classifyFind>) => ({ lineId: "r", lines: classified.lines, type: classified.type });
  expect(pushable(row(tag("paper", ["goal"])))).toBe(false);
  expect(pushable(row(tag("paper", ["m1"])))).toBe(true);
  expect(pushable(row(tag("news", ["goal"])))).toBe(false);
  expect(pushable(row(tag("competition", ["goal"])))).toBe(true);
});

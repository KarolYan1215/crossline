import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {} }) }));
import { LocaleProvider } from "../locale-context";
import type { BoardMilestone } from "../../lib/milestone-board";
import { LineApprovals, MilestoneStats } from "./milestone-timeline";
import { LinesBar, type LineCard } from "./lines-bar";
import { RiskList } from "./risk-glyph";
import { labelWidth, layoutTimeline } from "./timeline-model";

const draft = (id: string, line: string, risks: BoardMilestone["risks"]) => ({ id, identityId: line, title: id, status: "draft", risks }) as unknown as BoardMilestone;
const line = (over: Partial<LineCard> = {}): LineCard => ({ id: "research", label: "Researcher", color: "research", goals: ["Become an independent researcher"],
  hard: true, rank: 1, milestones: 1, drafts: 1, attributes: [], goalParts: ["independent", "well-published"], description: "", pendingEdit: null, redraftDue: false,
  interview: { reply: "", questions: [{ id: "q1", text: "When?", kind: "single", options: [] }], waiting: false, turns: 1 }, ...over });

describe("the timeline's geometry in English", () => {
  test("months on the axis are English names; Chinese stays 「11月」", () => {
    const input = { nodes: [{ id: "a", line: "research", title: "Paper", status: "approved" as const, kind: "milestone" as const, day: "2026-11-20", dependsOn: [] }],
      ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-28" };
    expect(layoutTimeline(input).axis.map((mark) => mark.label)).toContain("11月");
    const english = layoutTimeline({ ...input, locale: "en" }).axis.map((mark) => mark.label);
    expect(english).toContain("Nov");
    expect(english.join("")).not.toMatch(/[一-鿿]/);
  });

  test("label widths are measured by script: a CJK character is about two Latin letters", () => {
    expect(labelWidth("促成")).toBe(34);
    expect(labelWidth("Enables")).toBeLessThan(labelWidth("促成促成"));
    expect(labelWidth("Feedback loop")).toBeGreaterThan(labelWidth("反馈回路"));
  });
});

describe("the milestone page in English", () => {
  test("approving by track: counts, risk levels and the button in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><LineApprovals id="x" lineOrder={["research"]} labels={{ research: "Researcher" }}
      drafts={[draft("r1", "research", [{ level: "high", kind: "time", note: "" }])]} /></LocaleProvider>);
    expect(html).toContain("High risk 1, medium risk 0, low risk 0");
    expect(html).toContain("Approve this track");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("the week's figures with English plurals", () => {
    const board = { stats: { ticksDone: 1, ticksPlanned: 3, reuse: 2, nearest: { line: "research", days: 1, title: "Paper" } } } as unknown as Parameters<typeof MilestoneStats>[0]["board"];
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><MilestoneStats board={board} /></LocaleProvider>);
    expect(html).toContain("Waypoints this week");
    expect(html).toContain("1 day");
    expect(html).toContain("until Paper");
  });

  test("a line card reads in English and composes the goal without 「的」", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><LinesBar lines={[line()]} palette={{ research: "#0A5198" }} /></LocaleProvider>);
    expect(html).toContain(">Become<");
    expect(html).toContain("Become independent, well-published Researcher");
    expect(html).toContain(">Hard constraint<");
    expect(html).toContain("0/1 milestone · 1 to approve");
    expect(html).toContain('aria-label="Redo this track&#x27;s untouched drafts"');
    expect(html).toContain("1 question");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("risk kinds are translated where shown", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><RiskList gen={false} risks={[{ level: "medium", kind: "capacity", note: "" }]} /></LocaleProvider>);
    expect(html).toContain("Not enough hours");
    expect(html).toContain("Medium risk");
  });
});

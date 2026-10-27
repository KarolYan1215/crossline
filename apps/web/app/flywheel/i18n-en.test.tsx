import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { FlywheelGraph } from "./flywheel-graph";
import type { FlywheelGraphData } from "./graph-model";

const data: FlywheelGraphData = {
  lines: [
    { id: "research", label: "Researcher", goal: "Become a researcher who can run an independent project in neuromorphic computing", openTasks: 1 },
    { id: "media", label: "Creator", goal: "Explain hard research clearly", openTasks: 3 }
  ],
  milestones: [
    { id: "r1", line: "research", title: "Simulation study done", status: "approved", openTasks: 1, dependsOn: [] },
    { id: "m1", line: "media", title: "First explainer video", status: "draft", openTasks: 2, dependsOn: [] }
  ],
  relations: [{ id: "x1", from: "r1", to: "m1", kind: "reuses", status: "candidate", explanation: "Charts reused in the video" }]
};

describe("the flywheel graph in English", () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><FlywheelGraph data={data} /></LocaleProvider>);

  test("names, kinds, counts and the key are English", () => {
    expect(html).toContain("Simulation study done → First explainer video: Reuses, to confirm");
    expect(html).toContain("1 open task");
    expect(html).toContain(" in progress");
    expect(html).toContain("Legend and controls");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("an English goal is cut by width, keeping more letters than a Chinese one would", () => {
    // The goal takes two lines (`wrapLabel`): the first holds more letters than a Chinese line's sixteen, the last ends in 「…」.
    const goal = html.match(/class="fw-label fw-label-goal">(.*?)<\/text>/)?.[1] ?? "";
    const lines = [...goal.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1]!);
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
    expect(lines[0]!.length).toBeGreaterThan(16);
  });
});

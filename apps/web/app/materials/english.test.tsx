import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { Namer, humanTable } from "./humanize";
import { buildTutorial, type Book } from "./tutorial-model";
import { DocBlocksView } from "./doc-view";

/** Materials in English (docs/i18n.md): the labels the cleaning writes, and a guide written with English headings. */
test("a table that is only file bookkeeping becomes one English sentence, and unknown files are 'Source N'", () => {
  const namer = new Namer({}, "en");
  const all = humanTable(["file", "status"], [["a.pdf", "available"], ["b.pdf", "available"]], namer);
  expect(all).toEqual({ kind: "summary", text: "All 2 files can be read: a, b." });
  const mixed = humanTable(["file", "status"], [["a.pdf", "available"], ["b.pdf", "missing"]], namer);
  expect(mixed).toEqual({ kind: "summary", text: "2 files: a, b; 1 readable, 1 missing." });
  expect(namer.code("S03")).toBe("Source 3");
  const table = humanTable(["title", "deadline", "notes"], [["Homework 3", "Nov 2", "posted"]], namer);
  expect(table).toMatchObject({ kind: "table", header: ["Name", "Due", "Notes"] });
  // Chinese is unchanged.
  expect(humanTable(["file", "status"], [["a.pdf", "available"], ["b.pdf", "available"]], new Namer())).toEqual({ kind: "summary", text: "两份文件均可读取：a、b。" });
});

test("a guide written with English headings gives its acceptance, assumptions and missing items like a Chinese one", () => {
  const book: Book = {
    flow: { nodes: [{ id: "n1", title: "Read chapter 3", kind: "read", goal: "Know the model", stage: 1 }] },
    manual: "# Homework 3\n\nOverview text.\n\n## Assumptions\n- The problem sheet is the posted one\n\n## Flow\n1. Read chapter 3",
    nodes: { n1: { task: "# Read chapter 3\n\n**Goal**: Know the model\n\n## How it counts as done\nCan derive eq. 3.2\n", analysis: "",
      tutorial: "Still needed: the problem sheet, the dataset.\n\nRead section 3.1 first.", sources: [] } },
    materials: []
  };
  const tutorial = buildTutorial("w1", book);
  expect(tutorial.overview).toBe("Overview text.");
  expect(tutorial.assumptions).toEqual(["The problem sheet is the posted one"]);
  expect(tutorial.sections[0]).toMatchObject({ acceptance: "Can derive eq. 3.2", missing: ["the problem sheet", "the dataset"], guide: "Read section 3.1 first." });
});

test("a checklist's boxes are labelled in English", () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><DocBlocksView blocks={[{ t: "list", ordered: false, items: [{ spans: [{ text: "x" }], depth: 0, checked: true }] }]} /></LocaleProvider>);
  expect(html).toContain('aria-label="Done"');
});

import { expect, test } from "vitest";
import { extractText, sha256 } from "./extract";

const bytes = (text: string) => new TextEncoder().encode(text);

test("plain text is read as is, with layout whitespace tidied", async () => {
  const result = await extractText(bytes("Week-1: 8th Sept  \r\n\r\n\r\n\r\nL1: Intro\n"), "text");
  expect(result).toEqual({ status: "done", text: "Week-1: 8th Sept\n\nL1: Intro" });
});

test("an empty file is not a successful read of a blank document", async () => {
  const result = await extractText(bytes("  \n \n"), "text");
  expect(result.status).toBe("unsupported");
  expect(result.note).toContain("没有可提取的文字");
});

test("a corrupt PDF or Word file fails with a note instead of throwing", async () => {
  for (const kind of ["pdf", "docx"] as const) {
    const result = await extractText(bytes("this is not a real file"), kind);
    expect(result.status).toBe("failed");
    expect(result.note).toContain("解析失败");
  }
});

test("images and recordings are reported as not readable as text, not as empty", async () => {
  expect((await extractText(bytes("x"), "image")).status).toBe("unsupported");
  expect((await extractText(bytes("x"), "audio")).note).toContain("转写");
});

test("very long text is cut to the limit", async () => {
  const result = await extractText(bytes("字".repeat(250_000)), "text");
  expect(result.text.length).toBe(200_000);
});

test("the content hash is stable and content-only", () => {
  expect(sha256(bytes("a"))).toBe(sha256(bytes("a")));
  expect(sha256(bytes("a"))).not.toBe(sha256(bytes("b")));
});

import { htmlTablesToText, layoutPage } from "./extract";

test("a table's columns stay columns: the same marker under two different headings is not the same text twice", () => {
  // Header 「Out」 at x=360 and 「Due」 at x=410; the first row's #1 sits under Out, the second row's under Due.
  const cell = (str: string, x: number, y: number) => ({ str, x, y, width: str.length * 5 });
  const page = layoutPage([
    cell("Date", 85, 617), cell("Topic", 150, 617), cell("Out", 360, 617), cell("Due", 410, 617),
    cell("9/7", 85, 592), cell("Labor Day", 150, 592), cell("#1", 362, 592),
    cell("9/28", 85, 518), cell("DC Inverter", 150, 518), cell("#1", 412, 518)
  ]);
  const lines = page.split("\n");
  expect(lines).toHaveLength(3);
  const column = (line: string, text: string) => line.indexOf(text);
  // The marker sits under the heading it belongs to, to within a character.
  expect(Math.abs(column(lines[1]!, "#1") - column(lines[0]!, "Out"))).toBeLessThanOrEqual(2);
  expect(Math.abs(column(lines[2]!, "#1") - column(lines[0]!, "Due"))).toBeLessThanOrEqual(2);
  expect(column(lines[2]!, "#1")).toBeGreaterThan(column(lines[1]!, "#1"));
});

test("pieces of one word are joined, and pieces on one line come out top to bottom", () => {
  const cell = (str: string, x: number, y: number, width = str.length * 5) => ({ str, x, y, width });
  expect(layoutPage([cell("Intro", 10, 100), cell("duction", 35, 100), cell("Second", 10, 80), cell("First", 10, 120)]).split("\n").map((line) => line.trim()))
    .toEqual(["First", "Introduction", "Second"]);
  expect(layoutPage([])).toBe("");
});

test("a Word table keeps each row on one line with its cells separated", () => {
  const html = "<p>Schedule</p><table><tr><th>Date</th><th>Topic</th></tr><tr><td>9/4</td><td>Intro &amp; VLSI</td></tr></table>";
  const text = htmlTablesToText(html);
  expect(text).toContain("Date | Topic");
  expect(text).toContain("9/4 | Intro & VLSI");
});

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AssistantWidget } from "./assistant-widget";

const source = readFileSync(new URL("./assistant-widget.tsx", import.meta.url), "utf8");

// This suite runs under vitest's "node" environment (no jsdom/DOM events — see every other client
// component test in this directory, e.g. `energy-probe.test.tsx`), so it can only assert on the initial
// server-rendered markup, not on click-driven state changes or `localStorage` round-trips. The component
// reads its open/closed preference from `localStorage` inside a `useEffect`, which `renderToStaticMarkup`
// never runs — so the very first render is always the minimized bubble, which is the behaviour this
// suite actually verifies.
describe("assistant widget", () => {
  test("renders minimized (a bubble, not the expanded panel) on first paint", () => {
    const html = renderToStaticMarkup(<AssistantWidget />);
    expect(html).toContain("assistant-bubble");
    expect(html).not.toContain("assistant-panel");
  });

  test("before a figure is known (a new account, a guest that cannot draw images) the bubble is the text button 小帮手", () => {
    const html = renderToStaticMarkup(<AssistantWidget />);
    expect(html).toContain(">小帮手</button>");
    expect(html).toContain('aria-label="打开小帮手"');
    expect(html).not.toContain("helper-face");
  });

  test("never reads or writes this application's own repository", () => {
    for (const forbidden of ["readFile", "writeFile", "child_process", "import(\"fs\"", "require(\"fs\""]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureMaterials, ensurePortrait, ensureSkillLibrary } from "./ledger.js";

/**
 * The English interface (docs/i18n.md), page by page at desktop and phone width: the page says it is English, the frame reads in English,
 * nothing scrolls sideways and no two pieces of text overlap — English runs longer than the Chinese every layout was drawn for. A full-page
 * screenshot of each is written to `ENGLISH_SHOTS_DIR` (default `test-results/english`) for a person to look at.
 *
 * Chinese still on the page is listed, not failed: the example board's tasks and milestones are the person's own words and stay in the
 * language they were written in. `I18N_VERBOSE=1` prints each page's list, which is how system text that slipped through is found.
 *
 * The suites share one account and run side by side. A cookie on an account with no choice of its own would become the account's choice
 * (and turn every other suite's pages English), so each test first records Chinese as the account's choice from the page itself — the
 * browser carries the session cookie, a bare request would not — and only then sets this browser's cookie to English.
 */
const PAGES = ["/", "/milestones", "/plan", "/workbench", "/approvals", "/settings", "/onboarding", "/review", "/portrait", "/return",
  "/materials/[id]", "/materials/view", "/login", "/signup"];
const SHOTS = process.env.ENGLISH_SHOTS_DIR ?? path.join("test-results", "english");

const addressOf = async (page: Page, where: string) => where === "/materials/[id]" ? (await ensureMaterials(page)).tutorial
  : where === "/materials/view" ? (await ensureMaterials(page)).view : where;

test.beforeEach(async ({ page, context, baseURL }) => {
  await page.goto("/api/health");
  await page.evaluate(() => fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: "zh" }) }));
  await context.addCookies([{ name: "crossline-locale", value: "en", url: baseURL! }]);
});

for (const where of PAGES) {
  test(`${where} in English: lang, frame, no sideways scroll, no overlapping text`, async ({ page }, testInfo) => {
    if (where === "/portrait") await ensurePortrait(page);
    if (where === "/settings") await ensureSkillLibrary(page);
    await page.goto(await addressOf(page, where));
    await page.waitForLoadState("networkidle");
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    const found = await page.evaluate(() => {
      const han = /[㐀-鿿]/;
      const chinese = new Set<string>();
      const boxes: Array<{ node: number; text: string; rect: DOMRect }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let index = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (!text || !element || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        if (han.test(text)) chinese.add(text.slice(0, 60));
        // Overlap is measured where layout is ours (an SVG chart is checked by its own tests), and on what is actually drawn: text clipped
        // by a box that hides its overflow (a clamped paragraph under its 「Show all」) is cut to that box first.
        if (element.closest("svg")) continue;
        let clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
        for (let up: Element | null = element; up && up !== document.body; up = up.parentElement) {
          const css = getComputedStyle(up);
          if (css.overflowX !== "visible" || css.overflowY !== "visible") {
            const box = up.getBoundingClientRect();
            clip = { left: Math.max(clip.left, box.left), top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
          }
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        index += 1;
        for (const raw of range.getClientRects()) {
          const rect = new DOMRect(Math.max(raw.left, clip.left), Math.max(raw.top, clip.top), 0, 0);
          rect.width = Math.min(raw.right, clip.right) - rect.left;
          rect.height = Math.min(raw.bottom, clip.bottom) - rect.top;
          if (rect.width > 0 && rect.height > 0) boxes.push({ node: index, text: text.slice(0, 30), rect });
        }
      }
      const overlaps: string[] = [];
      for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a]!, two = boxes[b]!;
        if (one.node === two.node) continue;
        const width = Math.min(one.rect.right, two.rect.right) - Math.max(one.rect.left, two.rect.left);
        const height = Math.min(one.rect.bottom, two.rect.bottom) - Math.max(one.rect.top, two.rect.top);
        if (width > 2 && height > 2) overlaps.push(`「${one.text}」 × 「${two.text}」`);
      }
      return { chinese: [...chinese], overlaps: [...new Set(overlaps)].slice(0, 20),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    mkdirSync(SHOTS, { recursive: true });
    const name = `${testInfo.project.name}-${where.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "today"}.png`;
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
    if (process.env.I18N_VERBOSE) console.log(`EN ${testInfo.project.name} ${where} chinese=${JSON.stringify(found.chinese)} overlaps=${JSON.stringify(found.overlaps)}`);
    await testInfo.attach("chinese-on-page", { body: found.chinese.join("\n"), contentType: "text/plain" });
    expect.soft(found.overflow, `horizontal overflow on ${where}`).toBeLessThanOrEqual(1);
    expect.soft(found.overlaps, `text overlapping text on ${where}`).toEqual([]);
  });
}

test("the frame is English: the navigation and the switch back to Chinese", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const nav = testInfo.project.name.includes("mobile") ? page.locator(".bottom-nav") : page.locator("header");
  await expect(nav.getByText("Today", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "切换到中文" }).first()).toBeAttached();
});

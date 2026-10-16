import { expect, test, type Page } from "@playwright/test";
import { ensureMaterials, ensurePortrait, ensureSkillLibrary } from "./ledger.js";

/**
 * The Phase 4 acceptance bullets that a screenshot comparison cannot state: one typeface, nothing under 12px, text contrast
 * of at least 7:1, and no page that scrolls sideways on a phone. Every page of the app is walked at both widths, so a new
 * page or a restyle that breaks one of them fails here instead of waiting for someone to notice.
 *
 * Disabled controls and text that is hidden on purpose (visibility, opacity 0) are exempt from contrast: WCAG exempts inactive
 * controls, and a hidden element is not read.
 */
const PAGES = ["/", "/milestones", "/plan", "/workbench", "/approvals", "/settings", "/onboarding", "/review", "/portrait", "/return", "/materials/[id]", "/materials/view"];

/** The material pages need a tutorial and an upload to draw (`ensureMaterials`); every other entry is its own address. */
const addressOf = async (page: Page, path: string) => path === "/materials/[id]" ? (await ensureMaterials(page)).tutorial
  : path === "/materials/view" ? (await ensureMaterials(page)).view : path;

type Finding = { selector: string; text: string; detail: string };

async function audit(page: Page): Promise<{ fonts: Finding[]; small: Finding[]; contrast: Finding[]; overflow: number; wide: string[] }> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    // The colour actually behind an element: walk up, compositing translucent layers over what is below them.
    const backdrop = (element: Element): [number, number, number] => {
      const layers: Array<[number, number, number, number]> = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] >= 1) break;
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const layer of layers.reverse()) base = [0, 1, 2].map((i) => layer[i]! * layer[3] + base[i]! * (1 - layer[3])) as [number, number, number];
      return base;
    };
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
    const fonts: Finding[] = [], small: Finding[] = [], contrast: Finding[] = [];
    const seen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const element = node.parentElement;
      if (!text || !element) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const key = `${describe(element)}|${text.slice(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const finding = (detail: string): Finding => ({ selector: describe(element), text: text.slice(0, 40), detail });
      // Two faces: Arial (with DengXian) for the system's own text, Microsoft YaHei for text a model wrote (inside `.gen`). A third,
      // the poster's serif, is allowed only inside `.pt-serif` on the portrait, which is used only for strings written in code.
      const face = style.fontFamily.split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
      const expected = element.closest(".gen") ? "microsoft yahei" : element.closest(".pt-serif") ? "crossline poster serif" : "arial";
      // A formula typeset by KaTeX (`.katex`, app/ui/markdown.tsx) is drawn in KaTeX's own math fonts, bundled with the app: a formula in
      // Arial would no longer read as mathematics. Its sub- and superscripts are set at about 70% of the line by mathematical
      // convention, so the size rule does not apply inside it either; the formula's base size follows the text around it.
      const formula = Boolean(element.closest(".katex"));
      // English poster text uses the Latin companion of the poster serif (portrait.css).
      const same = face === expected || (expected === "crossline poster serif" && face === "crossline poster serif latin");
      if (!same && !formula) fonts.push(finding(style.fontFamily.slice(0, 60)));
      if (parseFloat(style.fontSize) < 12 && !formula) small.push(finding(style.fontSize));
      if (element.closest(":disabled, [aria-disabled='true']")) continue;
      const fg = parse(style.color);
      const bg = backdrop(element);
      const blended = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
      const l1 = luminance(blended), l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 7) contrast.push(finding(`${ratio.toFixed(2)}:1 (${style.color} on rgb(${bg.map(Math.round).join(",")}))`));
    }
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    // Which elements poke past the right edge, outermost first, so a failure names the cause and not just the number.
    const wide = overflow > 1 ? [...document.body.querySelectorAll("*")].filter((node) => {
      const box = node.getBoundingClientRect();
      if (box.right <= document.documentElement.clientWidth + 1 || box.width === 0) return false;
      // The fixed tab bar is as wide as the layout viewport, so it reports whatever else made that viewport wide.
      if (node.closest(".bottom-nav") || getComputedStyle(node).position === "fixed") return false;
      // Anything inside a region that scrolls on its own is not the page's problem.
      for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return false;
      return true;
    }).slice(0, 3).map((node) => `${describe(node)} right=${Math.round(node.getBoundingClientRect().right)}`) : [];
    if (wide.length) {
      // The ancestor chain of the first offender with each box's width: the first one that is wider than the viewport is the cause.
      const first = [...document.body.querySelectorAll("*")].find((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !node.closest(".bottom-nav") && getComputedStyle(node).position !== "fixed" && node.getBoundingClientRect().width > 0);
      for (let up: Element | null = first ?? null; up && up !== document.documentElement; up = up.parentElement) wide.push(`  ^ ${describe(up)} w=${Math.round(up.getBoundingClientRect().width)} display=${getComputedStyle(up).display} minw=${getComputedStyle(up).minWidth}`);
    }
    return { fonts, small, contrast, overflow, wide };
  });
}

for (const path of PAGES) {
  test(`${path} keeps one typeface, readable sizes, 7:1 text contrast and no sideways scroll`, async ({ page }, testInfo) => {
    // The portrait is audited with a full report, not its empty state.
    if (path === "/portrait") await ensurePortrait(page);
    if (path === "/settings") await ensureSkillLibrary(page);
    await page.goto(await addressOf(page, path));
    await page.waitForLoadState("networkidle");
    const found = await audit(page);
    if (process.env.AUDIT_VERBOSE) console.log(`AUDIT ${path} ${JSON.stringify(found)}`);
    expect.soft(found.fonts, "text not in the system face (Arial) or, inside .gen, the generated-text face").toEqual([]);
    expect.soft(found.small, "text under 12px").toEqual([]);
    expect.soft(found.contrast, "text under 7:1 contrast").toEqual([]);
    // The page itself must not scroll sideways (a deliberately scrollable inner region is fine).
    expect.soft(found.overflow, `horizontal overflow on ${testInfo.project.name}: ${found.wide.join("; ")}`).toBeLessThanOrEqual(1);
  });
}

// A 1280px window hid this once: a page whose content has a fixed minimum width (the milestone flow chart is ~1130px) scrolled the
// whole page sideways on an ordinary laptop window, and neither the desktop nor the phone width noticed. Only the inner region may scroll.
for (const path of PAGES) {
  test(`${path} does not scroll sideways in a 1000px laptop window`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "the phone width is covered above");
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(await addressOf(page, path));
    await page.waitForLoadState("networkidle");
    const found = await audit(page);
    expect(found.overflow, `horizontal overflow at 1000px: ${found.wide.join("; ")}`).toBeLessThanOrEqual(1);
  });
}

/**
 * The portrait's layout defects (decided 2026-10-12: axis percentages over their captions, energy labels on each other, two advice dots
 * on one spot) as one property: no two pieces of text on the page — on screen or in the off-screen share images — overlap. Measured per
 * line box with `Range.getClientRects()` (tighter than an element's box, and it works for SVG text). Both share cards must hold their content.
 */
test("/portrait: no two pieces of text overlap, and the share cards fit", async ({ page }) => {
  await ensurePortrait(page);
  await page.goto("/portrait");
  await page.waitForLoadState("networkidle");
  const { overlaps, cardOverflow } = await page.evaluate(() => {
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/s+/).slice(0, 2).join(".")}` : ""}`;
    const boxes: Array<{ node: number; text: string; where: string; rect: DOMRect }> = [];
    let index = 0;
    // The off-screen share half is itself a `.pt-doc`: walk each root once.
    for (const root of document.querySelectorAll(".pt-doc:not(.pt-offscreen .pt-doc), .pt-offscreen")) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (!text || !element) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        index += 1;
        for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) boxes.push({ node: index, text: text.slice(0, 30), where: describe(element), rect });
      }
    }
    const overlaps: string[] = [];
    for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) {
      const one = boxes[a]!, two = boxes[b]!;
      if (one.node === two.node) continue;
      const width = Math.min(one.rect.right, two.rect.right) - Math.max(one.rect.left, two.rect.left);
      const height = Math.min(one.rect.bottom, two.rect.bottom) - Math.max(one.rect.top, two.rect.top);
      if (width > 1 && height > 1) overlaps.push(`「${one.text}」(${one.where}) × 「${two.text}」(${two.where})`);
    }
    // Both 3:4 cards (type and energy rhythm) must hold their content.
    const cardOverflow = Math.max(0, ...[...document.querySelectorAll(".pt-card")].map((card) => card.scrollHeight - card.clientHeight));
    return { overlaps: [...new Set(overlaps)], cardOverflow };
  });
  expect.soft(overlaps, "text overlapping other text on /portrait").toEqual([]);
  expect.soft(cardOverflow, "share card content taller than the card").toBeLessThanOrEqual(1);
});

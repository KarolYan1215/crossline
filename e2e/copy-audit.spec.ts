import { expect, test, type Page } from "@playwright/test";

/**
 * The automatable half of the review rubric (docs/copy-style.md): no second person in the system's own text, folds only for advanced
 * content, nothing developer-facing on screen, and no long paragraphs outside material and tutorial bodies.
 *
 * Exempt on purpose: `.gen` (text a model wrote — it quotes the person and their files), `[data-user-text]` (what the person typed or
 * named), `.long-form` (material and tutorial bodies), and `details.advanced` (the one sanctioned use of a fold).
 *
 * Pages are reworked one phase at a time, so findings are reported and only fail once COPY_AUDIT_STRICT=1 (the final phase turns it on).
 */
const PAGES = ["/", "/milestones", "/plan", "/workbench", "/approvals", "/settings"];

type Findings = { secondPerson: string[]; folds: string[]; developer: string[]; longText: string[] };

const DEVELOPER = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|scripts[\\/]|\.ps1\b|\.tsx?\b|CROSSLINE_|CODEX_HOME|\bworker\b|\bsidecar\b|127\.0\.0\.1|localhost|\bthread\b|sha256/;

async function audit(page: Page): Promise<Findings> {
  return page.evaluate((developerSource) => {
    const developer = new RegExp(developerSource);
    const exempt = (element: Element) => Boolean(element.closest(".gen, [data-user-text], .long-form, details.advanced, script, style, noscript"));
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const found: Findings = { secondPerson: [], folds: [], developer: [], longText: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const element = node.parentElement;
      if (!text || !element || exempt(element) || !visible(element)) continue;
      if (/[你我]/.test(text)) found.secondPerson.push(text.slice(0, 40));
      if (developer.test(text)) found.developer.push(text.slice(0, 60));
    }
    for (const fold of document.querySelectorAll("details:not(.advanced)")) {
      if (visible(fold)) found.folds.push(fold.querySelector("summary")?.textContent?.trim().slice(0, 30) ?? "(no summary)");
    }
    for (const block of document.querySelectorAll("p, li, dd")) {
      if (exempt(block) || !visible(block)) continue;
      const style = getComputedStyle(block);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.35;
      if (block.getBoundingClientRect().height > line * 3.5) found.longText.push((block.textContent ?? "").trim().slice(0, 40));
    }
    return found;
  }, DEVELOPER.source);
}

for (const path of PAGES) {
  test(`${path} reads as product copy: third person, few folds, nothing developer-facing, no long paragraphs`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const found = await audit(page);
    if (process.env.AUDIT_VERBOSE || !process.env.COPY_AUDIT_STRICT) console.log(`COPY ${path} ${JSON.stringify(found)}`);
    if (!process.env.COPY_AUDIT_STRICT) return;
    expect.soft(found.secondPerson, "second person in system text").toEqual([]);
    expect.soft(found.folds, "folds outside advanced content").toEqual([]);
    expect.soft(found.developer, "developer-facing text").toEqual([]);
    expect.soft(found.longText, "paragraphs over three lines").toEqual([]);
  });
}

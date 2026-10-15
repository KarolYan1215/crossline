import { expect, test, type Page } from "@playwright/test";
import { ensureSkillLibrary } from "./ledger.js";

/**
 * The automatable half of the review rubric (docs/copy-style.md): no second person in the system's own text, folds only for advanced
 * content, nothing developer-facing on screen, and no long paragraphs outside material and tutorial bodies.
 *
 * Exempt on purpose: `.gen` (text a model wrote — it quotes the person and their files), `[data-user-text]` (what the person typed or
 * named), `.long-form` (material and tutorial bodies), and `details.advanced` (the one sanctioned use of a fold).
 *
 * Strict since the product pass finished (2026-10-08): any finding fails. `COPY_AUDIT_REPORT=1` only prints them, for a page being reworked.
 */
const PAGES = ["/", "/milestones", "/plan", "/workbench", "/approvals", "/settings", "/return"];

type Findings = { secondPerson: string[]; folds: string[]; developer: string[]; longText: string[] };

const DEVELOPER = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|scripts[\\/]|\.ps1\b|\.tsx?\b|CROSSLINE_|CODEX_HOME|\bworker\b|\bsidecar\b|127\.0\.0\.1|localhost|\bthread\b|sha256/;

async function audit(page: Page): Promise<Findings> {
  return page.evaluate((developerSource) => {
    const developer = new RegExp(developerSource);
    // `.ob-voice`: the interview's conversation, which addresses the person as 你 by decision (docs/onboarding-v3.md, 2026-10-14).
    const exempt = (element: Element) => Boolean(element.closest(".gen, .ob-voice, [data-user-text], .long-form, details.advanced, script, style, noscript"));
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
    // Navigation's 「更多」 is a menu, not folded content; a fold inside an advanced one is advanced too.
    for (const fold of document.querySelectorAll("details:not(.advanced)")) {
      if (fold.closest("nav, details.advanced")) continue;
      if (visible(fold)) found.folds.push(fold.querySelector("summary")?.textContent?.trim().slice(0, 30) ?? "(no summary)");
    }
    for (const block of document.querySelectorAll("p, li, dd")) {
      // A list item holding a whole card (an ask on 待确认: heading, paragraph, options) is a container, not a paragraph; its own
      // paragraphs are measured one by one.
      if (exempt(block) || !visible(block) || block.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, fieldset, form")) continue;
      const style = getComputedStyle(block);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.35;
      // Lines are counted in the text's own height: a paragraph styled as a padded panel (Today's empty 下一步) is two lines on a phone.
      const content = block.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
      if (content > line * 3.5) found.longText.push((block.textContent ?? "").trim().slice(0, 40));
    }
    return found;
  }, DEVELOPER.source);
}

for (const path of PAGES) {
  test(`${path} reads as product copy: third person, few folds, nothing developer-facing, no long paragraphs`, async ({ page }) => {
    if (path === "/settings") await ensureSkillLibrary(page);
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const found = await audit(page);
    if (process.env.AUDIT_VERBOSE || process.env.COPY_AUDIT_REPORT) console.log(`COPY ${path} ${JSON.stringify(found)}`);
    if (process.env.COPY_AUDIT_REPORT) return;
    expect.soft(found.secondPerson, "second person in system text").toEqual([]);
    expect.soft(found.folds, "folds outside advanced content").toEqual([]);
    expect.soft(found.developer, "developer-facing text").toEqual([]);
    expect.soft(found.longText, "paragraphs over three lines").toEqual([]);
  });
}

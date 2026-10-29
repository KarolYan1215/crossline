import { chromium, type BrowserContextOptions } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Screenshots of the redesigned Today (docs/plans/today-redesign-1028) from a review server (`scripts/review-server.ts dev`, never a real
 * ledger), at 1440×900, 1536×1024 and a 390×844 phone, light and dark, plus the design audit's font, size and contrast rules over what
 * is on screen. Signs in with the review account the review data directory keeps.
 *
 *   BASE=http://localhost:3320 REVIEW_DIR=<data dir> LOOK_CHROME=<chrome.exe> pnpm exec tsx scripts/today-shots.ts [outDir]
 */
const base = process.env.BASE ?? "http://localhost:3320";
const outDir = path.resolve(process.argv[2] ?? "docs/plans/today-redesign-1028");
const account = JSON.parse(readFileSync(path.join(process.env.REVIEW_DIR ?? path.join(tmpdir(), "crossline-review"), "review-account.json"), "utf8")) as { email: string; password: string };
const viewports: Array<[string, BrowserContextOptions]> = [
  ["desktop-1440", { viewport: { width: 1440, height: 900 } }],
  ["desktop-1536", { viewport: { width: 1536, height: 1024 } }],
  ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]
];
const pages = (process.env.PAGES ?? "/").split(",");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch(process.env.LOOK_CHROME ? { executablePath: process.env.LOOK_CHROME } : {});
try {
  for (const scheme of ["light", "dark"] as const) for (const [name, options] of viewports) {
    const context = await browser.newContext({ ...options, colorScheme: scheme, baseURL: base });
    const signIn = await context.request.post("/api/auth/sign-in/email", { data: account });
    if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()}`);
    await context.addInitScript("window.__name = (fn) => fn");
    const page = await context.newPage();
    for (const address of pages) {
      await page.goto(address, { waitUntil: "networkidle", timeout: 180_000 });
      if (new URL(page.url()).pathname === "/return") {
        await page.getByRole("button", { name: "这次先跳过" }).click();
        await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
        await page.waitForLoadState("networkidle");
      }
      await page.addStyleTag({ content: ".corner-stack,.notice-toast,.undo-toast{visibility:hidden !important}" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const slug = address === "/" ? "today" : address.replace(/\W+/g, "-").replace(/^-|-$/g, "");
      const file = path.join(outDir, `${slug}-${name}${scheme === "dark" ? "-dark" : ""}.png`);
      await page.screenshot({ path: file, fullPage: process.argv.includes("--full") });
      const audit = await auditPage(page);
      console.log(`${file}\n  overflow=${audit.overflow} fonts=${audit.fonts.length} small=${audit.small.length} contrast=${audit.contrast.length}`);
      for (const line of [...audit.fonts, ...audit.small, ...audit.contrast].slice(0, 12)) console.log(`    ${line}`);
    }
    await context.close();
  }
} finally { await browser.close(); }

/** The design audit's rules (e2e/design-audit.spec.ts) over the visible text, the display serif included. */
async function auditPage(page: import("@playwright/test").Page): Promise<{ fonts: string[]; small: string[]; contrast: string[]; overflow: number }> {
  return page.evaluate(() => {
    const parse = (value: string): number[] => { const m = /rgba?\(([^)]+)\)/.exec(value); const p = m ? m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0]; return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]; };
    const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (c: number[]) => 0.2126 * channel(c[0]!) + 0.7152 * channel(c[1]!) + 0.0722 * channel(c[2]!);
    const backdrop = (el: Element) => { const layers: number[][] = []; for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3]! > 0) layers.push(c); if (c[3]! >= 1) break; }
      let b = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3); if (parse(getComputedStyle(document.body).backgroundColor)[3] === 0) b = [255, 255, 255];
      for (const l of layers.reverse()) b = [0, 1, 2].map((i) => l[i]! * l[3]! + b[i]! * (1 - l[3]!)); return b; };
    const fonts: string[] = [], small: string[] = [], contrast: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim(); const el = node.parentElement;
      if (!text || !el || ["SCRIPT", "STYLE"].includes(el.tagName)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
      const face = style.fontFamily.split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
      const expected = el.closest(".gen") ? "microsoft yahei" : el.closest(".pt-serif") ? "crossline poster serif" : el.closest(".ds-serif") ? "crossline poster serif latin" : "arial";
      if (face !== expected && !el.closest(".katex")) fonts.push(`font ${el.className} 「${text.slice(0, 20)}」 ${face}`);
      if (parseFloat(style.fontSize) < 12) small.push(`small ${el.className} 「${text.slice(0, 20)}」 ${style.fontSize}`);
      if (el.closest(":disabled,[aria-disabled='true']")) continue;
      const fg = parse(style.color), bg = backdrop(el); const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));
      const a = lum(mixed), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 7) contrast.push(`contrast ${el.tagName.toLowerCase()}.${el.className} 「${text.slice(0, 20)}」 ${ratio.toFixed(2)}`);
    }
    return { fonts, small, contrast, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
}

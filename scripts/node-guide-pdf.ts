/**
 * Renders the person-facing install guide (docs/node-install-guide.md) to `dist/node-installer/Crossline-节点安装教程.pdf`, the file
 * published beside the node installer (docs/compute-node.md 「发布」). The Markdown is drawn by the app's own `Markdown` component
 * (apps/web/app/ui/markdown.tsx, bundled here with its CSS left out) and printed by Playwright's Chromium, or the system Edge without it.
 *
 *   pnpm exec tsx scripts/node-guide-pdf.ts
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const out = path.join(repoRoot, "dist", "node-installer");
const pdf = path.join(out, "Crossline-节点安装教程.pdf");
mkdirSync(out, { recursive: true });

// The app's Markdown component to static HTML: bundled with React, its stylesheets dropped (this page has its own below).
const fromWeb = createRequire(path.join(repoRoot, "apps", "web", "package.json"));
const esbuild = createRequire(createRequire(path.join(repoRoot, "apps", "worker", "package.json")).resolve("tsx/package.json"))("esbuild") as typeof import("esbuild");
const renderer = path.join(out, "guide-render.mjs");
await esbuild.build({
  stdin: { contents: `import { createElement } from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { Markdown } from "./markdown";
    export const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));`, resolveDir: path.join(repoRoot, "apps", "web", "app", "ui"), loader: "tsx" },
  outfile: renderer, bundle: true, platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "warning",
  // react-dom is CommonJS: inside an ES module its `require` calls need one.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  define: { "process.env.NODE_ENV": "\"production\"" },
  nodePaths: [path.dirname(path.dirname(fromWeb.resolve("react/package.json")))]
});
const { render } = await import(pathToFileURL(renderer).href) as { render: (text: string) => string };
rmSync(renderer, { force: true });

const markdown = readFileSync(path.join(repoRoot, "docs", "node-install-guide.md"), "utf8");
const [, title = "Crossline 节点安装教程", body = markdown] = /^#\s+(.*)\n([\s\S]*)$/.exec(markdown) ?? [];
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Arial, "Microsoft YaHei", "DengXian", sans-serif; font-size: 11pt; line-height: 1.65; color: #1d1d1b; }
  h1 { font-size: 20pt; margin: 0 0 12pt; }
  h5 { font-size: 14pt; margin: 18pt 0 6pt; break-after: avoid; }
  p, li { margin: 4pt 0; }
  code { font-family: Consolas, monospace; font-size: 10pt; background: #f1efe9; padding: 0 3pt; border-radius: 3pt; }
  a { color: #1d1d1b; word-break: break-all; }
</style></head><body><h1>${title}</h1>${render(body)}</body></html>`;

// Playwright's own Chromium when installed (`pnpm exec playwright install chromium`), else the Edge every Windows has.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  writeFileSync(pdf, await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
} finally {
  await browser.close();
}
// GitHub replaces non-ASCII letters in release asset names, so the release carries this copy (docs/compute-node.md 「发布」).
copyFileSync(pdf, path.join(out, "Crossline-Node-Guide.pdf"));
const pages = (readFileSync(pdf, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(JSON.stringify({ pdf, kilobytes: Math.round(readFileSync(pdf).length / 1024), pages }));

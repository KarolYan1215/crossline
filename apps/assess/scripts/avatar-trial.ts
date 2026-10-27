/**
 * A trial of the personal figures before the public assess goes out (asked 2026-10-15): eight made-up people with varied appearance,
 * each drawn from their type's template through the same model, prompt and seed rule the server uses (`apps/assess/server/avatar/`),
 * then laid out as one contact sheet — template on the left, the person's figure on the right, the appearance under it — for the owner
 * to approve. Nothing here touches the assess database.
 *
 *   pnpm --filter @crossline/assess exec tsx scripts/avatar-trial.ts [--count 8]
 *
 * Needs `ASSESS_IMAGE_API_KEY` (the SiliconFlow key; `ASSESS_IMAGE_MODEL` / `ASSESS_IMAGE_BASE_URL` as on the server). The lowest
 * SiliconFlow tier allows 2 images a minute, so the calls are spaced 31 seconds apart; a 429 waits as long as the API asks, once.
 * Writes `data/eval/avatar-trial-<time>/` (each figure, and `sheet.png`). Costs about $0.015 an image (Kontext [dev], model page price).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { Appearance } from "../lib/contract";
import { avatarPrompt, seedFor } from "../server/avatar/prompt";
import { ProviderError, imageType, providerFromEnv } from "../server/avatar/provider";
import { templateVariant, templatesDir } from "../server/avatar/templates";

const PEOPLE: Array<{ id: string; code: string; label: string; appearance: Appearance }> = [
  { id: "trial-1", code: "DLWU", label: "架构师 · 女 · 长发 · 眼镜 · 正式 · 「黑色长直发」", appearance: { presentation: "female", hair: "long", glasses: true, skin: "light", style: "smart", note: "黑色长直发" } },
  { id: "trial-2", code: "CLWV", label: "试验家 · 男 · 短发 · 运动", appearance: { presentation: "male", hair: "short", glasses: false, skin: "medium", style: "sporty", note: "" } },
  { id: "trial-3", code: "WUHG", label: "百晓生 · 中性 · 卷发 · 眼镜 · 深肤色 · 文艺 · 「红色毛线帽」", appearance: { presentation: "neutral", hair: "curly", glasses: true, skin: "deep", style: "artsy", note: "红色毛线帽" } },
  { id: "trial-4", code: "CXBU", label: "布道者 · 女 · 扎发 · 休闲 · 「马尾 雀斑」", appearance: { presentation: "female", hair: "tied", glasses: false, skin: "medium", style: "casual", note: "马尾 雀斑" } },
  { id: "trial-5", code: "DLBV", label: "联络官 · 男 · 中长发 · 眼镜 · 正式", appearance: { presentation: "male", hair: "medium", glasses: true, skin: "light", style: "smart", note: "" } },
  { id: "trial-6", code: "CXWV", label: "即兴艺人 · 女 · 短发 · 深肤色 · 文艺 · 「耳环」", appearance: { presentation: "female", hair: "short", glasses: false, skin: "deep", style: "artsy", note: "耳环" } },
  { id: "trial-7", code: "DXWU", label: "创始人 · 男 · 光头 · 休闲 · 「胡子」", appearance: { presentation: "male", hair: "bald", glasses: false, skin: "medium", style: "casual", note: "胡子" } },
  { id: "trial-8", code: "CLBU", label: "讲师 · 中性 · 中长发 · 正式", appearance: { presentation: "neutral", hair: "medium", glasses: false, skin: "light", style: "smart", note: "" } }
];

const args = process.argv.slice(2);
const count = Math.min(PEOPLE.length, Math.max(1, Number(args[args.indexOf("--count") + 1]) || PEOPLE.length));
// `--from N` starts at the Nth person (1-based), to redraw the ones a dropped connection lost.
const from = Math.max(1, Number(args[args.indexOf("--from") + 1]) || 1);
const provider = providerFromEnv();
if (!provider) { console.error("ASSESS_IMAGE_API_KEY is not set"); process.exit(2); }

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const outDir = path.join(repoRoot, "data", "eval", `avatar-trial-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Drawn = { person: (typeof PEOPLE)[number]; template: Buffer; figure?: Buffer; error?: string; seconds: number };
const drawn: Drawn[] = [];
for (const [index, person] of PEOPLE.slice(from - 1, from - 1 + count).entries()) {
  if (index > 0) await sleep(31_000);
  const template = readFileSync(path.join(templatesDir(), `${person.code}-${templateVariant(person.appearance.presentation, person.id)}.png`));
  const input = { reference: template, prompt: avatarPrompt(person.appearance), seed: seedFor(person.id) };
  const started = Date.now();
  let figure: Buffer | undefined;
  let error: string | undefined;
  for (let attempt = 0; attempt < 2 && !figure; attempt += 1) {
    try { figure = await provider.edit(input); error = undefined; }
    catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 200) : "failed";
      if (!(caught instanceof ProviderError && caught.retryable) || attempt === 1) break;
      await sleep(caught.retryAfterMs ?? 30_000);
    }
  }
  if (figure) writeFileSync(path.join(outDir, `${person.id}-${person.code}.${imageType(figure) === "image/jpeg" ? "jpg" : "png"}`), figure);
  drawn.push({ person, template, ...(figure ? { figure } : {}), ...(error ? { error } : {}), seconds: Math.round((Date.now() - started) / 1000) });
  console.info(JSON.stringify({ step: "drawn", id: person.id, code: person.code, ok: Boolean(figure), seconds: drawn.at(-1)!.seconds, ...(error ? { error } : {}) }));
}

// The contact sheet: two columns of pairs; resvg reads PNG and JPEG (a WebP figure is listed but not drawn).
const CELL_W = 260, CELL_H = 390, LABEL_H = 56, GAP = 16, PAIRS_PER_ROW = 2;
const pairWidth = CELL_W * 2 + GAP;
const rows = Math.ceil(drawn.length / PAIRS_PER_ROW);
const width = PAIRS_PER_ROW * pairWidth + (PAIRS_PER_ROW + 1) * GAP * 2;
const height = rows * (CELL_H + LABEL_H + GAP * 2) + GAP * 2;
const dataUri = (bytes: Buffer) => { const type = imageType(bytes); return type === "image/png" || type === "image/jpeg" ? `data:${type};base64,${bytes.toString("base64")}` : undefined; };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cells = drawn.map((item, index) => {
  const x = GAP * 2 + (index % PAIRS_PER_ROW) * (pairWidth + GAP * 2);
  const y = GAP * 2 + Math.floor(index / PAIRS_PER_ROW) * (CELL_H + LABEL_H + GAP * 2);
  const template = dataUri(item.template);
  const figure = item.figure ? dataUri(item.figure) : undefined;
  return [
    template ? `<image href="${template}" x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" preserveAspectRatio="xMidYMid meet"/>` : "",
    figure ? `<image href="${figure}" x="${x + CELL_W + GAP}" y="${y}" width="${CELL_W}" height="${CELL_H}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x + CELL_W + GAP}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="#E8E2D6"/><text x="${x + CELL_W + GAP + 12}" y="${y + 30}" font-size="16" fill="#1E1B16">${escape(item.error ?? "无图")}</text>`,
    `<text x="${x}" y="${y + CELL_H + 24}" font-size="17" fill="#1E1B16">${index + 1}. ${escape(item.person.label)}</text>`,
    `<text x="${x}" y="${y + CELL_H + 46}" font-size="14" fill="#4F4A42">左：类型模板　右：按外貌改画（${item.seconds} 秒）</text>`
  ].join("");
}).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#F6F2EA"/>${cells}</svg>`;
const sheet = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Microsoft YaHei" } }).render().asPng();
writeFileSync(path.join(outDir, "sheet.png"), sheet);
console.info(JSON.stringify({ step: "done", dir: outDir, sheet: path.join(outDir, "sheet.png"), ok: drawn.filter((item) => item.figure).length, of: drawn.length }));

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SatoriNode } from "satori";
import { TYPE_CODES } from "@crossline/core/assess-content";
import { ruleLines, wantsPlan, type WantLines } from "@crossline/core/assess-wants";
import { pairRelation, publicType } from "../../lib/public-type";
import { fontsDir } from "./fonts";
import { ROAMER, samplePair, samplePoster } from "./fixtures";
import { renderPairCard, renderTypePoster } from "./index";
import { posterEnglishText, posterLabels } from "./labels";
import { HEIGHT, WIDTH, longImageTree, pairCardTree, toPng, typePosterTree } from "./render";

/**
 * The posters in English (docs/i18n.md): each reader sees their own language, so the English poster must hold its layout — English runs
 * longer — and print every character (the subset fonts carry ASCII; the English copy uses nothing else).
 */
let dir: string;
const previous = process.env.ASSESS_DATA_DIR;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "assess-poster-en-"));
  process.env.ASSESS_DATA_DIR = path.join(dir, "data");
});
afterAll(() => {
  if (previous === undefined) delete process.env.ASSESS_DATA_DIR; else process.env.ASSESS_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const scoresFor = (code: string) => ({ scope: code[0] === "G" ? 80 : 20, basis: code[1] === "I" ? 80 : 20, output: code[2] === "R" ? 80 : 20, rhythm: code[3] === "A" ? 80 : 20 });
const URL = "https://assess.example.com/t/x";
const NICKNAME = "Alexandrina M";

function assertClean(nodes: SatoriNode[], height: number, label: string) {
  const texts = nodes.filter((node) => node.textContent?.trim());
  for (const node of texts) {
    const size = Number((node.props.style as Record<string, unknown> | undefined)?.fontSize ?? 0);
    expect(size, `${label}: "${node.textContent}" font size`).toBeGreaterThanOrEqual(24);
    expect(node.left, `${label}: "${node.textContent}" left`).toBeGreaterThanOrEqual(0);
    expect(node.left + node.width, `${label}: "${node.textContent}" right`).toBeLessThanOrEqual(WIDTH);
    expect(node.top + node.height, `${label}: "${node.textContent}" bottom`).toBeLessThanOrEqual(height - 24);
  }
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!, b = texts[j]!;
      const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > 1
        && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 1;
      expect(overlap, `${label}: "${a.textContent}" overlaps "${b.textContent}"`).toBe(false);
    }
  }
}

describe("English posters", () => {
  test("every English string a poster prints is plain ASCII, which both faces hold", () => {
    const sans = new Set(readFileSync(path.join(fontsDir(), "poster-sans.glyphs.txt"), "utf8"));
    const serif = new Set(readFileSync(path.join(fontsDir(), "poster-serif.glyphs.txt"), "utf8"));
    const text = posterEnglishText().join("");
    expect([...new Set(text)].filter((char) => !sans.has(char) || !serif.has(char))).toEqual([]);
    expect(posterLabels("en").kicker).toBe("Thinking style");
  });

  test("every type's poster and long image in English: nothing overlaps, nothing under 24 px, all on the canvas", { timeout: 120_000 }, async () => {
    for (const code of TYPE_CODES) {
      const type = publicType(scoresFor(code), {}, "", undefined, "en");
      const missing: string[] = [];
      const poster = await toPng(typePosterTree(type, NICKNAME, { dataUri: null }, URL, "en"), HEIGHT, { collect: true, onMissing: (segment) => missing.push(segment) });
      assertClean(poster.nodes, HEIGHT, `${code} poster`);
      expect(poster.nodes.some((node) => node.textContent === type.name)).toBe(true);
      const long = await toPng(longImageTree(type, NICKNAME, { dataUri: null }, URL, "en"), undefined, { collect: true, onMissing: (segment) => missing.push(segment) });
      assertClean(long.nodes, long.height, `${code} long`);
      expect(missing).toEqual([]);
    }
  });

  test("English lines from what the person said (rules, a written combination, a model's longest answer) lay out clean", { timeout: 120_000 }, async () => {
    const longest: WantLines = {
      lines: [{ domain: "Twenty character fld", identity: "Twenty two char ident" }, { domain: "AI", identity: "Designer" }, { domain: "", identity: "Developer" }],
      loop: ["Twenty-eight characters long", "Twenty-eight characters long", "Twenty-eight characters long", "Twenty-eight characters long"],
      links: [{ from: 0, to: 1, kind: "提供输入", how: "A sixty character sentence saying what one track gives the nx" },
        { from: 1, to: 2, kind: "促成", how: "Designs feed development" }, { from: 2, to: 0, kind: "反馈回路", how: "Usage data back to the group" }],
      source: "model", locale: "en"
    };
    for (const [code, chosen] of [["GEMA", longest], ["SEMP", ruleLines("SEMP", ["language", "build", "running"], "en")],
      ["GIRA", wantsPlan("GIRA", { picks: ["research", "media", "writing"], text: "" }, "en").lines]] as const) {
      const type = publicType(scoresFor(code), {}, "", chosen, "en");
      const poster = await toPng(typePosterTree(type, NICKNAME, { dataUri: null }, URL, "en"), HEIGHT, { collect: true });
      assertClean(poster.nodes, HEIGHT, `${code} wants poster`);
      const long = await toPng(longImageTree(type, NICKNAME, { dataUri: null }, URL, "en"), undefined, { collect: true });
      assertClean(long.nodes, long.height, `${code} wants long`);
    }
  });

  test("every pair of types in English: the card is clean", { timeout: 300_000 }, async () => {
    for (const a of TYPE_CODES) {
      for (const b of TYPE_CODES) {
        const relation = pairRelation(a, b, undefined, undefined, "en");
        const side = (code: string) => ({ type: publicType(scoresFor(code), {}, "", undefined, "en"), nickname: NICKNAME, figure: { dataUri: null } });
        const card = await toPng(pairCardTree(side(a), side(b), relation.primary, relation.secondary, relation.sharedLines, URL, "en"), HEIGHT, { collect: true });
        assertClean(card.nodes, HEIGHT, `${a}x${b} pair`);
      }
    }
  });

  test("the same poster in two languages is two files, each named with its language", { timeout: 30_000 }, async () => {
    const zh = samplePoster(path.join(dir, "fig"), ROAMER, "Jo", "#8C3709");
    const en = samplePoster(path.join(dir, "fig"), ROAMER, "Jo", "#8C3709", "en");
    const first = await renderTypePoster(zh);
    const second = await renderTypePoster(en);
    expect(first.equals(second)).toBe(false);
    const names = readdirSync(path.join(dir, "data", "posters"));
    expect(names.filter((name) => name.startsWith("type-zh-"))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("type-en-"))).toHaveLength(1);
    await renderPairCard(samplePair(path.join(dir, "fig"), "en"));
    expect(readdirSync(path.join(dir, "data", "posters")).some((name) => name.startsWith("pair-en-"))).toBe(true);
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SatoriNode } from "satori";
import { TYPE_CODES } from "@crossline/core/assess-content";
import { ruleLines, wantsPlan, type WantLines } from "@crossline/core/assess-wants";
import { pairRelation, publicType } from "../../lib/public-type";
import { fontsDir, safe } from "./fonts";
import { PLANNER, ROAMER, samplePair, samplePoster, writeFigure } from "./fixtures";
import { renderLongImage, renderPairCard, renderTypePoster } from "./index";
import { LABELS, posterFixedText } from "./labels";
import { figureFrom, imageMime } from "./figure";
import { HEIGHT, WIDTH, longImageTree, pairCardTree, strongestAxis, toPng, typePosterTree } from "./render";

let dir: string;
const previous = process.env.ASSESS_DATA_DIR;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "assess-poster-"));
  process.env.ASSESS_DATA_DIR = path.join(dir, "data");
});
afterAll(() => {
  if (previous === undefined) delete process.env.ASSESS_DATA_DIR; else process.env.ASSESS_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

/** Width and height from the PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Code (from TYPE_AXES order) to scores that land on it, leaning 30 points either way. */
const scoresFor = (code: string) => ({ lines: code[0] === "D" ? 80 : 20, purpose: code[1] === "X" ? 80 : 20, collab: code[2] === "B" ? 80 : 20, build: code[3] === "V" ? 80 : 20 });

/** Text boxes never overlap, never run off the canvas, and nothing is set under 24 px. */
function assertClean(nodes: SatoriNode[], height: number, label: string) {
  const texts = nodes.filter((node) => node.textContent?.trim());
  expect(texts.length, label).toBeGreaterThan(10);
  for (const node of texts) {
    const size = Number((node.props.style as Record<string, unknown> | undefined)?.fontSize ?? 0);
    expect(size, `${label}: 「${node.textContent}」 font size`).toBeGreaterThanOrEqual(24);
    expect(node.left, `${label}: 「${node.textContent}」 left`).toBeGreaterThanOrEqual(0);
    expect(node.left + node.width, `${label}: 「${node.textContent}」 right`).toBeLessThanOrEqual(WIDTH);
    expect(node.top + node.height, `${label}: 「${node.textContent}」 bottom`).toBeLessThanOrEqual(height - 24);
  }
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!, b = texts[j]!;
      const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > 1
        && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 1;
      expect(overlap, `${label}: 「${a.textContent}」 overlaps 「${b.textContent}」`).toBe(false);
    }
  }
}

describe("rendered PNGs", () => {
  test("the type poster and the pair card are 1080×1440, the long image 1080 wide and taller", { timeout: 30_000 }, async () => {
    const input = samplePoster(path.join(dir, "fig"), PLANNER, "小林", "#085E3A");
    expect(pngSize(await renderTypePoster(input))).toEqual({ width: 1080, height: 1440 });
    const long = pngSize(await renderLongImage(input));
    expect(long.width).toBe(1080);
    expect(long.height).toBeGreaterThan(1440);
    expect(pngSize(await renderPairCard(samplePair(path.join(dir, "fig"))))).toEqual({ width: 1080, height: 1440 });
  });

  test("once the fonts are loaded, a poster nobody asked for before draws in under 1.5 s", { timeout: 30_000 }, async () => {
    const input = samplePoster(path.join(dir, "fig"), ROAMER, "计时", "#8C3709");
    for (const render of [renderTypePoster, renderLongImage]) {
      const started = performance.now();
      await render(input);
      expect(performance.now() - started).toBeLessThan(1_500);
    }
  });

  test("a poster is drawn once and read back; a new figure draws it again", { timeout: 30_000 }, async () => {
    const input = samplePoster(path.join(dir, "fig-cache"), ROAMER, "阿乔", "#8C3709");
    const first = await renderTypePoster(input);
    const cached = readdirSync(path.join(dir, "data", "posters")).filter((name) => name.startsWith("type-"));
    const started = Date.now();
    expect((await renderTypePoster(input)).equals(first)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
    writeFigure(path.dirname(input.avatarPath), path.basename(input.avatarPath, ".png"), "#0A5198");
    await renderTypePoster(input);
    expect(readdirSync(path.join(dir, "data", "posters")).filter((name) => name.startsWith("type-")).length).toBe(cached.length + 1);
  });

  test("a missing figure file still renders, with the code on the disc", { timeout: 30_000 }, async () => {
    const input = { ...samplePoster(path.join(dir, "fig"), PLANNER, "", "#085E3A"), avatarPath: path.join(dir, "absent.png") };
    expect(pngSize(await renderTypePoster(input))).toEqual({ width: 1080, height: 1440 });
  });
});

describe("figures", () => {
  // The smallest baseline JPEG (1×1 grey), as an image model might send back under a .png name.
  const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

  test("the file type is read off its first bytes, not its name", () => {
    expect(imageMime(readFileSync(writeFigure(path.join(dir, "fig-mime"), "png", "#085E3A")))).toBe("image/png");
    expect(imageMime(JPEG)).toBe("image/jpeg");
    expect(imageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBeNull();
  });

  test("a JPEG saved as .png is embedded as JPEG; anything else, or no drawn figure, is the code tile — never the template", { timeout: 30_000 }, async () => {
    const jpeg = path.join(dir, "drawn-jpeg.png");
    writeFileSync(jpeg, JPEG);
    expect(figureFrom(jpeg).dataUri).toMatch(/^data:image\/jpeg;base64,/);
    const input = samplePoster(path.join(dir, "fig"), PLANNER, "小林", "#085E3A");
    expect(pngSize(await renderTypePoster({ ...input, avatarPath: jpeg }))).toEqual({ width: 1080, height: 1440 });
    const webp = path.join(dir, "drawn-webp.png");
    writeFileSync(webp, Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"));
    expect(figureFrom(webp).dataUri).toBeNull();
    expect(figureFrom("").dataUri).toBeNull();
    expect(figureFrom(path.join(dir, "missing.png")).dataUri).toBeNull();
    // The code tile still makes a whole poster.
    expect(pngSize(await renderTypePoster({ ...input, avatarPath: "" }))).toEqual({ width: 1080, height: 1440 });
  });
});

describe("fonts", () => {
  test("every fixed string is in both glyph lists, and the lists are what the script last wrote", () => {
    const fixed = posterFixedText();
    const sans = new Set(readFileSync(path.join(fontsDir(), "poster-sans.glyphs.txt"), "utf8"));
    const serif = readFileSync(path.join(fontsDir(), "poster-serif.glyphs.txt"), "utf8");
    expect(serif, "rerun scripts/assess-poster-fonts.ts").toBe(fixed);
    expect([...fixed].filter((char) => !sans.has(char))).toEqual([]);
    // GB2312 level 1 (3,755) on top of the fixed text, for nicknames.
    expect(sans.size).toBeGreaterThan(3755);
  });

  test("the subset fonts really hold every glyph their lists claim", { timeout: 60_000 }, async () => {
    const missing: string[] = [];
    for (const family of ["Sans", "Serif"] as const) {
      const glyphs = readFileSync(path.join(fontsDir(), `poster-${family.toLowerCase()}.glyphs.txt`), "utf8").replace(/\s/g, "");
      const chunks = glyphs.match(/[\s\S]{1,60}/gu) ?? [];
      for (const weight of [400, 700]) {
        const tree = { type: "div", props: { style: { display: "flex", flexDirection: "column", width: WIDTH, fontFamily: family, fontWeight: weight, fontSize: 24 },
          children: chunks.map((chunk) => ({ type: "div", props: { style: { display: "flex" }, children: chunk } })) } };
        await toPng(tree as never, undefined, { onMissing: (segment) => missing.push(`${family} ${weight}: ${segment}`) });
      }
    }
    expect(missing).toEqual([]);
  });

  test("a character outside the subset is printed as 「·」, never dropped", { timeout: 30_000 }, async () => {
    expect(safe("阿乔🙂龘x", "Sans")).toBe("阿乔··x");
    const input = samplePoster(path.join(dir, "fig"), PLANNER, "阿乔🙂龘", "#085E3A");
    const missing: string[] = [];
    const rendered = await toPng(typePosterTree(input.type, input.nickname, figureFrom(input.avatarPath), input.inviteUrl), HEIGHT,
      { collect: true, onMissing: (segment) => missing.push(segment) });
    expect(missing).toEqual([]);
    expect(rendered.nodes.some((node) => node.textContent === "阿乔··的超级个体类型")).toBe(true);
  });
});

test("the poster's one rank line is the clearest lean, never an ambiguous axis while a clear one exists", () => {
  const type = publicType({ lines: 52, purpose: 18, collab: 70, build: 45 });
  expect(strongestAxis(type).id).toBe("purpose");
  expect(strongestAxis(publicType({ lines: 55, purpose: 45, collab: 61, build: 50 })).id).toBe("collab");
});

describe("layout", () => {
  test("every type's poster and long image: nothing overlaps, nothing under 24 px, all on the canvas", { timeout: 120_000 }, async () => {
    for (const code of TYPE_CODES) {
      const type = publicType(scoresFor(code));
      const nickname = "名字最长有十二个字的朋友";
      const poster = await toPng(typePosterTree(type, nickname, { dataUri: null }, "https://assess.example.com/t/x"), HEIGHT, { collect: true });
      assertClean(poster.nodes, HEIGHT, `${code} poster`);
      const long = await toPng(longImageTree(type, nickname, { dataUri: null }, "https://assess.example.com/t/x"), undefined, { collect: true });
      assertClean(long.nodes, long.height, `${code} long`);
    }
  });

  test("lines from what the person said (rules, a written combination, a model's longest answer) lay out clean, with no missing glyph", { timeout: 120_000 }, async () => {
    const longest: WantLines = {
      lines: [{ domain: "七个字的领域名", identity: "社群主理人" }, { domain: "人工智能", identity: "设计师" }, { domain: "", identity: "开发者" }],
      loop: ["十个字的第一步产出物", "十个字的第二步做成什", "十个字的第三步卖成什", "用户需求回到这条主线"],
      links: [{ from: 0, to: 1, kind: "提供输入", how: "二十四个字的一句话说清前一条线给了后一条线什么东西" },
        { from: 1, to: 2, kind: "促成", how: "设计作品成为开发的素材" }, { from: 2, to: 0, kind: "反馈回路", how: "使用数据回到社群" }],
      source: "model"
    };
    for (const [code, chosen] of [["ROHG", longest], ["ROBA", ruleLines("ROBA", ["language", "collab", "running"])],
      ["WUHG", wantsPlan("WUHG", { picks: ["research", "media", "writing"], text: "" }).lines]] as const) {
      const type = publicType(scoresFor(code), {}, "", chosen);
      const missing: string[] = [];
      const poster = await toPng(typePosterTree(type, "小林", { dataUri: null }, "https://assess.example.com/t/x"), HEIGHT,
        { collect: true, onMissing: (segment) => missing.push(segment) });
      assertClean(poster.nodes, HEIGHT, `${code} wants poster`);
      const long = await toPng(longImageTree(type, "小林", { dataUri: null }, "https://assess.example.com/t/x"), undefined,
        { collect: true, onMissing: (segment) => missing.push(segment) });
      assertClean(long.nodes, long.height, `${code} wants long`);
      expect(missing).toEqual([]);
      // The poster no longer prints the lines (2026-10-24); the long image does.
      expect(long.nodes.some((node) => node.textContent === chosen.lines[0].identity)).toBe(true);
      expect(long.nodes.some((node) => node.textContent === LABELS.moreHeading)).toBe(false);
    }
  });

  test("every pair of types: the card is clean", { timeout: 300_000 }, async () => {
    for (const a of TYPE_CODES) {
      for (const b of TYPE_CODES) {
        const relation = pairRelation(a, b);
        const side = (code: string) => ({ type: publicType(scoresFor(code)), nickname: "名字最长有十二个字的朋友", figure: { dataUri: null } });
        const card = await toPng(pairCardTree(side(a), side(b), relation.primary, relation.secondary, relation.sharedLines, "https://assess.example.com/t/x"), HEIGHT, { collect: true });
        assertClean(card.nodes, HEIGHT, `${a}×${b} pair`);
      }
    }
  });

  // POSTER_SAMPLES_DIR=… writes two contrasting posters, their long images and their pair card, to look at.
  test.runIf(Boolean(process.env.POSTER_SAMPLES_DIR))("samples", { timeout: 60_000 }, async () => {
    const out = process.env.POSTER_SAMPLES_DIR!;
    for (const [scores, nickname, shirt] of [[PLANNER, "小林", "#085E3A"], [ROAMER, "阿乔的名字很长很长很长", "#8C3709"]] as const) {
      const input = samplePoster(path.join(out, "fig"), scores, nickname, shirt);
      writeFileSync(path.join(out, `type-${input.type.code}.png`), await renderTypePoster(input));
      writeFileSync(path.join(out, `long-${input.type.code}.png`), await renderLongImage(input));
    }
    writeFileSync(path.join(out, "pair.png"), await renderPairCard(samplePair(path.join(out, "fig"))));
  });
});

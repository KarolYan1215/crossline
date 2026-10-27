/**
 * Promotion samples: the type poster of all sixteen types and two pair cards, drawn by the same renderer the server uses, from the type templates
 * (what a person gets without an image key), into `data/samples/` (ignored by git). The QR code points at `ASSESS_BASE_URL` (default a
 * placeholder), so set it to the public address before drawing images that will be posted:
 *
 *   ASSESS_BASE_URL=https://… pnpm --filter @crossline/assess exec tsx scripts/poster-samples.ts
 */
import fs from "node:fs";
import path from "node:path";
import { TYPE_CODES } from "@crossline/core/assess-content";
import { pairRelation, publicType } from "../lib/public-type";
import { templateImagePath } from "../server/avatar";
import { renderPairCard, renderTypePoster } from "../server/poster";

const base = (process.env.ASSESS_BASE_URL ?? "https://crossline.example").replace(/\/+$/, "");
const invite = `${base}/t/sample`;
const out = path.join(import.meta.dirname, "..", "data", "samples");
fs.mkdirSync(out, { recursive: true });

// Every type, alternating women and men, with scores that land clearly on it. One axis per poster is left near the middle on every
// third type, so the faint letter shows as people will see it.
const NICKNAMES = ["阿木", "Kiki", "小满", "周周", "林一", "Leo", "糖糖", "老陈"];
const SAMPLES = TYPE_CODES.map((code, index) => {
  const lean = (right: boolean, strong: number) => right ? strong : 100 - strong;
  const soft = index % 3 === 0 ? (index / 3) % 4 : -1;
  const strength = (axis: number) => axis === soft ? 57 : 72 + ((index * 7 + axis * 5) % 22);
  return {
    code,
    scores: { collab: lean(code[0] === "W", strength(0)), purpose: lean(code[1] === "U", strength(1)), build: lean(code[2] === "H", strength(2)), lines: lean(code[3] === "G", strength(3)) },
    nickname: NICKNAMES[index % NICKNAMES.length]!,
    variant: index % 2 ? "male" as const : "female" as const
  };
});

for (const [index, sample] of SAMPLES.entries()) {
  const type = publicType(sample.scores, {}, `sample-${index}`, undefined, ["写初稿", "出图", "查资料"].slice(0, 1 + (index % 3)));
  if (type.code !== sample.code) throw new Error(`scores for ${sample.code} landed on ${type.code}`);
  const png = await renderTypePoster({ type, nickname: sample.nickname, avatarPath: templateImagePath(type.code, sample.variant), inviteUrl: invite });
  const file = path.join(out, `poster-${type.code}.png`);
  fs.writeFileSync(file, png);
  console.log(`${file}  ${type.name} ${type.code}`);
}

// Two pair cards: one pair with no line in common, one that shares some.
for (const [codeA, codeB] of [["ROBA", "WUHG"], ["WOHA", "ROHA"]] as const) {
  const a = SAMPLES.find((sample) => sample.code === codeA)!, b = SAMPLES.find((sample) => sample.code === codeB)!;
  const typeA = publicType(a.scores, {}, `pair-${codeA}`), typeB = publicType(b.scores, {}, `pair-${codeB}`);
  const card = await renderPairCard({
    a: { type: typeA, nickname: a.nickname, avatarPath: templateImagePath(typeA.code, a.variant) },
    b: { type: typeB, nickname: b.nickname, avatarPath: templateImagePath(typeB.code, b.variant) },
    ...pairRelation(typeA.code, typeB.code), inviteUrl: invite
  });
  const cardFile = path.join(out, `pair-${typeA.code}-${typeB.code}.png`);
  fs.writeFileSync(cardFile, card);
  console.log(`${cardFile}  ${typeA.name} × ${typeB.name}`);
}

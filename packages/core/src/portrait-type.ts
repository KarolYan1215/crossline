import { SCHWARTZ_VALUES, redactPortrait, type PortraitReport } from "./portrait";

/**
 * Crossline's own personality typing (decided 2026-10-08, after the popular result pages of MBTI-style tests): four axes about how a
 * person runs several lines of work, each scored 0–100 by the portrait writer from evidence, read as a four-letter code into one of
 * sixteen fixed types in four groups. The names live here, not in the model's answer, so the same profile always lands on the same,
 * comparable, shareable type — the model only says where on each axis the person stands and why.
 */
export const CHARACTER_POSES = ["standing confidently", "holding an object up to look at it", "mid-stride, walking forward", "sitting on a simple stool", "arms crossed, relaxed", "gesturing as if explaining"] as const;
export const CHARACTER_EXPRESSIONS = ["calm", "focused", "curious", "cheerful", "determined", "thoughtful"] as const;

export type TypeAxisId = "scope" | "basis" | "output" | "rhythm";
export const TYPE_AXES: Array<{ id: TypeAxisId; left: { letter: string; label: string }; right: { letter: string; label: string }; question: string }> = [
  { id: "scope", left: { letter: "S", label: "深耕" }, right: { letter: "G", label: "跨界" }, question: "注意力集中在一条线做深，还是在几条线之间连起来" },
  { id: "basis", left: { letter: "E", label: "实证" }, right: { letter: "I", label: "直觉" }, question: "做判断靠数据与证据，还是靠感觉与远景" },
  { id: "output", left: { letter: "M", label: "造物" }, right: { letter: "R", label: "传播" }, question: "成就感来自做出东西，还是来自影响他人" },
  { id: "rhythm", left: { letter: "P", label: "规划" }, right: { letter: "A", label: "应变" }, question: "按计划推进，还是边做边调整" }
];

/** The four groups (first two letters), each with its colour — the type card's background and the character's backdrop. */
export const TYPE_GROUPS: Record<string, { name: string; colour: string; tint: string; blurb: string }> = {
  SE: { name: "工匠组", colour: "#085E3A", tint: "#DCEBE3", blurb: "在一处做深，用证据说话" },
  SI: { name: "求索组", colour: "#792E9C", tint: "#EADDF1", blurb: "在一处做深，跟随内在的问题" },
  GE: { name: "架构组", colour: "#0A5198", tint: "#DAE6F2", blurb: "连接多条线，用证据搭结构" },
  GI: { name: "开拓组", colour: "#8C3709", tint: "#F1E0D5", blurb: "连接多条线，凭远景开新路" }
};

/** Sixteen types: name and one line each. Written once, the same for everyone. */
export const TYPE_TABLE: Record<string, { name: string; blurb: string }> = {
  SEMP: { name: "精密工匠", blurb: "按计划把一件事做到经得起检验" },
  SEMA: { name: "实验能手", blurb: "在一个领域里快速试错、用结果说话" },
  SERP: { name: "严谨讲师", blurb: "把深厚的专业讲清楚、讲成体系" },
  SERA: { name: "证据讲述者", blurb: "随时用扎实的证据回应他人的问题" },
  SIMP: { name: "专注造物者", blurb: "为一个心中的问题长期打磨作品" },
  SIMA: { name: "灵感工匠", blurb: "沿着好奇心在一个领域里不断做出新东西" },
  SIRP: { name: "深度布道者", blurb: "把一个信念长期、系统地讲给更多人" },
  SIRA: { name: "自由探索者", blurb: "在一个领域里追问，并随时分享所得" },
  GEMP: { name: "系统架构师", blurb: "把几条线按证据组织成一个系统" },
  GEMA: { name: "跨界建造者", blurb: "把不同领域的东西拼成能用的产品" },
  GERP: { name: "策略整合者", blurb: "梳理多方信息，提出并推行方案" },
  GERA: { name: "证据型连接者", blurb: "在不同圈子之间用证据牵线搭桥" },
  GIMP: { name: "远景创业者", blurb: "凭远景规划，把多条线汇成一项事业" },
  GIMA: { name: "多面发明家", blurb: "在多个领域间跳跃，不断造出新东西" },
  GIRP: { name: "愿景传播者", blurb: "描绘一个跨领域的愿景，并带动他人" },
  GIRA: { name: "跨界开拓者", blurb: "在多个领域开路，并把所见带给别人" }
};

export type PortraitType = {
  code: string; name: string; blurb: string;
  group: { key: string; name: string; colour: string; tint: string; blurb: string };
  /** Per axis: the side the person leans to and how far (50–100%), for the bars. */
  axes: Array<{ id: TypeAxisId; left: string; right: string; score: number; letter: string; label: string; percent: number; evidence: string }>;
};

/** The person's type from the writer's axis scores (0 = left pole, 100 = right pole); none for a report written before the axes existed. */
export function portraitType(report: PortraitReport): PortraitType | null {
  const type = report.type;
  if (!type) return null;
  const axes = TYPE_AXES.map((axis) => {
    const score = Math.max(0, Math.min(100, Math.round(type[axis.id])));
    const right = score >= 50;
    const side = right ? axis.right : axis.left;
    return { id: axis.id, left: axis.left.label, right: axis.right.label, score, letter: side.letter, label: side.label,
      percent: right ? score : 100 - score, evidence: type.evidence[axis.id] ?? "" };
  });
  const code = axes.map((axis) => axis.letter).join("");
  const groupKey = code.slice(0, 2);
  return { code, ...TYPE_TABLE[code]!, group: { key: groupKey, ...TYPE_GROUPS[groupKey]! }, axes };
}

export type PortraitLabelCell = { title: string; value: string; detail?: string };
export type PortraitIdentity = { lineId: string; label: string; target: number; now: number | null };

/**
 * The poster's labels (decided 2026-10-12), each computed or taken from a fixed field so two people's posters compare: the core word
 * the writer gave, the top-scoring Schwartz value (ties go to the earlier one in the circle), the line with the largest suggested share
 * as the base, and every other line as an identity row — suggested share as a bar, current share as a marker. A cell whose source is
 * missing (an older report) is left out.
 */
export function portraitLabels(report: PortraitReport, options: { lineLabel: (id: string) => string }): { cells: PortraitLabelCell[]; identities: PortraitIdentity[] } {
  const cells: PortraitLabelCell[] = [];
  const coreWord = report.cover.coreWord?.trim();
  if (coreWord) cells.push({ title: "核心词", value: coreWord });
  const values = report.compass.values ?? [];
  const names = SCHWARTZ_VALUES.map((value) => value.name as string);
  if (values.length === names.length && names.every((name) => values.some((value) => value.name === name))) {
    const top = names.map((name) => values.find((value) => value.name === name)!).reduce((best, value) => (value.score > best.score ? value : best));
    cells.push({ title: "价值核心", value: top.name });
  }
  const ranked = [...report.lines.items].sort((a, b) => (b.targetShare ?? 0) - (a.targetShare ?? 0));
  const base = ranked[0];
  if (base?.targetShare) cells.push({ title: "建议底座", value: options.lineLabel(base.lineId), detail: `建议投入约 ${base.targetShare}%` });
  const identities = ranked.slice(base?.targetShare ? 1 : 0).map((item) => ({ lineId: item.lineId, label: options.lineLabel(item.lineId), target: item.targetShare ?? 0, now: item.share ?? null }));
  return { cells, identities };
}

/**
 * The character standard (decided 2026-10-08): every person's figure is drawn in one fixed style — like the sixteen figures of a
 * personality test, recognisably a family — and only what the portrait says about this person varies: the outfit (in their base line's
 * colour), up to three props, the pose and the expression, on their type group's backdrop. The figure is gender-neutral and never a
 * likeness of anyone; no text, numbers or logos anywhere, so the picture can be shared.
 */
export const CHARACTER_STANDARD = [
  "Full-body stylized cartoon character in the style of modern personality-test avatars: flat vector shapes with soft faceted (low-poly inspired) shading, clean geometric silhouette.",
  "Proportions about five heads tall, three-quarter view, standing on a soft ground shadow, centered, the figure filling about 75% of the height.",
  "Simplified face: small dot eyes, a small mouth, no nose detail; simple neat hairstyle; gender-neutral, not a likeness of any real person.",
  "Exactly one main outfit colour and one accent colour; props drawn simply and clearly readable at small size.",
  "Plain backdrop: flat warm off-white (#F3EFE6) with one large soft circle behind the figure in the group tint.",
  "Absolutely no text, letters, numbers, logos or brand marks anywhere. Square 1:1 frame."
].join(" ");

const LINE_COLOUR_NAME: Record<string, string> = { research: "deep blue (#0A5198)", startup: "burnt orange (#8C3709)", media: "plum (#792E9C)", investment: "forest green (#085E3A)", health: "ochre (#664E00)" };

/** The one image prompt for the person's figure: the standard, their group's backdrop, and the writer's redacted choices. */
export function characterPrompt(report: PortraitReport): string | null {
  const type = portraitType(report);
  const character = redactPortrait(report).character;
  if (!type || !character) return null;
  const base = [...report.lines.items].sort((a, b) => (b.targetShare ?? b.share ?? 0) - (a.targetShare ?? a.share ?? 0))[0]?.lineId ?? "";
  const outfitColour = LINE_COLOUR_NAME[base] ?? "near-black";
  const accent = Object.entries(LINE_COLOUR_NAME).find(([id]) => id !== base && report.lines.items.some((item) => item.lineId === id))?.[1] ?? "white";
  return [CHARACTER_STANDARD,
    `Group tint for the circle: ${type.group.tint}.`,
    `Outfit: ${character.outfit.trim()}, main colour ${outfitColour}, accent ${accent}.`,
    character.props.length ? `Holding or carrying: ${character.props.map((prop) => prop.trim()).join(", ")}.` : "",
    `Pose: ${character.pose}. Expression: ${character.expression}.`
  ].filter(Boolean).join(" ");
}

import { TYPE_AXES, TYPE_TABLE, typeFromScores, type TypeAxisId } from "@crossline/core/assess";
import { TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, partnersOf, relationOf, type Relation } from "@crossline/core/assess-content";
import type { WantLines } from "@crossline/core/assess-wants";
import type { LineView, PartnerView, PublicType, RelationView } from "./contract";

/**
 * The public face of a result, built from its four axis scores alone (and, for the rank, the recorded scores of everyone so far, and
 * `seed` — the result's id — which picks a capped rank's shown number, so every view of one result agrees):
 * the views the result page, the invitation, the pair card and the poster all draw from. Pure.
 */
export function publicType(scores: Record<TypeAxisId, number>, recorded: Partial<Record<TypeAxisId, number[]>> = {}, seed = "", chosen?: WantLines): PublicType {
  const type = typeFromScores(scores);
  const partners = partnersOf(type.code);
  const partner = (side: { code: string; relation: Relation }): PartnerView =>
    ({ code: side.code, name: TYPE_TABLE[side.code]!.name, relation: side.relation.name, tip: side.relation.tips[0] });
  return {
    code: type.code, name: type.name, subtitle: TYPE_SUBTITLE[type.code]!,
    group: { key: type.group.key, name: type.group.name, colour: type.group.colour, tint: type.group.tint },
    axes: TYPE_AXES.map((axis, index) => {
      const shown = type.axes[index]!;
      return { id: axis.id, leftLetter: axis.left.letter, rightLetter: axis.right.letter, leftLabel: axis.left.label, rightLabel: axis.right.label,
        leftEn: axis.left.en, rightEn: axis.right.en, score: shown.score, letter: shown.letter, ambiguous: isAmbiguous(shown.score),
        rank: axisRank(axis.id, shown.score, recorded[axis.id] ?? [], seed) };
    }),
    // What the person said they want to do replaces the type's own suggestion, and the extra combinations with it.
    lines: chosen?.lines ?? TYPE_LINES[type.code]!.lines,
    loop: chosen?.loop ?? TYPE_LINES[type.code]!.loop,
    more: chosen ? [] : TYPE_LINES[type.code]!.more,
    linesFrom: chosen?.source ?? "type",
    links: chosen ? chosen.links.map((link) => ({ ...link })) : [],
    best: partner(partners.best),
    hardest: partner(partners.hardest)
  };
}

const relationView = (relation: Relation): RelationView => ({ name: relation.name, when: relation.when, tips: relation.tips });

/**
 * What two people's card says about them: the main and second relation, and the identities both people's lines share — the lines each
 * said they want when they did, else their types' suggestions.
 */
export function pairRelation(a: string, b: string, linesA?: LineView[], linesB?: LineView[]): { primary: RelationView; secondary?: RelationView; sharedLines: string[] } {
  const { primary, secondary } = relationOf(a, b);
  const other = new Set((linesB ?? TYPE_LINES[b]!.lines).map((line) => line.identity));
  return { primary: relationView(primary), ...(secondary ? { secondary: relationView(secondary) } : {}),
    sharedLines: (linesA ?? TYPE_LINES[a]!.lines).map((line) => line.identity).filter((identity) => other.has(identity)) };
}

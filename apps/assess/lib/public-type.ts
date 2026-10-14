import { TYPE_AXES, TYPE_TABLE, typeFromScores, type TypeAxisId } from "@crossline/core/assess";
import { TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, partnersOf, relationOf, type Relation } from "@crossline/core/assess-content";
import type { PartnerView, PublicType, RelationView } from "./contract";

/**
 * The public face of a result, built from its four axis scores alone (and, for the rank, the recorded scores of everyone so far):
 * the views the result page, the invitation, the pair card and the poster all draw from. Pure.
 */
export function publicType(scores: Record<TypeAxisId, number>, recorded: Partial<Record<TypeAxisId, number[]>> = {}): PublicType {
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
        rank: axisRank(axis.id, shown.score, recorded[axis.id] ?? []) };
    }),
    lines: TYPE_LINES[type.code]!.lines,
    loop: TYPE_LINES[type.code]!.loop,
    best: partner(partners.best),
    hardest: partner(partners.hardest)
  };
}

const relationView = (relation: Relation): RelationView => ({ name: relation.name, when: relation.when, tips: relation.tips });

/** What two people's card says about them: the main and second relation, and the lines both types suit. */
export function pairRelation(a: string, b: string): { primary: RelationView; secondary?: RelationView; sharedLines: string[] } {
  const { primary, secondary } = relationOf(a, b);
  const other = new Set(TYPE_LINES[b]!.lines);
  return { primary: relationView(primary), ...(secondary ? { secondary: relationView(secondary) } : {}),
    sharedLines: TYPE_LINES[a]!.lines.filter((line) => other.has(line)) };
}

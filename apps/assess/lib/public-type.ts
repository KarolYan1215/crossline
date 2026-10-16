import { TYPE_AXES, TYPE_TABLE, typeFromScores, type TypeAxisId } from "@crossline/core/assess";
import { TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, localizeLine, localizeRelation, partnersOf, relationOf, type LineIdentity, type Relation } from "@crossline/core/assess-content";
import type { WantLines } from "@crossline/core/assess-wants";
import type { LineView, PartnerView, PublicType, RelationView } from "./contract";
import { tFor, type Locale } from "./i18n";

/**
 * The public face of a result, built from its four axis scores alone (and, for the rank, the recorded scores of everyone so far, and
 * `seed` — the result's id — which picks a capped rank's shown number, so every view of one result agrees):
 * the views the result page, the invitation, the pair card and the poster all draw from. Pure.
 *
 * Built in the reader's language (`locale`, Chinese by default): the type tables are translated here, so the pages and the posters
 * only print what they get. Lines from what the person said (`chosen`) are already in a language — the rules' and written
 * combinations' in the one they were made for (`views.ts` remakes them for another reader), a model's in the one it wrote — and only
 * their relation kinds, kept as Chinese labels, are translated.
 */
export function publicType(scores: Record<TypeAxisId, number>, recorded: Partial<Record<TypeAxisId, number[]>> = {}, seed = "", chosen?: WantLines,
  locale?: Locale): PublicType {
  const t = tFor(locale);
  const type = typeFromScores(scores);
  const partners = partnersOf(type.code);
  const partner = (side: { code: string; relation: Relation }): PartnerView => {
    const relation = localizeRelation(side.relation, locale);
    return { code: side.code, name: t(TYPE_TABLE[side.code]!.name), relation: relation.name, tip: relation.tips[0] };
  };
  const own = TYPE_LINES[type.code]!;
  const lines = (combo: LineIdentity[]) => combo.map((line) => localizeLine(line, locale)) as [LineView, LineView, LineView];
  return {
    code: type.code, name: t(type.name), subtitle: t(TYPE_SUBTITLE[type.code]!),
    group: { key: type.group.key, name: t(type.group.name), colour: type.group.colour, tint: type.group.tint },
    axes: TYPE_AXES.map((axis, index) => {
      const shown = type.axes[index]!;
      const rank = axisRank(axis.id, shown.score, recorded[axis.id] ?? [], seed);
      return { id: axis.id, leftLetter: axis.left.letter, rightLetter: axis.right.letter, leftLabel: t(axis.left.label), rightLabel: t(axis.right.label),
        leftEn: axis.left.en, rightEn: axis.right.en, score: shown.score, letter: shown.letter, ambiguous: isAmbiguous(shown.score),
        rank: { ...rank, pole: t(rank.pole) } };
    }),
    // What the person said they want to do replaces the type's own suggestion, and the extra combinations with it.
    lines: chosen?.lines ?? lines(own.lines),
    loop: chosen?.loop ?? own.loop.map((step) => t(step)) as PublicType["loop"],
    more: chosen ? [] : own.more.map(lines),
    linesFrom: chosen?.source ?? "type",
    links: chosen ? chosen.links.map((link) => ({ ...link, kind: t(link.kind) })) : [],
    best: partner(partners.best),
    hardest: partner(partners.hardest)
  };
}

const relationView = (relation: Relation, locale?: Locale): RelationView => {
  const shown = localizeRelation(relation, locale);
  return { name: shown.name, when: shown.when, tips: shown.tips };
};

/**
 * What two people's card says about them: the main and second relation, and the identities both people's lines share — the lines each
 * said they want when they did, else their types' suggestions. Lines passed in are compared as they are (both in the reader's language).
 */
export function pairRelation(a: string, b: string, linesA?: LineView[], linesB?: LineView[], locale?: Locale): { primary: RelationView; secondary?: RelationView; sharedLines: string[] } {
  const { primary, secondary } = relationOf(a, b);
  const typeLines = (code: string) => TYPE_LINES[code]!.lines.map((line) => localizeLine(line, locale));
  const other = new Set((linesB ?? typeLines(b)).map((line) => line.identity));
  return { primary: relationView(primary, locale), ...(secondary ? { secondary: relationView(secondary, locale) } : {}),
    sharedLines: (linesA ?? typeLines(a)).map((line) => line.identity).filter((identity) => other.has(identity)) };
}

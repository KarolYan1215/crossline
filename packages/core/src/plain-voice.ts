/**
 * Counts of the writing patterns that make a reply read as machine-made (2026-10-18), for measuring models and prompts, never for
 * rejecting an answer: Wikipedia's 「Signs of AI writing」 (negative parallelism, em dashes) and the Chinese humanizer checklists
 * (破折号当万能连接, 「不是 X，而是 Y」, 格言与伪深度, 起跑式铺垫), plus the shapes counted in six candidates' sample interviews.
 * A single hit proves nothing; a model or prompt is compared by hits per thousand characters over many replies.
 */
export const PLAIN_VOICE_PATTERNS = {
  dash: /——|—|(?<=\p{Script=Han}) ?– ?(?=\p{Script=Han})/gu,
  contrast: /不是[^。！？\n]{0,30}?(?:而是|，是|——是)|而不是|并非|不在于|与其[^。！？\n]{0,20}?不如|不只是?[^。！？\n]{0,20}?(?:更|还)|真正(?:的|卡住|吃掉|待定|的问题)/gu,
  // 「理清」 not inside a word that only contains the two characters (办理清单, 整理清单, 处理清楚).
  formula: /先别|别急着|先不急|算清|(?<![办整处管清])理清|看清|量出来|落地|才是关键|关键在于/gu,
  // 「杠杆」 as a figure (撬动、杠杆效应、当杠杆), not the statistics term (杠杆值、残差-杠杆图) or a broker's margin.
  metaphor: /地基|双刃剑|滋养|土壤|燃料|撬动|杠杆效应|当杠杆|飞轮|天花板|护城河|底色|找缝|三笔账|锚点|碎片化|站得最稳|全速/gu,
  aphorism: /说明你|这说明|意味着|本质上|藏着/gu
} as const;
export type PlainVoiceMarker = keyof typeof PLAIN_VOICE_PATTERNS;

/** Hits per pattern, plus whether the text opens by repeating the person back (「你把……」「你说……」). */
export function plainVoiceMarkers(text: string): Record<PlainVoiceMarker | "echoOpening", number> {
  const counts = Object.fromEntries(Object.entries(PLAIN_VOICE_PATTERNS).map(([key, pattern]) => [key, text.match(pattern)?.length ?? 0])) as
    Record<PlainVoiceMarker, number>;
  return { ...counts, echoOpening: /^(?:你把|你说|你已经|你一口气)/u.test(text.trim()) ? 1 : 0 };
}

/** All hits per thousand characters: the one number two models or two prompts are compared by. */
export function plainVoiceRate(text: string): number {
  const length = [...text].length;
  if (!length) return 0;
  const hits = Object.values(plainVoiceMarkers(text)).reduce((sum, value) => sum + value, 0);
  return Math.round((hits * 1000 / length) * 10) / 10;
}

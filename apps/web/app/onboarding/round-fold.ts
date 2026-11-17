import type { AssistantTurn, Message } from "./onboarding-types";

/**
 * Past rounds fold (2026-11-10, the owner: one-shot cards vanish once done, what is reused stays, every step undoable): every round before
 * the latest becomes one line 「第 N 轮 · 一句话摘要」 that opens to the whole round (the questions' reply and what the person answered).
 * The latest round and anything after it (a reply on its way) stay open. An observation on a past round that is still unrated stays
 * outside its fold until it is rated, then folds with its round.
 */
export type ThreadItem =
  | { kind: "message"; message: Message }
  | { kind: "fold"; key: string; round: number; summary: string; messages: Message[]; unratedInsight?: Message };

/** The reply's first sentence, cut to a line. */
export function roundSummary(reply: string, max = 40): string {
  const first = reply.replace(/\s+/g, " ").trim().split(/(?<=[。！？!?；;])\s*|\s(?=[-•])/)[0]?.trim() ?? "";
  const chars = [...first];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : first;
}

/** A round's observation cards, first to last (2026-11-14: cards ready together come in one round). */
export const cardsOf = (turn: AssistantTurn | undefined) => [turn?.insight, ...(turn?.moreInsights ?? [])]
  .filter((card): card is NonNullable<AssistantTurn["insight"]> => Boolean(card?.text));

/** `rated(seq, index)`: whether the round's card `index` (0 the first) has a rating. */
export function foldThread(messages: Message[], rated: (seq: number, index: number) => boolean): ThreadItem[] {
  const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
  if (lastAssistant <= 0) return messages.map((message) => ({ kind: "message", message }));
  const items: ThreadItem[] = [];
  let round = 0;
  let index = 0;
  // What the person wrote before the first round (the opening card's reply).
  const lead: Message[] = [];
  while (index < lastAssistant && messages[index]!.role === "user") lead.push(messages[index++]!);
  if (lead.length) items.push({ kind: "fold", key: `lead-${lead[0]!.seq}`, round: 0, summary: roundSummary(String((lead[0]!.content as { text?: string }).text ?? "")), messages: lead });
  while (index < lastAssistant) {
    const turn = messages[index]!;
    const group: Message[] = [turn];
    index++;
    while (index < lastAssistant && messages[index]!.role === "user") group.push(messages[index++]!);
    round++;
    const content = turn.content as AssistantTurn;
    const insightOpen = cardsOf(content).some((_card, card) => !rated(turn.seq, card));
    items.push({ kind: "fold", key: `round-${turn.seq}`, round, summary: roundSummary(content.reply ?? ""), messages: group,
      ...(insightOpen ? { unratedInsight: turn } : {}) });
  }
  for (; index < messages.length; index++) items.push({ kind: "message", message: messages[index]! });
  return items;
}

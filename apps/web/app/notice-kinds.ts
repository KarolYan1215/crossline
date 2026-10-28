/**
 * Which of the system's own messages ask the person something (2026-10-27, the owner: 「区分提醒和任务，不需要用户输入的提醒放到右上角一个提醒按钮」).
 * These stay with the 小帮手 and 待决事项, where they are answered; every other message is a reminder (提醒): read once in the bell at the
 * top right and needs nothing more. The day's opener is neither: it is Today's head.
 */
export const INPUT_NUDGE_KINDS: ReadonlySet<string> = new Set([
  "block_confirm", "day_wrap", "energy_check", "outcome_check", "progress_check", "agent_question", "opener"
]);

export const isReminderKind = (kind: string | undefined): boolean => !INPUT_NUDGE_KINDS.has(kind ?? "");

export type NoticeView = {
  id: string; kind: string; text: string; at: string;
  /** Pages the message links to (its 「去待确认」, 「看草稿」 …). Buttons that change something stay in the 小帮手's conversation. */
  links: Array<{ label: string; href: string }>;
  /** It also carries buttons that act (撤销, 转成任务): offered as 「在小帮手里处理」. */
  actionable: boolean;
};

export type NoticesBody = { items: NoticeView[]; unread: number; readAt: string };

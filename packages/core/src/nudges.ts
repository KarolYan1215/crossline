/**
 * The system speaking first (docs/one-input.md §4): when to say something and what, decided by rules over what the app already knows —
 * the day's blocks, the timer, the deadlines, the background work — never by a model, so a nudge costs no quota and can always be
 * traced to the rule that raised it. The web writes each one into the day's conversation; the person answers with its buttons (a
 * button is the answer, carried out at once and undoable) or by typing.
 */
import type { ProposedAction } from "./concierge";

export type NudgeKind = "block_start" | "block_missed" | "latest_start" | "timer_overrun" | "background_done" | "energy_check";
export type NotifyLevelName = "off" | "less" | "normal" | "more";

/** A button: an action carried out on click, a page to open, an acknowledgement, 「少问这类」, or a cue to type. */
export type NudgeButton =
  | { kind: "action"; label: string; action: ProposedAction }
  | { kind: "href"; label: string; href: string }
  | { kind: "ack"; label: string }
  | { kind: "mute"; label: string }
  | { kind: "say"; label: string };

export type PlannedNudge = {
  kind: NudgeKind; fingerprint: string; text: string;
  /** Urgent ones are said even while the person is busy (they bear on a deadline or on the running timer). */
  urgent: boolean;
  /** Counted against the day's cap (the notify level); a block's start is not, as the person chose. */
  counted: boolean;
  buttons: NudgeButton[];
  /** Further fingerprints this one says too (background work finished together is one message), so none is said again. */
  covers?: string[];
};

/** A scheduled block of work that bears on a deadline within a week (the only blocks reminded about). */
export type NudgeBlock = {
  id: string; orderId: string; stepId: string; title: string; step: string; start: string; end: string; dueDay: string;
  /** When this order's latest execution started, in the person's local time `YYYY-MM-DDTHH:mm`, or "" — a block counts as started when one began after it was due to. */
  lastStartedAt: string;
};
/** How much time is left for one task with a due day: free minutes before it (after other work's blocks) against what remains of it. */
export type NudgeSlack = { orderId: string; title: string; dueDay: string; remainingMinutes: number; freeMinutes: number; dailyMinutes: number };

export type NudgeInput = {
  now: string; today: string; clock: string; tomorrow: string; level: NotifyLevelName;
  quiet: { timerRunning: boolean; inMeeting: boolean; answeredRecently: boolean };
  /** Before 08:00 or after 23:00 (the person's clock): only what follows their own activity — a block they are about to start, a timer they left running. */
  night?: boolean;
  muted: Set<NudgeKind>; sent: Set<string>; countedToday: number;
  blocks: NudgeBlock[];
  slack: NudgeSlack[];
  timer?: { orderId: string; title: string; stepId: string; stepTitle: string; startedAt: string; usualMinutes: number };
  finished: Array<{ key: string; text: string; label: string; href: string }>;
  /**
   * Asked when the next hours' work depends on energy, the model is not sure of it, and the person last said how they are over three
   * hours ago (docs/one-input.md §5.3). Unlimited, as the person chose, but never while they are busy or at night.
   */
  energyCheck?: { nextBlock: string; why: string };
};

export const DAILY_CAP: Record<NotifyLevelName, number> = { off: 0, less: 3, normal: 6, more: 10 };
const START_LEAD_MINUTES = 15;
const MISSED_WINDOW_MINUTES = 30;
const OVERRUN_RATIO = 1.5;

const minutesOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const hours = (minutes: number) => minutes >= 60 ? `${Math.round(minutes / 6) / 10} 小时` : `${Math.max(0, Math.round(minutes))} 分钟`;
const op = (orderId: string, type: "start" | "defer" | "step_done", summary: string, extra: { date?: string; stepId?: string } = {}): ProposedAction =>
  ({ action: "task.op", summary, args: { workOrderId: orderId, type, date: extra.date ?? "", minutes: 0, stepId: extra.stepId ?? "", text: "", who: "", energy: "" } });
const mute: NudgeButton = { kind: "mute", label: "少问这类" };

/** What would be said now, before the person's quiet hours, mutes and the day's cap are applied. */
export function nudgeCandidates(input: NudgeInput): PlannedNudge[] {
  const now = minutesOf(input.clock);
  const out: PlannedNudge[] = [];
  for (const block of input.blocks) {
    const start = minutesOf(block.start), end = minutesOf(block.end);
    const label = `「${block.title}${block.step ? ` · ${block.step}` : ""}」`;
    if (now >= start - START_LEAD_MINUTES && now < start && input.timer?.orderId !== block.orderId) {
      out.push({ kind: "block_start", fingerprint: `start:${block.id}:${input.today}`, urgent: true, counted: false,
        text: `${block.start} 做${label}（${end - start} 分），关系到 ${md(block.dueDay)} 的截止。`,
        buttons: [{ kind: "action", label: "开始计时", action: op(block.orderId, "start", `开始${label}`) },
          { kind: "action", label: "推到明天", action: op(block.orderId, "defer", `${label}推到明天`, { date: input.tomorrow }) }, mute] });
    }
    const started = block.lastStartedAt && block.lastStartedAt.slice(0, 10) === input.today && minutesOf(block.lastStartedAt.slice(11, 16)) >= start - 10;
    if (now >= end && now < end + MISSED_WINDOW_MINUTES && !started && input.timer?.orderId !== block.orderId) {
      out.push({ kind: "block_missed", fingerprint: `missed:${block.id}:${input.today}`, urgent: true, counted: true,
        text: `${block.start}–${block.end} 的${label}没有开始。系统会把它顺延到后面的空档（截止 ${md(block.dueDay)}）。`,
        buttons: [{ kind: "ack", label: "顺延就好" }, { kind: "href", label: "其实做了，去补记", href: `/workbench/${encodeURIComponent(block.orderId)}` },
          { kind: "action", label: "推到明天", action: op(block.orderId, "defer", `${label}推到明天`, { date: input.tomorrow }) }, mute] });
    }
  }
  for (const item of input.slack) {
    const slack = item.freeMinutes - item.remainingMinutes;
    if (slack >= item.dailyMinutes) continue;
    const late = slack < 0;
    out.push({ kind: "latest_start", fingerprint: `latest:${item.orderId}:${item.dueDay}:${late ? "late" : "tight"}`, urgent: late, counted: true,
      text: late
        ? `「${item.title}」按保守估时还需 ${hours(item.remainingMinutes)}，${md(item.dueDay)} 截止前只剩 ${hours(item.freeMinutes)} 可用，来不及。`
        : `「${item.title}」余量已不足一天：${md(item.dueDay)} 截止前可用 ${hours(item.freeMinutes)}，还需 ${hours(item.remainingMinutes)}。最晚现在开始。`,
      buttons: [{ kind: "action", label: "现在开始", action: op(item.orderId, "start", `开始「${item.title}」`) },
        { kind: "href", label: "调整计划", href: "/plan" }, mute] });
  }
  const timer = input.timer;
  if (timer && timer.usualMinutes >= 10) {
    const elapsed = (Date.parse(input.now) - Date.parse(timer.startedAt)) / 60_000;
    if (elapsed >= timer.usualMinutes * OVERRUN_RATIO) {
      const what = timer.stepTitle ? `「${timer.stepTitle}」` : `「${timer.title}」`;
      out.push({ kind: "timer_overrun", fingerprint: `overrun:${timer.startedAt}`, urgent: true, counted: true,
        text: `${what}已计时 ${Math.round(elapsed)} 分钟，比通常的 ${timer.usualMinutes} 分钟多一半。`,
        buttons: [...(timer.stepId ? [{ kind: "action" as const, label: "这步做完了", action: op(timer.orderId, "step_done", `${what}完成`, { stepId: timer.stepId }) }] : []),
          { kind: "ack", label: "还差一点" }, { kind: "say", label: "卡住了" }, mute] });
    }
  }
  if (input.energyCheck) {
    const report = (level: "low" | "medium" | "high", word: string): NudgeButton => ({ kind: "action", label: word,
      action: { action: "energy.report", summary: `精力${word}`, args: { level, note: "" } } });
    out.push({ kind: "energy_check", fingerprint: `energy:${input.today}:${Math.floor(now / 180)}`, urgent: false, counted: false,
      text: `现在精力怎么样？接下来是${input.energyCheck.nextBlock}。${input.energyCheck.why}`,
      buttons: [report("low", "低"), report("medium", "中"), report("high", "高"), mute] });
  }
  // Background work that finished together is said together: one message, every item in it, none of them said again.
  const finished = input.finished.filter((item) => !input.sent.has(`done:${item.key}`));
  if (finished.length === 1) {
    const [item] = finished;
    out.push({ kind: "background_done", fingerprint: `done:${item!.key}`, urgent: false, counted: true, text: item!.text,
      buttons: [{ kind: "href", label: item!.label, href: item!.href }, { kind: "ack", label: "稍后" }, mute] });
  } else if (finished.length > 1) {
    const review = finished.find((item) => item.href.startsWith("/approvals"));
    out.push({ kind: "background_done", fingerprint: `done:${finished[0]!.key}`, covers: finished.slice(1).map((item) => `done:${item.key}`), urgent: false, counted: true,
      text: `后台完成了 ${finished.length} 件：\n${finished.map((item) => `- ${item.text}`).join("\n")}`,
      buttons: [{ kind: "href", label: review ? review.label : finished[0]!.label, href: review ? review.href : finished[0]!.href }, { kind: "ack", label: "稍后" }, mute] });
  }
  return out;
}

/**
 * What is said now: nothing at the 「关闭」 level; nothing already said; no muted kind; at night only what follows their own activity; while the person is busy (the timer runs, a
 * meeting is on, they answered something under twenty minutes ago) only the urgent; and no more counted ones than the day's cap has
 * left, urgent first.
 */
export function planNudges(input: NudgeInput): PlannedNudge[] {
  if (input.level === "off") return [];
  const busy = input.quiet.timerRunning || input.quiet.inMeeting || input.quiet.answeredRecently;
  const candidates = nudgeCandidates(input).filter((item) => !input.sent.has(item.fingerprint) && !input.muted.has(item.kind) && (item.urgent || !busy)
    && (!input.night || item.kind === "block_start" || item.kind === "timer_overrun"))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent));
  let left = DAILY_CAP[input.level] - input.countedToday;
  return candidates.filter((item) => {
    if (!item.counted) return true;
    if (left <= 0) return false;
    left -= 1;
    return true;
  });
}

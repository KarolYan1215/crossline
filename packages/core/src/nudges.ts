/**
 * The system speaking first (docs/one-input.md §4): when to say something and what, decided by rules over what the app already knows —
 * the day's blocks, the timer, the deadlines, the background work — never by a model, so a nudge costs no quota and can always be
 * traced to the rule that raised it. The web writes each one into the day's conversation; the person answers with its buttons (a
 * button is the answer, carried out at once and undoable) or by typing.
 */
import type { ProposedAction } from "./concierge";
import { tFor, type Locale, type Translate } from "./i18n";

export type NudgeKind = "block_start" | "block_confirm" | "latest_start" | "timer_overrun" | "background_done" | "energy_check" | "outcome_check" | "progress_check"
  /** The evening wrap-up (docs/rituals.md): the day's blocks confirmed together at the end of the last available hours. */
  | "day_wrap";

/**
 * How far a step got, as the person says it in one tap (the return page's 「做了一部分」 and the `progress_check` question that follows a
 * partial answer with nothing said): each is a step's quarters done.
 */
export const PROGRESS_LEVELS = [
  { id: "started", label: "只开了个头", quarter: 1 },
  { id: "less", label: "做了一半左右", quarter: 2 },
  { id: "more", label: "做了一大半", quarter: 3 }
] as const;
export type ProgressLevelId = typeof PROGRESS_LEVELS[number]["id"];
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
  /** `block_confirm`: the block as it was when asked — the confirm page writes against these times, not the re-planned ones. */
  block?: NudgeEnding;
  /** `timer_overrun`: the step the timer ran over, kept so adaptive granularity can count it (`packages/core/src/granularity.ts`). */
  step?: { orderId: string; stepId: string };
};

/** The page a confirm question opens; `{message}` is replaced by the id of the message the question is written into. */
export const CONFIRM_HREF = "/confirm/{message}";

/** A scheduled block of work that bears on a deadline within a week (the only blocks reminded about). */
export type NudgeBlock = {
  id: string; orderId: string; stepId: string; title: string; step: string; start: string; end: string; dueDay: string;
  /** What the assistant has ready for this work (file names), said when the block comes up. */
  prepared?: string[];
  /** The step's first move, five minutes at most (docs/energy-and-ecosystem.md §6), said so the block is easy to begin. */
  firstAction?: string;
  /** Deadline work placed past the day's measured cap: the start message says it may not be finished in time (closed-loop-1030). */
  overCapacity?: boolean;
};
/**
 * Any of today's scheduled blocks, for the completion check (docs/loop-and-scout.md §3). `endedTimerAt`: when this order's timer was
 * last stopped today (`HH:mm`), or "" — a block whose timer the person already ended is not asked about.
 */
export type NudgeEnding = { id: string; orderId: string; stepId: string; title: string; step: string; day: string; start: string; end: string; endedTimerAt: string;
  /** The block's slot and work energy and the factor the plan used, carried to the completion check (absent on older blocks). */
  energy?: { slot: "low" | "medium" | "high"; need: "low" | "medium" | "high"; efficiency: number };
  /** The task's due day, when it has one: a block due tomorrow or sooner is still asked about on its own when the wrap-up is on. */
  dueDay?: string;
  /**
   * What the passive signals say about the block (`inferBlockOutcome`: its timer, the screen in work categories, Codex): with the
   * wrap-up on, a block due by tomorrow is asked about during the day only when it probably was not done (docs/plans/closed-loop-1030.md §2).
   */
  inferred?: "done" | "partial" | "not_done" };
/** How much time is left for one task with a due day: free minutes before it (after other work's blocks) against what remains of it. */
export type NudgeSlack = { orderId: string; title: string; dueDay: string; remainingMinutes: number; freeMinutes: number; dailyMinutes: number;
  /**
   * The due day is the person's own (or the system's), not a course's or someone else's: 「推迟截止」 is offered, to `deferDue` (the cautious
   * finish at the measured pace plus two days). docs/plans/closed-loop-1030.md §4–5.
   */
  selfSet?: boolean; deferDue?: string };

export type NudgeInput = {
  now: string; today: string; clock: string; tomorrow: string; level: NotifyLevelName;
  /** `focused`: the screen record reads the person as focused on work now (`inferWorkState`, with its consent only). */
  quiet: { timerRunning: boolean; inMeeting: boolean; answeredRecently: boolean; focused?: boolean };
  /** Before 08:00 or after 23:00 (the person's clock): only what follows their own activity — a block they are about to start, a timer they left running. */
  night?: boolean;
  muted: Set<NudgeKind>; sent: Set<string>; countedToday: number;
  blocks: NudgeBlock[];
  /** Every scheduled block of today, asked about once it ends. */
  ending: NudgeEnding[];
  slack: NudgeSlack[];
  timer?: { orderId: string; title: string; stepId: string; stepTitle: string; startedAt: string; usualMinutes: number;
    /** Minutes the session was paused (its closed pauses): a timer resumed the next day has not been running since yesterday. */
    pausedMinutes?: number };
  finished: Array<{ key: string; text: string; label: string; href: string }>;
  /**
   * Asked when the next hours' work depends on energy, the model is not sure of it, and the person last said how they are over three
   * hours ago (docs/one-input.md §5.3). Unlimited, as the person chose, but never while they are busy or at night.
   */
  energyCheck?: { nextBlock: string; why: string };
  /**
   * Finished work whose result was not known when it was finished (`completion.ts`, needs_assessment), due to be asked about: how it
   * went, or when its score comes out. Asked only at an idle moment — never urgent, so never while busy or at night — one at a time.
   * Each option answers the ask `askId`; `later` is the person saying when the result comes, which needs a date, so it is typed.
   */
  outcomes?: Array<{ askId: string; orderId: string; question: string; options: Array<{ id: string; label: string }>; laterLabel: string; fingerprint: string }>;
  /**
   * A step the person said they did part of while away, without saying how far (the return page): 「做到哪了」, asked once at an idle
   * moment under the same rules as `outcomes` — never urgent, one at a time. `laterLabel` is the cue to say it in words.
   */
  progressChecks?: Array<{ askId: string; orderId: string; question: string; options: Array<{ id: string; label: string }>; laterLabel: string; fingerprint: string }>;
  /**
   * The evening wrap-up (docs/rituals.md): `at` is the end of today's last available window, `open` how many of today's blocks wait to
   * be confirmed, `done` whether the person already wrapped up. While it is set, a block is asked about on its own only when its task is
   * due tomorrow or sooner (the answer changes tonight's or tomorrow's plan); every other block waits for the wrap-up — the completion
   * check's one push per block became one message at the end of the day.
   */
  wrap?: { at: string; open: number; done: boolean };
  /** The language the nudges are written in (the texts handed in — titles, questions, `why` — are shown as given). */
  locale?: Locale;
};

export const DAILY_CAP: Record<NotifyLevelName, number> = { off: 0, less: 3, normal: 6, more: 10 };
const START_LEAD_MINUTES = 15;
/** A block is asked about within this many minutes of its end; after that the next day's `missed_block` question covers it. */
const CONFIRM_WINDOW_MINUTES = 30;
const OVERRUN_RATIO = 1.5;

const minutesOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const hours = (t: Translate, minutes: number) => minutes >= 60 ? t("{{hours}} 小时", { hours: Math.round(minutes / 6) / 10 }) : t("{{minutes}} 分钟", { minutes: Math.max(0, Math.round(minutes)) });
/** 「title · step」 in the language's quotes. */
const quoted = (t: Translate, title: string, step?: string) => t("「{{text}}」", { text: `${title}${step ? ` · ${step}` : ""}` });
const op = (orderId: string, type: "start" | "defer" | "step_done" | "due", summary: string, extra: { date?: string; stepId?: string } = {}): ProposedAction =>
  ({ action: "task.op", summary, args: { workOrderId: orderId, type, date: extra.date ?? "", minutes: 0, stepId: extra.stepId ?? "", text: "", who: "", energy: "" } });
/** What would be said now, before the person's quiet hours, mutes and the day's cap are applied. */
export function nudgeCandidates(input: NudgeInput): PlannedNudge[] {
  const t = tFor(input.locale);
  const en = input.locale === "en";
  const mute: NudgeButton = { kind: "mute", label: t("少问这类") };
  const now = minutesOf(input.clock);
  const out: PlannedNudge[] = [];
  for (const block of input.blocks) {
    const start = minutesOf(block.start), end = minutesOf(block.end);
    const label = quoted(t, block.title, block.step);
    if (now >= start - START_LEAD_MINUTES && now < start && input.timer?.orderId !== block.orderId) {
      const prepared = block.prepared?.length ? block.prepared.slice(0, 3).join(en ? ", " : "、") : "";
      const text = [
        t("{{start}} 做{{label}}（{{minutes}} 分），关系到 {{due}} 的截止。", { start: block.start, label, minutes: end - start, due: md(block.dueDay) }),
        block.overCapacity ? t("超出实测 · 可能来不及。") : "",
        block.firstAction ? t("第一步：{{action}}。", { action: block.firstAction.replace(/[。．.！!；;\s]+$/u, "") }) : "",
        !prepared ? "" : block.prepared!.length > 3 ? t("已备好：{{items}} 等 {{count}} 份。", { items: prepared, count: block.prepared!.length })
          : t("已备好：{{items}}。", { items: prepared })
      ].filter(Boolean).join(en ? " " : "");
      out.push({ kind: "block_start", fingerprint: `start:${block.id}:${input.today}`, urgent: true, counted: false, text,
        buttons: [{ kind: "action", label: t("开始计时"), action: op(block.orderId, "start", t("开始{{label}}", { label })) },
          { kind: "action", label: t("推到明天"), action: op(block.orderId, "defer", t("{{label}}推到明天", { label }), { date: input.tomorrow }) }, mute] });
    }
  }
  // The completion check (docs/loop-and-scout.md §3): every block of the day, once it ends, is asked about once — one tap records
  // what happened. Not one whose timer the person already stopped, nor one whose timer still runs (the overrun question covers that).
  for (const block of input.ending) {
    const start = minutesOf(block.start), end = minutesOf(block.end);
    const stopped = block.endedTimerAt && minutesOf(block.endedTimerAt) >= start;
    if (now < end || now >= end + CONFIRM_WINDOW_MINUTES || stopped || input.timer?.orderId === block.orderId) continue;
    if (input.wrap && !(block.dueDay && block.dueDay <= input.tomorrow && (block.inferred === undefined || block.inferred === "not_done"))) continue;
    const label = quoted(t, block.title, block.step);
    out.push({ kind: "block_confirm", fingerprint: `confirm:${block.id}:${input.today}`, urgent: true, counted: true, block,
      text: t("{{start}}–{{end}} 的{{label}}做得怎么样？", { start: block.start, end: block.end, label }),
      buttons: [{ kind: "href", label: t("确认"), href: CONFIRM_HREF }, mute] });
  }
  if (input.wrap && !input.wrap.done && input.wrap.open > 0 && now >= minutesOf(input.wrap.at))
    out.push({ kind: "day_wrap", fingerprint: `wrap:${input.today}`, urgent: false, counted: false,
      text: t("今天还有 {{count}} 块工作没确认。收工时一起过一遍：完成、部分或没做，没做的顺延。", { count: input.wrap.open }),
      buttons: [{ kind: "href", label: t("收工"), href: "/wrap" }, mute] });
  // Free time before a due day is read at the measured pace (docs/plans/closed-loop-1030.md §4): under two days' worth to spare is said
  // two days or more before the deadline, not on its eve.
  for (const item of input.slack) {
    const slack = item.freeMinutes - item.remainingMinutes;
    if (slack >= 2 * item.dailyMinutes) continue;
    const late = slack < 0;
    const level = late ? "late" : slack < item.dailyMinutes ? "tight" : "margin";
    const values = { title: item.title, remaining: hours(t, item.remainingMinutes), due: md(item.dueDay), free: hours(t, item.freeMinutes) };
    out.push({ kind: "latest_start", fingerprint: `latest:${item.orderId}:${item.dueDay}:${level}`, urgent: late, counted: true,
      text: level === "late" ? t("「{{title}}」按保守估时还需 {{remaining}}，{{due}} 截止前只剩 {{free}} 可用，来不及。", values)
        : level === "tight" ? t("「{{title}}」余量已不足一天：{{due}} 截止前可用 {{free}}，还需 {{remaining}}。最晚现在开始。", values)
        : t("「{{title}}」按实测进度余量已不足两天：{{due}} 截止前可用 {{free}}，还需 {{remaining}}。", values),
      buttons: [{ kind: "action", label: t("现在开始"), action: op(item.orderId, "start", t("开始{{label}}", { label: quoted(t, item.title) })) },
        ...(item.selfSet && item.deferDue ? [{ kind: "action" as const, label: t("推迟截止"),
          action: op(item.orderId, "due", t("{{label}}截止推到 {{day}}", { label: quoted(t, item.title), day: md(item.deferDue) }), { date: item.deferDue }) }] : []),
        { kind: "href", label: t("去本周承诺"), href: "/commit" },
        { kind: "href", label: t("调整计划"), href: "/plan" }, mute] });
  }
  const timer = input.timer;
  if (timer && timer.usualMinutes >= 10) {
    const elapsed = (Date.parse(input.now) - Date.parse(timer.startedAt)) / 60_000 - (timer.pausedMinutes ?? 0);
    if (elapsed >= timer.usualMinutes * OVERRUN_RATIO) {
      const what = quoted(t, timer.stepTitle || timer.title);
      out.push({ kind: "timer_overrun", fingerprint: `overrun:${timer.startedAt}`, urgent: true, counted: true,
        ...(timer.stepId ? { step: { orderId: timer.orderId, stepId: timer.stepId } } : {}),
        text: t("{{what}}已计时 {{elapsed}} 分钟，比通常的 {{usual}} 分钟多一半。", { what, elapsed: Math.round(elapsed), usual: timer.usualMinutes }),
        buttons: [...(timer.stepId ? [{ kind: "action" as const, label: t("这步做完了"), action: op(timer.orderId, "step_done", t("{{what}}完成", { what }), { stepId: timer.stepId }) }] : []),
          { kind: "ack", label: t("还差一点") }, { kind: "say", label: t("卡住了") }, mute] });
    }
  }
  // Follow-ups on finished work and on partly done steps: the same idle-moment question, one of each kind at a time.
  for (const [kind, prefix, list] of [["outcome_check", "outcome", input.outcomes], ["progress_check", "progress", input.progressChecks]] as const) {
    const item = list?.find((entry) => !input.sent.has(`${prefix}:${entry.fingerprint}`));
    if (!item) continue;
    const answer = (option: { id: string; label: string }): NudgeButton => ({ kind: "action", label: option.label,
      action: { action: "ask.answer", summary: `${item.question} ${option.label}`.slice(0, 200), args: { askId: item.askId, optionId: option.id, fields: [] } } });
    out.push({ kind, fingerprint: `${prefix}:${item.fingerprint}`, urgent: false, counted: true, text: item.question,
      buttons: [...item.options.map(answer), { kind: "say", label: item.laterLabel }, mute] });
  }
  if (input.energyCheck) {
    const report = (level: "low" | "medium" | "high", word: string): NudgeButton => ({ kind: "action", label: t(word),
      action: { action: "energy.report", summary: t("精力{{level}}", { level: t(word) }), args: { level, note: "" } } });
    out.push({ kind: "energy_check", fingerprint: `energy:${input.today}:${Math.floor(now / 180)}`, urgent: false, counted: false,
      text: [t("现在精力怎么样？接下来是{{next}}。", { next: input.energyCheck.nextBlock }), input.energyCheck.why].filter(Boolean).join(en ? " " : ""),
      buttons: [report("low", "低"), report("medium", "中"), report("high", "高"), mute] });
  }
  // Background work that finished together is said together: one message, every item in it, none of them said again.
  const finished = input.finished.filter((item) => !input.sent.has(`done:${item.key}`));
  if (finished.length === 1) {
    const [item] = finished;
    out.push({ kind: "background_done", fingerprint: `done:${item!.key}`, urgent: false, counted: true, text: item!.text,
      buttons: [{ kind: "href", label: item!.label, href: item!.href }, { kind: "ack", label: t("稍后") }, mute] });
  } else if (finished.length > 1) {
    const review = finished.find((item) => item.href.startsWith("/approvals"));
    out.push({ kind: "background_done", fingerprint: `done:${finished[0]!.key}`, covers: finished.slice(1).map((item) => `done:${item.key}`), urgent: false, counted: true,
      text: `${t("后台完成了 {{count}} 件：", { count: finished.length })}\n${finished.map((item) => `- ${item.text}`).join("\n")}`,
      buttons: [{ kind: "href", label: review ? review.label : finished[0]!.label, href: review ? review.href : finished[0]!.href }, { kind: "ack", label: t("稍后") }, mute] });
  }
  return out;
}

/**
 * What is said now: nothing at the 「关闭」 level; nothing already said; no muted kind; at night only what follows their own activity; while the person is busy (the timer runs, a
 * meeting is on, they answered something under twenty minutes ago, the screen record reads them as focused) only the urgent; and no more
 * counted ones than the day's cap has left, urgent first.
 */
export function planNudges(input: NudgeInput): PlannedNudge[] {
  if (input.level === "off") return [];
  const busy = input.quiet.timerRunning || input.quiet.inMeeting || input.quiet.answeredRecently || Boolean(input.quiet.focused);
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

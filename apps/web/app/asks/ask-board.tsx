"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ASK_QUADRANTS, ASK_QUADRANT_LABEL, askQuadrant, type Ask, type AskKind, type AskQuadrant } from "@crossline/core";
import { AlertTriangle, Bot, CalendarClock, ChevronLeft, ChevronRight, FileQuestion, Hourglass, ListChecks, MessageSquare, ShieldCheck, type LucideIcon } from "lucide-react";
import { AskDeck, useAskList, useDeck } from "./ask-drawer";
import { keysFree } from "./ask-card";
import { byQuadrant } from "./model";
import type { AskPreviews } from "./types";
import { useT } from "../locale-context";
import { ICON, IconButton } from "../ui/icon-button";

/** The kinds of decision, as the left column groups them (2026-10-29, approvals.html). Keys are Chinese and translated where shown. */
export type AskGroup = "风险与逾期" | "等待到期" | "步骤与准备" | "助手" | "验收" | "日程与承诺" | "收集与文件" | "其他";
const GROUP_OF: Partial<Record<AskKind, AskGroup>> = {
  milestone_risk: "风险与逾期", milestone_risk_review: "风险与逾期", risk_digest: "风险与逾期", milestone_overdue: "风险与逾期", overdue_task: "风险与逾期",
  waiting_due: "等待到期",
  step_question: "步骤与准备", prep_question: "步骤与准备", backplan_input: "步骤与准备",
  agent_blocked: "助手",
  gate_insufficient: "验收", gate_failed: "验收", evidence_manual: "验收",
  missed_block: "日程与承诺", weekly_commit: "日程与承诺", event_propose: "日程与承诺", locked_conflict: "日程与承诺", travel_minutes: "日程与承诺",
  calendar_publish_failed: "日程与承诺", calendar_sync_failed: "日程与承诺", calendar_line_unclear: "日程与承诺",
  capture_blocked: "收集与文件", materials_blocked: "收集与文件", source_project: "收集与文件", ledger_duplicate: "收集与文件"
};
export const ASK_GROUPS: AskGroup[] = ["风险与逾期", "等待到期", "步骤与准备", "助手", "验收", "日程与承诺", "收集与文件", "其他"];
const GROUP_ICON: Record<AskGroup, LucideIcon> = { 风险与逾期: AlertTriangle, 等待到期: Hourglass, 步骤与准备: ListChecks, 助手: Bot, 验收: ShieldCheck,
  日程与承诺: CalendarClock, 收集与文件: FileQuestion, 其他: MessageSquare };
export const askGroup = (ask: Pick<Ask, "kind">): AskGroup => GROUP_OF[ask.kind] ?? "其他";

/** The short labels of the quadrant cells (the long ones stay the cells' accessible names). */
const QUADRANT_SHORT: Record<AskQuadrant, string> = { urgent_important: "紧急 · 重要", important: "重要", urgent: "紧急", neither: "其余" };

export type DeckFilter = { quadrant?: AskQuadrant | undefined; group?: AskGroup | undefined };

/** The asks a filter leaves, in the order they came (ranked by urgency and importance), quadrant by quadrant. Pure, for its test. */
export function filterAsks(asks: Ask[], filter: DeckFilter): Ask[] {
  const groups = byQuadrant(asks);
  return ASK_QUADRANTS.flatMap((quadrant) => groups[quadrant])
    .filter((ask) => (!filter.quadrant || askQuadrant(ask) === filter.quadrant) && (!filter.group || askGroup(ask) === filter.group));
}

/**
 * This week's asks on 待确认 (2026-10-29, approvals.html): the left column counts them in the four quadrants and by kind — pressing one
 * narrows the deck to it — and lists the keys; the middle shows one card at a time. Number keys pick an option, Enter sends it, J / K
 * step through the deck and H asks again tomorrow, all only while nothing takes typing. `aside` is what the page adds under the left
 * column (the decisions that wait, what is decided elsewhere). A link `?ask=<id>` (Today's 「打开」) brings that card to the front.
 */
export function AskBoard({ initial, previews, aside }: { initial: Ask[]; previews: AskPreviews; aside?: ReactNode }) {
  const { asks, onDone } = useAskList(initial, (ask) => !ask.entersOn);
  const t = useT();
  const [filter, setFilter] = useState<DeckFilter>({});
  const shown = filterAsks(asks, filter);
  const { at, go, pick } = useDeck(shown.length);
  const quadrants = byQuadrant(asks);
  const groups = ASK_GROUPS.map((group) => ({ group, count: asks.filter((ask) => askGroup(ask) === group).length })).filter((item) => item.count > 0);

  // Today's 「打开」 links straight to one card.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("ask");
    if (!id) return;
    const index = filterAsks(asks, {}).findIndex((ask) => ask.id === id);
    if (index >= 0) pick(index);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented || event.isComposing || !keysFree(event.target)) return;
      if (event.key === "j" || event.key === "J") { event.preventDefault(); go(1); }
      if (event.key === "k" || event.key === "K") { event.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const choose = (next: DeckFilter) => { setFilter(next); pick(0); };
  const top = shown[at];

  return <>
    <aside className="ap-left" aria-label={t("待决事项的分类")}>
      <section className="ap-card ap-quads" aria-label={t("四个格子")}>
        <h2 className="ap-card-title">{t("四个格子")}</h2>
        <div className="ap-quad-grid">{ASK_QUADRANTS.map((quadrant) => <button key={quadrant} type="button" data-quadrant={quadrant}
          aria-pressed={filter.quadrant === quadrant} aria-label={t("{{quadrant}} {{count}} 项", { quadrant: t(ASK_QUADRANT_LABEL[quadrant]), count: quadrants[quadrant].length })}
          disabled={!quadrants[quadrant].length} onClick={() => choose(filter.quadrant === quadrant ? {} : { quadrant })}>
          <b className="ds-serif">{quadrants[quadrant].length}</b><span>{t(QUADRANT_SHORT[quadrant])}</span>
        </button>)}</div>
        <p className="ap-keys"><kbd>1</kbd>–<kbd>3</kbd> {t("选项")} <kbd>Enter</kbd> {t("确定")} <kbd>J</kbd><kbd>K</kbd> {t("翻页")} <kbd>H</kbd> {t("明天再问")}</p>
      </section>
      {groups.length > 0 && <section className="ap-card ap-kinds" aria-label={t("种类")}>
        <h2 className="ap-card-title">{t("种类")}</h2>
        <ul>{groups.map(({ group, count }) => { const Icon = GROUP_ICON[group]; return <li key={group}>
          <button type="button" aria-pressed={filter.group === group} onClick={() => choose(filter.group === group ? {} : { group })}>
            <Icon {...ICON} /><span>{t(group)}</span><b className="mono">{count}</b></button></li>; })}</ul>
      </section>}
      {aside}
    </aside>

    <section className="ap-center" id="asks" aria-label={t("待决事项")}>
      <h2 className="sr-only">{t("待决事项 · {{count}}", { count: asks.length })}</h2>
      {asks.length === 0 ? <div className="ap-card ap-empty"><p>{t("本周暂无待决事项。")}</p></div>
        : <div className="ap-deck">
          <header className="ap-deck-head">
            {top && <><span className="ap-quad-tag" data-quadrant={askQuadrant(top)}>{t(QUADRANT_SHORT[askQuadrant(top)])}</span>
              <span className="ap-kind-tag">{t(askGroup(top))}</span></>}
            {(filter.quadrant || filter.group) && <button type="button" className="text-button ap-clear" onClick={() => choose({})}>{t("显示全部")}</button>}
            <nav className="ap-deck-nav" aria-label={t("切换待决事项")}>
              <IconButton label={t("上一项")} icon={<ChevronLeft {...ICON} />} disabled={at === 0} onClick={() => go(-1)} />
              <span className="mono" aria-live="polite">{shown.length ? at + 1 : 0} / {shown.length}</span>
              <IconButton label={t("下一项", { context: "button" })} icon={<ChevronRight {...ICON} />} disabled={at >= shown.length - 1} onClick={() => go(1)} />
            </nav>
          </header>
          {shown.length ? <AskDeck asks={shown} at={at} pick={pick} onDone={onDone} previews={previews} keys />
            : <p className="ap-empty-filter">{t("这一类本周没有了。")}</p>}
        </div>}
    </section>
  </>;
}

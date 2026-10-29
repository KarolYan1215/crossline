import { onPersonsBoard } from "@crossline/core";
import { stateLabel } from "../../lib/labels";
import { RestoreButton } from "./restore-button";
import { archivedBySystem, ensureSeeded, getStore, libraryUntil, loadCurrentPlan, planToday } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AnalyzeButton } from "./analyze-button";
import { PromoteForm } from "./promote-form";
import { CollectBar } from "./collect-bar";
import { WaitRow } from "./wait-row";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { cardView, loadTaskDetailsBatch, type TaskDetail } from "../../lib/task-detail";
import { nextSlots } from "../../lib/steps";
import { TaskCard } from "../task/task-card";
import { compareInGroup, groupOf, waitReason, type TaskGroup } from "../task/card-model";
import { identityLines } from "../../lib/lines";
import { timed } from "../../lib/sections";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";
import { punct, shortDate } from "../task/format";
import { milestonesBeingBackplanned } from "../../lib/backplan-status";
import { Conversation } from "../chat/conversation";
import { Archive } from "lucide-react";

export const dynamic = "force-dynamic";

type Entry = { id: string; detail: TaskDetail; slot?: { day: string; start: string; end: string } | undefined; library?: string | undefined };
type View = "now" | "next" | "waiting" | "library";
type By = "state" | "line" | "due";

/** The page's four questions, in the order the person asks them, each with what it holds. */
const SECTIONS: Array<{ group: View; title: string; hint: string }> = [
  { group: "now", title: "现在", hint: "正在计时、今天有时段或今天到期" },
  { group: "next", title: "接下来", hint: "按下一个时段排序；没有时段的在最后" },
  { group: "waiting", title: "在等", hint: "等本人批准、等他人或材料、等验收" },
  { group: "library", title: "任务库", hint: "所属里程碑还远，进入三周窗口后才排进日历" }
];
const BY: Array<{ value: By; label: string }> = [{ value: "state", label: "按状态" }, { value: "line", label: "按主线" }, { value: "due", label: "按截止" }];
/** 按截止: overdue, due within a week, later, and no due day — what is closest first. */
const DUE_BUCKETS = [["overdue", "已逾期"], ["week", "七天内到期"], ["later", "之后到期"], ["none", "没有截止日"]] as const;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * 任务 (redesigned 2026-10-15, then 2026-10-28 after the page draft). Opened to find a task or see everything under way: the inputs not
 * yet made into tasks sit in one bar at the top (收集, with 立即分析 and the items themselves on 查看); a row of tabs counts the four
 * questions — 现在 / 接下来 / 在等 / 任务库 — and narrows the page to one; the lines filter it; and the same tasks can be laid out by
 * state (the default), by line or by due day. 现在 and 接下来 are cards; 在等 is a list of rows saying what each waits for and where it
 * is answered (待确认 is where waiting items, proposals and acceptance are decided); the library, the finished and the archived fold at
 * the foot. Every choice lives in the address (`?view=`, `?line=`, `?by=`), so coming back to the page keeps it. The page's own input
 * box closes it.
 */
export default async function WorkbenchPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const params = await searchParams;
  ensureSeeded(ctx);
  const locale = localeFor(ctx), t = tFor(locale);
  const md = (day: string) => shortDate(locale, day);
  const store = getStore();
  const all = store.listWorkOrders(ctx.workspaceId);
  const today = planToday(ctx);
  const lines = identityLines(ctx).map((pack) => ({ id: pack.id, label: pack.label }));
  const lineFilter = typeof params.line === "string" && lines.some((line) => line.id === params.line) ? params.line : undefined;
  const view = SECTIONS.some((section) => section.group === params.view) ? params.view as View : undefined;
  const by: By = BY.some((item) => item.value === params.by) ? params.by as By : "state";
  // The task library: work backplanned for a milestone due beyond the scheduling window waits until the window opens.
  const library = new Map(all.flatMap((run) => { const day = run.state === "archived" ? null : libraryUntil(ctx, run, today); return day ? [[run.id, day] as const] : []; }));
  // What the system withdrew on its own (its replaced drafts, demo orders) is not shown: only what the person discarded.
  const systemArchived = new Set(store.listEvents(ctx.workspaceId, { type: "work_order.archived" })
    .filter((event) => archivedBySystem(event.payload)).map((event) => event.entityId));
  const discarded = all.filter((run) => run.state === "archived" && !systemArchived.has(run.id));
  // What the daily self-check merged into another task is shown, as its own group, with 撤销合并 (decided 2026-10-15).
  const mergedInto = new Map(store.listEvents(ctx.workspaceId, { type: "work_order.archived" })
    .flatMap((event) => { const target = (event.payload as { mergedInto?: string }).mergedInto; return target ? [[event.entityId, target] as const] : []; }));
  const merged = all.filter((run) => run.state === "archived" && mergedInto.has(run.id));
  const titleOfId = new Map(all.map((run) => [run.id, ((run.payload as { title?: string } | undefined)?.title ?? "").trim() || run.intent]));
  const captures = store.listCaptures(ctx.workspaceId).filter((capture) => capture.state !== "promoted" && capture.state !== "discarded");
  const attachments = store.listCaptureAttachments(ctx.workspaceId);
  const discardedCaptures = store.listCaptures(ctx.workspaceId).filter((capture) => capture.state === "discarded");
  const discardReasons = new Map(store.listEvents(ctx.workspaceId, { type: ["work_order.archived", "capture.discarded"] })
    .map((event) => [event.entityId, (event.payload as { reason?: string }).reason ?? ""]));
  const milestoneOptions = store.listMilestones(ctx.workspaceId)
    .filter((milestone) => milestone.status === "approved")
    .map((milestone) => ({ id: milestone.id, title: milestone.title, identityId: milestone.identityId }));
  // The assistant's preparation and the questions to the person are not the person's tasks (docs/work-split.md): no card here.
  const live = all.filter((run) => run.state !== "archived" && onPersonsBoard(run));
  // One batched read for every card instead of one per card — see `loadTaskDetailsBatch`'s own doc comment.
  const taskDetails = await timed("workbench.details", () => loadTaskDetailsBatch(ctx, live.map((run) => run.id)));
  const slots = nextSlots((await timed("plan.current", () => loadCurrentPlan(ctx))).blocks, today);
  const groups = new Map<TaskGroup, Entry[]>();
  const lineCounts = new Map<string, number>();
  for (const run of live) {
    const detail = taskDetails.get(run.id);
    if (!detail) continue;
    // The card's copy: its dialog reads the whole detail when opened (`cardView`).
    const entry: Entry = { id: run.id, detail: cardView(detail), slot: slots.get(run.id), library: library.get(run.id) };
    const group = groupOf(detail, { today, slot: entry.slot, library: entry.library });
    if (group !== "done") lineCounts.set(run.identityId, (lineCounts.get(run.identityId) ?? 0) + 1);
    if (lineFilter && run.identityId !== lineFilter) continue;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  for (const [group, entries] of groups) entries.sort(compareInGroup(group, today));
  const count = (group: TaskGroup) => groups.get(group)?.length ?? 0;
  const inProgress = SECTIONS.reduce((sum, section) => sum + count(section.group), 0);
  const withSlotToday = [...groups.values()].flat().filter((entry) => entry.slot?.day === today).length;
  const dueToday = [...groups.values()].flat().filter((entry) => entry.detail.window.dueBy?.slice(0, 10) === today && !["accepted", "archived"].includes(entry.detail.state)).length;
  const card = (entry: Entry) => <div key={entry.id} id={`work-order-${entry.id}`} className="task-grid-item">
    <TaskCard detail={entry.detail} slot={entry.slot} today={today} />
  </div>;
  const row = (entry: Entry) => { const wait = waitReason(entry.detail, today, locale);
    return <WaitRow key={entry.id} detail={entry.detail} today={today} kind={wait?.kind ?? "gate"} label={wait?.label ?? t("已提交 · 等验收")} />; };
  const nothing = !live.length && !captures.length;
  const backplanning = nothing ? milestonesBeingBackplanned(getStore(), ctx.workspaceId, today) : 0;
  const shownLines = lines.filter((line) => lineCounts.has(line.id));
  const href = (change: { view?: View | undefined; line?: string | undefined; by?: By }) => {
    const next = new URLSearchParams();
    const v = "view" in change ? change.view : view, l = "line" in change ? change.line : lineFilter, b = change.by ?? by;
    if (v) next.set("view", v);
    if (l) next.set("line", l);
    if (b !== "state") next.set("by", b);
    const query = next.toString();
    return query ? `/workbench?${query}` : "/workbench";
  };
  const shown = SECTIONS.filter((section) => !view || section.group === view);
  const archivedCount = discarded.length + discardedCaptures.length + merged.length;
  const summary = t("{{count}} 项在办", { count: inProgress }) + ` · ${t("今天 {{count}} 项有时段", { count: withSlotToday })}` + ` · ${t("{{count}} 项今天截止", { count: dueToday })}`;

  // 按主线 / 按截止: the same cards laid out another way; 在等 stays rows wherever it lands.
  const regrouped = (): Array<{ key: string; title: string; entries: Entry[] }> => {
    const pool = shown.filter((section) => section.group !== "library").flatMap((section) => groups.get(section.group) ?? []);
    if (by === "line") return lines.map((line) => ({ key: line.id, title: line.label, entries: pool.filter((entry) => entry.detail.identityId === line.id) }))
      .filter((bucket) => bucket.entries.length);
    const bucketOf = (entry: Entry) => { const due = entry.detail.window.dueBy; if (!due) return "none"; const days = daysBetween(today, due); return days < 0 ? "overdue" : days <= 7 ? "week" : "later"; };
    const byDue = (a: Entry, b: Entry) => (a.detail.window.dueBy ?? "9999").localeCompare(b.detail.window.dueBy ?? "9999") || a.id.localeCompare(b.id);
    return DUE_BUCKETS.map(([key, title]) => ({ key, title: t(title), entries: pool.filter((entry) => bucketOf(entry) === key).sort(byDue) })).filter((bucket) => bucket.entries.length);
  };
  const isWaiting = (entry: Entry) => Boolean(waitReason(entry.detail, today));

  return <SubpageShell active={"任务"} title={t("任务")} serif description={nothing ? undefined : summary}>
    <div className="tk-page tasks-page">
      <CollectBar count={captures.length} titles={captures.slice(0, 3).map((capture) => capture.title)}
        pending={captures.filter((capture) => capture.state !== "analyzing").map((capture) => capture.id)}>
        <div className="work-order-list">{captures.map((capture) => <article key={capture.id}>
          <header><span>{t("收集")}</span><b>{stateLabel[capture.state] ? t(stateLabel[capture.state]!) : capture.state}</b></header>
          <h2>{capture.title}</h2><p>{capture.context}</p>
          <p>{t("未分类 · 未估时 · 原文已保存，可人工处理")}</p>
          {(() => { const own = attachments.filter((item) => item.captureId === capture.id);
            return own.length > 0 && <p>{t("附件 {{count}} 份：", { count: own.length })}{own.map((item, index) => <span key={item.id}>
              {index > 0 ? punct(locale, "、") : ""}
              <a href={`/api/captures/${encodeURIComponent(capture.id)}/attachments?uri=${encodeURIComponent(item.uri)}`}
                target="_blank" rel="noreferrer">{item.fileName}</a>
            </span>)}</p>; })()}
          {capture.audit.blocker && <p role="status" title={capture.audit.blocker.code}>{capture.audit.blocker.message}</p>}
          <AnalyzeButton captureId={capture.id} analyzing={capture.state === "analyzing"} retry={capture.state === "blocked"} />
          <PromoteForm captureId={capture.id} identities={lines} milestones={milestoneOptions} />
        </article>)}</div>
      </CollectBar>
      {nothing ? <p className="panel today-empty">{backplanning
        ? t("系统正在从已批准的 {{count}} 个里程碑倒推任务（每个几分钟），出来的任务会出现在这里。", { count: backplanning })
        : t("还没有任务。任务有两个来源：批准「主线」页的里程碑草稿后，系统从它们倒推出任务；或者在今日页的输入框写下要做的事，系统整理成任务。")}</p>
        : <div className="tasks-top">
          <nav className="tasks-index" aria-label={t("任务分组")}>
            <a href={href({ view: undefined })} aria-current={!view ? "page" : undefined}><span>{t("全部")}</span><b className="mono">{inProgress}</b></a>
            {SECTIONS.map((section) => <a key={section.group} href={href({ view: section.group })} aria-current={view === section.group ? "page" : undefined}
              title={t(section.hint)}><span>{t(section.title)}</span><b className="mono">{count(section.group)}</b></a>)}
          </nav>
          <div className="tasks-top-right">
            {shownLines.length > 1 && <nav className="tasks-filter" aria-label={t("按主线筛选")}>
              {shownLines.map((line) => <a key={line.id} href={href({ line: lineFilter === line.id ? undefined : line.id })} data-line={line.id}
                aria-current={lineFilter === line.id ? "true" : undefined} title={t(lineFilter === line.id ? "取消筛选" : "只看这条主线")}><i className="task-card-dot" aria-hidden="true" />{line.label}</a>)}
            </nav>}
            {archivedCount > 0 && <a className="tk-archive-link" href={`${href({})}${view || lineFilter || by !== "state" ? "&" : "?"}archived=1#archived`} title={t("已归档 {{count}} 项", { count: archivedCount })}>
        <Archive size={18} strokeWidth={1.6} aria-hidden="true" /><span className="sr-only">{t("已归档 {{count}} 项", { count: archivedCount })}</span></a>}
            <nav className="tasks-by" aria-label={t("排列方式")}>
              {BY.map((item) => <a key={item.value} href={href({ by: item.value })} aria-current={by === item.value ? "true" : undefined}>{t(item.label)}</a>)}
            </nav>
          </div>
        </div>}
      {by === "state" ? shown.filter((section) => section.group !== "library").map((section) => {
        const entries = groups.get(section.group) ?? [];
        if (!entries.length && (section.group !== "now" || nothing)) return null;
        return <section key={section.group} id={`tasks-${section.group}`} className="tasks-section" aria-labelledby={`tasks-${section.group}-title`}>
          <header className="tasks-section-head">
            <h2 id={`tasks-${section.group}-title`} className="ds-serif">{t(section.title)} <span className="mono">{entries.length}</span></h2>
            <small>{t(section.hint)}</small>
          </header>
          {!entries.length ? <p className="tasks-empty">{t(count("next") ? "今天没有排到时段的任务；「接下来」里最早的一项可以提前开始。" : "今天没有排到时段的任务。")}</p>
            : section.group === "waiting" ? <ul className="tk-wait-list">{entries.map(row)}</ul>
            : <div className="task-grid">{entries.map(card)}</div>}
        </section>;
      }) : regrouped().map((bucket) => <section key={bucket.key} className="tasks-section" aria-labelledby={`tasks-${bucket.key}-title`}>
        <header className="tasks-section-head"><h2 id={`tasks-${bucket.key}-title`}>{bucket.title} <span className="mono">{bucket.entries.length}</span></h2></header>
        {bucket.entries.some((entry) => !isWaiting(entry)) && <div className="task-grid">{bucket.entries.filter((entry) => !isWaiting(entry)).map(card)}</div>}
        {bucket.entries.some(isWaiting) && <ul className="tk-wait-list">{bucket.entries.filter(isWaiting).map(row)}</ul>}
      </section>)}
      {count("library") > 0 && (!view || view === "library") && <details id="tasks-library" className="work-order-drawer tasks-library" open={view === "library" || undefined}>
        <summary>{t("任务库")} <span className="mono">{count("library")}</span> <small>{t("项 · 最早 {{day}} 起排入日程", { count: count("library"), day: md(groups.get("library")![0]!.library!) })}</small></summary>
        <p className="tasks-empty">{t("所属里程碑的截止日在三周窗口之外；窗口打开后自动排进日程。")}</p>
        <div className="task-grid">{groups.get("library")!.map((entry) => <div key={entry.id} id={`work-order-${entry.id}`} className="task-grid-item">
          <TaskCard detail={entry.detail} today={today} />
          <p className="task-card-note">{t("{{day}} 起排入日程", { day: md(entry.library!) })}</p>
        </div>)}</div>
      </details>}
      {count("done") > 0 && !view && <details className="work-order-drawer advanced">
        <summary>{t("已完成")} <span className="mono">{count("done")}</span> {t("项", { count: count("done") })}</summary>
        <div className="task-grid">{groups.get("done")!.map(card)}</div>
      </details>}
      {archivedCount > 0 && <details id="archived" className="work-order-drawer advanced" open={params.archived === "1" || undefined}>
        <summary>{t("已归档 {{count}} 项", { count: archivedCount })}</summary>
        {merged.length > 0 && <>
          <h3>{t("已合并")} <span className="mono">{merged.length}</span></h3>
          <ul className="archive-list">
            {merged.map((run) => <li key={run.id}><span>{titleOfId.get(run.id)}<small> · {t("已合并到「{{title}}」", { title: titleOfId.get(mergedInto.get(run.id)!) ?? t("另一项任务") })}</small></span>
              <RestoreButton kind="merge" id={run.id} /></li>)}
          </ul>
        </>}
        <ul className="archive-list">
          {discarded.map((run) => <li key={run.id}><span>{run.intent}
            {discardReasons.get(run.id) ? <small> · {discardReasons.get(run.id)}</small> : null}</span>
            <RestoreButton kind="work_order" id={run.id} /></li>)}
          {discardedCaptures.map((capture) => <li key={capture.id}><span>{capture.title}
            {discardReasons.get(capture.id) ? <small> · {discardReasons.get(capture.id)}</small> : null}</span>
            <RestoreButton kind="capture" id={capture.id} /></li>)}
        </ul>
      </details>}
      <div className="tk-input">
        <Conversation variant="block" page={{ kind: "tasks", entityId: "workbench" }} placeholder={t("对任务说一句：新建、改截止、某一步做完了、交给助手……")} />
      </div>
    </div>
  </SubpageShell>;
}

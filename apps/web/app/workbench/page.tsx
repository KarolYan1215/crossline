import { stateLabel } from "../../lib/labels";
import { RestoreButton } from "./restore-button";
import { archivedBySystem, ensureSeeded, getStore, libraryUntil, loadCurrentPlan, planToday } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AnalyzeButton } from "./analyze-button";
import { PromoteForm } from "./promote-form";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadTaskDetailsBatch, type TaskDetail } from "../../lib/task-detail";
import { nextSlots } from "../../lib/steps";
import { TaskCard } from "../task/task-card";
import { compareInGroup, groupOf, waitReason, type TaskGroup } from "../task/card-model";
import { identityLines } from "../../lib/lines";
import { timed, timedSync } from "../../lib/sections";
import { milestonesBeingBackplanned } from "../../lib/backplan-status";

export const dynamic = "force-dynamic";

type Entry = { id: string; detail: TaskDetail; slot?: { day: string; start: string; end: string } | undefined; library?: string | undefined };

/** The page's four questions, in the order the person asks them, each with what it holds. */
const SECTIONS: Array<{ group: TaskGroup; title: string; hint: string }> = [
  { group: "now", title: "现在", hint: "正在计时、今天有时段或今天到期" },
  { group: "next", title: "接下来", hint: "按下一个时段排序；没有时段的在最后" },
  { group: "waiting", title: "在等", hint: "等本人批准、等他人或材料、等验收" }
];
const WAIT_HEADINGS: Array<{ kinds: string[]; title: string }> = [
  { kinds: ["returned", "approval"], title: "等本人决定" },
  { kinds: ["input", "release", "material"], title: "等他人、材料或开放日" },
  { kinds: ["gate"], title: "等验收" }
];
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/**
 * 任务 (redesigned 2026-10-15). Opened to answer four questions at a glance — what to do now, where each task stands and what its next
 * step is, what waits for someone or something, and what sits in the library for later — so the tasks are grouped by those questions
 * rather than listed in one grid with a sort: 现在 / 接下来 / 在等 / 任务库, then the uncategorised 收集, the finished and the archived.
 * A line filter (`?line=`) narrows every group; it lives in the address, so coming back to the page keeps it.
 */
export default async function WorkbenchPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const params = await searchParams;
  ensureSeeded(ctx);
  const store = getStore();
  const all = store.listWorkOrders(ctx.workspaceId);
  const today = planToday(ctx);
  const lines = identityLines(ctx).map((pack) => ({ id: pack.id, label: pack.label }));
  const lineFilter = typeof params.line === "string" && lines.some((line) => line.id === params.line) ? params.line : undefined;
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
  const live = all.filter((run) => run.state !== "archived");
  // One batched read for every card instead of one per card — see `loadTaskDetailsBatch`'s own doc comment.
  const taskDetails = timedSync("workbench.details", () => loadTaskDetailsBatch(ctx, live.map((run) => run.id)));
  const slots = nextSlots((await timed("plan.current", () => loadCurrentPlan(ctx))).blocks, today);
  const groups = new Map<TaskGroup, Entry[]>();
  const lineCounts = new Map<string, number>();
  for (const run of live) {
    const detail = taskDetails.get(run.id);
    if (!detail) continue;
    const entry: Entry = { id: run.id, detail, slot: slots.get(run.id), library: library.get(run.id) };
    const group = groupOf(detail, { today, slot: entry.slot, library: entry.library });
    if (group !== "done") lineCounts.set(run.identityId, (lineCounts.get(run.identityId) ?? 0) + 1);
    if (lineFilter && run.identityId !== lineFilter) continue;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  for (const [group, entries] of groups) entries.sort(compareInGroup(group, today));
  const count = (group: TaskGroup) => groups.get(group)?.length ?? 0;
  const card = (entry: Entry) => <div key={entry.id} id={`work-order-${entry.id}`} className="task-grid-item">
    <TaskCard detail={entry.detail} slot={entry.slot} today={today} />
  </div>;
  const nothing = !live.length && !captures.length;
  const backplanning = nothing ? milestonesBeingBackplanned(getStore(), ctx.workspaceId, today) : 0;
  const shownLines = lines.filter((line) => lineCounts.has(line.id));
  return <SubpageShell active="任务" title="任务">
    {nothing ? <p className="panel today-empty">{backplanning
      ? `系统正在从已批准的 ${backplanning} 个里程碑倒推任务（每个几分钟），出来的任务会出现在这里。`
      : "还没有任务。任务有两个来源：批准「主线」页的里程碑草稿后，系统从它们倒推出任务；或者在今日页的输入框写下要做的事，系统整理成任务。"}</p>
      : <div className="tasks-top">
        <nav className="tasks-index" aria-label="任务分组">
          {SECTIONS.map((section) => <a key={section.group} href={`#tasks-${section.group}`}><span>{section.title}</span><b className="mono">{count(section.group)}</b></a>)}
          <a href="#tasks-library"><span>任务库</span><b className="mono">{count("library")}</b></a>
        </nav>
        {shownLines.length > 1 && <nav className="tasks-filter" aria-label="按主线筛选">
          <a href="/workbench" aria-current={!lineFilter ? "true" : undefined}>全部</a>
          {shownLines.map((line) => <a key={line.id} href={`/workbench?line=${encodeURIComponent(line.id)}`} data-line={line.id}
            aria-current={lineFilter === line.id ? "true" : undefined}><i className="task-card-dot" aria-hidden="true" />{line.label}</a>)}
        </nav>}
      </div>}
    {SECTIONS.map((section) => {
      const entries = groups.get(section.group) ?? [];
      if (!entries.length && section.group !== "now") return null;
      return <section key={section.group} id={`tasks-${section.group}`} className="tasks-section" aria-labelledby={`tasks-${section.group}-title`}>
        <header className="tasks-section-head">
          <h2 id={`tasks-${section.group}-title`}>{section.title} <span className="mono">{entries.length}</span></h2>
          <small>{section.hint}</small>
        </header>
        {!entries.length ? <p className="tasks-empty">{count("next") ? "今天没有排到时段的任务；「接下来」里最早的一项可以提前开始。" : "今天没有排到时段的任务。"}</p>
          : section.group === "waiting" ? WAIT_HEADINGS.map((heading) => {
            const own = entries.filter((entry) => heading.kinds.includes(waitReason(entry.detail, today)?.kind ?? "gate"));
            return own.length ? <div key={heading.title} className="tasks-subgroup"><h3>{heading.title} <span className="mono">{own.length}</span></h3>
              <div className="task-grid">{own.map(card)}</div></div> : null;
          })
          : <div className="task-grid">{entries.map(card)}</div>}
      </section>;
    })}
    {captures.length > 0 && <section className="tasks-section" aria-labelledby="tasks-captures-title">
      <header className="tasks-section-head"><h2 id="tasks-captures-title">收集 <span className="mono">{captures.length}</span></h2><small>尚未整理成任务的输入；系统自动分析</small></header>
      <div className="work-order-list">{captures.map((capture) => <article key={capture.id}>
        <header><span>收集</span><b>{stateLabel[capture.state]}</b></header>
        <h2>{capture.title}</h2><p>{capture.context}</p>
        <p>未分类 · 未估时 · 原文已保存，可人工处理</p>
        {(() => { const own = attachments.filter((item) => item.captureId === capture.id);
          return own.length > 0 && <p>附件 {own.length} 份：{own.map((item, index) => <span key={item.id}>
            {index > 0 ? "、" : ""}
            <a href={`/api/captures/${encodeURIComponent(capture.id)}/attachments?uri=${encodeURIComponent(item.uri)}`}
              target="_blank" rel="noreferrer">{item.fileName}</a>
          </span>)}</p>; })()}
        {capture.audit.blocker && <p role="status" title={capture.audit.blocker.code}>{capture.audit.blocker.message}</p>}
        <AnalyzeButton captureId={capture.id} analyzing={capture.state === "analyzing"} retry={capture.state === "blocked"} />
        <PromoteForm captureId={capture.id} identities={lines} milestones={milestoneOptions} />
      </article>)}</div>
    </section>}
    {count("library") > 0 && <details id="tasks-library" className="work-order-drawer tasks-library">
      <summary>任务库 <span className="mono">{count("library")}</span> 项 · 最早 {md(groups.get("library")![0]!.library!)} 起排入日程</summary>
      <p className="tasks-empty">所属里程碑的截止日在三周窗口之外；窗口打开后自动排进日程。</p>
      <div className="task-grid">{groups.get("library")!.map((entry) => <div key={entry.id} id={`work-order-${entry.id}`} className="task-grid-item">
        <TaskCard detail={entry.detail} today={today} />
        <p className="task-card-note">{md(entry.library!)} 起排入日程</p>
      </div>)}</div>
    </details>}
    {count("done") > 0 && <details className="work-order-drawer advanced">
      <summary>已完成 <span className="mono">{count("done")}</span> 项</summary>
      <div className="task-grid">{groups.get("done")!.map(card)}</div>
    </details>}
    {(discarded.length + discardedCaptures.length + merged.length) > 0
      && <details className="work-order-drawer advanced"><summary>已归档 {discarded.length + discardedCaptures.length + merged.length} 项</summary>
        {merged.length > 0 && <>
          <h3>已合并 <span className="mono">{merged.length}</span></h3>
          <ul className="archive-list">
            {merged.map((run) => <li key={run.id}><span>{titleOfId.get(run.id)}<small> · 已合并到「{titleOfId.get(mergedInto.get(run.id)!) ?? "另一项任务"}」</small></span>
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
  </SubpageShell>;
}

# F3 计划页重构：交接说明（供合并时并入 CLAUDE.md 与 docs/user-guide.md）

## 开发者说明（并入 CLAUDE.md「The plan is one calendar」一段，替换其中关于计划页日历的描述）

**The plan page is the long view, not a calendar** (decided 2026-10-10, docs/flywheel-and-views.md §3). The calendar (`CalendarPanel`) is on
Today only; `apps/web/app/plan/plan-view.tsx` still exports `CalendarData` because Today imports it from there. The page is: a top row
(`PlanView`: version, differences fold that opens itself while one is pending, 立即同步日历, 发布到 Crossline 日历, the horizon, schedule
status), four charts (`plan-stats-charts.tsx`), 「与上次查看时相比」, and the settings as three tabs (`plan-controls.tsx`: 可用时段 /
排程参数 / 排程依据). The importance slider lives only in the 排程依据 table (`ranking-table.tsx`, with the preset's reasons on hover); the
separate 重要性 tab, the old `CapacityPanel`/`ForecastChart` (`plan-charts.tsx`, deleted) and the duplicate 「本周已排」 are gone.

- **Horizon** (`?horizon=4|8|far`, `horizonFor` in `lib/plan-stats.ts`): 8 weeks by default, 4, or 「到最远截止」 — the farthest approved
  milestone deadline, rounded up to whole weeks and capped at 26 weeks (`HORIZON_CAP_DAYS` = 182). `loadGoalForecast(ctx, horizonDays = 56)`
  takes the horizon; every other caller still gets eight weeks.
- **`forecastGoals` records per-week demand** (`packages/planner/src/forecast.ts`): `weeks[k].demand[]` = minutes per milestone in the p50 and
  p85 runs. Work done after the milestone's deadline, or still undone at the horizon's end while the deadline is inside it, is charged to
  the **deadline's** week (`*OverdueMinutes`, included) — that is what lets a week's demand exceed its usable minutes, which the chart
  labels 「超载 N 小时」. Undone work whose deadline is past the horizon (or that has none) is only later, not overload. The week count is
  `ceil(days / 7)`, so 56 days is still eight weeks and the old shape is unchanged apart from `demand`.
- **`lib/plan-stats.ts`** is pure (no store) and shared by the page loader and the preview: `capacityWeeks` (per week and line: scheduled =
  the scheduler's blocks, pending = forecast demand above that, extra = p85 − p50; a line is never drawn below its placed blocks),
  `goalRows`, `investment` (last four weeks ending today, planned vs timed per line, plus the next seven days' planned), `statedShares`
  (portrait `share`, else each line's own `weekly_hours` facts, never a 合计 total), `estimatePoints` (analysis p50, else the baseline;
  censored left out), `rhythmGrid` (timer stretches split by quarter hour in the person's zone, pauses cut out), `availabilityGrid`.
- **Planned history is new data**: `recordScheduledToday` (`lib/schedule-memory.ts`, the attention timer) now also writes
  `schedule.minutes:<day>` → `{orderId: minutes}`, the most seen per order that day. `schedule.day:<day>` keeps its shape (the missed-block
  ask reads it). Days before this shipped have a start time and no length and count as 「计划时长未记录」 — on the real account the planned
  dots will be empty for the first weeks.
- **Previews move the charts**: `usePlanImpact` (`app/plan/preview-context.tsx`) wraps `useImpact({ charts: horizonDays })`; the route
  passes `charts` (7–182 days) to `previewChange(ctx, change, { chartsHorizonDays })`, which returns `impact.charts = { before, after }`
  (`loadForecastCharts` in `lib/plan-board.ts`, run inside `withPreview` for after). While a preview is open the capacity chart draws the
  after-state with a dashed ghost of the previous demand and usable line, the milestone rows a dashed ghost range, the dumbbell a ghost of
  the next seven days' plan, and the heatmap the old availability as dashed outlines.
- Charts are hand-written SVG drawn at their measured width (`useWidth`), text 12px Arial in graphite/ink, line colours only as fills.
  Geometry is in `app/plan/chart-geometry.ts` (tested). CSS is `app/plan/plan-stats.css` (imported by the page). With nothing timed,
  the scatter and heatmap say 「尚无实测」 instead of drawing empty axes; the dumbbell draws no actual dots.
- Copy fixed on the page: 草案 → 草稿, 采纳 → 批准, and the sync/publish errors no longer show `worker` or an error code.

## e2e changes (not run here)

`e2e/crossline.spec.ts`: 「Plan is one calendar…」 became 「Plan is the long view…」 (no calendar, four chart regions, 4/8 weeks switch,
milestone rows link to `/milestones?open=`, three settings tabs, no 重要性); the availability test reads `data-scheduled-minutes` on the
capacity chart instead of counting week-view blocks and checks the preview ghost; the deadline check uses
`.pl-gantt-deadline[data-deadline=…]`; `STABLE_FOR_SCREENSHOT` hides the new chart marks. **`plan-diff.png` must be regenerated**
(`pnpm exec playwright test --update-snapshots`), since the calendar is gone from that page.

## 用户指南段落（并入 docs/user-guide.md「计划」一节）

计划页不再显示日历，日程本身在今日页查看。计划页看的是更长的时间：页顶是计划版本、待处理的计划差异、「立即同步日历」和「发布到 Crossline 日历」，右侧可以把统计范围切换为 4 周、8 周或「到最远截止」（最多 6 个月）。下面四张图依次是：**容量与需求**——每周一根柱，按主线颜色分为已排、待排和保守估时多出的部分，折线是扣除预留后的可用小时，超出的周标「超载 N 小时」，悬停可看各主线的小时和占用最多的里程碑；**里程碑完成预测**——每个已批准的里程碑一行，横条从通常完成日到保守完成日，◆ 为截止日，余量不足 2 天标为风险，虚线是任务库进入日，点一行打开该里程碑；**主线投入：计划 vs 实际**——近 4 周每周计划小时（空心点）与实际计时小时（实心点），旁边是访谈中所述的投入比例；**估时准确度与节律**——估时与实际用时的对比和保守估时覆盖率，以及近 8 周按星期与小时的工作分布，外框为可用时段。没有计时记录时显示「尚无实测」。页底的排程设置分为可用时段、排程参数和排程依据三页，里程碑的重要性在排程依据表中调整；任何改动先预览，预览期间上方各图以虚线显示改动前的数值。

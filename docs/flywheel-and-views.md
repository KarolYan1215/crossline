


## 附录：实现记录（2026-10-10）

各阶段实现分支的交接说明，合并时并入此处。用户口径的说明在 `docs/user-guide.md` 第 18 节，架构摘要在 `CLAUDE.md`「Flywheel and views」。

### F1 / F2：今日页面板、日程块操作、自动交给 Agent、飞轮图谱

**The day panel (F1, 2026-10-10; `apps/web/app/timeline/quick-actions.tsx` `DayQuickActions`, `block-overview.tsx`, `complete-dialog.tsx`, `block-start.ts`, pure `panel-model.ts`).** The detail strip under the calendar (`aside.cal-detail` in `calendar-panel.tsx`) is gone; the column beside the day view is the one place a block is looked at and acted on. Top, fixed: 当日负荷 (`dayLoad`: scheduled / pencilled / fixed minutes). Middle, switching: the picked block's task (`BlockOverview` — 主线 · 里程碑, the block's step and the task's progress, the due date and this step's duration through `TaskQuickEdit` with its impact preview, the person's part (`humanCore`, else the person's own open steps), the task's next block (`followingBlock`)), or with nothing picked the next block in compact form (`nextBlock`). Bottom: 待批准任务 · N with 全部批准, 待决事项 · N, 调整可用时段. A pick in the week view opens that day with the block picked (the week has no panel); on a phone the panel sits under the timeline and is scrolled into view on a pick. **One start path**: the old `DayQuickActions.start` and the strip's 「开始（转为正式排程）」 were two copies of pin-then-start; now `TaskActions` takes `beforeStart`, and the panel passes `pinIfPencilled(item)` (a 预排 block becomes formal through `/api/plan/pin` before the timer starts). Actions on a block: TaskActions (approve / start / pause with a reason / resume / 交给 Agent / open the task dialog / archive) plus 完成并提交材料 and 推迟. **完成并提交材料** (`CompleteDialog`) is one line plus dropped or chosen files (images, PDF, plain text — what `ALLOWED_ATTACHMENT_TYPES` keeps), sent through the same two endpoints the task page uses: it starts the timer first when the task is not `active` (both `evidence-attachments` and `complete` require it), uploads, then `complete` with the files as `file` claims and the line as a `record` claim on `note:<id>` (the shape `evidence.submit` already uses); 「完成（记为无证据）」 completes with no claim, and 「只完成本步」 (shown when other open steps remain) marks the block's step done through the steps route instead. **推迟** offers 明天 or a chosen day, previewed as an `impact` `defer` change before it is applied. 交给 Agent appears when the block's own step is one the system can do (`agentStepFor`: executor ≠ human; a whole-task block falls back to the first such step). Task details for the coming week's blocks are read with Today in the same `loadTaskDetailsBatch` call (`calendarDetails`, a plain object because it crosses to the client); any other block's task is read on pick from the new read-only `GET /api/work-orders/[id]/detail`. `CalendarPanel`'s props stay backward compatible (`taskDetails` is optional), so the plan page — until F3 removes its calendar — gets the same panel, reading details on demand.

**「自动交给 Agent」 (F1; `AUTO_HANDOFF_SETTING` = `agent.autoHandoff`, default off; `isAutoHandoff`/`setAutoHandoff` in `packages/db/src/agent.ts`; `POST /api/agent/auto-handoff`; Settings → 自动化与助手).** Exactly what it controls: a step **on the calendar** that the step planner judged the system can do (`executor: "mixed"`), still planned, whose `dependsOn` steps are done, of a committed task the person is not timing right now (an open, unpaused execution), never handed over before (`triedSteps`, the same lost-run retry rule as preparation steps), of a kind the person allowed (a kind not yet allowed is asked about once via `requestCategory`). The assistant's own preparation steps (`executor: "agent"`) take no calendar time and are **not** governed by this switch — they keep being picked up by themselves, as decided on 2026-10-09. **"At its scheduled time"**: the schedule is derived on read in the web app and never stored, so the attention timer (`recordScheduledToday`, every ten minutes) now also writes `STEP_STARTS_SETTING` = `schedule.stepStarts`, `{ "<orderId>#<stepId>": ISO instant }` of each step's earliest block in the coming seven days (`stepStartsOf`, converted with `toZonedInstant`; a local time that does not exist is skipped). `autoHandoffTiming` calls a step `due` when its block starts within `AUTO_HANDOFF_LEAD_MINUTES` (30) or has already started, `early` when its block is later in the week, `unscheduled` (never started by itself) with no block. `agentService.pass` picks, one at a time and only under the existing ≥95% quota ceiling and pause: a `due` auto step, then preparation steps, then whole orders, then an `early` auto step ("in advance when idle"). The result still follows the kind's 关闭 / 逐次审阅 / 自动 mode: a step handed over (by the button or by this switch) is now marked done after a clean run when the kind is trusted on its own checks (`!reviewRequired`), and otherwise when the person accepts it on 待确认 (`reviewAgentTask`, unchanged) — before, a mixed step done in 自动 mode was never marked done. `STEP_CATEGORY` and `stepCategory` moved from the worker into `packages/core/src/agent-dispatch.ts` so the web can mark blocks: `withAgentMarks` (`timeline/model.ts`) tags a block 「Agent 执行中」 (a run with no outcome for that step, or for the whole order) or 「Agent 将执行」 (switch on, not paused, a mixed planned step of an allowed kind not yet handed over); `TimelineItem` gained `stepId` and `agent`.

**The flywheel graph (F2; `apps/web/app/flywheel/graph-model.ts` pure, `flywheel-graph.tsx`, `flywheel-graph.css`, data from `apps/web/lib/flywheel-graph.ts` `loadFlywheelGraph`).** Replaces Today's per-line cards (`section.lines-strip`; its CSS and `.flow-progress` went with it; `DashboardData.identities` is still computed because `generality.test.ts` reads it). Nodes: one anchor per identity line labelled with `goals[0]` (else the line's name) and one dot per live milestone (approved or draft; never archived, never `milestonesRetiredBySystem`; health is capacity and has no node — the legend says so), coloured by line (`data-line` → `--lc`), radius `6 + 3√(unfinished tasks)` capped at 20. Edges (`buildGraph`/`classifyEdge`): `member` (milestone → its anchor, faint, the pull that clusters a line), `chain` (anchor `dependsOn` within a line, thin, minus dependencies another path already implies, as on the 主线 timeline; a relation inside one line is drawn the same way), `cross` (an approved or candidate `milestone_relations` row between lines: thick, arrowed, in the source line's colour). Approved solid, candidate dashed; clicking any relation opens a popover with its kind and explanation, and a candidate can be approved or turned down there through `/api/milestone-relations/decide` (a relation the store skips for lack of evidence says so). `graphLoops` runs `flywheelLoops` on the line-level graph of **approved** cross relations only and labels each loop R1, R2… at the centre of the milestones its relations join; its lag is the sum of each hop's shortest `lagDays` when every hop states one — relations carry no lag yet (F5 adds artifact transfers), so today the R stands alone. Layout: a hand-written force simulation (`createSimulation`: pairwise repulsion with collision, springs per edge kind, weak centring, each anchor held weakly to its slot on a ring), seeded from FNV-1a hashes of the ids with mulberry32 and settled synchronously (300 ticks) before the first paint, rounded to a tenth — the same ledger draws the same shape on every load, on the server and in the browser. The SVG's coordinate space is the container's measured pixel width (`ResizeObserver`; 720 before it is measured), so text is drawn at 12–13px at any width and nothing scrolls sideways on a phone. Interaction: drag a dot (the rest relax around it — animated, or settled at once under `prefers-reduced-motion`), drag the background to pan, wheel zoom about the pointer (a non-passive listener, so the page does not scroll under it), two-finger pinch, +/−/复位; hover or focus lights a node's neighbours and dims the rest; a click (or Enter) opens `/milestones?open=<id>`. The legend keeps each line's tasks in progress (「研究者 · 17 项进行中」) with its goal.

**Tests.** `packages/core/src/agent-dispatch.test.ts` (timing, step kind), `apps/worker/src/agent-dispatch.test.ts` (「自动交给 Agent」 candidates: off by default, due / early / unscheduled, dependencies, the person timing, a kind not yet allowed), `apps/worker/src/agent-service.test.ts` (a due step goes before a whole order; a trusted kind's clean run marks the step done), `apps/web/lib/schedule-memory.test.ts` (`stepStartsOf`), `apps/web/app/timeline/panel-model.test.ts` and `day-panel.test.tsx` (the panel), `apps/web/app/flywheel/graph-model.test.ts` (graph building, edge classes, loops and lag, stable seeded layout, ring order, fit), `flywheel-graph.test.tsx`, `apps/web/lib/flywheel-graph.test.ts`. e2e (`e2e/crossline.spec.ts`, not yet run on this branch): the panel switches to a picked block, starts it there and hands it in with a line and a file; the graph draws, zooms without scrolling the page, and opens a milestone. The Today visual baseline changes (graph instead of cards).

### F3：计划页


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

#### e2e changes (not run here)

`e2e/crossline.spec.ts`: 「Plan is one calendar…」 became 「Plan is the long view…」 (no calendar, four chart regions, 4/8 weeks switch,
milestone rows link to `/milestones?open=`, three settings tabs, no 重要性); the availability test reads `data-scheduled-minutes` on the
capacity chart instead of counting week-view blocks and checks the preview ghost; the deadline check uses
`.pl-gantt-deadline[data-deadline=…]`; `STABLE_FOR_SCREENSHOT` hides the new chart marks. **`plan-diff.png` must be regenerated**
(`pnpm exec playwright test --update-snapshots`), since the calendar is gone from that page.

### F4：原子化定语与卡片访谈

#### 实现要点

##### 1. 定语候选（core + 访谈）

- `packages/core/src/line-attributes.ts`：类型 `AttributeCandidate {text, kind: domain|ability|state, sourceRef}`、`StoredLineProfile`、`PendingGoalEdit`；纯函数 `cleanAttribute`（去「成为」、去尾「的」、去标点）、`attributeKey` / `duplicateAttributes`（去「的」与标点后一个包含另一个即重复）、`notAtomic`（含「、，；/」等并列）、`guessKind`（无标注时的规则分类）、`orderAttributes`（领域 → 能力 → 状态，同类保持原序）、`insertByKind`（新选的定语插在最后一个同类或更早类之后，不打乱手动排序）、`composeGoal`（「成为A的、B的<身份>」）、`goalCore`、`recomposes`、`lineAttributes`（旧 `goalCandidates` 每句读成一个定语，兼容旧数据，不迁移）、`checkGoalParts`。设置键 `LINE_PROFILES_SETTING = "lines.profiles"`、`GOAL_EDITS_SETTING = "lines.goalEdits"`。
- 分类采用**模型标注 `kind`**（schema 里的枚举，可测、可校验），`guessKind` 只用于人手写的定语和旧整句候选。
- `onboarding-turn-schema.ts`：`lineProfiles[].attributeCandidates`（≤12 项，每项 `{text ≤40, kind, sourceRef}`）替换 `goalCandidates`；新增顶层 `goalEdits: [{lineId, parts:[{text,kind}], sourceRef}]`。严格模式规则不变（全部 required、`additionalProperties:false`），`structured-output.test.ts` 的发现式检查覆盖。
- 校验 `validateOnboardingTurn`：候选为 0（保留已有）或 6–12 个；`sourceRef` 必须是已知的 `reply-N`/`src-N`（与事实同样处理：退回修正 `ONBOARDING_UNKNOWN_SOURCE_REF`）；并列 `ONBOARDING_ATTRIBUTE_NOT_ATOMIC`；重复 `ONBOARDING_ATTRIBUTE_DUPLICATE`，详情点名两个定语；数量 `ONBOARDING_ATTRIBUTES_COUNT`。`goalEdits` 必须引用本人的回复（`ONBOARDING_GOAL_EDIT_UNASKED`），主线必须存在，定语不重复。`keepOnboardingTurn`（修复用尽时）逐个丢弃坏定语，剩不足 6 个就当空列表（保留已有），丢弃不合格的 `goalEdits`。
- `persistTurn`（`apps/worker/src/onboarding-session.ts`）：`lines.profiles[line] = {description, attributes}`；空候选只更新描述；新候选替换旧候选，但保留由已采用长期目标拆出的定语（`sourceRef: "goal"`，且不与新候选重复）。`goalEdits` 写入 `lines.goalEdits[line] = {parts, sourceRef, at}`，按本人说的顺序，不自动生效。访谈上下文的 `lines[]` 带上 `goalParts`。
- Skill `crossline-onboarding/SKILL.md` 与 worker 开发者指令同步改写（lines 阶段、`goalEdits`、focusLine/卡片访谈刷新候选）。
- 读取方：`packages/db/src/interview.ts`（清单的「描述与候选」按 `attributes` 或旧 `goalCandidates` 计数）、`portrait-writer`（只读描述）、`calendar-classifier`（只读描述）、`/api/onboarding/state`、主线页。

##### 2. 选定语界面与 `goalParts`

- `packages/identity-packs`：`LineSpec.goalParts` / `IdentityPack.goalParts`。
- `apps/web/lib/lines.ts` `updateLine` 接受 `goalParts`：`checkGoalParts` 校验（空、超过 12、重复 → `LINE_GOAL_PARTS_*`，带中文原因），`goals[0]` = 组合句，其余长期目标保留；整句改写 `goals[0]` 时去掉不再对应的 `goalParts`（之后由拆分任务重新拆）；主线改名时组合句跟着改。长期目标上限放宽到 300 字（多个定语组合会长）。`POST /api/lines {id, goalParts}`，GET 返回 `goalParts`；撤销标签写主线名而非 id。
- `apps/web/app/ui/attribute-picker.tsx`（+ `attribute-picker.css`）：芯片多选不限个数、`insertByKind` 自动排序、拖动与 ←/→ 调序（手机上拖动不可靠）、点击改字、补充自定义定语、重复提示、实时预览、「采用」。用于主线页 LineEditor（`lines-bar.tsx`）与访谈页 `portrait-panel.tsx`（替换原整句候选与「添加」表单；对应的孤立 CSS 已删）。

##### 3. 已采用整句的拆分（worker 任务）

- 新 Skill `crossline-goal-splitter`（低档，`model-policy.ts`），schema `GOAL_SPLIT_SCHEMA` / `validateGoalSplit` / `keepGoalSplit`（core）。上下文 `crossline.goal-split.v1`：每条主线的 `goals`。
- 校验：每条主线、每个长期目标都要返回，`goal` 逐字照抄；定语不重复、不含并列；**按序组合后与原句一致**（`recomposes`：忽略空白、标点、开头「成为」和所有「的」——组合时只会增加「的」与「、」，比较时去掉「的」是有意的，见下方偏差）。不一致退回修正（同一线程，最多两次），修复用尽后 `softAccept` → `keepGoalSplit`：拆得对的保留，拆不对的整句作为一个定语保留（`goalCore`）。
- `apps/worker/src/goal-splitter.ts`：`linesAwaitingSplit`（有 `goals[0]`、无 `goalParts`、该句未拆过）；写入前重新读取主线设置，人在运行期间改过的长期目标不覆盖；`goals[0]` 的措辞不变，只加 `goalParts`；所有长期目标的定语并入候选（`sourceRef: "goal"`，旧 `goalCandidates` 一并转成定语）；每句记一条 `line.goal_split` 事件（`goalHash`、`parts`、`kinds`、`recomposed`），幂等键 `line:goal-split:<line>:<hash>`。运行时不可用或模型失败时什么都不记，下次再试。
- 触发：worker 每个 tick 的 `goalSplitPass`（额度为 `manual_core_only` 时不跑）；立即触发：supervisor `POST /v1/lines/split-goals`（202，后台运行）← web `POST /api/lines/split-goals`。

##### 4. 卡片里的访谈与页面上下文 `line`

- `apps/web/lib/line-cards.ts` `lineCardDetails`：每条主线的描述、定语候选、`goalParts`、待确认的长期目标修改、该主线访谈（会话 `line-<id>`，与 `/onboarding?line=` 相同）的最新回复与问题、是否在等回复、是否该提示重算。
- `apps/web/app/milestones/line-card-interview.tsx`（+ `line-card.css`）：卡片内输入框，问题选项可点选（`composeAnswers` 组成回复），发送到 `/api/onboarding/turn`；进行中显示已用秒数，输入框可用，新消息排队；409（同账号另一轮访谈在跑）20 秒后自动重发；失败可「重新发送」（服务端已保存消息）；结束后 `router.refresh()` 原地刷新描述与候选；刷新页面时若最后一条消息还没回答，每 20 秒看一次。卡片拖动排序改为只拖标题，避免与输入框冲突。
- 修改长期目标：`POST /api/lines/goal-edit {lineId, decision: adopt|dismiss}` → `decideGoalEdit`（采用走 `updateLine` 的 `goalParts` 校验；两种决定都清除待办并记 `line.goal_edit_adopted|dismissed`；可撤销）。
- 页面上下文 `kind: "line"`：`pageFromLocation` 读 `/milestones?line=` 与 `/onboarding?line=`；聚焦卡片输入框时用 `history.replaceState` 写入 `?line=<id>`，全局小助手因此知道当前主线。`contextPack` 的 `page.title` 为主线名，`ConciergePack.lines[]` 增加 `description`；快照新增「本页主线」三行（`pageLine`）。动作 `profile.tell` 新增参数 `lineId`（"" = 整体访谈；否则送到该主线的访谈会话），卡片字段可改；concierge Skill 文本已同步（注册表一致性测试通过）。

##### 5. 重算提示

- `redraftDue`：这条主线有里程碑，且长期目标（`line.updated` 中改了 goals/goal/goalParts，或 `line.goal_edit_adopted`）或这条主线的事实（`updatedAt`）晚于最近一次提议（该线里程碑的 `milestone.proposed`，或 `line.redraft_requested`）。
- 按钮「目标已变，重算未动过的草稿」→ 现有 `POST /api/milestones/propose {only:[line]}`；该路由对 `only` 中的每条主线先记 `line.redraft_requested`，提示随即消失，直到长期目标或事实再变。已批准的里程碑不受影响（架构师本来就只重做未动过的草稿）。

#### 与设计稿的偏差

- 重组校验比较时除空白、标点外还忽略「的」和开头「成为」。原因：组合格式必然在定语之间加「的、」（「成为神经形态计算方向的、能独立立项的研究者」），而原句通常没有（「成为神经形态计算方向能独立立项的研究者」）；只忽略空白标点则任何多定语拆分都不可能通过。拆分时 `goals[0]` 保留原句措辞不变，所以显示给人的仍是原句。
- 校验拒绝写给 `person` 的 `lineProfiles` 与 `goalEdits`（以前不拒绝 `person`）。
- 访谈的候选允许 0 个（表示保留已有、继续追问），否则必须 6–12 个。

#### 在真实账号上执行拆分

合并并重启 worker 后，下一个 tick（≤15 分钟）会自动拆分所有「有长期目标、没有 `goalParts`」的主线，每句只拆一次。要立即执行：在已登录的浏览器控制台运行

```js
await fetch("/api/lines/split-goals", { method: "POST", headers: { "content-type": "application/json" } }).then((r) => r.json())
```

返回 `{ok: true, started: true}` 后数秒到一两分钟内完成。核对：`line.goal_split` 事件的 `recomposed` 应为 `true`（`false` 表示该句被整体保留为一个定语）；主线页卡片的长期目标文字不变，「调整定语 →」里对应定语处于选中状态，预览的组合句与原句只差「的、」。

#### 测试

- `packages/core/src/line-attributes.test.ts`：组合、清理、重复、排序、插入、分类、重组、旧数据兼容、`checkGoalParts`、拆分 schema 与校验、修复用尽后的整句保留。
- `packages/core/src/onboarding-turn-schema.test.ts`：候选数量/来源/并列/重复（点名）、清理、`goalEdits` 必须引用回复、`keepOnboardingTurn` 逐个丢弃。
- `apps/worker/src/onboarding-session.test.ts`：卡片访谈（`line-research`）按线刷新候选、保留拆出的定语、修改只记录不生效；空候选只更新描述。
- `apps/worker/src/goal-splitter.test.ts`（共享 Codex fake）：拆分并保持选中、幂等、重组失败退回修正后整句保留、运行期间人改了长期目标不覆盖、无运行时不记录。
- `apps/web/lib/line-cards.test.ts`：`goalParts` 采用/改名/整句改写、校验、重算提示、卡片数据、修改卡的采用与放弃、页面上下文 `line` 与 `profile.tell` 的 `lineId` 路由。
- `apps/web/app/api/lines/route.test.ts`：`goalParts` 保存路由；新路由由 `csrf-protection.test.ts` 自动覆盖。
- `apps/web/app/milestones/lines-bar.test.tsx`：卡片渲染访谈框、描述、修改卡（组合句、采用/不改）、重算按钮、本轮问题。`empty-account.test.tsx` 增加 `next/navigation` 的 mock（卡片用 `router.refresh()`）。
- e2e 未改：现有用例不点击长期目标候选；主线页没有截图基线。设计与文案审查（`design-audit`、`copy-audit`）需在合并后运行。

### F5 / F6：产物优先的联合规划与任务层产出 → 使用

#### 每项规格如何实现

1. **产物清单一轮**：新 Skill `crossline-artifact-planner`（`skills/marketplace/plugins/crossline/skills/crossline-artifact-planner/SKILL.md`，以共享的「Language」段收尾），模式 `crossline.artifact-plan.v1`，top tier（`packages/codex/src/model-policy.ts`），登记在 worker 的 `requiredSkills`。契约在 `packages/core/src/artifact-plan.ts`：`ARTIFACT_PLAN_SCHEMA`（严格模式，结构化输出发现测试覆盖）+ `validateArtifactPlan`。供需对字段为 `{from, toLine, use, transfer:{metric, expected, unit}, lagDays, counterfactual, hoursSaved}`——在规格字段外加了 `hoursSaved`（反事实的小时数），因为出边上限的排序需要一个可比较的数，「3 张图表」与「5 位访谈对象」不可比。计划存在设置 `flywheel.artifacts`（`ARTIFACT_PLAN_SETTING`），随备份走。输入含各线画像事实与长期目标、所有进行中里程碑（含其他线已批准的）及其 outputs/inputs、`flywheel_*` 事实、保留部分 `kept`、兑现率低的产物类型 `lowFulfilment`。
2. **逐线设计带上供需对**：`lineArtifacts` 给每条线 `artifacts.produce` / `artifacts.consume`（含已有的生产者、等待它的消费者及其截止日），每条线运行前重算，所以先设计的线的新草稿就是后设计的线的生产者/消费者。`MILESTONE_PLAN_SCHEMA` 增加 `outputs[]`、`inputs[]`；`validateArtifactReferences` 在 `validateMilestoneProposal` 里检查；这些代码都进入 `MILESTONE_SOFT_CODES`（`ARTIFACT_SOFT_CODES`），修复用尽后 `keepMilestoneProposal` 用 `sanitizeArtifactReferences` 去掉不合格的引用再保留整条线，所以存下来的引用只会得出合格的关系。架构师 SKILL.md 删除关系模式、增加 Artifacts 段。
3. **关系由引用得出**：`deriveArtifactRelations`（纯函数）→ `syncArtifactRelations` / `retireUnderivedRelations`（`packages/db/src/artifacts.ts`），封装为 worker 的 `rederiveArtifactRelations`。关系 id `artifact:<产物>:<上游>-><下游>`。删除：`runRelations`、`MILESTONE_RELATIONS_SCHEMA`、`validateRelationsProposal`、`relationWarnings`、`relation-check.test.ts`、旧的关系模式提示。`createRelationReviser` 保留名字，改为「重新设计下游主线」（复核意见作为产物计划和架构师的 brief）。迁移 13：`milestone_anchors.outputs_json/inputs_json`，`milestone_relations.artifact_id/transfer_json/check_on/counterfactual`；快照导入按列名自省，旧快照可导入（有测试）；`pnpm doctor:ledger` 在 `user_version ≥ 13` 时检查这些列。
4. **保存前硬校验**（全部在代码里，退回修正）：
   - 产物对得上：上游 outputs 含 id、下游 inputs 引用、两端不同线（`MILESTONE_OUTPUT_UNKNOWN` / `MILESTONE_INPUT_UNKNOWN` / `MILESTONE_ARTIFACT_UNPRODUCED` / `SUPPLY_SAME_LINE`，推导时再查一遍）；
   - 时间顺序：`timeOrderProblem`：上游截止 ≤ 下游截止 − lagDays。**反馈回路的精确定义**：两条线互相供给即构成回路，回路上的每条边按至少 1 天滞后计算，因此回流必然落在原上游线的更晚里程碑（下一期），两个里程碑之间不可能互相供给——回路只存在于主线之间，不存在于里程碑之间；这类边的 kind 为 `recurring_feedback`，其余为 `reuses`。代码 `MILESTONE_INPUT_TOO_EARLY` / `MILESTONE_OUTPUT_TOO_LATE`；没有生产者时按产物的 `readyBy` 检查；
   - 可测传递量：`transfer.expected` 为大于 0 的有限数、有单位和计量对象（`SUPPLY_TRANSFER_NOT_NUMERIC` / `SUPPLY_TRANSFER_UNIT_MISSING`）；核对日 = 下游截止日（有人确认的截止日优先）；
   - 每条线最多 2 条出边（`MAX_OUTGOING_PER_LINE`）。**排序规则**：保留部分（已批准里程碑所依赖的）先占位；其余按反事实节省小时数降序，再按 `transfer.expected` 降序，再按产物 id；关系层面同样，已批准关系先占位，平局按核对日早者优先。超出的对被裁掉并写进 assumptions，不算拒绝。
   - 质量问题（反事实空泛、用途太短）走 `supplyWarnings` → `validation.warned`（subject `milestone_relation`）→ 现有复核。
5. **只重做一条线**：`keptArtifactPlan` 保留其他线的产物与需求，以及计划线中已批准里程碑产出或使用的产物和供需对（「指向已批准里程碑」= 上游已批准里程碑产出该产物，或接收线有已批准里程碑使用它）；模型只重算这条线的部分，不得重复列出保留的 id。`supersedeUntouchedDrafts` 不再批量归档关系；推导后只归档无法再推导出的候选（产物关系未再推导出，或端点已归档/不存在）。被本人去掉或被核对否定的关系永不复活。
6. **批准**：`approveArtifactRelationsFor`（db）在 `saveMilestoneEdit` 批准时调用（批量 `approve-batch` 与单个批准都走它）。规则：关系随下游里程碑批准；若下游在关系出现前已批准，则在上游批准时批准（两边决定都已做出）。主线页草稿列表每个草稿下列出跨主线产物，`DELETE /api/milestone-relations/[id]`（`isCrossSiteWrite` + `resolveAccessContext`，CSRF 发现测试自动覆盖）单独去掉，并记为一条 `relation_rejected` 偏好。
7. **核对问答**：新 AskKind `relation_check`（`apps/web/lib/artifact-relations.ts`），在核对日（含之后）对已批准、两端仍在的产物关系提问；兑现 / 部分（填实际数量）/ 没有（否定，写反例）；`milestone_relation.checked` 事件。`relationFulfilment`：兑现记 1、部分记 0.5、没有记 0；系统体检 `relations` + 设置页「跨线关系兑现率」环图与偏低类型标签；至少 2 次核对且兑现率 < 0.5 的产物类型作为 `lowFulfilment` 传给下一次产物计划。`importance` / `entersOn` 由 `decisionHorizon.annotate` 照常处理（该问答 urgency 为 soon，不打断）。
8. **任务层**：倒推上下文带 `artifacts.produce/use`（`milestoneArtifacts`），`BACKPLAN_SCHEMA` 步骤增加 `produces` / `uses`，校验每个产出恰由一个任务产出、每个使用至少被一个任务用到；任务 payload 记 `produces` / `uses`。`linkArtifactWork` 把生产任务写入使用任务的 `dependsOn`（跨线，排程据此先后，有排程单测）；`handOffArtifacts` 在 `human.completed` / `agent.delivered` 时（`transitionWorkOrder` 内）以及倒推保存后，把生产任务的文件证据作为使用任务的材料（归入下游项目、记一条任务记录、有步骤计划时请求重排），每个（产物、生产者、使用者）只一次。任务卡与对话框显示「产出供 … · …」「使用 … · … 的产出」（`ArtifactTag`）。副产品并入：落地任务 `uses: [byproduct:<主任务>:<线>]`，`producedArtifacts` 把副产品算作主任务的产物，交接同一套；落地期限用 `BYPRODUCT_LAG_DAYS`（2）。
9. **时间轴显示**：跨线边颜色取上游主线、待批准为虚线、违反时间顺序（如上游截止日后来改了）为红色断线并在图例中说明；边中点的标签为可聚焦按钮，悬停/聚焦显示产物、预期/实测传递量、核对日（与传递天数）、反事实。新样式在 `apps/web/app/milestones/flywheel-edges.css`。未改动 `dashboard-view.tsx`；关系的 status/from/to/kind 与 decide 路由保持不变。

#### 与规格的出入

- 供需对多了 `hoursSaved`（见上，排序需要）。
- 产物 id 必须以所属主线 id 开头（如 `research-figures`），用来保证只重做一条线时不会与保留的产物撞 id。
- 只重做一条线时，指向这条线、但没有已批准里程碑依赖的供需对属于「这条线的部分」，由本次运行重新给出（模型可以用保留的其他线产物作为 `from` 重新声明）。
- 依赖释放仍按现有排程规则：使用任务在生产任务**验收**后（或与之同在本次排程中时由求解器排序）才排入；交付时文件已先行交接。

#### 回放与在真实账号上应用

回放（不写真实账本，只在临时副本上跑，会消耗真实额度）：

```powershell
pnpm exec tsx scripts\artifact-plan-replay.ts            # 取第一条有已确认事实的主线
pnpm exec tsx scripts\artifact-plan-replay.ts research   # 指定主线
```

输出：重算前后的跨主线关系、产物计划、本次运行的耗时与修复次数、以及「不涉及该主线或已批准的关系中丢失的」条数（应为 0）。

在真实账号上应用（先问本人，F5/F6 会消耗额度）：重启 worker（新 Skill 需要装进隔离的 CODEX_HOME，`requiredSkills` 已登记），web 打开账本时自动跑迁移 13（会先留 `.v12.bak`）。然后在主线页对某条线「修改并重算草稿」或调用 `POST /api/milestones/propose`（`only: [line]`），即走产物计划 → 逐线设计 → 关系推导。批准草稿后 `approve-batch` 连带批准关系并触发 `/v1/goals/auto-backplan`，倒推出的任务带 `produces` / `uses`，依赖与交接自动生效。

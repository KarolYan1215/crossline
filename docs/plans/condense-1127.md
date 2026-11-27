# 浓缩与访谈修正（2026-11-27）

本人在 2026-11-27 定下的范围：访谈修正（A）、skill 合并（B）、事件分族（C）全部完成、两套回放通过之后，本人开始自用。原则：**能交给模型的交给模型**——质量与风格类要求写进 SKILL.md，代码只留安全、隐私、金钱、外部动作、结构和「核对模型的说法」这几类（CLAUDE.md「Accretion」）。不再为单次回放加一条规则，按场景泛化。

## 依据

三份盘点（只读）：账本事件约 335 种（真实账本 99 种、1660 行）、skill 66 个、访谈与画像里对自然语言的硬编码检查约 40 处 + `RULE_SPEC` 29 条。回放 11-26（11 轮）和 11-27（5 轮，DeepSeek-V4.1-Flash）。

## A. 访谈与画像

1. **数字只来自证据。** 画像 schema 里强制的数字（`compass.values[].score`、`energy.map[].skillScore/loveScore`、`lines.items[].share/targetShare`、`gap.pairs[].says`）改为可 null；删掉写手 SKILL.md「没谈到的价值给 45–55」，删掉占比静默缩放到 100。页面把 null 显示为「未谈到」，图表跳过该项。
2. **价值观分数由代码取 TwIVI。** 访谈前量表页的 TwIVI 测的正是这十项 Schwartz 价值观；分数由代码填入，模型不打分，只拿本人实际的行为（回复、文件、执行记录）对照量表分数做批判性分析：量表上看重的，做出来的是否一致。量表没做完时分数为 null，访谈提醒本人去做量表页。
3. **没有量表的数字靠访谈覆盖。** 精力（擅长/喜欢、充电/耗电）、各主线注意力占比、说与做五项，加成清单 `portrait_grounded` 里由模型判定的部分（与现有 `portrait:<section>` 同一机制）。没覆盖就继续问；问过仍不知道就 null。访谈完整度以这些部分为准，不设轮数上限。
4. **不编细节。** 写手和对话的 prompt：每句可追到本人说过的话或文件；推断写成推断；主线之间的流向只写本人说过的。
5. **一轮一件事。** 对话 prompt：一轮只有一个洞察或卡片，加一个问题；洞察要能用一句话核对。
6. **规则移进 prompt。** 质量类硬编码检查删除，规则写进对应 SKILL.md：`unsaidCounts` 回退（IR-200）、记录型 IR（014/047/051/165/190/191 及 006、123 的记录半）、`stageAsked`、`questionsAsked` 正则、卡片「至少两条回复」、`typeSummaryProblem`（已失效）、`narrativeProblems` 的字数/用词/MBTI 检查、`dayOption`、worker 里未登记的 `END_HINT`/`CARD_NOTATION`/`PENDING_TALK`/`SCORE_TALK`/`NO_NEAR_TERM`。能用 schema 解决的（`role: start|end`、`about` 必填、`maxLength`）改 schema。**保留**：自伤与安全、隐私遮蔽、逐字引用核对、日期证据窗口、id 与结构、同意。
7. **回放走真实路径。** 扮演者先做量表页（IPIP-NEO-120 + TwIVI，按人物设定作答），不限轮数，模型判定完整即结束。

## B. Skill：66 → 约 35

合并后一个 skill 一个场景，用 `mode` 区分用途；档位与不降级按 `skill:mode` 设；第三方模型准入记录把旧 skill 的结果映射到新 `skill:mode`，不重测。

- 画像：portrait-writer + portrait-narrative + portrait-illustrator → `portrait`
- 做事方法：method-research + insight-compiler → `line-method`
- 规划：goal-splitter 并入 milestone-architect；task-titler 并入 goal-backplanner；artifact-planner + flywheel-scout → `cross-line-planner`；milestone-risk-reviewer + gate-admission → `milestone-review`；step-planner + manualbook-designer + archetype-curator → `task-planner`；plan-explainer + energy-advisor → `schedule-advisor`
- 判定：milestone-gate + gate-completion + progress-judge + deliverable-check → `evidence-judge`；gate-priority + gate-front → `focus`；gate-attention + gate-setback + weekly-insight → `weekly-review`
- 表单：form-filler + form-observer + form-browser-agent → `form-page`；form-checker + gate-night → `outward-check`
- 调研：due-diligence + onboarding-research + material-researcher + skill-scout + opportunity-needs → `research`；opportunity-reader + visa-finder → `page-reader`
- 录入：calendar-classifier + folder-classifier + time-attributor → `line-filer`；recording-digest + source-digest + background-facts → `capture-digest`；mail-triage + import-triage → `inbox-triage`
- 助手：agent + agent-tools → `agent`（`toolset`）
- gate-drill（本人的 Verilog 每周练习）移出内置插件，成为本人那条线自己的 skill / 工作流。
- `REQUIRED_SKILLS` 补上生产在用而漏列的六个。

## C. 事件：约 335 → 47

- 没有读者的本人决定类审计（约 55 种）→ `person.decided{subject, decision}`
- 后台运行与冷却标记（约 35 种）→ `job.ran{job, state}`
- 进度心跳（`manualbook.progress` 260 行、`gate.attempted` 等）移出账本，进 JSONL 日志
- 其余按实体 → `<实体>.changed{change}`（以 `op.applied` 为样板）
- `capture.created`、`work_order.transitioned` 保留原名（已安装副本和遥测收集端按名读）
- 历史行一次性迁移（schema 迁移的一步，迁移前自动备份），本机与托管一起上线；代码里只留一套名字
- 顺手修：`effectiveness.ts` 读 `milestone_relation.decided`、写的是复数；遥测白名单里五个已无人写的类型；`review:ledger` 的统计漏掉常量、包装函数与模板写入

### C 的结果（2026-11-27）

**343 → 47。** 代码与账本里出现过的旧名 343 个（329 个改名、12 个独立类型原样保留、2 种进度心跳删除）；之后只有 47 个类型，登记在 `packages/core/src/event-types.ts`（`appendEvent` / `listEvents` 只收这些名字，拼错或已退役的名字过不了 typecheck）：

- **12 个独立类型**（热的状态来源，读者多、意义自成一类）：`calendar.published`、`capture.created`、`dates.decided`、`dates.extracted`、`gate.judged`、`git.commit_seen`、`milestone.proposed`、`milestone_gate.judged`、`notification.sent`、`op.applied`、`op.undone`、`work_order.transitioned`。
- **33 个 `<实体>.changed{change}`**，旧名数：skill 24、opportunity 22、task 20、work_order 19、agent 15、milestone 10、remote 10、automation 9、goal 9、line 9、waiting 8、gate 7、insight 6、materials 6、plan 6、ask 5、milestone_relation 5、recording 5、deliverable 4、energy 4、execution 4、milestone_gate 4、onboarding 4、portrait 4、source 4、import 3、mail 3、profile 3、artifact 2、model 2、report 2、validation 2、capture 1。
- **`job.ran{job, state}`**：41 个旧名、32 个 job。旧 payload 自己的 `state`（`collect` 的运行结果）挪到 `result`。
- **`person.decided{subject, decision}`**：47 个旧名、25 个 subject。payload 自己的 `decision`（`diligence.decided`、`opportunity.watch.decided` 里本人的答案）保留，不被覆盖。
- **移出账本**：`manualbook.progress`、`gate.attempted` 进 `<数据目录>/telemetry/<kind>.jsonl`（`appendTick` / `readTicks`，`packages/db/src/rule-telemetry.ts`）。任务页的说明书进度读 `manualbook-progress` 日志；关口的重试次数读 `gate-attempts` 日志。

**迁移**：schema 迁移 28（`condenseEventTypes`，`packages/db/src/event-condense.ts`，迁移前照例强制备份 `.v27.bak`），本机和托管一样跑；`importSnapshot` 也对导入的快照跑一遍，旧导出和未升级服务器的镜像进来就是新名字。幂等：第二遍找不到旧名。旧名只活在这张映射表里。

**真实账本副本**（只读快照复制后迁移）：1660 行 / 99 种 → 1391 行 / 33 种（细分 96 项），删掉 269 行心跳（`manualbook.progress` 260、`gate.attempted` 9）；迁移 34 ms；登记表外的类型或 change 为 0；`doctor` 前后都无发现。

**顺手修的读者**（类型化之后 typecheck 才暴露出来的死读）：

- `effectiveness.ts` 读 `milestone_relation.decided`，写的是 `milestone_relations.decided`：关系决定从没算进周效果。
- 遥测白名单 `LEDGER_EVENT_TYPES` 改由 `LEDGER_TELEMETRY` 生成，线上名为 `类型` 或 `类型:change`；收集端 `apps/collector/src/dashboard.ts` 新旧名都认。
- 从没写过的类型被当作在读：`human.completed`（完成关口 3 处，改读 `work_order.transitioned` 的 `human.completed`）、`work_order.accepted` / `evidence.accepted`（改读转入 `accepted` 的状态转移）、`approval.revoked`（撤销次数从没加一，第二次撤销复用第一次的幂等键，什么都不做）、`weekly_review.question`（v2 之后无写入，删掉）。`goal.backplan_input_waiting` 仍只有读者（待确认卡和倒推都读，只有测试写），登记为 `goal.changed` `backplan_input_waiting` 留着，`review:ledger` 列在「登记了但代码不写」。
- `scripts/eval-lib.ts` 的拒绝类里 `approval.declined`、`skill.rejected`、`assess.declined` 从不是账本事件（节点上报、日志行、设置键），去掉。
- `pnpm review:ledger` 改从登记表计数（47 类型、285 项细分），按调用上下文判断读写，并对 `--db` 列出账本里登记表没有的名字。仍是启发式：常用词（`done`、`created`）会让某项看起来有读者，宁可漏报不误报。

<details><summary>旧名 → 新名（329 行；另有两种进度心跳删除）</summary>

| 旧类型 | 新类型 | 字段 |
|---|---|---|
| `agent.approval.decided` | `agent.changed` | change=`approval_decided` |
| `agent.approval.requested` | `agent.changed` | change=`approval_requested` |
| `agent.blocked_acknowledged` | `agent.changed` | change=`blocked_acknowledged` |
| `agent.category.requested` | `agent.changed` | change=`category_requested` |
| `agent.question.answered` | `agent.changed` | change=`question_answered` |
| `agent.question.expired` | `agent.changed` | change=`question_expired` |
| `agent.question.requested` | `agent.changed` | change=`question_requested` |
| `agent.retry_requested` | `agent.changed` | change=`retry_requested` |
| `agent.task.blocked` | `agent.changed` | change=`task_blocked` |
| `agent.task.completed` | `agent.changed` | change=`task_completed` |
| `agent.task.files_checked` | `agent.changed` | change=`task_files_checked` |
| `agent.task.reopened` | `agent.changed` | change=`task_reopened` |
| `agent.task.requested` | `agent.changed` | change=`task_requested` |
| `agent.task.reviewed` | `agent.changed` | change=`task_reviewed` |
| `agent.task.settled` | `agent.changed` | change=`task_settled` |
| `apply.kit.edited` | `person.decided` | subject=`apply.kit` decision=`edited` |
| `apply.profile.removed` | `person.decided` | subject=`apply.profile` decision=`removed` |
| `apply.profile.saved` | `person.decided` | subject=`apply.profile` decision=`saved` |
| `archetypes.curated` | `job.ran` | job=`archetypes.curate` state=`done` |
| `artifact_plan.saved` | `artifact.changed` | change=`plan_saved` |
| `artifact.handed_off` | `artifact.changed` | change=`handed_off` |
| `ask.answered` | `ask.changed` | change=`answered` |
| `ask.auto_answered` | `ask.changed` | change=`auto_answered` |
| `ask.snoozed` | `ask.changed` | change=`snoozed` |
| `assessment.answered` | `work_order.changed` | change=`assessment_answered` |
| `assessment.deferred` | `work_order.changed` | change=`assessment_deferred` |
| `assessment.pending` | `work_order.changed` | change=`assessment_pending` |
| `automation.changed` | `automation.changed` | change=`edited` |
| `automation.created` | `automation.changed` | change=`created` |
| `automation.deleted` | `automation.changed` | change=`deleted` |
| `automation.design_attempted` | `automation.changed` | change=`design_attempted` |
| `automation.design_failed` | `automation.changed` | change=`design_failed` |
| `automation.refused` | `automation.changed` | change=`refused` |
| `automation.requested` | `automation.changed` | change=`requested` |
| `automation.restored` | `automation.changed` | change=`restored` |
| `automation.suggested` | `automation.changed` | change=`suggested` |
| `availability.saved` | `person.decided` | subject=`availability` decision=`saved` |
| `block.confirmed` | `work_order.changed` | change=`block_confirmed` |
| `block.snoozed` | `work_order.changed` | change=`block_snoozed` |
| `byproduct.planned` | `work_order.changed` | change=`byproduct_planned` |
| `calendar.published.google` | `job.ran` | job=`calendar.publish.google` state=`done` |
| `calendar.write.authorized` | `person.decided` | subject=`calendar.write` decision=`authorized` |
| `capture.context_added` | `person.decided` | subject=`capture` decision=`context_added` |
| `capture.discarded` | `capture.changed` | change=`discarded` |
| `capture.promoted_manually` | `person.decided` | subject=`capture` decision=`promoted_manually` |
| `capture.restored` | `person.decided` | subject=`capture` decision=`restored` |
| `collect.handover` | `job.ran` | job=`collect` state=`handover` |
| `collect.ran` | `job.ran` | job=`collect` state=`done` |
| `collect.started` | `job.ran` | job=`collect` state=`started` |
| `criteria.assessed` | `task.changed` | change=`criteria_assessed` |
| `criterion.confirmed` | `task.changed` | change=`criterion_confirmed` |
| `date.advanced` | `job.ran` | job=`date.advance` state=`done` |
| `datepair.created` | `goal.changed` | change=`datepair_created` |
| `dates.unrecorded` | `onboarding.changed` | change=`dates_unrecorded` |
| `deliverable.gap_answered` | `deliverable.changed` | change=`gap_answered` |
| `deliverable.judged` | `deliverable.changed` | change=`judged` |
| `deliverable.settled` | `deliverable.changed` | change=`settled` |
| `deliverable.withdrawn` | `deliverable.changed` | change=`withdrawn` |
| `design.note_set` | `profile.changed` | change=`design_note_set` |
| `diligence.decided` | `person.decided` | subject=`diligence` decision=`decided` |
| `diligence.done` | `job.ran` | job=`diligence` state=`done` |
| `drill.answered` | `gate.changed` | change=`drill_answered` |
| `drill.graded` | `gate.changed` | change=`drill_graded` |
| `drill.issue_failed` | `gate.changed` | change=`drill_issue_failed` |
| `drill.issued` | `gate.changed` | change=`drill_issued` |
| `energy.advice.dismissed` | `energy.changed` | change=`advice_dismissed` |
| `energy.observed` | `energy.changed` | change=`observed` |
| `energy.transition_outcome` | `energy.changed` | change=`transition_outcome` |
| `energy.transition_predicted` | `energy.changed` | change=`transition_predicted` |
| `estimate.adjusted` | `person.decided` | subject=`estimate` decision=`adjusted` |
| `execution.confirmed` | `execution.changed` | change=`confirmed` |
| `execution.paused` | `execution.changed` | change=`paused` |
| `execution.resumed` | `execution.changed` | change=`resumed` |
| `execution.stopped_at` | `execution.changed` | change=`stopped_at` |
| `favourites.topics_changed` | `person.decided` | subject=`favourites` decision=`topics_changed` |
| `flywheel.finding` | `insight.changed` | change=`found` |
| `flywheel.nightly.failed` | `job.ran` | job=`flywheel.nightly` state=`failed` |
| `flywheel.nightly.ran` | `job.ran` | job=`flywheel.nightly` state=`done` |
| `flywheel.nightly.skipped` | `job.ran` | job=`flywheel.nightly` state=`skipped` |
| `flywheel.relation_proposed` | `milestone_relation.changed` | change=`proposed` |
| `gate.confirmed` | `gate.changed` | change=`confirmed` |
| `gate.overridden` | `gate.changed` | change=`overridden` |
| `goal.backplan_blocked` | `goal.changed` | change=`backplan_blocked` |
| `goal.backplan_declined` | `goal.changed` | change=`backplan_declined` |
| `goal.backplan_input_resolved` | `goal.changed` | change=`backplan_input_resolved` |
| `goal.backplan_input_supplied` | `goal.changed` | change=`backplan_input_supplied` |
| `goal.backplan_input_waiting` | `goal.changed` | change=`backplan_input_waiting` |
| `goal.backplan_proposed` | `goal.changed` | change=`backplan_proposed` |
| `goal.backplan_rerun_requested` | `goal.changed` | change=`backplan_rerun_requested` |
| `goal.settings_confirmed` | `goal.changed` | change=`settings_confirmed` |
| `import.closed_upstream` | `import.changed` | change=`closed_upstream` |
| `import.confirmed` | `person.decided` | subject=`import` decision=`confirmed` |
| `import.connected` | `person.decided` | subject=`import` decision=`connected` |
| `import.item_captured` | `import.changed` | change=`item_captured` |
| `import.item_merged` | `import.changed` | change=`item_merged` |
| `import.removed` | `person.decided` | subject=`import` decision=`removed` |
| `insight.approved` | `insight.changed` | change=`approved` |
| `insight.rejected` | `insight.changed` | change=`rejected` |
| `insight.revoked` | `insight.changed` | change=`revoked` |
| `instructions.set` | `profile.changed` | change=`instructions_set` |
| `invite.redeemed` | `person.decided` | subject=`invite` decision=`redeemed` |
| `lessons.imported_from_codex_memory` | `job.ran` | job=`lessons.codex_memory_import` state=`done` |
| `line.candidates_split` | `line.changed` | change=`candidates_split` |
| `line.created` | `line.changed` | change=`created` |
| `line.goal_edit_adopted` | `line.changed` | change=`goal_edit_adopted` |
| `line.goal_edit_dismissed` | `line.changed` | change=`goal_edit_dismissed` |
| `line.goal_split` | `line.changed` | change=`goal_split` |
| `line.ranked` | `line.changed` | change=`ranked` |
| `line.redraft_requested` | `line.changed` | change=`redraft_requested` |
| `line.updated` | `line.changed` | change=`updated` |
| `lines.set_up` | `line.changed` | change=`set_up` |
| `mail.connected` | `person.decided` | subject=`mail` decision=`connected` |
| `mail.known` | `job.ran` | job=`mail.known` state=`done` |
| `mail.removed` | `person.decided` | subject=`mail` decision=`removed` |
| `mail.reply.closed` | `mail.changed` | change=`reply_closed` |
| `mail.reply.drafted` | `mail.changed` | change=`reply_drafted` |
| `mail.sent_seen` | `mail.changed` | change=`sent_seen` |
| `mail.triaged` | `job.ran` | job=`mail.triage` state=`done` |
| `manualbook.built` | `materials.changed` | change=`manualbook_built` |
| `materials.blocked` | `materials.changed` | change=`blocked` |
| `materials.questions` | `materials.changed` | change=`questions` |
| `materials.retry_requested` | `materials.changed` | change=`retry_requested` |
| `method.research_blocked` | `job.ran` | job=`method.research` state=`blocked` |
| `method.researched` | `job.ran` | job=`method.research` state=`done` |
| `milestone_gate.auto_acceptance_revoked` | `milestone_gate.changed` | change=`auto_acceptance_revoked` |
| `milestone_gate.auto_accepted` | `milestone_gate.changed` | change=`auto_accepted` |
| `milestone_gate.blocked` | `milestone_gate.changed` | change=`blocked` |
| `milestone_gate.retry_requested` | `milestone_gate.changed` | change=`retry_requested` |
| `milestone_relation.checked` | `milestone_relation.changed` | change=`checked` |
| `milestone_relation.refuted` | `milestone_relation.changed` | change=`refuted` |
| `milestone_relation.removed` | `milestone_relation.changed` | change=`removed` |
| `milestone_relations.decided` | `milestone_relation.changed` | change=`decided` |
| `milestone.created` | `milestone.changed` | change=`created` |
| `milestone.kept_parked` | `milestone.changed` | change=`kept_parked` |
| `milestone.overdue` | `milestone.changed` | change=`overdue` |
| `milestone.overdue_resolved` | `milestone.changed` | change=`overdue_resolved` |
| `milestone.parked` | `milestone.changed` | change=`parked` |
| `milestone.retrospective` | `milestone.changed` | change=`retrospective` |
| `milestone.revised` | `milestone.changed` | change=`revised` |
| `milestone.risk_reviewed` | `milestone.changed` | change=`risk_reviewed` |
| `milestone.unparked` | `milestone.changed` | change=`unparked` |
| `missed.handled` | `work_order.changed` | change=`missed_handled` |
| `model.provider.changed` | `model.changed` | change=`provider_changed` |
| `model.provider.conformance` | `model.changed` | change=`provider_conformance` |
| `onboarding.citation_warned` | `job.ran` | job=`onboarding.citation_check` state=`warned` |
| `onboarding.extract_failed` | `job.ran` | job=`onboarding.extract` state=`failed` |
| `onboarding.extracted` | `job.ran` | job=`onboarding.extract` state=`done` |
| `onboarding.finish_requested` | `onboarding.changed` | change=`finish_requested` |
| `onboarding.insight_rated` | `person.decided` | subject=`onboarding` decision=`insight_rated` |
| `onboarding.round_edited` | `onboarding.changed` | change=`round_edited` |
| `onboarding.settings_applied` | `person.decided` | subject=`onboarding` decision=`settings_applied` |
| `onboarding.start_confirmed` | `person.decided` | subject=`onboarding` decision=`start_confirmed` |
| `onboarding.unrecorded` | `onboarding.changed` | change=`unrecorded` |
| `opportunity.apply_self` | `opportunity.changed` | change=`apply_self` |
| `opportunity.confirmed` | `opportunity.changed` | change=`confirmed` |
| `opportunity.decided` | `person.decided` | subject=`opportunity` decision=`decided` |
| `opportunity.form.blocked` | `opportunity.changed` | change=`form_blocked` |
| `opportunity.form.confirmed` | `opportunity.changed` | change=`form_confirmed` |
| `opportunity.form.continued` | `opportunity.changed` | change=`form_continued` |
| `opportunity.form.fallback` | `opportunity.changed` | change=`form_fallback` |
| `opportunity.form.opened` | `opportunity.changed` | change=`form_opened` |
| `opportunity.form.page` | `opportunity.changed` | change=`form_page` |
| `opportunity.form.previewed` | `opportunity.changed` | change=`form_previewed` |
| `opportunity.form.queued` | `opportunity.changed` | change=`form_queued` |
| `opportunity.form.ready_to_submit` | `opportunity.changed` | change=`form_ready_to_submit` |
| `opportunity.form.receipt_asked` | `opportunity.changed` | change=`form_receipt_asked` |
| `opportunity.form.session_lost` | `opportunity.changed` | change=`form_session_lost` |
| `opportunity.form.started` | `opportunity.changed` | change=`form_started` |
| `opportunity.form.stopped` | `opportunity.changed` | change=`form_stopped` |
| `opportunity.form.submit_clicked` | `opportunity.changed` | change=`form_submit_clicked` |
| `opportunity.form.submitted` | `opportunity.changed` | change=`form_submitted` |
| `opportunity.less` | `person.decided` | subject=`opportunity` decision=`less` |
| `opportunity.less_undone` | `person.decided` | subject=`opportunity` decision=`less_undone` |
| `opportunity.milestone_written` | `opportunity.changed` | change=`milestone_written` |
| `opportunity.needs.derived` | `opportunity.changed` | change=`needs_derived` |
| `opportunity.outcome` | `opportunity.changed` | change=`outcome` |
| `opportunity.result` | `opportunity.changed` | change=`result` |
| `opportunity.scout.done` | `job.ran` | job=`opportunity.scout` state=`done` |
| `opportunity.watch.added` | `person.decided` | subject=`opportunity.watch` decision=`added` |
| `opportunity.watch.decided` | `person.decided` | subject=`opportunity.watch` decision=`decided` |
| `opportunity.watch.edited` | `person.decided` | subject=`opportunity.watch` decision=`edited` |
| `opportunity.watch.retired` | `person.decided` | subject=`opportunity.watch` decision=`retired` |
| `opportunity.watch.state` | `opportunity.changed` | change=`watch_state` |
| `opportunity.watches.migrated` | `job.ran` | job=`opportunity.watches.migrate` state=`done` |
| `permission.auto_approved` | `insight.changed` | change=`auto_approved` |
| `permission.mode_changed` | `person.decided` | subject=`permission` decision=`mode_changed` |
| `permission.rejected` | `person.decided` | subject=`permission` decision=`rejected` |
| `person.question.asked` | `ask.changed` | change=`question_asked` |
| `plan.approved` | `plan.changed` | change=`approved` |
| `plan.change_archived` | `plan.changed` | change=`change_archived` |
| `plan.explained` | `plan.changed` | change=`explained` |
| `plan.reality_changed` | `plan.changed` | change=`reality_changed` |
| `plan.version_archived` | `plan.changed` | change=`version_archived` |
| `portrait.blocked` | `portrait.changed` | change=`blocked` |
| `portrait.gap_rewritten` | `portrait.changed` | change=`gap_rewritten` |
| `portrait.narrative_rated` | `person.decided` | subject=`portrait` decision=`narrative_rated` |
| `portrait.requested` | `portrait.changed` | change=`requested` |
| `portrait.written` | `portrait.changed` | change=`written` |
| `prep.question_answered` | `person.decided` | subject=`prep` decision=`question_answered` |
| `profile.claim_judged` | `person.decided` | subject=`profile` decision=`claim_judged` |
| `profile.confirmed` | `profile.changed` | change=`confirmed` |
| `profile.item_answered` | `person.decided` | subject=`profile` decision=`item_answered` |
| `profile.points_migrated` | `job.ran` | job=`profile.points.migrate` state=`done` |
| `profile.portrait_feedback` | `person.decided` | subject=`profile` decision=`portrait_feedback` |
| `profile.privacy_set` | `person.decided` | subject=`profile` decision=`privacy_set` |
| `profile.scale_analysed` | `job.ran` | job=`profile.scale.analyse` state=`done` |
| `profile.scale_changed` | `person.decided` | subject=`profile` decision=`scale_changed` |
| `progress.answered` | `work_order.changed` | change=`progress_answered` |
| `recording.digested` | `recording.changed` | change=`digested` |
| `recording.failed` | `recording.changed` | change=`failed` |
| `recording.silent` | `recording.changed` | change=`silent` |
| `recording.transcribed` | `recording.changed` | change=`transcribed` |
| `recording.transcripts_deleted` | `recording.changed` | change=`transcripts_deleted` |
| `remote.approval` | `remote.changed` | change=`approval` |
| `remote.command` | `remote.changed` | change=`command` |
| `remote.files` | `remote.changed` | change=`files` |
| `remote.folder.read` | `remote.changed` | change=`folder_read` |
| `remote.form.submitted` | `remote.changed` | change=`form_submitted` |
| `remote.message` | `remote.changed` | change=`message` |
| `remote.refused` | `remote.changed` | change=`refused` |
| `remote.session.ended` | `remote.changed` | change=`session_ended` |
| `remote.session.interrupted` | `remote.changed` | change=`session_interrupted` |
| `remote.session.started` | `remote.changed` | change=`session_started` |
| `repair.frozen_race` | `job.ran` | job=`repair.frozen_race` state=`done` |
| `repair.import_duplicates` | `job.ran` | job=`repair.import_duplicates` state=`done` |
| `repair.line_attributes` | `job.ran` | job=`repair.line_attributes` state=`done` |
| `repair.own_completion` | `job.ran` | job=`repair.own_completion` state=`done` |
| `report.item_added` | `report.changed` | change=`item_added` |
| `report.item_dismissed` | `report.changed` | change=`item_dismissed` |
| `return.answered` | `ask.changed` | change=`return_answered` |
| `return.tidied` | `job.ran` | job=`return.tidy` state=`done` |
| `risk.accepted` | `milestone.changed` | change=`risk_accepted` |
| `schedule.params_saved` | `person.decided` | subject=`schedule` decision=`params_saved` |
| `schedule.preferences_saved` | `person.decided` | subject=`schedule` decision=`preferences_saved` |
| `schedule.time_zone_detected` | `job.ran` | job=`schedule.time_zone_detect` state=`done` |
| `selfcheck.ran` | `job.ran` | job=`selfcheck` state=`done` |
| `setback.reported` | `gate.changed` | change=`setback_reported` |
| `site.read` | `job.ran` | job=`site.read` state=`done` |
| `site.resumed` | `job.ran` | job=`site.read` state=`resumed` |
| `skill.grown.absorb_dropped` | `job.ran` | job=`skill.grown.absorb` state=`dropped` |
| `skill.grown.attempted` | `skill.changed` | change=`grown_attempted` |
| `skill.grown.consented` | `skill.changed` | change=`grown_consented` |
| `skill.grown.created` | `skill.changed` | change=`grown_created` |
| `skill.grown.feedback` | `skill.changed` | change=`grown_feedback` |
| `skill.grown.improve_skipped` | `job.ran` | job=`skill.grown.improve` state=`skipped` |
| `skill.grown.improve_started` | `job.ran` | job=`skill.grown.improve` state=`started` |
| `skill.grown.logged_in` | `person.decided` | subject=`skill.grown` decision=`logged_in` |
| `skill.grown.merged` | `skill.changed` | change=`grown_merged` |
| `skill.grown.ran` | `job.ran` | job=`skill.grown.run` state=`done` |
| `skill.grown.rejected` | `skill.changed` | change=`grown_rejected` |
| `skill.grown.removed` | `skill.changed` | change=`grown_removed` |
| `skill.grown.restored` | `skill.changed` | change=`grown_restored` |
| `skill.grown.result` | `job.ran` | job=`skill.grown.run` state=`result` |
| `skill.grown.reverted` | `skill.changed` | change=`grown_reverted` |
| `skill.grown.revised` | `skill.changed` | change=`grown_revised` |
| `skill.grown.revision_rejected` | `skill.changed` | change=`grown_revision_rejected` |
| `skill.grown.revision_skipped` | `job.ran` | job=`skill.grown.revise` state=`skipped` |
| `skill.grown.unmerged` | `skill.changed` | change=`grown_unmerged` |
| `skill.grown.updated` | `skill.changed` | change=`grown_updated` |
| `skill.mine.blocked` | `skill.changed` | change=`mine_blocked` |
| `skill.mine.rewritten` | `skill.changed` | change=`mine_rewritten` |
| `skill.public.installed` | `skill.changed` | change=`public_installed` |
| `skill.public.lines_added` | `skill.changed` | change=`public_lines_added` |
| `skill.public.rejected` | `skill.changed` | change=`public_rejected` |
| `skill.public.removed` | `skill.changed` | change=`public_removed` |
| `skill.public.scouted` | `skill.changed` | change=`public_scouted` |
| `skill.public.search_requested` | `skill.changed` | change=`public_search_requested` |
| `skill.public.updated` | `skill.changed` | change=`public_updated` |
| `skill.public.wanted` | `skill.changed` | change=`public_wanted` |
| `skill.scripts_allowed` | `person.decided` | subject=`skill` decision=`scripts_allowed` |
| `skill.scripts_revoked` | `person.decided` | subject=`skill` decision=`scripts_revoked` |
| `source.project_assigned` | `source.changed` | change=`project_assigned` |
| `source.project_cleared` | `source.changed` | change=`project_cleared` |
| `source.project_inferred` | `source.changed` | change=`project_inferred` |
| `source.refused` | `source.changed` | change=`refused` |
| `source.removed` | `person.decided` | subject=`source` decision=`removed` |
| `source.restored` | `person.decided` | subject=`source` decision=`restored` |
| `sources.folder_content_removed` | `person.decided` | subject=`sources` decision=`folder_content_removed` |
| `sources.folder_revoked` | `person.decided` | subject=`sources` decision=`folder_revoked` |
| `step.owner_chosen` | `person.decided` | subject=`step` decision=`owner_chosen` |
| `target.set` | `person.decided` | subject=`target` decision=`set` |
| `task.duplicate_prevented` | `task.changed` | change=`duplicate_prevented` |
| `task.material_provided` | `task.changed` | change=`material_provided` |
| `task.merged` | `task.changed` | change=`merged` |
| `task.need_checked` | `task.changed` | change=`need_checked` |
| `task.need_from_mail` | `task.changed` | change=`need_from_mail` |
| `task.note` | `task.changed` | change=`note` |
| `task.overdue_resolved` | `task.changed` | change=`overdue_resolved` |
| `task.postponed` | `task.changed` | change=`postponed` |
| `task.progress_judged` | `task.changed` | change=`progress_judged` |
| `task.progress_reported` | `task.changed` | change=`progress_reported` |
| `task.renamed` | `task.changed` | change=`renamed` |
| `task.step_estimated` | `task.changed` | change=`step_estimated` |
| `task.step_focused` | `task.changed` | change=`step_focused` |
| `task.step_progress` | `task.changed` | change=`step_progress` |
| `task.step_resume_noted` | `task.changed` | change=`step_resume_noted` |
| `task.steps_blocked` | `task.changed` | change=`steps_blocked` |
| `task.steps_planned` | `task.changed` | change=`steps_planned` |
| `task.steps_replan_requested` | `task.changed` | change=`steps_replan_requested` |
| `tasks.titled` | `job.ran` | job=`tasks.title` state=`done` |
| `tutorial.blocked` | `materials.changed` | change=`tutorial_blocked` |
| `tutorial.requested` | `materials.changed` | change=`tutorial_requested` |
| `validation.reviewed` | `validation.changed` | change=`reviewed` |
| `validation.warned` | `validation.changed` | change=`warned` |
| `waiting.arrived` | `waiting.changed` | change=`arrived` |
| `waiting.arrived_by_file` | `waiting.changed` | change=`arrived_by_file` |
| `waiting.blocks_added` | `waiting.changed` | change=`blocks_added` |
| `waiting.cancelled` | `waiting.changed` | change=`cancelled` |
| `waiting.created` | `waiting.changed` | change=`created` |
| `waiting.deferred` | `waiting.changed` | change=`deferred` |
| `waiting.mail_seen` | `waiting.changed` | change=`mail_seen` |
| `waiting.reopened` | `waiting.changed` | change=`reopened` |
| `week.committed` | `plan.changed` | change=`week_committed` |
| `weekly_review.insight_proposal` | `insight.changed` | change=`weekly_proposal` |
| `weekly_review.insight_run` | `job.ran` | job=`weekly_review.insight` state=`done` |
| `work_order.archived` | `work_order.changed` | change=`archived` |
| `work_order.auto_approval_revoked` | `work_order.changed` | change=`auto_approval_revoked` |
| `work_order.auto_approved` | `work_order.changed` | change=`auto_approved` |
| `work_order.auto_closed` | `work_order.changed` | change=`auto_closed` |
| `work_order.deferred` | `work_order.changed` | change=`deferred` |
| `work_order.drill_swept` | `work_order.changed` | change=`drill_swept` |
| `work_order.due_advanced` | `work_order.changed` | change=`due_advanced` |
| `work_order.due_changed` | `work_order.changed` | change=`due_changed` |
| `work_order.due_confirmed` | `work_order.changed` | change=`due_confirmed` |
| `work_order.family_backfilled` | `job.ran` | job=`work_order.family_backfill` state=`done` |
| `work_order.outcome_reported` | `work_order.changed` | change=`outcome_reported` |
| `work_order.reopened` | `work_order.changed` | change=`reopened` |
| `work_split.reorganized` | `job.ran` | job=`work_split.reorganize` state=`done` |
| `workflow.requested` | `skill.changed` | change=`workflow_requested` |

</details>

## 回放 2026-11-27（ChatGPT 路线，人物 a）的发现与修正

48 轮后因 Codex 额度用完中断（`SKILL_USAGE_LIMIT`），访谈没有结束。原因不在抽取：要点规则下各部分的散文本来就只由最后的报告写（`portraitTask`，2026-11-26），所以 sections 通道的 `profileSections` 全为 null 是设计如此。

- **`portrait_fields` 在访谈中无法完成。** 它读的画像字段只在本人按「结束并出报告」后由报告写入（`projectReport`），访谈期间没有任何一问能让它完成；回放以「清单完整」为终点，所以永远停不下来。改为延后项（`deferred`），同 `portrait_synthesis`。每部分有没有本人依据仍由 `portrait_grounded` 判。
- **模型不回头判已收尾部分的项。** 第 19–23 题已答齐精力（充电、耗电、擅长与喜欢、时段），`portrait:energy` 和 `portrait:method` 40 轮里一直「未判」。两处：快照里每个部分的「缺」都重复整项的说明（六个标签全列），看不出哪一部分缺；SKILL 只要求写「有变化的项」。现在每部分带自己的问题（`PORTRAIT_PARTS[].ask`），SKILL 要求每轮把「未判」和 `partial` 的项都过一遍，不论哪一部分、是否已收尾；收尾一部分时它的每一项都要有判定。
- **回放的终点** 改为访谈自己的项都已判定（`interviewOwnedOpen` 为空）；画像字段和本人的「符合」在报告之后。
- **额度。** 对话线程每轮带着之前所有轮的账本快照，到第 48 轮单次调用约 30 万 token，全程约 2060 万输入 token（98% 命中缓存），三条抽取通道另计。2026-11-17 的决定是访谈线程只在接近运行时上限时压缩；是否提前压缩，待本人决定。

# F5 / F6 实现记录：产物优先的联合规划与任务层产出 → 使用

对应设计稿 `docs/flywheel-and-views.md` 第 5、6 节。本文是开发记录与给本人的说明，合并后由主线程并入 `CLAUDE.md` / 用户指南。

## 给本人的说明（中文，界面口径）

重新设计里程碑时，系统先列出每条主线这一期会产出的东西（论文图表、数据集、视频、访谈记录……），以及哪几样会被另一条主线直接用上；每条主线最多向外供给两样。之后各主线的里程碑围绕这些产出设计：产出它的里程碑写明「产出」，用到它的里程碑写明「使用」并在推导里算清它省下多少。飞轮关系不再另外猜测，而是从这些引用得出，每条都写明产物、预期传递量（如「3 张图表」）、核对日（下游里程碑的截止日）和反事实（没有它下游要多花多少小时或缺什么）。主线页的草稿列表里，每个草稿下列出它使用和供给的跨主线产物，可以单独去掉；批准下游里程碑时，这些关系随之批准。到核对日，待决事项会问「研究 · X 是否给 自媒体 · Y 提供了 3 张图表？」：兑现、部分或没有；「没有」会把这条关系标为不成立。系统体检里多了「跨线关系兑现率」，兑现率低的产物类型，下次规划时会少安排。只重做一条主线时，其他主线的产出和已批准里程碑依赖的供需对保持不变，关系随新草稿重新得出，不会再整批消失。任务层面，产出某样东西的任务完成交付后，它的文件自动成为使用它的任务的材料，排程也会把产出任务排在前面；任务卡上写「产出供 自媒体 · …」或「使用 研究 · … 的产出」。顺带产出（副产品）也按同一套方式处理：它是主任务产出的一个小产物，落地任务在主任务交付后两天内完成。

## 每项规格如何实现

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

## 与规格的出入

- 供需对多了 `hoursSaved`（见上，排序需要）。
- 产物 id 必须以所属主线 id 开头（如 `research-figures`），用来保证只重做一条线时不会与保留的产物撞 id。
- 只重做一条线时，指向这条线、但没有已批准里程碑依赖的供需对属于「这条线的部分」，由本次运行重新给出（模型可以用保留的其他线产物作为 `from` 重新声明）。
- 依赖释放仍按现有排程规则：使用任务在生产任务**验收**后（或与之同在本次排程中时由求解器排序）才排入；交付时文件已先行交接。

## 回放与在真实账号上应用

回放（不写真实账本，只在临时副本上跑，会消耗真实额度）：

```powershell
pnpm exec tsx scripts\artifact-plan-replay.ts            # 取第一条有已确认事实的主线
pnpm exec tsx scripts\artifact-plan-replay.ts research   # 指定主线
```

输出：重算前后的跨主线关系、产物计划、本次运行的耗时与修复次数、以及「不涉及该主线或已批准的关系中丢失的」条数（应为 0）。

在真实账号上应用（先问本人，F5/F6 会消耗额度）：重启 worker（新 Skill 需要装进隔离的 CODEX_HOME，`requiredSkills` 已登记），web 打开账本时自动跑迁移 13（会先留 `.v12.bak`）。然后在主线页对某条线「修改并重算草稿」或调用 `POST /api/milestones/propose`（`only: [line]`），即走产物计划 → 逐线设计 → 关系推导。批准草稿后 `approve-batch` 连带批准关系并触发 `/v1/goals/auto-backplan`，倒推出的任务带 `produces` / `uses`，依赖与交接自动生效。

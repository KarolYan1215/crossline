# 2026-10-15 真实账本清理：重复任务与死日历

机主要求清理真实账本（`data/crossline.db`，工作区 `bf8be609-…`）里的重复任务和死日历。真实账本只读查询；所有改动走 worker 的 pass 或一次性修复（带 marker、记事件）。演练在 `better-sqlite3` backup 出的副本上做（2026-10-15 18:47Z）。

## 1. 重复任务

每日合并（`dedupePass`）今天 10:40Z 已跑过（`tasks.dedupe.day = 2026-10-15`），按规则合并了 13 个获取信息类任务（13 条 `task.merged`，各有 `task.unmerge` 撤销）。

**规则判不了的 16 对一对都没复核。** 10:40Z 时额度处于 economy（同一时刻 `crossline-milestone-risk-reviewer` 记为 `spend_mode: economy`），复核属 discretionary，只在 normal 时跑；`tasks.dedupe.judged` 为空。旧代码一天只跑一次，所以这 16 对要等到明天。

| # | A | B | 规则 |
|---|---|---|---|
| 1 | 整理 ECE 548 复习提纲 | 汇集 ECE 548 复习材料 | 标题 0.6、说明 0 |
| 2 | 整理 ECE 548 复习提纲 | 整理 ECE 548 复习材料 | 0.6 / 0.04 |
| 3 | 整理 ECE 548 复习提纲 | 汇集 ECE 548 复习材料（另一个） | 0.6 / 0.07 |
| 4 | 完成 Crossline 介入 | 编制 Crossline 自用记录 | 0.62 / 0.02 |
| 5 | 完成 Crossline 介入 | 校准 Crossline 真实任务 | 0.62 / 0.19 |
| 6 | ECE 548 汇集两门课程评分规则 | ECE 548 整理两门课程当前成绩 | 0.56 / 0.29 |
| 7 | 编制 Crossline 自用记录 | 校准 Crossline 真实任务 | 0.57 / 0.18 |
| 8 | 编制收益风险配置模板 | 设计收益风险配置字段 | 0.56 / 0.11 |
| 9 | 编制 Crossline 外部试用包 | 设计 Crossline 反馈框架 | 0.55 / 0.06 |
| 10 | 编制 Crossline 外部试用包 | 整理 Crossline 功能优先级 | 0.53 / 0.08 |
| 11 | 设计 Crossline 反馈框架 | 整理 Crossline 功能优先级 | 0.55 / 0.04 |
| 12 | 汇集 ECE 548 成绩记录（待批准） | 整理 ECE 548 当前成绩 | 0.4 / 0.05 |
| 13 | 汇集 ECE 548 评分标准 | 汇集 ECE 548 评分规则 | 0.6 / 0.18 |
| 14 | 定义 Crossline 核心工作流 | 确定 Crossline 试用者口径 | 0.53 / 0.06 |
| 15 | 定义 Crossline 核心工作流 | 整理 Crossline 功能优先级 | 0.53 / 0.05 |
| 16 | 确定 Crossline 试用者口径 | 整理 Crossline 功能优先级 | 0.53 / 0.06 |

多数只是同一项目里共用「Crossline」「ECE 548」的不同产出；真像重复的是 #12、#13（可能还有 #2）。由复核决定，不由这份清单决定。

**改动（`apps/worker/src/dedupe.ts`）**：
- 规则仍一天一次；当天第一次运行因额度没问复核的对子，在同一天后面的 tick 里额度恢复 normal 时补问一次（`tasks.dedupe.reviewDay` 记已问的日子，所以复核失败不会每个 tick 重试）。补跑合并的结果单独说一次（消息键 `merged:<day>:review`）。
- 复核一次最多 12 对，超出的分批问完（原来多出的要等下一天）。
- 合并沿用 `applyMerge`：留进度最多的一项，其余 `bySystem` 归档，原因「与「X」合并」，每次合并一条 `task.unmerge`，在「已归档 → 已合并」里可撤销。

## 2. 死日历

定义与副本上的数量：

| 类 | 定义 | 数量 | 处理 |
|---|---|---|---|
| (a) | `calendar.published` 中对应已归档、已合并、已完成任务的未来事件 | **0** | 已由发布自然清掉：10:40Z 合并之后的 16 次发布共删 106 个事件（例如 14:09Z 删 8、16:11Z 删 43、17:01Z 删 8，keptAsEdited 均为 0），现在记录里已没有任何已归档、已合并或已完成任务的条目；`forceRemove` 对已完成任务的残留事件连本人改过的也删。记录里剩下 3 条「已阻塞」任务（ECE 555 作业 2）的事件都在 10-09，属于过去，按边界不动。 |
| (b) | 导入课程块：同一时段既有周课又有当天讲次 | **1** | `import:02178a6e…:ece555-class-fall-2026:2026-12-07`（ECE 555 上课）与 `import:02178a6e…:ece555-final-2026-12-07`（课堂期末考试），同在 2026-12-07 14:30–15:45。生成逻辑已由另一会话修好（`decideDateBatch` 一个时段只留一块），旧块还在。写一次性修复 `repairDuplicateImports`。 |
| (c) | 来源已不存在或已取消勾选、但还留在计划里的日历块 | **0** | 计划里 4 个 `graph_calendar:` 块都带当前唯一选中来源（日历 · kyan47）的 `sourceKey`；没有不带 `sourceKey` 的旧块，也没有 iCal 订阅。 |
| (d) | 已过期且没有作用的固定事件（`schedule.events`） | **0** | `schedule.events` 为空。`schedule.events.decisions` 只有一项（ECE 555 上课 → 创建），系列到 2026-12-07，仍在用。 |
| (e) | 其他 | 见下 | 均不清理，理由如下。 |

(e) 看过而不动的：
- 39 个 `deadline:` 提醒标记全部对应已批准里程碑，其中 2 个已过去（10-10、10-15），按「只删未来」不动；5 个时段里有多条标记同在 09:00，是不同里程碑，不是重复。
- 计划里 3 个已过去的 ECE 555 课块（10-05、10-09、10-12）是历史，不影响排程。
- 记录中 10 条已过去的 `scheduled:` 事件，同上。
- Crossline 日历上的 ECE 555 周课系列包括 12-07（那天实为期末考试）。系列的例外日还没写进日历（CLAUDE.md 已记为未做），这次不改。

**发布干跑**：在副本上按当前代码算一次 `blocksToPublish` + `fixedEventsToPublish` 与记录对比：要删的 51 条全是已批准任务的工作块（副本上没有缓存的最优解，用的是贪心排程，所以和常驻版的最优排程不同，属正常改排），没有一条属于已结束任务。

**修复（`apps/worker/src/calendar-repair.ts` `repairDuplicateImports`，worker 启动时每个工作区跑一次）**：
- marker `repair.import-duplicates.v1`，只执行一次；
- 同一天同一起止时间的 `import:` 块中，留当天的讲次（`import:<batch>:<item>`），删周课那一次（`import:<batch>:<item>:<day>`）；
- 记 `repair.import_duplicates` 事件，载荷里是被删块的完整内容，需要时可原样放回；
- 只动计划里的导入块，不碰任何日历事件（导入块本来就不发布到 Crossline 日历）。

副本上演练结果：删 1 块（上表那一块），计划从 23 块变 22 块，第二次运行不再动作。

## 3. 执行与验证

- 19:00:30Z 确认没有在跑的助手任务（没有未结束的 `agent.task.requested`）、worker 全仓 typecheck 干净后重启 worker（只重启 worker，web 未动）。
- 19:00:45Z worker 日志：`repair.import_duplicates` 删 1 块（上表那块），另一个工作区 0；`repair.import-duplicates.v1` 已写，计划 23 → 22 块；`repair.import_duplicates` 事件里存着被删块全文。
- 按常驻 web 自己的 `loadTimeline` 读真实账本副本：10-15、10-16、10-19、12-07 都没有同时同名或同时段重复的固定块，12-07 只剩「ECE 555 课堂期末考试」。
- Crossline 日历：重启前最后一次发布（18:49Z）创建 12、更新 57、删除 26、未变 41、keptAsEdited 0；记录 121 条（scheduled 81、deadline 39、fixed 1），其中对应已结束或已不存在任务的为 0。导入块不发布，所以这次修复不会触发新的发布（发布哈希不变）。
- 合并复核：补跑排在同一 tick 的教程生成之后（重启后第一个 tick 先做了 ECE 555 作业 3 的教程，其中一步研究用了 32 分钟）。19:45Z 补跑执行：复核分两批（12 + 4 对），额度为 normal；`tasks.dedupe.reviewDay = 2026-10-15`。结果：**1 对相同**——#13「汇集 ECE 548 评分规则」并入「汇集 ECE 548 评分标准」（`bySystem` 归档，原因「与「汇集 ECE 548 评分标准」合并」，一条 `task.unmerge` 撤销，消息键 `merged:2026-10-15:review`）；其余 15 对判为不同（包括 #2、#12），均记入 `tasks.dedupe.judged`，以后不再问。
- 注意：每 15 分钟一次的看门狗（`start-crossline.ps1`）重新拉起 worker 时，会因锁退出并写 `worker.already_running`，但 `Start-Process` 的重定向会先清空 `worker.log`，正在运行的那个 worker 的日志因此丢失。重启前的日志另存为 `data/logs/worker.before-cleanup-restart.log`。

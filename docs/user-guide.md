


## 18. 今日面板、飞轮图谱、计划页、身份定语与跨主线产出（2026-10-10）


**时间轴旁的面板。** 今日页时间轴左侧的面板分三层：最上面是当日负荷（已排、预排与固定日程的小时数）；中间显示点选的日程——所属主线与里程碑、本步与任务进度、截止日、本步时长（可直接拖动，应用前先预览对其他任务和里程碑的影响）、本人负责的部分和这项任务的下一个时段；没有点选时显示下一项。在这里可以直接开始、暂停（选原因）和继续计时，预排在非工作时段的日程开始时会先转为正式排程；「完成并提交材料」打开一个窗口，写一句说明、拖入或选择文件（PDF、文本或图片）即可提交验收，没有材料时可「完成（记为无证据）」，任务还有其他步骤时也可以「只完成本步」；「推迟」可选明天或某一天，同样先预览影响；本步可由系统完成时出现「交给 Agent」。已由 Agent 接手的日程在时间轴上标「Agent 将执行」或「Agent 执行中」。面板底部是待批准任务（可全部批准）、待决事项和调整可用时段三个入口。在周视图里点选日程，会打开那一天并选中它。

**自动交给 Agent。** 设置 → 自动化与助手里的「自动交给 Agent」默认关闭。开启后，日历上被判定为系统能做的步骤，到排定时间前约半小时（或助手空闲时提前）由后台直接开始，不必再点「交给 Agent」；只处理已允许的工作类别，同一时间只做一项，模型额度用到 95% 以上时暂停。产出是否需要审阅，仍按上方各类别的「关闭 / 逐次审阅 / 自动」三档处理。助手自己的准备步骤不占日历时间，不受这个开关影响，照常自动进行。

**飞轮图谱。** 今日页底部的飞轮图谱把各主线画在一起：每条主线一个锚点，标着它的长期目标；每个进行中的里程碑是一个点，颜色是所属主线，点越大表示未完成的任务越多，空心表示草稿。同一主线前后相继的里程碑用细线相连；一条主线的产出被另一条主线复用的飞轮关系用带箭头的粗线表示，颜色取上游主线，已确认为实线、待确认为虚线。点一条关系线可以查看它的说明，待确认的可以当场判定「成立」或「不成立」。由已确认关系构成的闭环在环心标 R。图可以拖动、用滚轮或双指缩放；把鼠标停在一个点上会突出与它相连的部分；点里程碑打开主线页上它的详情。图例列出每条主线进行中的任务数。健康是容量约束，不在图中。

计划页不再显示日历，日程本身在今日页查看。计划页看的是更长的时间：页顶是计划版本、待处理的计划差异、「立即同步日历」和「发布到 Crossline 日历」，右侧可以把统计范围切换为 4 周、8 周或「到最远截止」（最多 6 个月）。下面四张图依次是：**容量与需求**——每周一根柱，按主线颜色分为已排、待排和保守估时多出的部分，折线是扣除预留后的可用小时，超出的周标「超载 N 小时」，悬停可看各主线的小时和占用最多的里程碑；**里程碑完成预测**——每个已批准的里程碑一行，横条从通常完成日到保守完成日，◆ 为截止日，余量不足 2 天标为风险，虚线是任务库进入日，点一行打开该里程碑；**主线投入：计划 vs 实际**——近 4 周每周计划小时（空心点）与实际计时小时（实心点），旁边是访谈中所述的投入比例；**估时准确度与节律**——估时与实际用时的对比和保守估时覆盖率，以及近 8 周按星期与小时的工作分布，外框为可用时段。没有计时记录时显示「尚无实测」。页底的排程设置分为可用时段、排程参数和排程依据三页，里程碑的重要性在排程依据表中调整；任何改动先预览，预览期间上方各图以虚线显示改动前的数值。

**长期目标由定语组成。** 访谈在「主线」阶段为每条主线给出 6–12 个互不重叠的定语（领域、能力、状态各类），每个都注明来自哪句回答或哪个文件。在主线页点主线名称或「调整定语 →」，在弹出的面板里点选任意多个定语；系统按「领域 → 能力 → 状态」排好顺序，也可以拖动或用箭头调换顺序、点一下改字，上方实时预览「成为 A 的、B 的研究者」，点「采用」即成为这条主线的长期目标。访谈页右侧的画像面板里也能同样操作。此前采用的整句长期目标会由系统拆成定语并保持选中，组合结果与原句一致，之后可以增减。

**每张主线卡片里都有这条主线的访谈。** 在卡片下方的输入框写这条主线的现状、进展或想法，内容记入这条主线的访谈（与「完整访谈 →」是同一段对话）。每轮约一两分钟，期间显示已用时间，输入框仍可继续写，新内容会排在这一轮之后发送；结束后卡片上的描述、本轮问题和定语候选当场刷新。说「把长期目标改成……」时，卡片上先出现修改卡，点「采用」才生效，点「不改」则放弃。长期目标或这条主线的情况变了以后，卡片上出现「目标已变，重算未动过的草稿」，点一下即重算这条主线尚未改动过的里程碑草稿；已批准的里程碑不变。

## 实现要点

### 1. 定语候选（core + 访谈）

- `packages/core/src/line-attributes.ts`：类型 `AttributeCandidate {text, kind: domain|ability|state, sourceRef}`、`StoredLineProfile`、`PendingGoalEdit`；纯函数 `cleanAttribute`（去「成为」、去尾「的」、去标点）、`attributeKey` / `duplicateAttributes`（去「的」与标点后一个包含另一个即重复）、`notAtomic`（含「、，；/」等并列）、`guessKind`（无标注时的规则分类）、`orderAttributes`（领域 → 能力 → 状态，同类保持原序）、`insertByKind`（新选的定语插在最后一个同类或更早类之后，不打乱手动排序）、`composeGoal`（「成为A的、B的<身份>」）、`goalCore`、`recomposes`、`lineAttributes`（旧 `goalCandidates` 每句读成一个定语，兼容旧数据，不迁移）、`checkGoalParts`。设置键 `LINE_PROFILES_SETTING = "lines.profiles"`、`GOAL_EDITS_SETTING = "lines.goalEdits"`。
- 分类采用**模型标注 `kind`**（schema 里的枚举，可测、可校验），`guessKind` 只用于人手写的定语和旧整句候选。
- `onboarding-turn-schema.ts`：`lineProfiles[].attributeCandidates`（≤12 项，每项 `{text ≤40, kind, sourceRef}`）替换 `goalCandidates`；新增顶层 `goalEdits: [{lineId, parts:[{text,kind}], sourceRef}]`。严格模式规则不变（全部 required、`additionalProperties:false`），`structured-output.test.ts` 的发现式检查覆盖。
- 校验 `validateOnboardingTurn`：候选为 0（保留已有）或 6–12 个；`sourceRef` 必须是已知的 `reply-N`/`src-N`（与事实同样处理：退回修正 `ONBOARDING_UNKNOWN_SOURCE_REF`）；并列 `ONBOARDING_ATTRIBUTE_NOT_ATOMIC`；重复 `ONBOARDING_ATTRIBUTE_DUPLICATE`，详情点名两个定语；数量 `ONBOARDING_ATTRIBUTES_COUNT`。`goalEdits` 必须引用本人的回复（`ONBOARDING_GOAL_EDIT_UNASKED`），主线必须存在，定语不重复。`keepOnboardingTurn`（修复用尽时）逐个丢弃坏定语，剩不足 6 个就当空列表（保留已有），丢弃不合格的 `goalEdits`。
- `persistTurn`（`apps/worker/src/onboarding-session.ts`）：`lines.profiles[line] = {description, attributes}`；空候选只更新描述；新候选替换旧候选，但保留由已采用长期目标拆出的定语（`sourceRef: "goal"`，且不与新候选重复）。`goalEdits` 写入 `lines.goalEdits[line] = {parts, sourceRef, at}`，按本人说的顺序，不自动生效。访谈上下文的 `lines[]` 带上 `goalParts`。
- Skill `crossline-onboarding/SKILL.md` 与 worker 开发者指令同步改写（lines 阶段、`goalEdits`、focusLine/卡片访谈刷新候选）。
- 读取方：`packages/db/src/interview.ts`（清单的「描述与候选」按 `attributes` 或旧 `goalCandidates` 计数）、`portrait-writer`（只读描述）、`calendar-classifier`（只读描述）、`/api/onboarding/state`、主线页。

### 2. 选定语界面与 `goalParts`

- `packages/identity-packs`：`LineSpec.goalParts` / `IdentityPack.goalParts`。
- `apps/web/lib/lines.ts` `updateLine` 接受 `goalParts`：`checkGoalParts` 校验（空、超过 12、重复 → `LINE_GOAL_PARTS_*`，带中文原因），`goals[0]` = 组合句，其余长期目标保留；整句改写 `goals[0]` 时去掉不再对应的 `goalParts`（之后由拆分任务重新拆）；主线改名时组合句跟着改。长期目标上限放宽到 300 字（多个定语组合会长）。`POST /api/lines {id, goalParts}`，GET 返回 `goalParts`；撤销标签写主线名而非 id。
- `apps/web/app/ui/attribute-picker.tsx`（+ `attribute-picker.css`）：芯片多选不限个数、`insertByKind` 自动排序、拖动与 ←/→ 调序（手机上拖动不可靠）、点击改字、补充自定义定语、重复提示、实时预览、「采用」。用于主线页 LineEditor（`lines-bar.tsx`）与访谈页 `portrait-panel.tsx`（替换原整句候选与「添加」表单；对应的孤立 CSS 已删）。

### 3. 已采用整句的拆分（worker 任务）

- 新 Skill `crossline-goal-splitter`（低档，`model-policy.ts`），schema `GOAL_SPLIT_SCHEMA` / `validateGoalSplit` / `keepGoalSplit`（core）。上下文 `crossline.goal-split.v1`：每条主线的 `goals`。
- 校验：每条主线、每个长期目标都要返回，`goal` 逐字照抄；定语不重复、不含并列；**按序组合后与原句一致**（`recomposes`：忽略空白、标点、开头「成为」和所有「的」——组合时只会增加「的」与「、」，比较时去掉「的」是有意的，见下方偏差）。不一致退回修正（同一线程，最多两次），修复用尽后 `softAccept` → `keepGoalSplit`：拆得对的保留，拆不对的整句作为一个定语保留（`goalCore`）。
- `apps/worker/src/goal-splitter.ts`：`linesAwaitingSplit`（有 `goals[0]`、无 `goalParts`、该句未拆过）；写入前重新读取主线设置，人在运行期间改过的长期目标不覆盖；`goals[0]` 的措辞不变，只加 `goalParts`；所有长期目标的定语并入候选（`sourceRef: "goal"`，旧 `goalCandidates` 一并转成定语）；每句记一条 `line.goal_split` 事件（`goalHash`、`parts`、`kinds`、`recomposed`），幂等键 `line:goal-split:<line>:<hash>`。运行时不可用或模型失败时什么都不记，下次再试。
- 触发：worker 每个 tick 的 `goalSplitPass`（额度为 `manual_core_only` 时不跑）；立即触发：supervisor `POST /v1/lines/split-goals`（202，后台运行）← web `POST /api/lines/split-goals`。

### 4. 卡片里的访谈与页面上下文 `line`

- `apps/web/lib/line-cards.ts` `lineCardDetails`：每条主线的描述、定语候选、`goalParts`、待确认的长期目标修改、该主线访谈（会话 `line-<id>`，与 `/onboarding?line=` 相同）的最新回复与问题、是否在等回复、是否该提示重算。
- `apps/web/app/milestones/line-card-interview.tsx`（+ `line-card.css`）：卡片内输入框，问题选项可点选（`composeAnswers` 组成回复），发送到 `/api/onboarding/turn`；进行中显示已用秒数，输入框可用，新消息排队；409（同账号另一轮访谈在跑）20 秒后自动重发；失败可「重新发送」（服务端已保存消息）；结束后 `router.refresh()` 原地刷新描述与候选；刷新页面时若最后一条消息还没回答，每 20 秒看一次。卡片拖动排序改为只拖标题，避免与输入框冲突。
- 修改长期目标：`POST /api/lines/goal-edit {lineId, decision: adopt|dismiss}` → `decideGoalEdit`（采用走 `updateLine` 的 `goalParts` 校验；两种决定都清除待办并记 `line.goal_edit_adopted|dismissed`；可撤销）。
- 页面上下文 `kind: "line"`：`pageFromLocation` 读 `/milestones?line=` 与 `/onboarding?line=`；聚焦卡片输入框时用 `history.replaceState` 写入 `?line=<id>`，全局小助手因此知道当前主线。`contextPack` 的 `page.title` 为主线名，`ConciergePack.lines[]` 增加 `description`；快照新增「本页主线」三行（`pageLine`）。动作 `profile.tell` 新增参数 `lineId`（"" = 整体访谈；否则送到该主线的访谈会话），卡片字段可改；concierge Skill 文本已同步（注册表一致性测试通过）。

### 5. 重算提示

- `redraftDue`：这条主线有里程碑，且长期目标（`line.updated` 中改了 goals/goal/goalParts，或 `line.goal_edit_adopted`）或这条主线的事实（`updatedAt`）晚于最近一次提议（该线里程碑的 `milestone.proposed`，或 `line.redraft_requested`）。
- 按钮「目标已变，重算未动过的草稿」→ 现有 `POST /api/milestones/propose {only:[line]}`；该路由对 `only` 中的每条主线先记 `line.redraft_requested`，提示随即消失，直到长期目标或事实再变。已批准的里程碑不受影响（架构师本来就只重做未动过的草稿）。

**跨主线产出。**重新设计里程碑时，系统先列出每条主线这一期会产出的东西（论文图表、数据集、视频、访谈记录……），以及哪几样会被另一条主线直接用上；每条主线最多向外供给两样。之后各主线的里程碑围绕这些产出设计：产出它的里程碑写明「产出」，用到它的里程碑写明「使用」并在推导里算清它省下多少。飞轮关系不再另外猜测，而是从这些引用得出，每条都写明产物、预期传递量（如「3 张图表」）、核对日（下游里程碑的截止日）和反事实（没有它下游要多花多少小时或缺什么）。主线页的草稿列表里，每个草稿下列出它使用和供给的跨主线产物，可以单独去掉；批准下游里程碑时，这些关系随之批准。到核对日，待决事项会问「研究 · X 是否给 自媒体 · Y 提供了 3 张图表？」：兑现、部分或没有；「没有」会把这条关系标为不成立。系统体检里多了「跨线关系兑现率」，兑现率低的产物类型，下次规划时会少安排。只重做一条主线时，其他主线的产出和已批准里程碑依赖的供需对保持不变，关系随新草稿重新得出，不会再整批消失。任务层面，产出某样东西的任务完成交付后，它的文件自动成为使用它的任务的材料，排程也会把产出任务排在前面；任务卡上写「产出供 自媒体 · …」或「使用 研究 · … 的产出」。顺带产出（副产品）也按同一套方式处理：它是主任务产出的一个小产物，落地任务在主任务交付后两天内完成。

## 19. 可开始标准与上手（2026-10-12）

**五条满足才开始使用。** 每条主线一句描述、每周可用时间、硬约束主线的固定安排（或含它的文件）、每条主线一个当前项目及截止或「没有截止」、每条主线由本人采用的长期目标——五条都满足之前，今日、主线、计划、任务、待确认、复盘与画像页都会回到访谈页，访谈页写明「开始使用前还差 N 项」。已有账号同样适用；访谈已经结束的账号，缺的问题（例如某个项目「有截止日期吗？」，可直接选「没有截止」）就在访谈页回答。五条满足后访谈页出现「开始使用」，画像访谈在同一处继续，问题同时列在待决事项。原来的「先开始使用」按钮已去掉。

**先放材料。** 访谈的第一步是添加材料，点「读完材料，开始访谈」后，第一轮先读完全部文件，再只问文件里没有的。访谈先问五条，再写画像。

**计时只算本人在看的时间。** 访谈页可见且一分钟内有操作时才计时；模型生成下一轮时离开页面不计，生成完会推送到已订阅的手机（「访谈下一轮已就绪」），浏览器标签页标题前出现「● 新问题」。

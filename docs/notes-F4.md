# F4：原子化定语、已有长期目标拆分、卡片里的访谈、重算提示

设计见 `docs/flywheel-and-views.md` §4、§6。本文是实现说明，供合并时并入 CLAUDE.md 与用户指南。

## 给用户的说明（可并入 docs/user-guide.md）

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

## 与设计稿的偏差

- 重组校验比较时除空白、标点外还忽略「的」和开头「成为」。原因：组合格式必然在定语之间加「的、」（「成为神经形态计算方向的、能独立立项的研究者」），而原句通常没有（「成为神经形态计算方向能独立立项的研究者」）；只忽略空白标点则任何多定语拆分都不可能通过。拆分时 `goals[0]` 保留原句措辞不变，所以显示给人的仍是原句。
- 校验拒绝写给 `person` 的 `lineProfiles` 与 `goalEdits`（以前不拒绝 `person`）。
- 访谈的候选允许 0 个（表示保留已有、继续追问），否则必须 6–12 个。

## 在真实账号上执行拆分

合并并重启 worker 后，下一个 tick（≤15 分钟）会自动拆分所有「有长期目标、没有 `goalParts`」的主线，每句只拆一次。要立即执行：在已登录的浏览器控制台运行

```js
await fetch("/api/lines/split-goals", { method: "POST", headers: { "content-type": "application/json" } }).then((r) => r.json())
```

返回 `{ok: true, started: true}` 后数秒到一两分钟内完成。核对：`line.goal_split` 事件的 `recomposed` 应为 `true`（`false` 表示该句被整体保留为一个定语）；主线页卡片的长期目标文字不变，「调整定语 →」里对应定语处于选中状态，预览的组合句与原句只差「的、」。

## 测试

- `packages/core/src/line-attributes.test.ts`：组合、清理、重复、排序、插入、分类、重组、旧数据兼容、`checkGoalParts`、拆分 schema 与校验、修复用尽后的整句保留。
- `packages/core/src/onboarding-turn-schema.test.ts`：候选数量/来源/并列/重复（点名）、清理、`goalEdits` 必须引用回复、`keepOnboardingTurn` 逐个丢弃。
- `apps/worker/src/onboarding-session.test.ts`：卡片访谈（`line-research`）按线刷新候选、保留拆出的定语、修改只记录不生效；空候选只更新描述。
- `apps/worker/src/goal-splitter.test.ts`（共享 Codex fake）：拆分并保持选中、幂等、重组失败退回修正后整句保留、运行期间人改了长期目标不覆盖、无运行时不记录。
- `apps/web/lib/line-cards.test.ts`：`goalParts` 采用/改名/整句改写、校验、重算提示、卡片数据、修改卡的采用与放弃、页面上下文 `line` 与 `profile.tell` 的 `lineId` 路由。
- `apps/web/app/api/lines/route.test.ts`：`goalParts` 保存路由；新路由由 `csrf-protection.test.ts` 自动覆盖。
- `apps/web/app/milestones/lines-bar.test.tsx`：卡片渲染访谈框、描述、修改卡（组合句、采用/不改）、重算按钮、本轮问题。`empty-account.test.tsx` 增加 `next/navigation` 的 mock（卡片用 `router.refresh()`）。
- e2e 未改：现有用例不点击长期目标候选；主线页没有截图基线。设计与文案审查（`design-audit`、`copy-audit`）需在合并后运行。

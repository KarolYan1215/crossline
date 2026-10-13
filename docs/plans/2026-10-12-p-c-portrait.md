# P-C 画像海报改版 实施计划

> **给执行者**：按任务顺序逐个完成；每个任务先写失败的测试、看它失败、再写最少的实现、看它通过。复选框（`- [ ]`）用来记进度。**不要提交**，除非本人明确要求；文中「建议提交点」只是提交的合适位置。

**目标**：把画像报告（`/portrait`）与分享图改成本人选定的 A「编辑杂志」风格，同时修掉版面缺陷、加可信度标注、精简分享卡，并让各维度可以在人与人之间对比：标签由代码计算（核心词、价值核心、建议底座、身份），价值雷达固定为施瓦茨 10 项，言行对照固定 5 项且「所做」从账本算出，能量地图固定 6 类。旧报告在上线后自动重写一次。

**架构**：固定维度（施瓦茨 10 项、能量 6 类、言行 5 项）和 `PORTRAIT_SCHEMA_VERSION` 放在 `packages/core/src/portrait.ts`，既是 writer 的输出契约，也是网页画图的唯一依据。「所做」分两层：纯函数 `sayDoReadings`（`packages/core/src/portrait-say-do.ts`）负责算分和判断数据是否够用，`packages/db/src/portrait.ts` 的 `sayDoFor` 负责读账本，网页（`apps/web/lib/portrait.ts`）和 worker（`apps/worker/src/portrait-writer.ts`）共用这一份读法，写法与 `packages/db/src/interview.ts` 相同。标签由 `portraitLabels` 计算（`packages/core/src/portrait-type.ts`）。版面几何（倾向条、矩阵避让、能量图例编号）是纯函数（`apps/web/app/portrait/poster-geometry.ts`），可以用 vitest 测。重写一次与每月重写言行对照都放在 worker 的一个 tick pass 里，判断条件写成 `portraitRewriteDue`，可以单独测试。

**技术栈与约束**：pnpm 工作区；单测 `pnpm vitest run <file>`；类型检查 `pnpm typecheck`；e2e `pnpm exec playwright test <spec>`；提交前跑一次 `pnpm verify`（typecheck + test + build + e2e）。代码注释用英文，界面文案用中文，遵守 `docs/copy-style.md`：第三人称、不用你/我、模型写的文字放在 `.gen` 里、不小于 12px、文字对比度至少 7:1、手机宽度不能横向滚动。手写 SVG，不引图表库。

**依据**：`docs/loop-and-scout.md` 第 7 节「画像报告修改」、第 11 节第 7–8 条、第 12 节 P-C；视觉稿 `data/eval/poster-drafts/build.mjs`（`posterA`、`longImage(t, "A")`）、`A-poster.png`、`A-long.png`。`data/` 在 gitignore 里，而且装的是真实账号的报告：代码与测试**不得**引用这些文件。颜色和尺寸按视觉稿抄进 CSS，e2e 夹具用虚构数据另写。

**不在本计划内**：
- 定制形象、`portrait.character.prefs`、形象与报告版本脱钩、浮窗，以及 `CHARACTER_STANDARD` 与插画器 Skill 里关于性别的句子 —— 属于 P-D。本计划不改 `CHARACTER_STANDARD`，插画器沿用「每写一版就重画一次」。
- 名人库与「名人一栏」—— 属于 P-E。分享卡高度要留出空间，P-E 直接往卡片底部追加。
- 完成确认带来的执行数据 —— 属于 P-A 第 3 步。本计划按账本现有的数据计算「所做」；数据不够时只写文字，P-A 落地后自然就够了。

**决定点（动手前问本人，第 0.1 题）**：字体。A 稿的大标题用衬线体（Noto Serif SC），而 `e2e/design-audit.spec.ts` 规定全站只能有两种字体（Arial；`.gen` 里用微软雅黑）。下文默认方案 **F1**，本人若选 F2，只改任务 4.5 和 5.2 里标了【F1】的步骤。
- **F1（推荐）**：只对**代码里写死的字符串**用衬线体，包括四字母类型码、16 个类型名、4 个组名、章节标题、标签栏标题和施瓦茨 10 项的中文名。字体文件是 Noto Serif SC Bold（SIL OFL 1.1）的子集，自托管在 `apps/web/public/fonts/poster-serif.woff2`，可离线使用，导出图片时 `html-to-image` 也能嵌入。由模型写的文字（一句话、核心词）仍用微软雅黑，用户的主线名仍用 Arial。设计审查增加第三种允许的字体，只在 `.pt-serif` 内生效。获取字体文件属于下载，需要本人同意（来源：github.com/notofonts/noto-cjk，几 MB；子集化后预计不到 60 KB）。
- **F2**：不引入新字体，用 Arial 加粗、大字号、粗黑边框和米色纸面做出版面感。外观约为 A 稿的九成，没有衬线。

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/core/src/portrait.ts` | 改 | `PortraitReport` 类型、`PORTRAIT_SCHEMA`、`validatePortrait`，新增 `SCHWARTZ_VALUES`、`ENERGY_CATEGORIES`、`SAY_DO_DIMENSIONS`、`PORTRAIT_SCHEMA_VERSION` |
| `packages/core/src/portrait-type.ts` | 改 | 改写 `portraitLabels`；删除「飞轮形态」「充电方式」「工作时段」，以及因此不再用到的 `flywheelLoops` 引用和 `peakHours` 参数 |
| `packages/core/src/portrait-say-do.ts` | 新建 | `sayDoReadings`（纯函数：5 项分数和数据是否够用）、`answeredOnTime` |
| `packages/core/src/portrait.test.ts` | 改 | 契约、校验、标签 |
| `packages/core/src/portrait-say-do.test.ts` | 新建 | 言行对照计算 |
| `packages/core/src/agent-dispatch.ts` 或新位置 | 改 | 把 `scheduledMinutesKey` 从 web 挪到 core（与 `STEP_STARTS_SETTING` 放在一起） |
| `packages/db/src/portrait.ts` | 新建 | `sayDoFor(store, workspaceId, now)`：读账本，调用 `sayDoReadings` |
| `packages/db/src/portrait.test.ts` | 新建 | 用 `:memory:` 账本测试 |
| `apps/web/lib/effectiveness.ts` | 改 | 等待按时规则改用 `answeredOnTime`（复用，删掉内联的那份） |
| `apps/web/lib/schedule-memory.ts` | 改 | `scheduledMinutesKey` 改为从 core 引入 |
| `skills/marketplace/plugins/crossline/skills/crossline-portrait-writer/SKILL.md` | 改 | `cover.coreWord`、施瓦茨 10 项、能量 6 类、言行 5 项（只写「所说」）、`doing` |
| `apps/worker/src/portrait-writer.ts` | 改 | 上下文加 `doing`、保存 `schema`、`softAccept`、`portraitRewriteDue`、只写言行对照的模式 |
| `apps/worker/src/portrait-writer.test.ts` | 新建 | 用假运行时测试写入、只写言行对照的合并、到期判断、Skill 是否与契约一致 |
| `apps/worker/src/index.ts` | 改 | 把 `writePortrait` 抽成模块级的 `writePortraitFor`；新增 tick pass `portraitPass` |
| `apps/web/lib/portrait.ts` | 改 | `PortraitState` 加 `sayDo`；删除 `agentHours`、`peakHours` 及读取 `AGENT_HISTORY_SUMMARY` 的代码 |
| `apps/web/app/portrait/poster-geometry.ts` | 新建 | `axisBar`、`dodgeMatrix`、`energyLegend`、`radarValues` |
| `apps/web/app/portrait/poster-geometry.test.ts` | 新建 | 几何测试；同时用 `validatePortrait` 校验 e2e 夹具 |
| `apps/web/app/portrait/portrait-charts.tsx` | 改 | 新增 `DivergingAxes`、`IdentityBars`（替换并删除 `AllocationChart`）；`EnergyScatter` 改为编号加图例；`ValuesRadar` 固定 10 轴；`GapChart` 用账本数据；`AdviceMatrix` 加避让 |
| `apps/web/app/portrait/portrait-view.tsx` | 改 | 前半部分改版、可信度标注、改名、精简分享卡、标签区 |
| `apps/web/app/portrait/portrait.css` | 改 | A 风格的颜色变量、页面高度随内容、打印样式、【F1】字体 |
| `apps/web/app/portrait/page.tsx` | 改 | 页面说明里的「人格类型」改为「思维模式类型」 |
| `apps/web/public/fonts/poster-serif.woff2`、`scripts/poster-font-subset.ts` | 新建【F1】 | 字体子集与生成脚本 |
| `e2e/ledger.ts` | 新建 | 从 `crossline.spec.ts` 抽出 `openStore`、`realWorkspaceId`，加 `ensurePortrait` |
| `e2e/fixtures/portrait-report.json` | 新建 | 虚构的压力夹具 |
| `e2e/design-audit.spec.ts` | 改 | 画像页文字不重叠、分享卡装得下、`/portrait` 用完整报告审查、【F1】第三种字体 |
| `e2e/crossline.spec.ts` | 改 | 改用 `e2e/ledger.ts`；新增两张画像视觉基线 |
| `CLAUDE.md`、`docs/copy-style.md`、`GLOSSARY.md` | 改 | 同一次改动里更新文档 |

---

## 阶段 0：准备

### 任务 0.1：确认字体方案，记下基线

- [ ] 按上面的「决定点」问本人选 F1 还是 F2。选 F1 的话，同时问能否下载 Noto Serif SC。
- [ ] 跑基线：`pnpm typecheck` 和 `pnpm vitest run packages/core/src/portrait.test.ts`。预期全部通过。如果工作区里 10/12 未提交的改动让基线不绿，先停下来报告，不要在红色基线上开工（P-A 第 0 步负责提交那批改动）。

---

## 阶段 1：核心契约（`packages/core`）

### 任务 1.1：固定维度与 schema

**文件**：改 `packages/core/src/portrait.ts`，测试写在 `packages/core/src/portrait.test.ts`。

- [ ] **先写失败的测试**（加到 `portrait.test.ts`）：
  - `SCHWARTZ_VALUES.map((v) => v.name)` 恰好是 `["自主","刺激","享乐","成就","权力","安全","遵从","传统","仁慈","普世"]`。按施瓦茨环形结构排列，这个顺序也就是雷达的画法顺序。
  - `ENERGY_CATEGORIES` 恰好是 `["深度工作","学习输入","创造产出","沟通协作","行政事务","休息恢复"]`。
  - `SAY_DO_DIMENSIONS.map((d) => d.label)` 恰好是 `["按计划投入","按时完成","收尾","外部验收","回应等待"]`；`id` 依次为 `plan`、`on_time`、`follow_through`、`acceptance`、`waiting`。
  - schema 里：`PORTRAIT_SCHEMA.properties.compass.properties.values.items.properties.name.enum` 等于这 10 个名字，`maxItems` 为 10；`energy.map.items.properties.category.enum` 等于 6 类；`gap.pairs.items` 的键恰好是 `dimension`（5 个标签的枚举）、`says`、`evidence`，**没有** `does`；`cover.properties.coreWord.maxLength` 为 6。
  - `PORTRAIT_SCHEMA_VERSION === 2`。
- [ ] 运行 `pnpm vitest run packages/core/src/portrait.test.ts`，预期失败：常量不存在。
- [ ] **实现**：
  - 导出三组常量（`as const`），以及 `PORTRAIT_SCHEMA_VERSION = 2`。
  - 类型：`cover.coreWord?: string`；`compass.values` 的 `name` 仍是 string（旧报告的名字不是枚举）；`energy.map[].category?: string`；`gap.pairs?: Array<{ dimension: string; says: number; evidence?: string; does?: number }>`。`does` 只为读旧报告保留，网页不再使用。
  - schema：`cover` 加 `coreWord: text(6)`；`values` 的 `name` 改成 `{ type: "string", enum: SCHWARTZ_VALUES.map(...) }`、`maxItems: 10`、`evidence: text(80)`；`map` 的条目加 `category` 枚举；`pairs` 的条目改为 `object({ dimension: enum, says: score(0,100), evidence: text(80) })`、`maxItems: 5`。
  - 不改的部分：`keywords`、`tagline`、`type`、`character`、`insights`。
- [ ] 跑 `pnpm vitest run packages/core/src/portrait.test.ts packages/core/src/structured-output.test.ts`，预期通过。`structured-output.test.ts` 会自动检查所有导出的 `*_SCHEMA`，枚举个数不能超过 `MAX_ENUM_VALUES`。

### 任务 1.2：`validatePortrait` 检查是否齐全

**文件**：同上。

- [ ] **先写失败的测试**：
  - 一份报告只给了 9 项价值时，抛出 `PORTRAIT_VALUES_INCOMPLETE`，`detail` 写出缺了哪一项；价值有重复名时同样抛出。
  - `gap.pairs` 缺了某一项或重复时，抛出 `PORTRAIT_SAY_DO_INCOMPLETE`，`detail` 写出缺的标签。
  - 10 项齐全、顺序打乱时能通过，输出的 `values` 已按 `SCHWARTZ_VALUES` 的顺序排好，`pairs` 已按 `SAY_DO_DIMENSIONS` 的顺序排好。
  - 已有测试（主线、敏感词、份额缩放）照常通过。
- [ ] 运行，预期失败。
- [ ] **实现**：在 `validatePortrait` 里排序并检查是否齐全，错误的 `detail` 写法照 `PORTRAIT_LINE_UNKNOWN`。这两类错误属于内容质量问题，由修复循环发回给模型（见任务 3.2 的 `softAccept`）。
- [ ] 运行，预期通过。

### 任务 1.3：标签由代码计算

**文件**：改 `packages/core/src/portrait-type.ts`，测试写在 `portrait.test.ts`。

- [ ] **先写失败的测试**（替换原来断言 `"环形飞轮"` 的那一行）：
  - `portraitLabels(report, { lineLabel })` 返回 `{ cells, identities }`。
  - `cells` 依次是：`{ title: "核心词", value: cover.coreWord }`、`{ title: "价值核心", value: 得分最高的施瓦茨项 }`（同分时按 `SCHWARTZ_VALUES` 的顺序取前一项）、`{ title: "建议底座", value: lineLabel(targetShare 最高的主线), detail: "建议投入约 N%" }`。
  - `identities` 是**其余**主线，按 `targetShare` 从高到低排，每项 `{ lineId, label, target, now }`，`now` 取 `share`，没有时为 `null`。
  - 缺 `coreWord` 时没有「核心词」这一格；价值不齐全或名字不在施瓦茨 10 项内（旧报告）时没有「价值核心」这一格。
  - 返回结果里没有任何一项的 title 是「飞轮形态」「充电方式」「工作时段」。
- [ ] 运行，预期失败。
- [ ] **实现**：改写 `portraitLabels`，删掉 `peakHours` 参数、已不用的 `flywheelLoops` 引用，以及三段被删标签的代码。把 `portrait-view.tsx` 里对它的调用改到新的签名（视图的细节放到阶段 4）。这时 `pnpm typecheck` 会报出所有调用处。
- [ ] 跑 `pnpm vitest run packages/core/src/portrait.test.ts && pnpm --filter @crossline/core typecheck`，预期通过。

### 任务 1.4：言行对照的「所做」（纯函数）

**文件**：新建 `packages/core/src/portrait-say-do.ts`、`packages/core/src/portrait-say-do.test.ts`，并从 `packages/core/src/index.ts` 导出。

- [ ] **先写失败的测试**：
  - 输入 `SayDoInput = { now; firstExecutionAt: string | null; executions: number; plannedMinutes; workedMinutes; stepsDue; stepsOnTime; started; finished; submitted; passed; waitingAnswered; waitingOnTime }`。
  - 输出 `{ sufficient, days, executions, does: Record<SayDoId, number | null> }`。
  - 分数 = 分子 ÷ 分母 × 100，四舍五入，最大 100；分母为 0 时为 `null`。按计划投入是 `workedMinutes / plannedMinutes`，超过计划的部分按 100 计。
  - 数据是否够用的边界：首次执行距今 13 天或只有 9 次执行时，`sufficient: false`；满 14 天且有 10 次执行时为 `true`。`firstExecutionAt` 为 `null` 时为 `false`、`days` 为 0。
  - `answeredOnTime({ updatedAt, followUpAt })`：在跟进日后两天内（含）回应算按时，第三天算迟。规则与 `apps/web/lib/effectiveness.ts` 现有的写法一致。
- [ ] 运行 `pnpm vitest run packages/core/src/portrait-say-do.test.ts`，预期失败。
- [ ] **实现**：约 40 行，不读账本。常量 `SAY_DO_MIN_DAYS = 14`、`SAY_DO_MIN_EXECUTIONS = 10`。
- [ ] 运行，预期通过。

**建议提交点**：「画像契约：施瓦茨 10 项、能量 6 类、言行 5 项与代码计算的标签」。

---

## 阶段 2：从账本读出「所做」（`packages/db`）

### 任务 2.1：`sayDoFor`

**文件**：新建 `packages/db/src/portrait.ts`、`packages/db/src/portrait.test.ts`，并从 `packages/db/src/index.ts` 导出；`scheduledMinutesKey` 挪到 core；改 `apps/web/lib/schedule-memory.ts` 和 `apps/web/lib/effectiveness.ts`。

- [ ] **先写失败的测试**（`new CrosslineStore(":memory:")`，写法照 `waiting.test.ts`）：
  - 造 10 次执行，首次执行在 20 天前，结束时间和暂停分钟都已知；两天的 `schedule.minutes:<day>` 记录；三个步骤，其中两个 `done`、一个过期未做；两个工单 `work_order.transitioned` 到 `evidence_review`，其中一个最后到了 `accepted`；两个等待事项，一个按时回应、一个迟了。
  - 断言 `sayDoFor(store, "w", now)` 的 `does` 等于手算的值，`sufficient` 为 `true`。
  - 断言另一个工作区看不到这些数据（`workspace_id` 隔离）。
- [ ] 运行 `pnpm vitest run packages/db/src/portrait.test.ts`，预期失败。
- [ ] **实现**（只读，一个函数），各项的读法：
  - 计划分钟：近 28 天里有 `schedule.minutes:<day>` 记录的那些天，把计划分钟加总。实际分钟：同样那些天里开始的执行（按 `startedAt.slice(0,10)` 归日，与计划按本地日记录有最多一天的偏差，在 28 天总量上可以忽略，代码注释里写明）的「结束 − 开始 − 暂停」之和。只算有 `endedAt` 的执行。
  - 步骤：`listStepPlans(ws)` 里每个计划的 `steps`。参与计算的是 `dueBy` 非空、`status !== "skipped"`，并且已做或 `dueBy` 已过的步骤；按时是指 `status === "done"` 且 `updatedAt` 的日期不晚于 `dueBy`。`updatedAt` 是近似值，注释里写明。
  - 收尾：开始过（有执行记录）的工单里，状态是 `evidence_review` 或 `accepted` 的比例。
  - 外部验收：`listEvents(ws, { type: "work_order.transitioned" })` 里转到过 `evidence_review` 的工单里，当前状态为 `accepted` 的比例。
  - 回应等待：`listWaitingItems(ws)` 中非 `open` 的事项用 `answeredOnTime` 判断。
  - 把 `scheduledMinutesKey` 挪到 core，`schedule-memory.ts` 改为从 core 引入；`effectiveness.ts` 里内联的「两天内」判断改用 `answeredOnTime`（复用，行为不变）。
- [ ] 跑 `pnpm vitest run packages/db/src/portrait.test.ts apps/web/lib/schedule-memory.test.ts`，以及 `pnpm typecheck`，预期通过。

**建议提交点**：「言行对照的所做从账本计算」。

---

## 阶段 3：Writer、Skill 与重写（worker）

### 任务 3.1：Writer Skill 与契约对齐

**文件**：改 `skills/marketplace/plugins/crossline/skills/crossline-portrait-writer/SKILL.md`，新建 `apps/worker/src/portrait-writer.test.ts`。

- [ ] **先写失败的测试**（作用同 `concierge.test.ts`，防止两边各改各的）：读 SKILL.md，断言它写到了 `coreWord`、10 个施瓦茨中文名、6 个能量类别、5 个言行标签和 `doing`；并断言它**不再**出现「5–8 things」这句旧的价值说明。
- [ ] 运行 `pnpm vitest run apps/worker/src/portrait-writer.test.ts`，预期失败。
- [ ] **改 SKILL.md**：
  - `cover.coreWord`：一个词（不超过 6 字），概括思维习惯。不得写成「思维模式」，因为页面上的类型叫「思维模式类型」。
  - `compass.values`：恰好 10 项，按施瓦茨的定义给每项打 0–100 分，并写一句依据。每项附一行定义，例如 自主＝独立思考与选择；刺激＝新奇与挑战；享乐＝愉悦；成就＝按社会标准证明能力；权力＝地位与对资源的支配；安全＝稳定与秩序；遵从＝克制、不违背规范；传统＝尊重文化与宗教习俗；仁慈＝关心身边的人；普世＝理解、宽容与保护所有人和自然。证据不同的项，分数也要拉开。
  - `energy.map[].category`：6 类中选一类，活动名仍然个人化。
  - `gap.pairs`：恰好 5 项，固定标签。`says` 是访谈中本人对这一项看重程度的推断，附一句依据。**不写 `does`**，「所做」由应用从执行记录算出。
  - 输入多了 `doing = {sufficient, days, executions, does}`：`sufficient` 为真时，`gap.does` 和 `gap.reading` 必须以这些数字为据；为假时，只能根据访谈和文件来写，并说明执行记录还不够。
  - 「Language」一节保持不变。
- [ ] 运行，预期通过。

### 任务 3.2：Writer 带上 `doing`、保存版本号、内容质量问题保留答案

**文件**：改 `apps/worker/src/portrait-writer.ts`、`apps/worker/src/index.ts`，测试写在 `portrait-writer.test.ts`。

- [ ] **先写失败的测试**（用 `fakeRuntime`，`:memory:` 账本里放一条主线）：
  - 假运行时返回一份合规报告后，`portrait.report` 设置里的 JSON 带有 `schema: PORTRAIT_SCHEMA_VERSION`，发给模型的上下文里有 `doing`（用 `prompts()` 检查）。
  - 假运行时连续三次返回价值缺一项的报告（两次修复都没修好）时，报告仍然写入（`softAccept`）、`state: "written"`，网页据此不画雷达（见任务 4.3）。
  - 主线不存在（`PORTRAIT_LINE_UNKNOWN`）时仍然 `blocked`，这是硬性错误，不能放过。
- [ ] 运行，预期失败。
- [ ] **实现**：
  - 上下文加 `doing: sayDoFor(store, workspaceId, new Date())`。
  - `setSetting` 写入 `{ version, at, schema: PORTRAIT_SCHEMA_VERSION, report }`。
  - `softAccept`：只在 `PORTRAIT_VALUES_INCOMPLETE` 和 `PORTRAIT_SAY_DO_INCOMPLETE` 时保留答案（经过 `validatePortrait` 的排序，但不检查是否齐全，可以给它加一个 `lenient` 参数），其余错误返回 `undefined`。
  - 把 `index.ts` 里内联的 `writePortrait` 抽成模块级 `writePortraitFor(workspaceId)`，供 supervisor 和 tick 共用，行为不变（先记 `portrait.requested`，结果是 `blocked` 时记 `portrait.blocked`，否则在后台调插画器）。
- [ ] 运行 `pnpm vitest run apps/worker/src/portrait-writer.test.ts && pnpm --filter @crossline/worker typecheck`，预期通过。

### 任务 3.3：上线后自动重写一次

**文件**：改 `apps/worker/src/portrait-writer.ts`、`apps/worker/src/index.ts`，测试写在 `portrait-writer.test.ts`。

- [ ] **先写失败的测试**，针对 `portraitRewriteDue(store, workspaceId, now)`：
  - 没有报告时返回 `null`，新账号由访谈结束触发。
  - 报告缺 `schema` 或 `schema < 2`、并且没有设置 `portrait.rewrite.v2` 时，返回 `"schema"`。
  - 已经有 `portrait.rewrite.v2` 时返回 `null`。只重写一次，失败了也不重试；失败会以 `portrait.blocked` 显示在页面上，由本人点「重新生成」。
  - 最近一小时内有 `portrait.requested` 时返回 `null`，避免同时跑两次。
- [ ] 运行，预期失败。
- [ ] **实现**：
  - 写 `portraitRewriteDue`。
  - 在 `index.ts` 加 `portraitPass(workspaceId, checkedAt)`：用 `rewriting` 集合防止重叠，用 `spendAllows(..., "discretionary")` 控制额度（额度紧时等它恢复，到时再跑）。**先**写 `portrait.rewrite.v2 = checkedAt`，**再**调用 `writePortraitFor`。
  - 在 `tick()` 中、`goalSplitPass` 之后，对每个工作区调用一次。
- [ ] 运行，预期通过。

### 任务 3.4：言行对照每月最多重写一次（只换 `gap`）

**文件**：同上。

- [ ] **先写失败的测试**：
  - `portraitRewriteDue` 在报告已是 v2、`sayDoFor(...).sufficient === true`、`portrait.gap.at` 为空或已超过 30 天时，返回 `"gap"`；数据不够或不到 30 天时返回 `null`。`"schema"` 优先于 `"gap"`。
  - `createPortraitWriter(..., { only: "gap" })` 写入后，报告里只有 `gap` 换了，其他字段与原报告逐字相同；`version` 不变（插画按版本对应，版本一变形象就会消失）；记一条 `portrait.gap_rewritten` 事件；不调插画器。
- [ ] 运行，预期失败。
- [ ] **实现**：
  - `createPortraitWriter` 增加 `options.only?: "gap"`：上下文里加上 `previous: 原报告`，`runCodexSkill` 传 `tier: "mid"`（按设计稿可以降档），输出只取 `gap` 合并进原报告，再写 `portrait.gap.at`。
  - `portraitPass` 根据返回值选择模式，同样受 `"discretionary"` 额度控制。
- [ ] 运行 `pnpm vitest run apps/worker/src/portrait-writer.test.ts`，预期通过。

### 任务 3.5：真实运行一次 writer【需要真实 Codex】

- [ ] 启动审查服务器（`.claude/launch.json` 里的 `"review"`，打开 `localhost:3320`，不要用 `127.0.0.1:3320`），设置 `CROSSLINE_RECORD_DIR`，在 `/portrait` 点「生成画像报告」。顶档模型，大约 80 秒到几分钟。
- [ ] 检查：恰好 10 项价值且分数拉得开；`coreWord` 不超过 6 字，也不是「思维模式」；每个能量活动都有类别；言行对照 5 项都有 `says`；没有修复失败（`audit.repairs` 看 Settings → 模型用量，或看录下的文件）。
- [ ] 把录下的答案放进 `apps/worker/src/testing/fixtures/portrait-v2-real.txt`，在 `portrait-writer.test.ts` 加一个用 `recordedAnswer("portrait-v2-real")` 回放的测试，让它走完 worker → 校验器 → 账本的全程。
- [ ] 跑 `pnpm vitest run apps/worker/src/portrait-writer.test.ts`，预期通过。

**建议提交点**：「画像 writer 改用固定维度，上线后自动重写一次，言行对照每月重写」。

---

## 阶段 4：网页改成 A 风格

### 任务 4.1：版面几何的纯函数

**文件**：新建 `apps/web/app/portrait/poster-geometry.ts`、`apps/web/app/portrait/poster-geometry.test.ts`。

- [ ] **先写失败的测试**：
  - `axisBar(score)`：返回 `{ side: "left" | "right", percent, from, width, inside }`，单位是轨道宽度的百分比。条从中线向偏向的一极伸出；`percent >= 66` 时百分比写在条内，否则写在条外紧挨条端，与 A 稿规则一致。`score = 50` 时宽度为 0、写在条外。94、22、69、52 四种情况都要测到。
  - `dodgeMatrix(items)`：影响和投入相同的建议，围绕格子中心按固定角度散开。任意两个点的圆心距离都不小于 `2r + 2`（r 是圆点半径），用 6 个同格的点测。
  - `energyLegend(map)`：先按 `ENERGY_CATEGORIES` 的顺序分组（旧报告没有类别时归到最后的「未分类」），组内按 `loveScore + skillScore` 从高到低排；编号从 1 开始连续，平面上的点和图例用同一套编号。
  - `radarValues(values)`：报告的价值恰好是施瓦茨 10 项时，按 `SCHWARTZ_VALUES` 的顺序返回，否则返回 `null`，网页就不画雷达。
  - 夹具：读 `e2e/fixtures/portrait-report.json`（任务 5.1 写），断言 `validatePortrait(fixture, ["research","startup","media","investment"])` 不抛错。可以先写这个测试，夹具在 5.1 补上。
- [ ] 运行 `pnpm vitest run apps/web/app/portrait/poster-geometry.test.ts`，预期失败。
- [ ] **实现**：全部写成纯函数，不引用 React。
- [ ] 运行，预期通过（夹具那条等 5.1 完成后再通过）。

### 任务 4.2：`loadPortrait` 带上 `sayDo`

**文件**：改 `apps/web/lib/portrait.ts`。

- [ ] 在 `PortraitState` 加 `sayDo: ReturnType<typeof sayDoFor>`，取值为 `sayDoFor(getStore(), ctx.workspaceId, now)`。`now` 取 `CROSSLINE_FIXED_NOW`，没有时用当前时间。
- [ ] 删除 `agentHours`、`peakHours`，以及读取 `AGENT_HISTORY_SUMMARY` 的代码；`portrait-view.tsx` 的 `State` 类型同步修改。
- [ ] 跑 `pnpm --filter @crossline/web typecheck`，预期通过。

### 任务 4.3：图表

**文件**：改 `apps/web/app/portrait/portrait-charts.tsx`。

- [ ] `DivergingAxes({ type, evidence })`：HTML 加 CSS 栅格（宽度随屏幕变化，手机上不溢出），用 `axisBar` 计算。两端都写极名，偏向的一极加粗并用深色，另一极用浅色；百分比按 `inside` 决定写在条内（白字）还是条外（深色字）。`evidence` 为真时，在条下单独一行写依据，这一行只出现在长图里。
- [ ] `IdentityBars({ rows })`：每行是主线名、一根轨道、实心条（建议比例）和空心标记（现在的比例），右侧写「现在 → 建议」。身份标签只列其余主线，「主线飞轮」那一节列全部主线。删除 `AllocationChart`。
- [ ] `EnergyScatter` 改为编号圆点（实心表示充电，空心表示耗电），平面上不写活动名；图下是按类别分组的图例「编号 活动名（充电/耗电）」，用 `energyLegend` 排。
- [ ] `ValuesRadar`：只接收 `radarValues` 的结果，固定 10 轴。在 `max = 340` 时标签不能互相压住，靠 5.2 的重叠测试保证；不够时加大标签半径，或给左右两侧的标签留出更多边距。
- [ ] `GapChart({ says, sayDo })`：「所说」来自报告的 `pairs`，「所做」来自 `sayDo.does`。`sayDo.sufficient` 为假时**不画分数**，换成一行说明，写出现有天数和次数，例如「执行记录满 14 天且不少于 10 次后画出对照（现有 6 天、3 次）」，再加上 `gap.says` 和 `gap.does` 的文字（`.gen`）。某一项的分母为 0 时，这一行写「暂无记录」，不画点。
- [ ] `AdviceMatrix` 用 `dodgeMatrix` 布点。
- [ ] 跑 `pnpm --filter @crossline/web typecheck` 和 `pnpm vitest run apps/web/app/portrait`，预期通过。

### 任务 4.4：页面结构、可信度标注、改名、精简分享卡

**文件**：改 `apps/web/app/portrait/portrait-view.tsx`、`apps/web/app/portrait/page.tsx`。

- [ ] 前半部分（`SharePart`），按 A 稿的顺序：
  1. 页眉写「Crossline 思维模式类型」，紧接着是可信度标注「基于访谈的推断，不是标准化心理测验」（系统文字）。
  2. 形象在左，用组色圆形背景（没有形象时只画圆）；类型码、类型名、组名条在右。
  3. 一句话（`tagline`，`.gen`），左侧一道竖线。
  4. `DivergingAxes`：屏幕上和长图里都带依据（`evidence`）。
  5. 标签区：用 `portraitLabels` 的 `cells` 排一行（核心词和价值核心用 `.gen`，因为核心词是模型写的；价值核心的名字是固定的，F1 下可以用衬线体），下面是「身份」的 `IdentityBars`。
  6. 第 01 节「价值与能量」：`ValuesRadar`、正北、`EnergyScatter`。
  7. 第 02 节「主线飞轮」：`LineNetwork`、全部主线的 `IdentityBars`、长期目标条、`GapChart`。
- [ ] 改名：把 `page.tsx` 的 `description`、两个页眉、分享说明「人格类型卡片」以及文件名「我的人格类型.png」里的「人格类型」都改成「思维模式类型」。16 个类型名和四条轴不变。
- [ ] 分享卡（`.pt-card`）**只留**：形象、类型码、类型名、一句话、四条轴（只有百分比和偏向的极名，不写依据）、四个标签（核心词、价值核心、建议底座三格，加上紧凑的「身份」条），以及底部的可信度标注和 Crossline 字样。去掉组名说明（`blurb`）。P-E 的名人一栏直接往卡片底部追加。
- [ ] 删除没人用了的 `pt-modes` 等样式（如果有）。私密的后半部分（03–07）只换风格，不改内容。
- [ ] 跑 `pnpm --filter @crossline/web typecheck`，预期通过。

### 任务 4.5：A 风格样式、页面高度随内容、【F1】字体

**文件**：改 `apps/web/app/portrait/portrait.css`；【F1】新建 `scripts/poster-font-subset.ts` 和 `apps/web/public/fonts/poster-serif.woff2`。

- [ ] 在 `.pt-doc` 上定义颜色变量（不要改到全站）：`--pt-paper:#F6F2EA`、`--pt-ink:#1C1A17`、`--pt-muted:#4F4A42`、`--pt-track:#DDD5C7`、`--pt-soft:#ECE5D8`、`--pt-accent:var(--group)`、`--pt-accent-text:#08427A`。A 稿的 `#6B655C` 在纸色上只有约 5.2:1，达不到 7:1，所以 muted 改成更深的 `#4F4A42`，约 7.9:1。组色作为文字放在纸色上约 7.1:1，处在边界上，条外的百分比因此用 `--pt-ink`。
- [ ] 页面：米色纸面，分享卡外框 14px 粗黑边，章节之间用 3px 黑线分隔，章节编号用小号浅色字。**去掉屏幕上 `.pt-page` 的 `min-height:1123px`**，页面高度随内容。打印时保留 `break-after: page`，去掉 `min-height:297mm`，A4 上就不会留下大片空白。
- [ ] 手机（`max-width:820px`）：形象和类型名改为上下排列，类型码缩小，倾向条轨道按比例变窄。
- [ ] 【F1】
  - `scripts/poster-font-subset.ts`：从 core 收集所有衬线字符串（`TYPE_TABLE` 的名字、`TYPE_GROUPS` 的名字、`TYPE_AXES` 的字母、`SCHWARTZ_VALUES`、章节标题和标签栏标题常量），加上数字与 `%`；调用 devDependency `subset-font` 生成 `poster-serif.woff2`，同时生成 `poster-serif.glyphs.txt`（收录了哪些字符）。
  - CSS 里写 `@font-face{font-family:"Crossline Poster Serif";src:url(/fonts/poster-serif.woff2) format("woff2");font-weight:700;font-display:block}`；`.pt-serif` 的字体为 `"Crossline Poster Serif", var(--f-display)`。
  - 单测（写进 `poster-geometry.test.ts`）：所有衬线字符串里的字符都在 `poster-serif.glyphs.txt` 中，否则某个字会悄悄退回成其他字体。
- [ ] 跑 `pnpm build`，预期通过。启动 `pnpm dev`，在 1440 宽和手机宽度下用浏览器看一遍，对照 `A-poster.png` 和 `A-long.png`。这一步只是人眼看，验收由阶段 5 的测试负责。

### 任务 4.6：分享导出

**文件**：改 `apps/web/app/portrait/portrait-view.tsx`。

- [ ] `toBlob` 的 `backgroundColor` 两处都改成 `#F6F2EA`；文件名改为「我的思维模式类型.png」和「我的画像.png」。
- [ ] 分享卡尺寸保持 540×675（4:5，导出时放大两倍成 1080×1350）。长图宽 794，高度随内容（已有 `.pt-shared-half .pt-page{min-height:0}`）。
- [ ] 长图末尾的页脚加上可信度标注。
- [ ] 在 `pnpm dev` 下点一次「分享画像」，确认导出的两张图里没有文字被裁掉，衬线字体也嵌进去了（F1）。

**建议提交点**：「画像改成编辑杂志风格：倾向条、编号能量图、身份条、精简分享卡、可信度标注」。

---

## 阶段 5：e2e

### 任务 5.1：共享的账本工具和夹具

**文件**：新建 `e2e/ledger.ts`、`e2e/fixtures/portrait-report.json`；改 `e2e/crossline.spec.ts`。

- [ ] 把 `openStore`、`realWorkspaceId` 从 `crossline.spec.ts` 挪到 `e2e/ledger.ts`，`crossline.spec.ts` 改为从这里引入（复用，行为不变）。
- [ ] 加 `ensurePortrait(page)`：先 `page.goto("/settings")`，让账号的工作区建好；没有 `portrait.report` 时，写入 `{ version: 1, at: "2026-10-12T09:00:00.000Z", schema: 2, report: fixture }`。
- [ ] 夹具全部虚构，并且故意制造压力：
  - 10 项价值，有相邻的高分；12 个能量活动，名字都是 10 字以内的长名，其中三项的分数完全相同（以前标签会重叠）。
  - 6 条建议，其中两条的影响和投入相同（原来 5、6 号点重叠的情况）。
  - 四条轴分别是 94、22、31、52：52 那条要测「写在条外」。
  - 四条主线 `research`、`startup`、`media`、`investment`，都有 `share` 和 `targetShare`；`coreWord` 刚好 6 字，`tagline` 刚好 40 字；言行对照 5 项。
  - `sensitive` 里放一个虚构的机构名，用来检查分享版是否打码。
- [ ] 跑 `pnpm vitest run apps/web/app/portrait/poster-geometry.test.ts`，夹具那条现在应该通过。

### 任务 5.2：画像页文字不重叠，分享卡装得下

**文件**：改 `e2e/design-audit.spec.ts`。

- [ ] **先写测试**：`test("/portrait: no two pieces of text overlap, and the share card fits")`。
  - `await ensurePortrait(page)`，然后打开 `/portrait`。
  - 在页面里收集 `.pt-doc` 与 `.pt-offscreen` 下所有可见文字节点，对每个节点用 `Range.getClientRects()` 取每一行的包围盒（比元素自身的盒子更贴合字形，SVG 的 `<text>` 也适用），两两比较，交叠的宽和高都超过 1px 就算重叠。失败信息写出两段文字和各自的选择器。
  - 断言 `.pt-card` 的 `scrollHeight <= clientHeight + 1`。
  - 在 desktop-chrome 和 mobile-chrome 两个项目下都跑。
- [ ] 原来的 `PAGES` 循环在 `path === "/portrait"` 时也先调用 `ensurePortrait`，这样字体、字号、对比度和溢出检查审的是一份完整报告，而不是空页面。
- [ ] 【F1】`audit()` 里期望的字体改成：在 `.gen` 内为 `microsoft yahei`，在 `.pt-serif` 内为 `crossline poster serif`，其余为 `arial`。注释写明第三种字体只用于代码写死的字符串。
- [ ] 先在**改版前**的代码上跑一次 `pnpm exec playwright test e2e/design-audit.spec.ts -g portrait`，预期失败：能量地图的标签重叠，或建议矩阵的点重叠。这一步证明测试真能发现原来的缺陷。如果阶段 4 已经做完，用 `git stash` 临时退回 `apps/web/app/portrait` 来验证。
- [ ] 在改版后的代码上再跑一次，预期全部通过。

### 任务 5.3：视觉基线（两个平台）

**文件**：改 `e2e/crossline.spec.ts`，生成 `e2e/crossline.spec.ts-snapshots/portrait-*-desktop-chrome-{win32,linux}.png`。

- [ ] 新增测试 `画像海报的视觉基线`，只在 desktop-chrome 下跑：先 `ensurePortrait`，再对 `.pt-page.pt-type` 截图（`portrait-share-half.png`）。用 `addStyleTag` 把 `.pt-offscreen` 改成 `position:static`，然后对 `.pt-card` 截图（`portrait-card.png`）。e2e 里没有形象图，这样反而稳定；日期来自夹具的 `at`。
- [ ] Windows：`pnpm exec playwright test e2e/crossline.spec.ts -g 画像 --update-snapshots`，生成 `-win32.png`。打开 PNG 与 `A-poster.png` 对照着看。
- [ ] Linux：在云端会话（`CLAUDE_CODE_REMOTE=true`，`.claude/hooks/session-start.sh` 会装好依赖）里跑同一条命令，生成 `-linux.png`。不要在 Windows 上手改 PNG。
- [ ] 两个平台各跑一次，不带 `--update-snapshots`，预期通过。

**建议提交点**：「画像 e2e：文字不重叠、分享卡装得下、两平台视觉基线」。

---

## 阶段 6：文档、全量验证与上线

### 任务 6.1：同一次改动里更新文档

- [ ] `CLAUDE.md` 里讲画像报告的那一段：
  - 「personality-test result page」改为「思维模式类型」；
  - 标签改为核心词、价值核心、建议底座、身份（横条），由 `portraitLabels` 计算，「飞轮形态」「充电方式」「工作时段」已删除；
  - 补上施瓦茨 10 项、能量 6 类和言行 5 项（`sayDoFor`，数据不够时只写文字）；
  - 补上 A 风格、可信度标注、`PORTRAIT_SCHEMA_VERSION` 与上线后重写一次（`portrait.rewrite.v2`）、言行对照每月重写（`portrait.gap.at`）。
- [ ] `docs/copy-style.md`：【F1】写明第三种字体只用于海报上代码写死的字符串；【F2】不改。
- [ ] `GLOSSARY.md`：加「思维模式类型」词条，并注明它不是「人格类型」。

### 任务 6.2：全量验证与上线【上线后的重写会消耗真实 Codex 额度】

- [ ] `pnpm verify`，预期 typecheck、test、build、e2e 全部通过。
- [ ] `pnpm build:prod`，然后**重启常驻的网页应用和 worker**（在运行中的服务器下重建 `.next-prod` 会让页面丢失样式，所以必须重启）。
- [ ] 观察真实账号：下一次 tick 应该先写 `portrait.rewrite.v2`，再出现 `portrait.requested` 和 `portrait.written`（顶档，大约 80 秒），随后插画器重画形象。只通过页面和接口查看，不直接改账本（见 auto-memory「real-account-operations」）。打开 `/portrait` 确认：标签是四类，雷达是 10 轴，言行对照只有文字（真实账号目前执行记录不够），分享卡精简，没有重叠。
- [ ] 把以上结果报告给本人，提交与否由本人决定。

---

## 验收（对照第 7 节「跑通标准」中关于画像的一条）

| 跑通标准 | 证明 |
|---|---|
| 画像页任意两段文字不重叠 | `e2e/design-audit.spec.ts` 的「/portrait: no two pieces of text overlap」，桌面和手机都跑，用压力夹具 |
| 分享卡只含类型名、形象、一句话、四个百分比、四个标签和名人一栏 | 任务 4.4 的结构，加上视觉基线 `portrait-card.png` 两个平台；分享卡装得下有断言。**名人一栏属于 P-E**，本计划验收时卡片上没有它，P-E 往底部追加 |
| 价值雷达恰为施瓦茨 10 项 | 任务 1.1 的 schema 枚举与 `maxItems: 10`、任务 1.2 的齐全检查、任务 4.1 的 `radarValues`（不是 10 项就不画） |
| 名人与名言来自名人库、斜体显示 | P-E，不在本计划内 |
| 版面缺陷（倾向条压字、能量图标签重叠、矩阵 5/6 号点重叠、页面下半部空白、倾向条容易误读） | `axisBar`、`energyLegend`、`dodgeMatrix` 的单测；去掉 `min-height`；重叠测试；5.2 中「先在旧代码上失败」的那一步 |
| 可信度标注、「所做」用真实执行数据、数据不够时只写文字 | 任务 4.4 与 4.6 的文案；`sayDoReadings` 的边界测试（13 天、9 次）；`sayDoFor` 的账本测试；`GapChart` 在数据不够时不画分数 |
| 标签由代码计算，删除飞轮形态、充电方式、工作时段，「人格类型」改称「思维模式类型」 | 任务 1.3 的单测；任务 4.4 改名，并用 `grep -rn "人格类型" apps` 确认结果为空 |
| 能量地图 6 类、言行对照 5 项 | 任务 1.1 和 1.2 的单测；任务 3.5 的真实回放夹具 |
| 旧报告上线后自动重写一次 | `portraitRewriteDue` 的单测；任务 6.2 在真实账号上看到的事件顺序 |

## 风险

- **字体（F1）**：子集里缺字时会悄悄退回成其他字体，由字符覆盖单测兜底。改了类型名或标题之后，要重新跑 `scripts/poster-font-subset.ts`。Linux 和 Windows 上的抗锯齿不同，视觉基线本来就按平台分开存。
- **对比度处在边界上**：组色放在纸色上约 7.1:1。如果审查报错，不要调浅纸色，把对应文字改成 `--pt-ink` 或 `--pt-accent-text`。
- **「所做」是近似值**：步骤按时依据的是 `updatedAt`，做完以后再编辑会让它变晚；执行按 UTC 归日。数据够用的门槛（14 天、10 次）也限制了噪声。P-A 第 3 步的完成确认会给出准确的完成时间，到时把 `sayDoFor` 换成新字段。
- **重写会改动本人已经看过的报告**，并且会重画形象（P-D 之前形象跟着报告版本走）。重写只发生一次，标记在跑之前写入，失败不会反复重跑。
- **夹具与 schema 可能对不上**：`poster-geometry.test.ts` 用 `validatePortrait` 校验夹具，schema 一改，单测就先报错。
- **e2e 共用一个账本**：`ensurePortrait` 只在没有报告时才写入，桌面和手机谁先跑都不影响结果。
- **雷达 10 轴在手机宽度下标签挤**：由重叠测试发现；修法是加大标签半径或换行，不要把字号降到 12px 以下。

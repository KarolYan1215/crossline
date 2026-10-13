# P-B 可开始标准与访谈提速 · P-B2 授权文件夹 实施计划

> 给执行者：按任务顺序做，每个任务先写失败的测试、再写最少的实现、再跑验证。勾选框（`- [ ]`）用来记进度。依据是 `docs/loop-and-scout.md` 第 7 节前半、第 11 节第 4、6 条、第 12 节 P-B / P-B2。本计划写于 2026-10-12，所列文件与函数已对照当日代码核实（含工作区里未提交的 10/12 修改）。

**目标**：
- **P-B**：新账号必须达到「可开始标准」（五条）才能使用除访谈、设置、登录以外的页面；已有账号不豁免。访谈改为先读材料、先问五条、达标即可开始，画像在同一次访谈里继续。用「注意力时间」衡量上手用时，评测脚本断言：到达可开始 ≤ 6 轮、模拟注意力时间 ≤ 30 分钟、完整设置 ≤ 90 分钟。
- **P-B2**：本人逐个授权本机文件夹，常驻 worker 定时读取其中的已有与新增文件，作为访谈和规划的材料；设置页可见已读清单、可撤销，并如实写明正文会发给模型服务商。

**架构**：
- 五条标准是现有检查清单（`interviewChecklist`，`packages/core/src/interview-checklist.ts`）里打了 `start: true` 标记的几项；`readyToStart(items)` 只看这几项，且这几项**只认本人确认或文件为据，不认「假设：」**。`complete` 仍是全部完成。
- 闸门在页面层：`apps/web/lib/start-gate.ts` 的 `gateUntilReady(ctx)`，由各页面在 `requireSessionContext()` 之后调用；替换并删除 `needsOnboarding`。API 路由不加闸门（页面拿不到就没有入口；worker 与本地工具照常）。
- `parked` 改为 `readyToStart && !complete`，删除「先开始使用」、`/api/onboarding/park`、`onboarding.parkedAt`、「一天未回复即停放」。
- 访谈阶段顺序改为 `orientation → lines → situation → compass → energy → details`：前两段收齐五条，后四段写画像与项目细节。
- 注意力时间：访谈页每 15 秒在「页面可见且 60 秒内有操作」时上报一次心跳，服务器累加，首次达到可开始 / 完整时记下当时的秒数和轮数（设置 `onboarding.attention`）。
- P-B2：保存文件的那一段（哈希、类型、大小、写入 `sources/`、建 `source_documents` 行）从 `apps/web/lib/sources.ts` 下沉到 `packages/db`；读取正文（`apps/worker/src/extract.ts` 的 `extractText`）与归属判断（`apps/worker/src/source-filing.ts` 的 `fileSourceDocuments`）**本来就在 worker 里**，不用再搬。worker 新增一个十分钟一次的文件夹扫描，过滤规则是 core 里的纯函数。

**约束**：
- pnpm 工作区，测试用 vitest（`pnpm vitest run <file>`），提交前 `pnpm verify`（typecheck + test + build + e2e）。
- **不要提交**，除非本人明确要求；文中「建议提交点」只是建议的切分位置。
- 前置条件：P-A 第 0 步已完成（10/12 未提交的排程与访谈修复已提交，`apps/worker/src/onboarding-session.ts`、`crossline-onboarding/SKILL.md` 以提交后的版本为底）。
- ponytail：能复用就不新写，删除优于新增。中档模型、后台预取、问题流式显示**不在本计划里做**，见任务 B6.3 的判定条件。
- 标 **【真实 Codex】** 的任务要消耗真实额度、跑数小时；标 **【本人】** 的任务需要本人操作或决定。

---

## 第一部分 · P-B 可开始标准与访谈提速

### 阶段 B1 · 判定：`readyToStart`

#### 任务 B1.1：检查清单给五条打标，五条不认假设

**文件**
- 修改：`packages/core/src/interview-checklist.ts`
- 测试：`packages/core/src/interview-checklist.test.ts`

- [ ] **先写失败的测试**（加在 `interview-checklist.test.ts`，复用文件里的 `full`）：

```ts
test("可开始标准：五条打标，全满足才算；画像不要求", () => {
  const items = interviewChecklist({ ...full, portraitConfirmed: false, profile: {} });
  expect(items.filter((item) => item.start).map((item) => item.id))
    .toEqual(["line_desc:research", "line_goal:research", "hard_schedule:research", "availability", "line_project:research"]);
  expect(readyToStart(items)).toBe(true);
  expect(items.find((item) => item.id === "portrait_fields")?.done).toBe(false);
});

test("可开始标准不认「假设：」：硬约束日程与截止只认本人确认或文件", () => {
  const assumed = { ...full, dates: full.dates.filter((entry) => !entry.recurring),
    facts: [...full.facts, { identityId: "research", projectId: "", slot: "fixed_schedule", status: "inferred", sourceRef: "", value: "假设：周二四上课" }] };
  expect(interviewChecklist(assumed).find((item) => item.id === "hard_schedule:research")?.done).toBe(false);
  expect(readyToStart(interviewChecklist(assumed))).toBe(false);
});

test("每条主线至少一个当前项目且知道截止；「没有截止」也算", () => {
  const undated = { ...full, dates: full.dates.filter((entry) => entry.recurring) };
  expect(interviewChecklist(undated).find((item) => item.id === "line_project:research")).toMatchObject({ done: false, owner: "interview" });
  const none = { ...undated, facts: [...undated.facts, { identityId: "research", projectId: "ece555", slot: "no_deadline", status: "confirmed", sourceRef: "reply-4", value: "没有截止" }] };
  expect(interviewChecklist(none).find((item) => item.id === "line_project:research")?.done).toBe(true);
  // 只有 `-default` 项目不算「当前项目」。
  const onlyDefault = { ...full, projects: full.projects.filter((project) => project.id.endsWith("-default")) };
  expect(interviewChecklist(onlyDefault).find((item) => item.id === "line_project:research")?.detail).toBe("尚无当前项目");
});
```

  并把第一个用例「a complete record ticks every item」的 id 列表改为在 `"project:ece555"` 前插入 `"line_project:research"`（位置以实现为准，测试与实现保持一致）；把最后一个用例「what the person could not say is assumed」保持不变（画像项仍认假设）。

- [ ] 运行 `pnpm vitest run packages/core/src/interview-checklist.test.ts`，预期：新用例失败（`readyToStart` 未导出、`start` 字段不存在、`line_project:*` 不存在）。
- [ ] **实现**（最少改动）：
  - `ChecklistItem` 加可选字段 `start?: true`。
  - `line_desc:*`：加 `start: true`；`done` 改为「有描述 且（有候选 或 `line.goals.length > 0`）」——本人自己写了目标就不必再要候选。
  - `line_goal:*`：加 `start: true`（本来就只认本人采用：`line.goals` 只由 `/api/lines`、对话里本人确认的 `line.goal.add`、`/api/lines/goal-edit` 写入）。
  - `hard_schedule:*`：加 `start: true`；删掉 `assumed` 分支（`fixed.length > 0` 才算；待确认的文件日期也算，即「已提供含这些信息的文件」）。
  - `availability`：加 `start: true`，逻辑不变。
  - 新增 `line_project:<lineId>`（`group: "项目"`，`owner: "interview"`，`start: true`）：该线有一个非 `-default` 项目，且满足其一——有 `confirmedFact` 的 `deadline`/`date_*` 事实、有该项目的日期条目（`input.dates`）、有 `confirmedFact` 的 `no_deadline` 事实或 `deadline` 值匹配 `NO_DEADLINE = /没有截止|无截止|不设截止|no deadline/i`。`detail`：没有项目时「尚无当前项目」，有项目没截止时「缺截止（或说明没有截止）：<项目名>」。
  - 导出 `readyToStart(items) = items.filter((i) => i.start).every((i) => i.done)` 与 `startMissing(items) = items.filter((i) => i.start && !i.done)`；从 `packages/core/src/index.ts` 导出（检查已有的 `export * from "./interview-checklist"`）。
- [ ] 运行同一命令，预期全部通过；再跑 `pnpm --filter @crossline/core typecheck`，预期无错。

#### 任务 B1.2：截止的应用自问题 `PROJECT_DEADLINE`

本人答「没有截止」需要一个能被代码读回的选项，否则只能靠模型写事实。

**文件**
- 修改：`packages/core/src/profile-gaps.ts`
- 测试：`packages/core/src/profile-gaps.test.ts`

- [ ] **先写失败的测试**：

```ts
test("一个非默认项目没有截止时，问「有截止日期吗」，答「没有截止」写成 no_deadline", () => {
  const gaps = profileGaps({ identities: [{ id: "media", label: "创作者" }], projects: [{ id: "xhs", identityId: "media", name: "小红书自媒体" }],
    facts: [{ identityId: "media", projectId: "xhs", slot: "what", value: "账号", status: "confirmed" }] });
  const gap = gaps.find((item) => item.code === "PROJECT_DEADLINE")!;
  expect(gap).toMatchObject({ projectId: "xhs", blocking: true });
  expect(answeredGapFacts(`【${gap.question.text}】选择：没有截止`, gaps)).toEqual([expect.objectContaining({ slot: "no_deadline", value: "没有截止" })]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来写日期。补充：2026-12-15`, gaps)).toEqual([expect.objectContaining({ slot: "deadline", value: "2026-12-15" })]);
});
```

- [ ] 运行 `pnpm vitest run packages/core/src/profile-gaps.test.ts`，预期失败。
- [ ] **实现**：`ProfileGap["code"]` 加 `"PROJECT_DEADLINE"`；`ProfileGapInput` 加可选 `dated?: string[]`（有日期条目的项目 id 或名称，调用方从日期批次给）；对每个非 `-default` 项目，若无已确认的 `deadline`/`date_*`/`no_deadline` 事实且不在 `dated` 里，加一个 `blocking: true` 的缺口，问题 id `gap-deadline-<projectId>`，选项「我来写日期」「没有截止」（附说明「不设截止，排程按主线份额安排」）。`answeredGapFacts` 加分支：`补充` 有内容 → `deadline`；选了「没有截止」→ `no_deadline`。`COVERS` 加 `PROJECT_DEADLINE: /截止|deadline|什么时候(交|完成)/i`，避免与模型自己的同类问题重复。
- [ ] `packages/db/src/interview.ts` 的 `interviewGapsFor` 传入 `dated`（复用 `interviewChecklistFor` 里同一份日期批次读取：把那段读取抽成文件内的小函数 `datedProjects(store, workspaceId, today)`，两处共用，不新建文件）。
- [ ] 运行 `pnpm vitest run packages/core/src/profile-gaps.test.ts packages/db`，预期通过。

**建议提交点**：「可开始标准：检查清单五条打标、不认假设，截止缺口可答『没有截止』」。

---

### 阶段 B2 · 状态：`parked` 重定义，删除「先开始使用」

#### 任务 B2.1：`interviewStatus` 带出 `readyToStart`，`parked` 改定义

**文件**
- 修改：`apps/web/lib/interview-status.ts`
- 测试：`apps/web/lib/interview-status.test.ts`、`apps/web/lib/test-support.ts`

- [ ] 在 `apps/web/lib/test-support.ts` 加一个测试用的小函数 `seedReadyToStart(store, workspaceId)`：写 `lines.v1`（一条非硬约束线，带 `goals`）、`lines.profiles`（描述 + 候选）、`schedule.availability.proposed`（`DEFAULT_AVAILABILITY`）、一个非默认项目和它的 `no_deadline` 已确认事实。后面的页面测试、asks 测试都复用它。
- [ ] **先写失败的测试**（改写 `interview-status.test.ts`）：
  - 删掉 `DAY_LATER` 与 `parkInterview` 的引用，删掉 `expect(interviewStatus(TEST_CTX, DAY_LATER).parked).toBe(true)`。
  - 新用例：「未达可开始时访谈问题不进待决事项，哪怕一天没回复」——`setup()` 后 `interviewStatus(TEST_CTX).parked` 为 `false`、`readyToStart` 为 `false`，`collectAsks` 里没有 `interview_open`/`interview_question`/`source_project`。
  - 把「used without finishing it…」用例的前置从 `parkInterview(TEST_CTX, SOON)` 改为 `seedReadyToStart(store, ws)`（并让 `setup()` 的研究线满足五条或改用 `seedReadyToStart` 的线），断言 `parked === true` 后，原有的待决事项断言与「答完一并发送」断言保持不变。
- [ ] 运行 `pnpm vitest run apps/web/lib/interview-status.test.ts`，预期失败。
- [ ] **实现**：
  - `InterviewStatus` 加 `readyToStart: boolean` 与 `startMissing: ChecklistItem[]`（来自 B1.1 的函数）；`parked = readyToStart && !complete`，注释改为「已能使用、画像还没完成：访谈的问题同时列在待决事项」。
  - 删除 `ONBOARDING_PARKED`、`PARK_AFTER_MS`、`parkInterview`，以及 `interviewStatus` 的 `now` 参数（它只为停放计时用）；同步改两个调用处 `apps/web/lib/asks.ts:451`、`:496`（`interviewStatus(ctx, now)` → `interviewStatus(ctx)`）。
  - `takePendingAnswers`、`answerInterviewQuestion`、`pendingAnswerIds`、`PENDING_ANSWERS` 保留。
- [ ] `apps/web/lib/asks.ts` 的 `sourceProjectAsks`（`if (interview.started && !interview.complete && !interview.parked) return []`）与 `interviewAsks`（`if (!status.started || status.complete || !status.parked) return []`）**表达式不改**，语义随新定义变化；只把两处注释里的「put aside / 先开始使用」改成「已可开始」。
- [ ] 运行 `pnpm vitest run apps/web/lib/interview-status.test.ts apps/web/lib/asks.test.ts`，预期通过。

#### 任务 B2.2：删除停放路由与按钮

**文件**
- 删除：`apps/web/app/api/onboarding/park/route.ts`（整个目录）
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`（删 `park` 函数与「先开始使用」按钮，约 150–153 行、236–237 行）
- 修改：`apps/web/app/settings/page.tsx:91`（`interview.parked ? " · 问题已列在待决事项"` 保留，语义已变；`interviewStatus(ctx)` 调用不变）

- [ ] 运行 `pnpm vitest run apps/web/app/api/csrf-protection.test.ts`，预期通过（发现式测试少了一个路由，不会失败）。
- [ ] `rg "parkedAt|parkInterview|/api/onboarding/park|先开始使用" apps packages scripts`，预期无结果。

**建议提交点**：「停放改为『已可开始、画像未完』，删除『先开始使用』」。

---

### 阶段 B3 · 闸门：未达标回到访谈

#### 任务 B3.1：`gateUntilReady`，替换 `needsOnboarding`

**文件**
- 创建：`apps/web/lib/start-gate.ts`
- 修改：`apps/web/lib/crossline.ts`（删 `needsOnboarding`，约 391–403 行）
- 测试：`apps/web/lib/no-example-data.test.ts`（改写两条 `needsOnboarding` 用例）、新建 `apps/web/lib/start-gate.test.ts`

- [ ] **先写失败的测试** `start-gate.test.ts`：

```ts
test("未达可开始标准的账号被带回访谈，已有工作也不豁免", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  // 任意一条工作（用 store 现有的写作业方法，形状参照 apps/web/lib 里已有测试的作业夹具）
  seedOneWorkOrder(store, TEST_CTX.workspaceId);
  expect(() => gateUntilReady(TEST_CTX)).toThrow(expect.objectContaining({ digest: expect.stringContaining("/onboarding") }));
  seedReadyToStart(store, TEST_CTX.workspaceId);
  expect(() => gateUntilReady(TEST_CTX)).not.toThrow();
});
```

  `no-example-data.test.ts`：删掉「stops being once there is any profile or session」与「existing account with work … never redirected」两条（与「已有账号不豁免」相反），改成对 `startReadiness(TEST_CTX).ready` 的断言：空账号为 `false`，`seedReadyToStart` 后为 `true`。
- [ ] 运行 `pnpm vitest run apps/web/lib/start-gate.test.ts apps/web/lib/no-example-data.test.ts`，预期失败。
- [ ] **实现** `start-gate.ts`（`import "server-only"`）：
  - `startReadiness(ctx)`：先 `ensureSeeded(ctx)`（示例数据要在判定前写好，原 `needsOnboarding` 也这样做），再用 `interviewChecklistFor`（线来自 `identityLines`，`unfiledFiles` 来自 `apps/web/lib/file-belonging.ts` 的 `unfiledFiles`）算出 `{ ready, missing }`。
  - `gateUntilReady(ctx)`：`if (!startReadiness(ctx).ready) redirect("/onboarding")`。
  - 不做豁免、不读环境变量。
- [ ] 运行同一命令，预期通过。

#### 任务 B3.2：所有页面接上闸门（访谈、设置、登录除外）

**文件**（每个都在 `const ctx = await requireSessionContext()` 后加一行 `gateUntilReady(ctx)`）
- `apps/web/app/page.tsx`（把 `if (needsOnboarding(ctx)) redirect("/onboarding")` 换成这一行，删掉无用的 `redirect` 与 `needsOnboarding` 导入）
- `apps/web/app/milestones/page.tsx`、`apps/web/app/milestones/[id]/page.tsx`
- `apps/web/app/plan/page.tsx`
- `apps/web/app/workbench/page.tsx`、`apps/web/app/workbench/[id]/page.tsx`、`apps/web/app/workbench/[id]/material/page.tsx`
- `apps/web/app/approvals/page.tsx`、`apps/web/app/review/page.tsx`、`apps/web/app/portrait/page.tsx`、`apps/web/app/assistant/page.tsx`
- 不改：`apps/web/app/onboarding/page.tsx`、`apps/web/app/settings/page.tsx`、`login`/`signup`/`reset-password`、`apps/web/app/offline/page.tsx`（离线兜底页没有会话，必须断网可渲染）。

- [ ] **先写失败的测试**：`apps/web/app/empty-account.test.tsx`
  - 现有 `test.each` 改名为「空账号打开这些页面被带回访谈」，`settings` 从表里拿出来单列（设置页不设闸门，空账号仍应渲染）；其余页面断言 `rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") })`。
  - 新增同一组页面在 `seedReadyToStart` 后能渲染（`html.length > 200`）——这才是原测试「空账号也要诚实渲染」的本意：达标但没有里程碑和工作的账号。
  - 「Today renders once the interview has produced a profile…」改为：只有事实、未达标 → 被带回访谈。
- [ ] 运行 `pnpm vitest run apps/web/app/empty-account.test.tsx`，预期失败；接好闸门后通过。
- [ ] 跑全部 web 单测 `pnpm vitest run apps/web`。预期：使用示例数据的页面测试会因闸门失败——这是下一个任务要解决的，先记下失败清单。

#### 任务 B3.3：示例数据带上可开始所需的输入

`vitest.config.ts`、`playwright.config.ts`、`scripts/run-e2e.ts` 都开着 `CROSSLINE_SEED_EXAMPLES=1`，示例账号若不达标，整套页面测试和 e2e 都会被带回访谈。

**文件**
- 修改：`apps/web/lib/crossline.ts` 的 `ensureSeeded` 示例分支

- [ ] **先写失败的测试**（加在 `no-example-data.test.ts`）：开启示例数据时 `ensureSeeded` 后 `startReadiness(TEST_CTX).ready === true`。
- [ ] **实现**：在示例分支里，仅当对应设置不存在时写入（幂等）：
  - `lines.v1`：内置四条线原样写出（id、label、color 不变），各带一个示例 `goals`。
  - `lines.profiles`：每条线一句描述、两个候选。
  - `schedule.availability.proposed`：`DEFAULT_AVAILABILITY`——与不写时的默认时段完全相同，排程结果不变。
  - 每条线一个示例项目（非 `-default`）和它的 `no_deadline` 已确认事实（`sourceRef: "reply-1"`）。
  - 抽成一个函数 `seedExampleReadiness(store, ctx)` 放在 `ensureSeeded` 旁边，B2.1 的 `seedReadyToStart` 测试辅助函数可以直接调用它，避免两份。
- [ ] 运行 `pnpm vitest run apps/web`，预期 B3.2 记下的失败全部消失。若主线页、计划页的单测快照式断言因多出目标文字或「推断时段」标签失败，按新文字更新断言（这是有意的行为变化）。

#### 任务 B3.4：e2e 覆盖闸门

**文件**
- 修改：`e2e/global-setup.ts`（把注册—验证—登录那段抽成 `e2e/accounts.ts` 的 `signUpAccount(baseURL, email)`，global-setup 调用它）
- 修改：`e2e/crossline.spec.ts`（新增一条）

- [ ] 新用例「未达可开始标准时打开今日页回到访谈，并写明还差什么」：用 `signUpAccount` 建第二个账号（示例数据会让它达标），再用 `CROSSLINE_E2E_DATA_DIR` 打开同一账本，把该账号工作区 `lines.v1` 里第一条线的 `goals` 清空；用新账号打开 `/`，断言 URL 为 `/onboarding`，页面含「开始使用前还差」与那条线的名字；恢复目标后打开 `/` 停在今日页。只动新账号，不影响共享账本里主账号的其他用例。
- [ ] 运行 `pnpm exec playwright test e2e/crossline.spec.ts -g "可开始"`，预期通过。
- [ ] 全量 `pnpm test:e2e`：主线页、计划页的视觉基线会因示例目标和「推断时段」标签变化而失败。**【本人】**确认变化是预期的后，`pnpm exec playwright test --update-snapshots` 重录 Windows 基线；Linux 基线需要在 Linux 环境（云会话）重录。

**建议提交点**：「闸门：未达可开始标准的页面回到访谈，已有账号不豁免；示例数据带上可开始输入」。

---

### 阶段 B4 · 访谈页：还差什么、开始使用

#### 任务 B4.1：状态接口带出可开始信息与应用自问题

**文件**
- 修改：`apps/web/app/api/onboarding/state/route.ts`
- 修改：`apps/web/app/onboarding/onboarding-types.ts`（`OnboardingState` 加字段）
- 测试：`apps/web/app/onboarding/onboarding-types.test.ts` 或新建 `apps/web/app/api/onboarding/state/route.test.ts`

- [ ] **先写失败的测试**：已有账号（访谈已结束、没有待答一轮）缺一条主线的截止时，`GET /api/onboarding/state` 返回 `readyToStart: false`、`startMissing` 含该项，`extraQuestions` 含 `gap-deadline-<项目>`。
- [ ] **实现**：主访谈（非 `?line=`）时调用 `interviewStatus(ctx)`，返回 `readyToStart`、`startMissing: [{ id, label, detail, owner }]`，以及 `extraQuestions`——`status.questions` 中不在最后一轮里的（即应用自问题）。这样访谈已结束的老账号也能在访谈页直接回答「没有截止」，不必等一轮新问题。
- [ ] 运行该测试，预期通过。

#### 任务 B4.2：访谈页显示「开始使用前还差」与「开始使用」

**文件**
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`
- 测试：`apps/web/app/onboarding/onboarding-workspace.test.tsx`（新建，用 `renderToStaticMarkup` 渲染给定 state）

- [ ] **先写失败的测试**：`readyToStart: false` 时渲染「开始使用前还差 N 项」和每项的 `label`/`detail`，没有「开始使用」；`owner: "person"` 的项写明在哪里点（「在右侧画像下为「X」采用长期目标」）。`readyToStart: true` 时出现链接「开始使用」（`href="/"`），并说明「画像访谈在同一处继续，问题也会列在待决事项」。
- [ ] **实现**：
  - 在对话区顶部（`StageBar` 下）放一块固定的进度卡，内容来自 `state.startMissing`；`readyToStart` 时换成「开始使用」链接（替代被删的停放按钮的位置，不放在发送行里）。
  - 本轮问题列表 `batch` 改为 `[...roundQuestions, ...state.extraQuestions 中不重复的]`，回答拼进同一条回复（`composeAnswers` 不变），由 worker 的 `answeredGapFacts` 写成已确认事实。
  - 文案遵守 `docs/copy-style.md`（第三人称，不用游戏化词）。
- [ ] 运行该测试与 `pnpm exec playwright test e2e/copy-audit.spec.ts e2e/design-audit.spec.ts -g onboarding`，预期通过。

**建议提交点**：「访谈页：写明还差哪几条，达标后出现『开始使用』」。

---

### 阶段 B5 · 访谈提速：先读材料、两段排序、当轮假设

#### 任务 B5.1：阶段改为两段，五条不允许 `moveOn`

**文件**
- 修改：`packages/core/src/onboarding-turn-schema.ts:48`（`ONBOARDING_STAGES`）
- 修改：`apps/web/app/onboarding/portrait-panel.tsx:14`（`STAGES` 同序）
- 修改：`apps/worker/src/onboarding-session.ts`（`stagePace`、`openChecklist`、`INSTRUCTIONS`）
- 修改：`packages/core/src/onboarding-turn-schema.ts` 的 `OnboardingTurnContext.checklist` 类型加 `start?: boolean`
- 测试：`apps/worker/src/onboarding-checklist.test.ts`、`apps/web/lib/interview-status.test.ts`

- [ ] **先写失败的测试**（改写 `onboarding-checklist.test.ts` 末尾的 `stagePace` 用例）：

```ts
test("同一阶段第二轮起才换阶段；五条没齐时前段不换阶段", () => {
  const round = (stage: string) => ({ role: "assistant", content: { stage } });
  const stuckFront = stagePace([round("lines"), { role: "user", content: {} }, round("lines")], { startOpen: true });
  expect(stuckFront).toEqual({ stageRounds: 2 });
  const stuckBack = stagePace([round("energy"), { role: "user", content: {} }, round("energy")], { startOpen: true });
  expect(stuckBack.moveOn).toContain("进入下一阶段");
  expect(stuckBack.moveOn).not.toContain("假设");
});
```

  `interview-status.test.ts` 里 `stage: "lines", stageIndex: 5` 改为 `stageIndex: 2`。
- [ ] 运行 `pnpm vitest run apps/worker/src/onboarding-checklist.test.ts apps/web/lib/interview-status.test.ts`，预期失败。
- [ ] **实现**：
  - `ONBOARDING_STAGES = ["orientation", "lines", "situation", "compass", "energy", "details"]`；`portrait-panel.tsx` 的 `STAGES` 同序。
  - `stagePace(messages, { startOpen })`：当前阶段是 `orientation`/`lines` 且 `startOpen` 时不给 `moveOn`；其余情况第二轮起给 `moveOn`，文字只说「本轮进入下一阶段」——写假设的规则改为 Skill 里的常驻规则（见 B5.2），不再随轮次下发。
  - `openChecklist()` 带出 `start`；两处调用 `stagePace(messages)` 改为 `stagePace(messages, { startOpen: checklistNow().some((item) => item.start && !item.done) })`。
  - `INSTRUCTIONS` 里的阶段顺序改为新顺序，并加一句：带 `start` 的清单项必须由本人回答或从文件读到，不得写成「假设：」，不满足就留在当前阶段继续问；全部满足时在 `reply` 里告诉本人可以开始使用，访谈在同一处继续。
- [ ] 运行同一命令，预期通过；`pnpm --filter @crossline/worker typecheck` 无错。

#### 任务 B5.2：Skill 改写：先读材料、先问五条、「不确定」当轮假设

**文件**
- 修改：`skills/marketplace/plugins/crossline/skills/crossline-onboarding/SKILL.md`
- 测试：`apps/worker/src/onboarding-session.test.ts`（只测代码侧：首轮上下文里带着文件；不测模型）

- [ ] **改写 SKILL.md**（只改相关段落）：
  - 第 32 行「Never wait forever…」：「不确定 / 不知道 / 跳过」的非 `start` 项**当轮**写成以「假设：」开头的 `inferred` 事实并在 `reply` 说明可改；`start` 项除外，换成更具体的选项再问一次，仍答不上就问「没有截止」「暂不规划这条线」这类可以确认的答案。删掉「when the turn carries `moveOn`」的条件。
  - 阶段列表重排为 orientation → lines → situation → compass → energy → details，开头说明前两段是「可开始标准」（每线一句描述、每周可用时间、硬约束线的固定安排、每线一个当前项目及截止或「没有截止」、每线长期目标由本人采用），达标后进入画像。
  - **orientation**：删掉首问「最想推进或最焦虑什么」（移到 situation 开头）；改为：先读 `sources` 里的全部文件，一次性把能读出的事实写进 `slotUpdates`（引用 `src-N` 原文）、日期写进 `fileDates`、课程的评分占比与上课时间从课表读；只问文件没回答的可开始项，硬约束线的规则与可用时间排在最前。
  - **lines**：提前到第二段；描述与 6–12 个属性候选在这一段写出；同时问每条线当前在推进的项目及其截止（可答「没有截止」）。
  - **details**：不再重复已在 lines 段收齐的截止。
  - 第 66 行 `checklist` 段：说明 `start` 字段的含义。
- [ ] **先写失败的测试**（`onboarding-session.test.ts`，用 `apps/worker/src/testing/` 的 Codex 假实现）：首轮之前已有两份 `extractionStatus: "done"` 的文件时，`runCodexSkill` 收到的上下文 `sources` 长度为 2、`checklist` 里带 `start: true` 的项存在、`stage` 为 `"orientation"`。
- [ ] 运行 `pnpm vitest run apps/worker/src/onboarding-session.test.ts`，预期通过（这条主要防回归：先读材料依赖首轮把文件全部带上）。
- [ ] 运行 `pnpm vitest run packages/core/src/structured-output.test.ts`，预期通过（schema 没动，确认 enum 重排不违反严格模式规则）。

#### 任务 B5.3：访谈页第一步是材料

**文件**
- 修改：`apps/web/app/onboarding/onboarding-types.ts`（加常量 `MATERIALS_FIRST_REPLY = "材料已添加，请先从材料里读出能读的，再问还缺的。"`）
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`（`messages.length === 0` 时的开场）

- [ ] **先写失败的测试**（B4.2 的 `onboarding-workspace.test.tsx` 里加）：没有消息时渲染「第一步：添加材料」卡——上传按钮、P-B2 完成后出现的「授权文件夹」入口、按钮「读完材料，开始访谈」；没有材料时按钮文字为「没有材料，直接开始」。
- [ ] **实现**：开场 `OPENING` 改为先请本人添加简历、课表、课程大纲、项目说明；「读完材料，开始访谈」发送 `MATERIALS_FIRST_REPLY` 作为第一轮回复（有已读文件时），否则发送原来的开场问题。上传仍走 `/api/onboarding/sources`。
- [ ] 运行该测试，预期通过。

**建议提交点**：「访谈两段排序：先读材料、先问五条，『不确定』当轮写成假设（可开始项除外）」。

---

### 阶段 B6 · 计时：注意力时间与评测指标

#### 任务 B6.1：注意力心跳（纯函数 + 路由）

**文件**
- 创建：`packages/core/src/onboarding-attention.ts`（并从 `index.ts` 导出）
- 测试：`packages/core/src/onboarding-attention.test.ts`
- 创建：`apps/web/app/api/onboarding/attention/route.ts`
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`

- [ ] **先写失败的测试**：

```ts
const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();
test("只计可见且 60 秒内有操作的时间；两次心跳间隔超过 20 秒只记 20 秒；达标时刻只记一次", () => {
  let record = addAttentionBeat(undefined, { at: at(0), inputAgoMs: 1_000, rounds: 1, ready: false, complete: false });
  record = addAttentionBeat(record, { at: at(15), inputAgoMs: 5_000, rounds: 1, ready: false, complete: false });
  expect(record.seconds).toBe(15);
  record = addAttentionBeat(record, { at: at(30), inputAgoMs: 70_000, rounds: 1, ready: false, complete: false });
  expect(record.seconds).toBe(15);
  record = addAttentionBeat(record, { at: at(330), inputAgoMs: 2_000, rounds: 3, ready: true, complete: false });
  expect(record.seconds).toBe(35);
  expect(record.ready).toEqual({ seconds: 35, rounds: 3, at: at(330) });
  record = addAttentionBeat(record, { at: at(345), inputAgoMs: 2_000, rounds: 4, ready: true, complete: false });
  expect(record.ready?.rounds).toBe(3);
});
```

- [ ] 运行 `pnpm vitest run packages/core/src/onboarding-attention.test.ts`，预期失败。
- [ ] **实现** core：`ATTENTION_SETTING = "onboarding.attention"`、`ATTENTION_IDLE_MS = 60_000`、`ATTENTION_BEAT_CAP_MS = 20_000`、`AttentionRecord = { seconds; lastBeatAt; ready?: { seconds; rounds; at }; complete?: {…} }`、`addAttentionBeat(record, beat)`。心跳本身若 `inputAgoMs > ATTENTION_IDLE_MS` 只更新 `lastBeatAt` 不加秒数。
- [ ] **实现**路由 `POST /api/onboarding/attention`：第一行 `isCrossSiteWrite`，再 `resolveAccessContext`；body 只收 `{ inputAgoMs: number }`（0–600000，否则 400）；用服务器时间；`rounds` = 主访谈会话里 assistant 消息数；`ready`/`complete` 来自 `interviewStatus(ctx)`；结果写回 `ATTENTION_SETTING`。`apps/web/app/api/csrf-protection.test.ts` 会自动覆盖这个新路由，运行它确认通过。
- [ ] **实现**页面：`onboarding-workspace.tsx` 记录最近一次 `keydown`/`pointerdown`/`input` 时间；每 15 秒、`document.visibilityState === "visible"` 时 POST 一次。只在主访谈（非 `?line=`）上报。

#### 任务 B6.2：生成完叫本人回来

**文件**
- 修改：`apps/web/lib/push.ts`（把 `sendTestPush` 的发送部分抽成 `sendPush(ctx, payload)`，`sendTestPush` 调用它）
- 修改：`apps/web/app/api/onboarding/turn/route.ts`
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`
- 测试：`apps/web/app/api/onboarding/turn/route.test.ts`（新建；mock `requestCodexSupervisor` 与 `sendPush`）

- [ ] **先写失败的测试**：`presence.visibleAt` 是 5 分钟前时，一轮返回后调用 `sendPush`，标题「访谈下一轮已就绪」、`path: "/onboarding"`；`visibleAt` 是 30 秒前时不调用。
- [ ] **实现**：一轮成功返回后，若 `presence.visibleAt`（`AssistantWidget` 在页面可见时每 60 秒写一次）早于 90 秒前，`void sendPush(...)`。页面侧：一轮返回时若 `document.visibilityState === "hidden"`，标题前加「● 新问题 · 」，页面重新可见时去掉。桌面 Windows 通知不在本任务里做（127.0.0.1 下不能订阅推送）；评测若显示等待期间流失明显，再加。
- [ ] 运行该测试，预期通过。

#### 任务 B6.3：评测脚本的时间指标与断言 【真实 Codex】

**文件**
- 修改：`scripts/onboarding-eval.ts`

- [ ] **实现**（脚本没有单测，按现有风格写）：
  - 第一轮之前把 `available` 里的文件全部上传（模拟「先读材料」），第一条回复用 `MATERIALS_FIRST_REPLY`（从 `apps/web/app/onboarding/onboarding-types.ts` 导入，与页面同一常量）。
  - 每轮之后模拟本人的点击：确认日期（已有 `confirmDates`）；某线有 ≥ 2 个属性候选且没有目标时，用 core 的 `composeGoal` 取前两个候选写进 `lines.v1` 的 `goals`/`goalParts`（等同于点「采用」）。每次点击记一次操作。
  - 计时：`SECONDS_PER_ANSWER = 20`；模拟注意力时间 = （每轮展示的问题数 + 本轮点击数）× 20 秒，模型时间不计；另记每轮墙钟与模型用时（中位数、最长）。
  - 每轮后用 `readyToStart(interviewChecklistFor(...))` 判定；首次为真时记下轮数与模拟分钟；`complete`（全部清单项完成）同理。
  - 达到完整后结束；轮数上限默认改为 20 不变。
  - 报告新增一节「时间」：到达可开始的轮数、模拟分钟；到达完整的模拟分钟；每轮模型用时中位数与最长；三条断言 `可开始 ≤ 6 轮`、`可开始 ≤ 30 分钟`、`完整 ≤ 90 分钟` 各打 ✓/✗，任一 ✗ 时 `process.exitCode = 1`。
- [ ] 运行 `pnpm exec tsc --noEmit -p scripts`（若无独立 tsconfig，用 `pnpm typecheck` 覆盖）确认脚本能编译。
- [ ] **【真实 Codex】**运行 `pnpm exec tsx scripts/onboarding-eval.ts`，预期：报告写到 `data/eval/onboarding-*.md`，三条断言全部 ✓，退出码 0。耗时数小时、消耗真实额度，只在本人同意时跑。
- [ ] **判定条件（不在本计划里实现）**：注意力时间不含模型时间，所以中档模型、后台预取、流式显示只影响墙钟。若报告显示前段每轮模型用时中位数 > 3 分钟，或断言因轮数而非时间失败，另写小计划：前段（`orientation`/`lines`）回合用 `continueSkillTurn` 的 `tier: "mid"`（经济模式下本来就忽略），并用同一评测前后对比。

#### 任务 B6.4：在真实账本副本上核对已有账号的缺口 【本人】

- [ ] 创建 `scripts/start-readiness.ts <db 路径>`：拒绝打开 `data/crossline.db` 本身（与 `pnpm restore` 拒绝写活账本同理，比较解析后的路径），对每个工作区用 `apps/worker/src/lines.ts` 的 `identityLines` 与 `interviewChecklistFor` 打印 `startMissing` 的 `label`/`detail`。只读，不调用模型。
- [ ] 本人把真实账本复制到临时目录后运行 `pnpm exec tsx scripts/start-readiness.ts <副本>`。预期 6 项：四条主线各一条 `line_goal:*`（尚未采用长期目标），「小红书自媒体」「美股科技股投资」各一条 `line_project:*`（缺截止）。若多出别的项，先查清是判定写错还是数据真缺，再上线闸门。

**建议提交点**：「上手计时：注意力时间、生成完叫回、评测报告时间指标；已有账号缺口核对脚本」。

#### 任务 B7：文档同步（与代码同一次改动）

- [ ] `CLAUDE.md`：删掉「Unfinished and in use: the questions move to 待决事项」一段里「先开始使用」「一天未回复」与 `onboarding.parkedAt` 的说法，改写为可开始标准、闸门、`parked = readyToStart && !complete`；「Missing information is assumed…」一段改为当轮假设、可开始项除外；「The profile-first loop」开头关于 `needsOnboarding` 的句子改为 `gateUntilReady`；访谈阶段顺序。
- [ ] `docs/user-guide.md` 的上手章节同步（去掉「先开始使用」，写明五条与「开始使用」）。
- [ ] `pnpm verify`，预期全部通过（视觉基线已在 B3.4 重录）。

---

## 第二部分 · P-B2 授权文件夹

### 阶段 F1 · 保存文件下沉到 packages

#### 任务 F1.1：`storeSourceFile` 进入 `packages/db`

**文件**
- 创建：`packages/db/src/sources.ts`（从 `index.ts` 导出）
- 修改：`apps/web/lib/sources.ts`（`saveSourceFiles` 改为循环调用它；`EXTENSION`、哈希、越界检查都移过去）
- 测试：`packages/db/src/sources.test.ts`

- [ ] **先写失败的测试**：

```ts
test("同一份内容存两次是同一个文档；类型不支持与超限都拒绝，不写盘", () => {
  const root = mkdtempSync(path.join(tmpdir(), "src-"));
  const store = new CrosslineStore(":memory:");
  const base = { root, workspaceId: "w", ownerId: "o", fileName: "Syllabus.md", mediaType: "", buffer: Buffer.from("# ECE 555") };
  const first = storeSourceFile(store, base), second = storeSourceFile(store, { ...base, fileName: "copy.md" });
  expect(first.ok && second.ok && first.document.id === second.document.id).toBe(true);
  expect(storeSourceFile(store, { ...base, fileName: "a.exe" })).toMatchObject({ ok: false, code: "SOURCE_TYPE_NOT_ALLOWED" });
  expect(readdirSync(root)).toHaveLength(1);
});
```

- [ ] 运行 `pnpm vitest run packages/db/src/sources.test.ts`，预期失败。
- [ ] **实现**：`storeSourceFile(store, { root, workspaceId, ownerId, projectId?, fileName, mediaType, buffer })` → `{ ok: true; document } | { ok: false; code; message }`，逻辑原样搬自 `saveSourceFiles` 的循环体（`sourceKindFor`、`SOURCE_SIZE_LIMIT`、sha256 命名、`path.relative` 越界检查、`saveSourceDocument`）。web 侧 `saveSourceFiles` 只剩循环与 `sourcesRoot()`。worker 的数据目录是 `apps/worker/src/index.ts:59` 的 `dataDir`，`root = path.join(dataDir, "sources")`，与 web 的 `sourcesRoot()` 指向同一处。
- [ ] 运行该测试与 `pnpm vitest run apps/web/lib/conversation-files.test.ts`（`actions.ts:166` 的 `material.save` 与对话文件上传都经过 `saveSourceFiles`），预期通过。

**建议提交点**：「文件保存下沉到 packages/db，供 worker 使用」。

---

### 阶段 F2 · 过滤规则与扫描

#### 任务 F2.1：过滤规则（纯函数）

**文件**
- 创建：`packages/core/src/folder-scan.ts`（从 `index.ts` 导出）
- 测试：`packages/core/src/folder-scan.test.ts`

- [ ] **先写失败的测试**：

```ts
const NOW = Date.parse("2026-10-12T12:00:00Z");
const entry = (name: string, extra: Partial<FolderEntry> = {}): FolderEntry =>
  ({ path: `C:\\Users\\p\\Downloads\\${name}`, size: 20_000, mtimeMs: NOW - 3_600_000, attributes: 0, ...extra });
test("按扩展名、大小、敏感词、仅联机、下载中、未写完过滤，并说明原因", () => {
  const { read, skipped } = folderCandidates([
    entry("ECE555 Syllabus.pdf"), entry("photo.png"), entry("big.pdf", { size: 40_000_000 }), entry("招商银行对账单.pdf"),
    entry("vault.kdbx"), entry("notes.md", { attributes: 0x400000 }), entry("lecture.pdf.crdownload"), entry("draft.docx", { mtimeMs: NOW - 30_000 }),
    entry("~$draft.docx"), entry("密码.txt")], {}, NOW);
  expect(read.map((item) => item.path.split("\\").pop())).toEqual(["ECE555 Syllabus.pdf"]);
  expect(Object.fromEntries(skipped.map((item) => [item.path.split("\\").pop(), item.reason]))).toMatchObject({
    "photo.png": "extension", "big.pdf": "size", "招商银行对账单.pdf": "sensitive", "vault.kdbx": "extension",
    "notes.md": "online_only", "lecture.pdf.crdownload": "temporary", "draft.docx": "settling", "~$draft.docx": "temporary", "密码.txt": "sensitive" });
});
test("已读且大小、时间未变的不再读；变了的重读；每次最多读 20 个，新的优先；超过 180 天的旧文件不读", () => {
  const seen = { [entry("a.pdf").path]: { size: 20_000, mtimeMs: NOW - 3_600_000, documentId: "d1" } };
  expect(folderCandidates([entry("a.pdf")], seen, NOW).read).toEqual([]);
  expect(folderCandidates([entry("a.pdf", { size: 21_000 })], seen, NOW).read).toHaveLength(1);
  const many = Array.from({ length: 30 }, (_, index) => entry(`f${index}.pdf`, { mtimeMs: NOW - (index + 1) * 3_600_000 }));
  expect(folderCandidates(many, {}, NOW).read.map((item) => item.path.split("\\").pop())[0]).toBe("f0.pdf");
  expect(folderCandidates(many, {}, NOW).read).toHaveLength(20);
  expect(folderCandidates([entry("old.pdf", { mtimeMs: NOW - 200 * 86_400_000 })], {}, NOW).skipped[0]?.reason).toBe("old");
});
```

- [ ] 运行 `pnpm vitest run packages/core/src/folder-scan.test.ts`，预期失败。
- [ ] **实现**：
  - `FOLDER_LIMITS = { depth: 4, listed: 2000, perPass: 20, maxBytes: 10 * 1024 * 1024, settleMs: 120_000, sinceDays: 180 }`。
  - 扩展名白名单 `.pdf .docx .txt .md .csv`（图片与录音不自动读：录音要单独同意下载转写模型，截图常含隐私；需要时本人手动上传）。
  - `temporary`：`.crdownload .part .partial .tmp .download`，以及以 `~$` 开头的 Office 锁文件。
  - `sensitive`：路径任一段匹配 `SENSITIVE = /密码|口令|银行|对账单|账单|流水|证件|身份证|护照|签证|税|工资|薪资|病历|体检|password|passwd|bank|statement|tax|passport|payroll|salary|medical|wallet|seed|recovery|\.(kdbx|kdb|key|pem|p12|pfx|env)$/i`（`.kdbx` 等本就不在白名单，留在这里是为了原因写对）。
  - `online_only`：`attributes & (0x400000 | 0x40000 | 0x1000)`（RECALL_ON_DATA_ACCESS、RECALL_ON_OPEN、OFFLINE），读取会触发 OneDrive 下载。另跳过隐藏、系统与重解析点（`0x2 | 0x4 | 0x400`），避免目录联接造成循环。
  - `settling`：`NOW - mtimeMs < settleMs`（写入中，下一轮再看）。
  - 已读记录 `seen: Record<path, { size, mtimeMs, documentId? , skipped? }>`；大小与时间都没变则跳过且不计入 `skipped`。
- [ ] 运行同一命令，预期通过。

#### 任务 F2.2：worker 扫描

**文件**
- 创建：`apps/worker/src/folder-scan.ts`
- 修改：`apps/worker/src/index.ts`（加十分钟一次的扫描，仿 `historyPass` 的防重入写法，约 855–870 行）
- 修改：`packages/core/src/settings-keys.ts`（`FOLDERS_AUTHORIZED = "folders.authorized"`、`FOLDERS_SEEN = "folders.seen"`）
- 测试：`apps/worker/src/folder-scan.test.ts`

- [ ] **先写失败的测试**（注入一个假的 `listFolder`，用临时目录真文件）：授权一个文件夹，含一份 `.md` 和一份 `.png`；跑一次 `folderPass(store, workspaceId, dataDir, { listFolder })` 后，`listSourceDocuments` 多一份文档、`extractionStatus === "done"`；`FOLDERS_SEEN` 记下两者（`.png` 带 `skipped: "extension"`）；再跑一次不新增文档；非电脑主人的工作区（`RUNTIME_OWNER_SETTING` 不是 `"1"` 且存在别的主人）什么也不读。
- [ ] 运行 `pnpm vitest run apps/worker/src/folder-scan.test.ts`，预期失败。
- [ ] **实现**：
  - `listFolder(dir, limits)`：Windows 上起**一个** PowerShell 进程，用 `-EncodedCommand`（`notify.ts` 已有同样做法，路径不经命令行拼接），`Get-ChildItem -LiteralPath <dir> -Recurse -Depth 3 -File -Attributes !Hidden+!System -ErrorAction SilentlyContinue | Select-Object -First 2000` 输出 `FullName, Length, LastWriteTimeUtc, [int]Attributes` 的 JSON；其他平台用 `readdir` + `lstat` 递归（跳过符号链接）。Get-ChildItem 只读目录项，不会触发仅联机文件下载。
  - `folderPass`：只对 `runtimeOwner`（`apps/worker/src/owner.ts`）的工作区运行——文件夹在电脑主人的磁盘上，访客账号不能借授权读主人的文件。对每个授权文件夹：列出 → `folderCandidates` → 逐个 `readFileSync` → `storeSourceFile`（F1.1）→ `extractText`（`apps/worker/src/extract.ts`）→ `setSourceDocumentExtraction`；写回 `FOLDERS_SEEN`（只存路径、大小、时间、文档 id 或跳过原因，不存正文）；文件归属由现有 tick 里的 `fileSourceDocuments` 照常处理。
  - `index.ts`：`setInterval(folderPassGuarded, 10 * 60_000)`，启动时跑一次；`CROSSLINE_FOLDER_SCAN=off` 时不跑（vitest 与 e2e 的配置里设为 off）。
- [ ] 运行同一命令，预期通过；`pnpm --filter @crossline/worker typecheck` 无错。

#### 任务 F2.3：授权后立即扫一次

**文件**
- 修改：`packages/codex/src/index.ts`（supervisor 选项加 `scanFolders?: (workspaceId) => Promise<unknown>`，路由 `POST /v1/folders/scan`，与 `/v1/sources/extract` 同样验证 capability，用 `runDetached` 立即回 202）
- 修改：`apps/worker/src/index.ts`（传入 `scanFolders`，复用 F2.2 的防重入函数）

- [ ] 运行 supervisor 路由的发现式 capability 测试（`pnpm vitest run packages/codex`），预期通过；若新路由忘了验证 token，该测试会失败。

**建议提交点**：「授权文件夹：过滤规则与 worker 定时扫描，只为电脑主人读取」。

---

### 阶段 F3 · 设置页与访谈第一步

#### 任务 F3.1：授权、撤销、已读清单的接口

**文件**
- 创建：`apps/web/lib/folders.ts`
- 创建：`apps/web/app/api/settings/folders/route.ts`（GET / POST / DELETE）
- 测试：`apps/web/lib/folders.test.ts`

- [ ] **先写失败的测试**：
  - 授权：`authorizeFolder(ctx, { preset: "downloads" })` 解析为 `os.homedir()/Downloads`；`{ path }` 必须是绝对路径、存在、是目录；拒绝盘符根（`C:\`）、`C:\Windows`、`Program Files*`、`AppData`、数据目录与仓库目录本身及其子目录（`FOLDER_NOT_ALLOWED`）；同一路径不重复；最多 10 个。非电脑主人的账号返回 `FOLDER_OWNER_ONLY`。
  - 撤销：`revokeFolder(ctx, id)` 从 `FOLDERS_AUTHORIZED` 删除，并删掉 `FOLDERS_SEEN` 里该文件夹下的记录；已读出的文档保留（见风险与待定项）。
  - 清单：`listFolders(ctx)` 返回每个文件夹的已读文件（文件名、相对路径、读取状态、归属项目）与按原因计数的跳过数，不返回正文。
- [ ] 运行 `pnpm vitest run apps/web/lib/folders.test.ts`，预期失败；实现后通过。
- [ ] 路由：变更方法第一行 `isCrossSiteWrite`，再 `resolveAccessContext`；POST 成功后请求 `/v1/folders/scan`（失败不影响授权，下一轮定时扫描会补上）。运行 `pnpm vitest run apps/web/app/api/csrf-protection.test.ts`，预期新路由被自动覆盖并通过。

#### 任务 F3.2：设置卡片与隐私说明

**文件**
- 创建：`apps/web/app/settings/folders-card.tsx`
- 修改：`apps/web/app/settings/page.tsx`（放进 `#privacy` 区，`AgentHistoryCard` 之后）
- 测试：`apps/web/app/settings/page.test.tsx`

- [ ] **先写失败的测试**：设置页含「授权文件夹」卡与隐私说明，说明中出现「本机读取与存储」「发给模型服务商」「可随时撤销」；没有授权时不列空清单；不出现任何环境变量或脚本路径（沿用现有 `not.toMatch(/CROSSLINE_|…/)`）。
- [ ] **实现**：
  - 说明文字：「文件在本机读取和保存；读出的正文会作为访谈和规划的材料，连同问题一起发给模型服务商。只读 PDF、Word 和文本文件，不读密码库、银行、证件等文件，不读 OneDrive 中仅联机的文件。可随时撤销，撤销后不再读取。」
  - 快捷按钮「下载」「桌面」「文档」（服务器按 `homedir` 解析）和一个路径输入框；每个已授权文件夹一行：路径、已读 N 份（展开为清单）、跳过 M 份（按原因）、「撤销」。
  - 选项用分段控件与按钮，不用开关（`docs/copy-style.md` 与设置页现有约定）。
- [ ] 运行该测试与 `pnpm exec playwright test e2e/design-audit.spec.ts -g settings`，预期通过。

#### 任务 F3.3：访谈第一步接上授权文件夹

**文件**
- 修改：`apps/web/app/onboarding/onboarding-workspace.tsx`（B5.3 的材料卡）

- [ ] 在材料卡里复用 `folders-card.tsx` 的快捷按钮部分（抽成同文件导出的小组件，不另建文件），授权后每 5 秒轮询 `GET /api/settings/folders` 显示「已读 N 份」；读完（连续两次计数不变）后「读完材料，开始访谈」可点。
- [ ] 运行 B5.3 的测试，加一条：材料卡含「授权文件夹」入口。预期通过。

#### 任务 F3.4：真实机器上的行为核对 【本人】

- [ ] 本人授权「下载」文件夹（含一份课程大纲 PDF、一份 OneDrive 仅联机文件、一份正在下载的 `.crdownload`）：10 分钟内大纲出现在已读清单、仅联机文件与下载中文件出现在跳过计数里，且仅联机文件**没有**被下载到本地（资源管理器里状态图标不变）。
- [ ] 放入一份新文件，一个扫描周期（10 分钟）内出现在已读清单。
- [ ] 在 PowerShell 5.1 下确认 `Get-ChildItem -Recurse` 不沿目录联接进入循环（重解析点已被过滤）。

**建议提交点**：「授权文件夹：设置页卡片、隐私说明、访谈第一步入口」。

#### 任务 F4：文档同步

- [ ] `CLAUDE.md` 加一段「授权文件夹」：只为电脑主人、过滤规则、定时扫描、正文进入模型上下文；Safety boundaries 不变（没有新的外部写路径）。
- [ ] `pnpm verify`，预期全部通过。

---

## 验收（对应 `docs/loop-and-scout.md` 第 7 节「跑通标准 · 上手」）

| 跑通标准 | 由谁证明 |
|---|---|
| 新账号授权一个含课程大纲的文件夹 → 系统读出课程与日期并提出确认 | `apps/worker/src/folder-scan.test.ts`（读取与提取）+ B5.2 的首轮上下文测试（文件全部进入首轮）+ F3.4【本人】；日期确认沿用现有日期批次卡 |
| 未满足五条时打开今日页被带回访谈，且写明还差什么 | `apps/web/lib/start-gate.test.ts`、`apps/web/app/empty-account.test.tsx`、B3.4 的 e2e 用例、B4.2 的组件测试 |
| 满足五条后出现「开始使用」→ 首次见到排期 | B4.2 组件测试；B3.4 e2e 用例后半（恢复目标后停在今日页） |
| 已有账号不豁免 | `start-gate.test.ts` 的「已有工作也不豁免」；B6.4【本人】在账本副本上核对出 6 项 |
| 新放入文件夹的文件在一个检查周期内被读取 | `folder-scan.test.ts`（第二次扫描读到新增、未变的不重读）+ F3.4【本人】 |
| `onboarding-eval.ts` 断言：到达可开始 ≤ 6 轮、模拟注意力时间 ≤ 30 分钟、完整设置 ≤ 90 分钟 | B6.3【真实 Codex】报告的三条 ✓ 与退出码 0 |
| 只计注意力在 app 上的时间 | `packages/core/src/onboarding-attention.test.ts` |

## 风险与待定项

- **视觉基线**：示例账号多了长期目标与「推断时段」标签，主线页、计划页的截图会变；Windows 与 Linux 两套都要重录（B3.4）。
- **前段候选质量**：长期目标的属性候选提前到画像之前写，模型掌握的信息更少，候选可能更泛。评测报告里看本人（模拟）采用的候选；若明显变差，可在画像写完后由访谈刷新候选（现有 `lineProfiles` 机制即支持），不改闸门。
- **五条不认假设可能卡住**：本人确实说不出的项（例如截止）必须有可确认的答案，所以加了「没有截止」与 LINE_UNCONFIRMED 已有的「暂不规划」。若评测里仍出现同一项问 3 轮以上，先看问题措辞，再考虑给该项加更多可确认选项，不放宽为假设。
- **闸门只在页面层**：API 路由不拦，`/offline` 不拦。这是有意的：worker、本地工具与离线回放都依赖 API；未达标的人没有页面入口即可。
- **授权文件夹的隐私**：正文会发给模型服务商——设置页与材料卡都如实写明；默认不授权任何文件夹；只为电脑主人读取（访客账号授权不了主人磁盘上的路径）。敏感词过滤是兜底，不是保证；文件名不含敏感词的敏感文件仍可能被读，所以清单可见、可撤销。
- **【本人】待定：撤销时是否删除已读内容**。本计划撤销只停止读取、保留已读文档（与手动上传的文件同样对待，且可能已被任务引用）。若本人希望撤销即删除，需要给 `CrosslineStore` 加删除源文档的方法并处理被引用的情况，单独一个任务。
- **下载文件夹噪声**：下载里常有发票、安装包说明。首次只读 180 天内、最多 20 份，新的优先；访谈每轮文件正文总量本就有上限（`SOURCE_TEXT_TOTAL = 60_000`）。若评测或本人发现无关文件挤占上下文，再加「只把能归属到项目或提到主线的文件交给访谈」的筛选。
- **Windows 文件属性**：仅联机判断依赖 `Get-ChildItem` 返回的属性位，需在本机核对（F3.4）；PowerShell 冷启动约 1 秒，每个文件夹每 10 分钟一次可以接受。
- **生成完叫回只到手机**：桌面在 127.0.0.1 下没有推送订阅，只改标签页标题；评测若显示等待期间流失，再接 worker 的桌面通知。

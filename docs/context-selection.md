# 上下文选择：只把当前任务需要的信息放进去

2026-10-20。本人原话：「关键是要把且只把当前任务需要的用户或者系统的信息放进上下文，而不是单纯搜索，要和模型结合在一起」。起因见 docs/review-2026-10-20.md §4：拆步骤把本项目文件盲截塞入（每份 16k、总 48k），事实最多 50 条按存储顺序；捕获分析给「前 8 份文件开头 300 字」，与捕获内容无关；倒推只看里程碑和已有任务；57 个任务里 19 个没有本项目文件，什么也拿不到。

## 两段式

**（a）代码给候选。** 每个任务先由代码挑出两类候选：

- 结构化的强相关项：本项目与本线的事实（本项目在前，其余按任务检索词命中数排序，按字符预算截，`relevantFacts`）、本项目的日期、已答问题、计划画像（`planningProfile`）、助手已有产出。这些一直是直接给，不经检索。
- 文件片段：所有已读文件切成约 800 字的段落（`chunkText`，在空行、换行、句末、逗号处切），每段带「文件名 · 项目 · 线」标题，进 SQLite FTS5 trigram 索引（`doc_chunks` + `doc_chunks_fts`）。检索词由任务标题、意图、项目、里程碑、要交付的和需要的拼成（`taskQuery`）；标题、项目、里程碑另作「核心词」再检索一次加分，免得交付合同里的通用措辞（「核验结果」「确定结论」）压过任务本身。本任务文件 ×2，本线文件（本线项目的文件、授权给本线的文件夹里未归项目的文件）×1.4，别的线的文件 ×0.5；同一文件先取两段再轮到第三段，让第一屏能看到多个文件。

**（b）模型参与挑选。** 拆步骤的输入里只放：文件清单（`files`），最强的几段全文（`passages`，≤ 4,000 字），其余候选只给一行开头（`candidates`，≤ 3,600 字）。模型通过两个动态工具自己决定再读什么：

- `search_material(query, scope)`：`task` 只搜本任务文件，`line` 搜本线，`all` 搜全部；返回最多 8 段的编号、文件、位置和开头一行。
- `read_chunk(id)`：读一段全文，并给出同文件前后段的编号。

一次运行里工具返回的字数合计 ≤ 30,000（`MATERIAL_TOOL_BUDGET`），超过后工具说明已到上限，让模型用已读内容完成计划，没读到的写进 questions。计划里的 `units` 引用段落时，校验对照的是模型被展示过或读过的每个文件的全文（`documents()`），所以通过工具读到的段落同样可以被引用和核对。

不再盲截 48k。

## 不能调用工具的路由

第三方模型经 chat-bridge 走的也是 Codex 的动态工具（输入框、访谈整理、助手早已在用），模型检验里有一项 `ADVERSARIAL_TOOLS`（必须调用一次函数并用其结果作答）。拆步骤本身不要求工具（`SKILL_NEEDS` 不标 `tools`），以免没通过这一项的模型连拆步骤都做不了；改为运行时判断：

- 本人自己的 Codex：给工具。
- 其他提供方：其检验记录里工具一项跑过且通过（`callsFunctions(record)` → `ProviderRouting.functionCalls`）才给工具；记录早于这一项、或没通过，按不能调用处理。
- 不能调用时，`SkillRunOptions.optionalTools.withoutTools` 把输入里的 `materials` 换成「代码挑选的前 N 段全文」（≤ 16,000 字，按同样的排序），不声明工具，也不附工具说明。

日志 `context.selected` 记每次拆步骤用了哪种方式、展示了多少字、调了几次工具、工具返回多少字。

赞助模型的规划 Skill 可能跑在另一个候选模型上（`modelFor`），`functionCalls` 读的是被选中模型的记录，两者不同时以被选中模型为准，这是已知的近似。

## 各处的预算（字符）

| 地方 | 内容 | 上限 |
|---|---|---|
| 拆步骤，有工具 | 候选清单（一行一段） | 3,600 |
| 拆步骤，有工具 | 最强段落全文 | 4,000 |
| 拆步骤，有工具 | 一次运行里工具返回合计 | 30,000 |
| 拆步骤，无工具 | 代码挑选的段落全文 | 16,000 |
| 拆步骤、倒推 | 本项目与本线事实 | 6,000 / 3,000 |
| 捕获分析 | 与捕获相关的段落（每段 ≤ 700，得分 ≥ 最高分一半）+ 其余文件名一行 | 4,200 |
| 倒推 | 本项目文件片段，没有则本线（每段 ≤ 280） | 3,000 |
| 里程碑设计（每条线） | 本线文件片段（每段 ≤ 280） | 3,000 |

预算是对内容本身计的；JSON 结构和文件清单另算，所以表里「无工具」实测在 17–19k。常量在 `packages/core/src/context-selection.ts` 的 `CONTEXT_BUDGETS`。

## 数据库：迁移 19

`doc_chunks(id INTEGER PRIMARY KEY, workspace_id, document_id, ord, start_at, heading, body)` 加外部内容的 FTS5 表 `doc_chunks_fts(heading, body, tokenize='trigram')`，三个触发器维护索引。`id` 用整数主键，VACUUM 不会改 rowid。

- 编号：原计划用 18，但 origin/main 的 18 已是 `domain_records`（轻量版，已部署，线上账本已在 user_version 18），所以本迁移是 **19**。迁移语句全部 `IF NOT EXISTS`，再改号也只需改数字。
- 维护：`saveSourceDocument`、`setSourceDocumentExtraction`（读入、重读）重切；`deleteSourceDocument` 删段；`assignSourceDocumentProject` 和改了名字或主线的 `saveProject` 更新标题。
- 两字中文词（「组会」）用 LIKE 补；查询里有三字以上的词时，两字词只给已被它们找到的段落加分，免得「输入」这类词把每份讲语音输入的文件都拉进来。
- 派生数据不导出：`doc_chunks` 由 `source_documents` 推出，备份里带上会让体积翻倍，还可能与文件不一致。`exportSnapshot` 不含它（`tableNames()` 也排除 FTS 虚表和它的影子表），`importSnapshot` 跳过快照里带的 `doc_chunks`，导入后从文档重切。`resetWorkspace`、`purgeWorkspace` 按 `workspace_id` 删，触发器同步删索引。
- `pnpm doctor:ledger`（user_version ≥ 19 时）检查：缺表、段落指向已删文件、已读文件没有段落、索引行数与段落数不一致。
- 访谈的编号证据句（`evidence_sentences`）没有进这个索引：访谈整理已有 `search_evidence`，而拆步骤需要的事实已经结构化成 `profile_facts`。

## 实测（2026-10-20，本人账本只读副本，不调模型）

SQLite 在线备份到 `%TEMP%\claude\ctxsel\`，从不写 `data/crossline.db`；`scripts/context-selection-check.ts <副本>` 可复现（它拒绝 `data/` 下的文件）。

- 副本 user_version 18 → 19，打开并迁移约 2 秒；110 份文件、约 297 万字，切成 3,996 段。
- 检索一次平均约 28 ms（含两字词 LIKE 和联表）。

| 任务 | 线 / 项目 | 改前给的文件数 | 改前 材料 / 事实 | 改后 有工具 / 无工具 / 事实 | 捕获分析 改前 → 改后 | 倒推片段 |
|---|---|---|---|---|---|---|
| 建立 6T SRAM 基线单元 | research / Hippocampus sleep replay 硬件实现 | 6 | 49,442 / 2,177（50 条） | 10,218 / 18,998 / 4,084（74 条） | 2,850 → 4,154 | 2,873 |
| 完成西湖 NeuroSim 仿真 | research / 单晶 MoS2 忆阻器片上训练 | 6 | 49,442 / 2,201（50 条） | 9,382 / 17,904 / 4,084（74 条） | 2,850 → 4,413 | 2,755 |
| 整理 ECE 548 复习提纲 | research / ECE 548 | 4 | 9,005 / 2,220（50 条） | 10,137 / 18,504 / 4,084（74 条） | 2,850 → 4,157 | 2,761 |
| 完成 Crossline 介入 | startup / Crossline | 6 | 49,442 / 405（11 条） | 6,878 / 16,752 / 537（11 条） | 2,850 → 4,416 | 2,730 |
| 选定首轮选题 | media / 小红书自媒体 | 0 | 2 / 343（9 条） | 2,442 / 2,426 / 469（9 条） | 2,850 → 452 | 2 |

「改前给的文件数」里的 6 份，对前两个和第四个任务来说并不是本项目文件，而是授权文件夹里归到同一条线、没归项目的文件（Downloads、创业文件夹），旧代码在本项目文件少于 3 份时整份塞入，前 48k 里有一份是「AI 摄影布光指导软件 PRD」。

命中的段落是否相关（标题，前几名）：

- **6T SRAM 基线单元**：`offline_replay_hardware_proposal.md` 第 5、6 段（本项目的硬件方案），`ECE_555_Tutorial_1`（Cadence 入门），`hippocamflex` 论文；候选里有 ECE 555 的 CMOS 延迟功耗讲义和作业。相关。
- **西湖 NeuroSim 仿真**：`personal-profile.md`（本人写的项目说明），MoS₂ 逻辑存内计算、二维浮栅存储、MoS₂ 向量矩阵乘法等参考文献。相关；第一版没有核心词加分和跨线降权时，前排是创业线的商业计划书。
- **ECE 548 复习提纲**：ECE 548 的两份作业、`Course Overview.docx` 全文，`TENTATIVE_Lecture Plan for Fall 2026.docx` 在候选第一。相关，但讲次表本该进全文：任务是中文（「前几章」「期中」），课程文件是英文，三字中文词命中不了英文文件。这正是让模型自己 `search_material("lecture plan midterm")` 的理由；只有实测跨语召回不够时再加 embedding（review §4 的第 4 条）。
- **Crossline 介入**：只命中静默语音输入的商业计划书（本线文件，没有文件讲 Crossline）。分数都低，是噪声；模型看了候选一行开头就能判断不读。
- **选定首轮选题**：自媒体线没有文件，只拿到 `personal-profile.md` 的三段（本人对自媒体方向的描述），捕获分析得到「没有相关段落」加一行其余文件名，而改前是 8 份无关文件的开头。

捕获分析：改前固定拿前 8 份文件的开头（三个研究任务和创业任务拿到的是同一批）；改后按捕获内容取段落，ECE 548 拿到 548 的作业和课程概览，6T SRAM 拿到 ECE 555 的教程和大纲。NeuroSim 的捕获文本较长，仍混进两段商业计划书（捕获时不知道线，没有线的加权）。

里程碑设计：研究线（95 份本线文件）拿到 8 段 2.9k，来自硬件方案、ECE 555 讲义和海马体论文；创业线 4 段；自媒体线和投资线本线没有文件，什么也不加。

## 测试

- `packages/core/src/context-selection.test.ts`：切段、检索词、预算。
- `packages/db/src/doc-chunks.test.ts`：保存即可检索（三字词、英文、两字词、标题）；重读、归项目、项目改名、删除后索引跟着变，FTS 行数一致；跨工作区读不到；迁移 19 在旧库上补建索引并留 `.v18.bak`；导出不含、导入重建、快照里带的旧 `doc_chunks` 被忽略；重置与删除账号清掉段落，另一工作区的不受影响。
- `apps/worker/src/material-context.test.ts`：候选排序（本任务 > 本线 > 别的线）、全文与候选的预算、无工具时的全文、两个工具的三种范围、读到的段落可以被单元引用、超出预算的提示、捕获分析的阈值、片段的范围、事实排序和预算。
- `packages/codex/src/optional-tools.test.ts`：自己的 Codex 声明工具；没证明会调函数的提供方不声明工具、输入换成全文；证明过的提供方给工具。
- 原有 `analysis.test.ts` 的「已上传文件」用例改成按相关性。

## 没做

- 不调真实模型：模型实际读了哪些段落、计划质量是否变好，要等下一次真实拆步骤的 `context.selected` 日志和计划对照。
- `evidence_sentences` 不建索引（理由见上）。
- `profile_facts` 的 `valid_from`/`invalidated_at`、稳定前缀吃缓存、embedding：review §4 的后三条，未做。
- 赞助模型按 Skill 换模型时，`functionCalls` 用被选中模型的记录（见上）。

# Crossline 重构设计 v2

> **归档文档**：2026-09 的 v2 重构设计与 14 条裁决。「数学只作用于可测量的量」等原则仍然有效；界面、onboarding、手册、屏幕活动等后续演进见根目录 CLAUDE.md。 当前文档索引见 [docs/README.md](../README.md)。


状态：**已确认（14 条裁决齐备）**，可进入实现。本文取代 `docs/archive/crossline-mvp-implementation-plan.md` 中与之冲突的部分；
`docs/archive/crossline-plan-critical-review.md` 的结论继续有效，本文在它之上收紧。

---

## 0. 这次要解决什么

现有实现打通了「捕获 → AI 拆解 → 审批 → 执行 → 证据 → 验收」的骨架，但三条独立审查
（正确性、架构、UI）一致指出：**产品声称的核心价值没有兑现**。具体是三条断链：

1. 分析成功的条目**从首页消失** —— `saveTask` 只有种子调用，而首页只读 `tasks`。
2. **AI 越尽职，工单越卡死** —— Skill 提出任何材料需求就触发 `MATERIALS_NOT_PREPARED`，
   而进入 `preparing` 的事件没有任何生产者。
3. **跨身份飞轮不存在** —— `milestone_relations` 只驱动一张图，不影响任何决策，
   且没有证据、反例、成本、最近验证时间等字段。

v2 的目标不是加功能，是让这三条链真正闭合，并把飞轮从"一张图"变成"一个会转的东西"。

---

## 1. 第一原理：数学只作用于被测量的量

用户的判断是对的且必须成为架构约束：**LLM 生成的分数不能作为数学优化的输入**。
一个由模型打出的"重要性 8.5 分"，乘上权重、送进求解器，只会给主观判断盖一个客观的章。

因此本设计确立一条不可越界的分工：

| 层 | 允许的运算 | 禁止 |
|---|---|---|
| **可测量层** | 分钟数加减、区间统计、活跃/空闲时间核算、预算累加 | — |
| **判断层（LLM）** | 拆解、归类、里程碑提案、材料准备、证据预审、洞察 | 输出任何被下游当作数值计算输入的分数 |
| **确定性层（机械代码）** | 状态机、事务、幂等、Schema 校验、审批闸门、配额 | 用启发式替代缺失的 AI 结果 |

直接后果，已由用户确认：

- **删除 `optimizeTaskSelection` / HiGHS**。它的目标函数系数只可能来自打分，
  而可测量的惩罚分钟数在有真实执行数据之前不存在。P2 之后若真有可测量目标再谈。
- **删除 `packages/workflows`**。它服务的是"用户自己画流程图"的产品形态，已被放弃；
  它强制的「外部副作用前必须有审批节点」这条规则改由 `requiredApproval` 单点表达。
- **不做 DAG，也不做任务拆解关系图**。真实的主线依赖是**有环的**
  （自媒体产出反哺科研选题，是回路不是链），DAG 在结构上就描述不了它。

替代物见 §6。

---

## 2. 系统分层

```
┌─────────────────────────────────────────────────────────────┐
│  UI (Next.js)   B 主视图 · C 审批入口 · A 周/日详情          │
├─────────────────────────────────────────────────────────────┤
│  确定性核心     状态机 · 事务原语 · 审批策略 · 配额 · Schema  │
├─────────────────────────────────────────────────────────────┤
│  Codex Gateway  线程隔离 · 上下文包 · 结构化输出 · 事件归一   │
├─────────────────────────────────────────────────────────────┤
│  Skill 三层     通用编排核心 / 身份工作流包 / 用户覆盖层      │
├─────────────────────────────────────────────────────────────┤
│  账本 (SQLite)  事件溯源 · 当前状态表 · 全量导出              │
└─────────────────────────────────────────────────────────────┘
```

**新增的关键约束：确定性核心不认识任何具体身份。** 新增一条人生主线 = 新增一个身份包，
不改调度器、不改状态机、不改 UI 代码。这一条用一个测试锁住（§12）。

---

## 3. Skill 三层与交付机制

### 3.1 重大发现：运行时原生支持 skills

Crossline 隔离 sidecar 实际启动的 `Codex Desktop/0.133.0` app-server 协议已包含：

```
skills/list              skills/config/write        ← 一等公民的 skill 管理
plugin/install           plugin/skill/read          ← skill 由 plugin 交付
PluginInstallParams { marketplacePath: 绝对路径 }    ← 可从本地目录安装
```

**结论：不 fork codex 源码。** Crossline 把 skills 做成仓库内的本地 plugin marketplace
（`skills/marketplace/`），启动时 `plugin/install` 到隔离的 `CODEX_HOME`，
按任务用 `skills/config/write` 开关。plugin 内 skill 在运行时带 plugin 命名空间，例如
`crossline:crossline-automation-stripper`；配置是 CODEX_HOME 全局状态，因此同一 home 的
启用—执行—恢复必须串行化。

这样做的收益正是用户要的"依托前沿模型本身的更新能力"：skill 是数据不是代码，
模型升级后改 SKILL.md 即可，不用动 TypeScript。

> 若将来确需改 codex 源码，先记录**为什么现有协议不够**，再改；本设计不预留 fork。

> 2026-09-18 运行实现更新：依用户要求，Crossline 现从[自有 fork](codex-fork-runtime.md)构建并固定 Codex 可执行文件；fork 有一处 Windows 状态库迁移兼容补丁。上文的 Desktop 版本和“不 fork”是原设计决策的历史记录。

### 3.2 三层职责

**A. 通用编排核心**（`crossline-core`，与身份无关）
- 拆解：可 AI 自动化部分 vs 不可约的人工核心
- 证据契约：什么算完成的证明
- 审批：哪些动作需要人、需要到什么粒度
- 成本：预算档位下的降级策略
- 重排：约束变化时如何重新安排
- 跨线复用：把一次产出识别为另一条主线的输入候选

**B. 身份工作流包**（`packs/<identity>/`，可插拔）

每个包**只声明结构，不写任何个人目标**：

```yaml
id: research
label: 科研
kind: identity            # identity | capacity
interviewQuestions: [...]  # 建立该主线时问什么
milestoneTemplates: [...]  # 该领域里程碑长什么样（可证伪的形状）
workflows: [...]           # 常见流程骨架
evidencePolicy: tiered     # tiered | telemetry
riskThresholds: {...}      # 什么动作在该领域算高风险
durationPriors: {...}      # 标注先验，带来源
```

**C. 用户覆盖层**（`data/overlay/`，不进版本库）
- 用户的具体目标、文件根目录授权、偏好、例行安排

> 判据：把 `packs/` 整个换掉，系统仍应能跑；`overlay/` 清空，系统应回到"未标定"
> 而不是崩溃或编造。

---

## 4. 五大 AI 能力

### 4.1 自动化剥离 + AI 工作流设计（已有，需修断链）

现状：`automationParts` 被拆出来但**没有执行者**，`materialContract` 非空即卡死。

v2：
- 新增 `preparing` 状态的真实入口。`automation.started` 由「材料准备」能力发出。
- `automationParts[].reversibility` 解锁 `"external"`，但走 `requiredApproval` 逐项审批。
- Skill 不再只输出"哪些能自动化"，还输出**怎么自动化**（一个可执行的准备计划），
  但该计划本身是提案，执行前需批准。

### 4.2 精力监测与排程（新，见 §5）

### 4.3 人工核心任务的材料准备（新）

- 触发：WorkOrder 进入 `approved` 且 `materialContract` 非空。
- 隔离线程，授权**该身份声明的本地文件根目录**，只读 + 网络检索（该线程显式开启）。
- 产出：真实文件引用 + 来源 + 时间戳，写入 `materials` 表。
- 完成后 `materials.ready` → `ready_for_human`。
- 失败/超预算 → typed blocker，**不阻断人工自己准备**。

### 4.4 里程碑闸门 Skill（`crossline-milestone-gate`，取代 `crossline-evidence-reviewer`）

用户裁决：**绑定里程碑的条目必须有证据，且证据须经 LLM 审查才能完成。**

关键在于这个 Skill 的判据不是"这件事做完了吗"，而是
**"当前证据是否支撑飞轮的下一步"**。这是两个不同的问题：
一份完整的实验记录可以完美满足证据契约，却对任何其他主线毫无解锁作用。

#### 前提：里程碑必须自带可量化指标

用户裁决：**里程碑本身要有可量化的指标要求**，否则"达没达到"无从判断，
闸门只能沦为对着一段散文说"看起来不错"。

因此 `StoredMilestone` 增加 `successCriteria`（见 §7），每条是一个**可判定**的陈述：

```ts
SuccessCriterion = {
  id: string
  statement: string        // "把 3 组实验的异常归因到同一个机制，并给出反例检验"
  measure:
    | { kind: "count";     unit: string; atLeast: number }        // 至少 N 个
    | { kind: "artifact";  mustExist: string }                    // 必须存在某产物
    | { kind: "threshold"; unit: string; comparator: "gte"|"lte"; value: number }
    | { kind: "judgement"; rubric: string }                       // 无法量化时显式承认
  required: boolean
}
```

**指标由 LLM 提案、由用户拥有**（裁决 §13-6）。`crossline-milestone-architect`
在建里程碑时提出一组 `successCriteria`，用户在抽屉里直接改数字或改 rubric 文字，
改动即生效、记一次版本。LLM 不能改已批准的指标 —— 那等于考生改考题。

`kind: "judgement"` 是诚实出口。**允许一个里程碑全部是 judgement**（裁决 §13-6），
因为硬凑一个假指标比承认"这件事要靠判断"更糟。

但代价必须被补偿，否则全 judgement 的里程碑**永远无法被客观判负**。补偿是
**可证伪性要求**，比原来的"至少一条可量化"更贴题：

```ts
{ kind: "judgement"; rubric: string; failsWhen: string }   // failsWhen 必填
```

`failsWhen` 必须写明**什么样的证据会让这条判不过**。写不出 `failsWhen` 的 rubric
在创建时被拒（`CRITERION_NOT_FALSIFIABLE`）——
"做得好"不是标准，"没有给出任何反例检验"才是标准。

全 judgement 的里程碑标 `verifiability: "judgement_only"`，周复盘单独列出来复核。

> 顺带：你举的「完成所有 XX 课程」其实**高度可量化** ——
> `count`（N 门）+ `artifact`（成绩单）。真正只能 judgement 的是
> "想清楚这条路要不要走"这类。别把可量化的写成 judgement，
> 那会白白丢掉机械校验。

#### 输入

```
{
  milestone:        { id, title, evidenceContract, successCriteria, identityId, version }
  identityPack:     { evidencePolicy, riskThresholds }
  evidenceClaims:   [{ id, kind, uri, description, createdAt }]
  artifacts:        [...]            // 可读到的真实内容
  executions:       [...]            // 真实时长与中断，用于判断证据与投入是否相称
  outgoingRelations:[{ id, kind, targetMilestoneId, targetIdentityId,
                       evidence[], counterexample[], lastValidatedAt }]
  targetMilestones: [...]            // 关系另一端的当前状态
}
```

#### 输出（严格 Schema）

```
{
  verdict: "pass" | "insufficient" | "refuted"

  criteriaVerdict: [{                               // 逐条可量化指标，不允许漏判
    criterionId,
    met: "met" | "partial" | "unmet" | "unverifiable",
    observed: string,                               // 从证据里实际读到的值/事实
    evidenceQuote: string,                          // 必须引用原文，不得转述
    shortfall: string | null                        // 差多少，可执行地写
  }]

  contractCoverage: [{ requirement, satisfiedBy: evidenceId|null,
                       reasoning, quote }]          // 逐条契约覆盖，每条必须引用原文

  unplannedGains: [{                                // 「是否有其他收获」
    finding: string,                                // 指标之外、但确实发生的收获
    evidenceQuote: string,
    mayEnable: [milestoneId] | []                   // 它可能解锁哪条主线（候选，不自动建关系）
  }]

  improvements: [{                                  // 「还有什么需要改进」
    area: "evidence" | "method" | "scope" | "pace",
    observation: string,                            // 基于本次真实证据与执行数据
    suggestion: string
  }]

  incomplete: [{                                    // 「还有什么未完成」
    what: string,
    blocksWhich: [criterionId | relationId],
    isBlockingPass: boolean
  }]

  flywheelAssessment: [{                            // ← 核心
    relationId, targetMilestoneId, targetIdentityId,
    supports: "advances" | "neutral" | "contradicts",
    whatIsNowPossible: string,                      // 现在能做而之前不能做的事
    whatIsStillMissing: string,
    evidenceQuote: string
  }]

  gaps: [{ code, whatWouldSatisfyIt }]              // 缺什么才能过
  proposedNextMilestones: [...]                     // 交给飞轮 Skill 的种子
  blockers: []
}
```

`refuted` 的含义：证据**反证**了某条既有关系（原以为 A 能助力 B，实际做完发现不能）。
这时把该关系标 `refuted`，它不再产生候选。**这是飞轮唯一的负反馈通道，不能省。**

#### 确定性层复核模型的自洽性

这是 §1 原则在闸门上的直接应用：**不信任模型给出的总结论，只信任它的逐条判断。**
接收端机械校验，不一致就拒收：

```
verdict === "pass"  ⟺  每一条 required 且非 judgement 的 criterion 都是 "met"
                      且 incomplete 中没有 isBlockingPass
incomplete[].isBlockingPass 为真 ⟹ verdict ≠ "pass"
每条 criteriaVerdict / unplannedGains / flywheelAssessment 的 evidenceQuote
                      必须是提交证据原文的子串（与分析 Skill 同一套引用校验）
```

校验失败 → `GATE_VERDICT_INCONSISTENT`，当作未审查处理，**不落任何状态**。
模型可以判断错，但不能自相矛盾还被采信。

#### 决策权限（非对称设计）

| 判定 | 谁能落地 | 理由 |
|---|---|---|
| `insufficient` / `refuted` | **AI 可单方阻断** | 阻断不产生任何虚假事实，误判的代价只是多一次人工复核 |
| `pass` + 非里程碑绑定 | AI 自动验收 | 认知负载的主要来源 |
| `pass` + **里程碑绑定** | **AI 自动验收**（裁决 §13-7） | 用户裁决：人工不再逐条确认 |
| 涉及外部副作用 | **永远逐项人工** | 不在本表范围内，见 §11 |

**这条裁决把系统从「AI 提案、人工裁定」改成「AI 裁定、人工审计」。**
这对单人个人工具是合理取舍，但必须诚实记录它的代价：
里程碑状态会由一个没有人当场验证过的判断改变。

因此以下四条补偿控制**不是可选项，是这条裁决的组成部分**：

1. **机械自洽校验从后备变成承重**（见下一节）。它现在是 `pass` 路径上唯一的
   非 LLM 关卡 —— 校验失败即 `GATE_VERDICT_INCONSISTENT`，不落状态。
2. **每一次自动验收都可撤销**，且撤销把里程碑退回 `evidence_review`，不丢证据。
3. **周复盘必须逐条列出本周所有自动验收**，不折叠、不汇总成一个数字。
   看不见的自动化等于没有审计。
4. **`refuted` 可回溯**：若某条关系后来被反证，由它支撑通过的里程碑被标记
   `auto_accepted_then_questioned`，在周复盘置顶。飞轮的负反馈必须能倒着走。
这两件事的风险不对等，权限就不该对等。

### 4.5 长期洞察与适配（新）

- 输入：executions 真实时长与中断、证据验收通过率、预审与人工决定的分歧、精力曲线。
- 输出：**版本化的覆盖层补丁提案**（估时先验调整、例行安排调整、里程碑节奏建议）。
- 永不自动应用。周复盘页批量审批。
- 保留期有界，且每条洞察必须能指回产生它的原始观测。

---

## 5. 精力监测设计

### 5.1 信号（用户已确认三类）

| 信号 | 采集方式 | 隐私边界 |
|---|---|---|
| 主动自评 L/M/H | 已实现 | 无 |
| **真实执行数据** | 已在采集：`executions` 的时长、中断次数/原因/时段 | 无新增 |
| **本机活动** | PowerShell 内联 C# 调 Win32，**零 npm 依赖** | 见下 |
| 可穿戴（睡眠/HRV） | 预留接口，本期不实现 | 需独立授权 |

本机活动的实测结果（已验证可用）：

```
GetLastInputInfo  → idleMs    真实系统空闲毫秒
GetForegroundWindow → fgHandle 窗口句柄（一个不透明数字）
```

**关键设计：只取句柄不取标题。** 由此只能导出两个聚合量 ——
**活跃/空闲区间**与**窗口切换频率** —— 天然不含任何内容。
不装 iohook 之类的全局钩子库（既是新增原生依赖，也会拿到按键内容）。

worker 每 60 秒轮询一次，只落聚合，不落原始序列。

### 5.2 输出的形状（硬约束）

文献支持的是**针对个人基线的、粗粒度（2–3 档）分类**；
文献中那些高灵敏度数字来自**临床诊断**（帕金森、轻度认知障碍），
而临床推断是本项目明令禁止的。

因此算法输出**与自评同一个量表，不多一档精度**：

```ts
CapacityReading = {
  level: "low" | "medium" | "high" | "uncalibrated"
  confidence: "low" | "medium" | "high"
  observationCount: number
  basis: Array<"self_report" | "execution_history" | "local_activity">
  blockers: Array<{ code: string; message: string }>
}
```

- 永不输出连续分数、百分比、"疲劳度 73%"。
- 样本不足 → `uncalibrated`，不猜。
- 永不做医学推断，永不给健康建议。
- 精力**建议**排程，不**决定**排程；用户覆盖一律记账（覆盖成本进周复盘）。

---

## 6. 里程碑飞轮（取代 DAG）

### 6.1 结构

一个**允许有环的有向多重图**，节点是里程碑，边是关系。不是 DAG，不做拓扑排序。
渲染方式是"打开时从数据库轮询一遍，画出当前跨主线流程图"——**派生视图，不可编辑**。

`milestone_relations` 补齐审查指出的缺失字段：

```ts
StoredMilestoneRelation = {
  ...现有字段
  evidence:        Array<{ uri: string; source: string; observedAt: string }>
  counterexample:  Array<{ note: string; observedAt: string }>
  costMinutes:     number | null       // 维持这条关系的真实成本
  lastValidatedAt: string | null
  status: "candidate" | "approved" | "archived" | "refuted"   // 新增 refuted
}
```

**没有证据的关系只能是 `candidate`，candidate 不影响任何决策。**

### 6.2 飞轮 Skill

- 输入：已批准的里程碑集合、各主线近期真实产出、身份包的里程碑模板。
- 能力：**该线程显式开启网络检索**，用于调研"这个领域的里程碑通常怎么设才互相借力"。
- 输出：候选里程碑提案 + 候选关系，每条必须带**来源 URL、时间戳、反证条件**。
- 闸门：批量审批后才进正式队列。**永不自动创建任务**。

### 6.3 飞轮怎么"越转越快"

不靠算分。靠三件可测量的事：

1. **复用率** —— 一条主线的产出被另一条主线实际引用的次数（来自 evidence 引用，可数）。
2. **关系成本** —— 维持一条关系实际花掉的分钟数（来自 executions，可测）。
3. **反例** —— 关系失效时人工标 `refuted`，该关系不再产生候选。

周复盘展示这三个数，**不展示任何合成指数**。

---

## 7. 数据模型：WorkOrder 吸收 Task

用户已确认合并。

- `packages/core` 的 `Task` 模型删除，但**三条领域规则搬到 WorkOrder 路径**：
  - 绑定里程碑的条目零证据不能验收（已裁决，见 §13-1）
  - 跳过重复条目必须写原因
  - 删除留墓碑，不硬删
- **`StoredMilestone` 增加 `successCriteria: SuccessCriterion[]`**（形状见 §4.4）。
  创建里程碑时机械校验：至少一条标准；`judgement` 标准必须声明 `failsWhen`。
  允许全部为可证伪的 judgement。现有四条种子里程碑没有指标，迁移时保留原状态并标
  `verifiability: "unstated"`，闸门拒绝其验收，直到用户确认指标 —— **不替用户编指标**。
- `Task.recurrence.minimumMinutes`（"最低可行版本"）并入 WorkOrder，与
  `capacity_commitments.minimumMinutes` 统一语义。
- **首页改读 `work_orders`** —— 这直接修掉断链 ①。
- `StoredTask.contribution`（种子里硬编码的 10/7/5/6 加权分）删除：
  它是个隐藏的打分，正好违反 §1。

---

## 8. Codex Gateway

职责（用户已列明，此处补充实现口径）：

| 职责 | 实现要点 |
|---|---|
| 线程隔离 | 每个 WorkOrder 一个 thread，持久化 thread/turn id 供审计与恢复 |
| 上下文包 | 版本化 key；任一输入变化即 bump |
| 结构化输出 | JSON Schema 约束；**本地二次校验**，不信任 runtime 的执行 |
| 事件归一 | 原始通知 → `{progress \| blocked \| completed}`，不在别处读原始事件 |
| 副作用 | 文件/网络/外部一律交统一审批系统 |
| 记账 | 模型、token、费用、产物、失败原因 |
| **版本漂移** | 已实现：`--strict-config` 遇未知配置键即剔除重试（0.133 不认 8 个为 0.154 写的键） |

**模型路由**
- 低成本档：提取、分类、格式化、例行准备
- 高能力档：里程碑设计、跨线规划、高风险综合、关键评审

**预算门**（`budgetPolicy` 已存在但零调用，本期接上）
- 默认 $100/月
- 70% 警告 · 85% 暂停低价值研究与润色并降级模型 · 100% 仅运行逐项批准的核心任务
- **用量必须来自运行时真实回报**；读不到就显示"未标定"，不估算

---

## 9. UI 迁移

参考 `karols-wandering-again.html`。它是当前设计语言的**成熟版本**，迁移是增量的。

### 9.1 采纳的
- 完整暗色模式（`prefers-color-scheme` + `[data-theme]` 双轨）
- **Noto Sans SC** 进字体栈（当前中文走系统回退，是版面质量差距主因）
- 28px 网格底纹；零圆角；`--mist` 发丝线 / `--ink` 1.5px 结构线
- **`--now` 绿只用于"此刻"标记**，从状态色降级为时间色
  —— 顺带解决 UI 审查指出的"诚实标记对比度 3.89:1"问题：状态改用形状与字重编码
- **形状编码状态**（`.gly[data-s]` 半填充 / 圆 / 斜线），色盲安全
- `1px gap + --mist 底色`伪造表格线
- `.mtrack[data-over]` 斜线阴影表示超载
- 抽屉式详情，替代跳页

### 9.2 B / C / A 重排（用户指定）

| 视图 | 定位 | 内容 |
|---|---|---|
| **B（主）** | 默认落地 | 现实约束与 AI 块并行的一条时间线 + 下一行动 |
| **C** | **审批入口** | 所有待批：计划差异、里程碑候选、关系候选、外部动作、洞察补丁 |
| **A** | 周/日详情 | 周矩阵 + 日细节，用参考文件的 `.week` / `.month` 网格 |

C 从"三个标签之一"升级为**全系统唯一的审批收口**。

### 9.3 必修的既有缺陷（UI 审查）
- 移动端 nav 用 `nth-child` 隐藏了 Workbench/Milestones → 改横向滚动，不隐藏功能
- `.execution-actions` / `.offline-page` 无 CSS → 补齐
- Plan/Workbench/Approvals 无移动端断点 → 补齐
- 术语泄漏（`llm_prior`、`routine`、`pending`、`CONNECTOR_NOT_CONFIGURED`）→ 建映射表，
  原始码收进 `<details>`
- tablist 缺 `aria-controls`/`tabpanel`/方向键
- 假表盘指针（固定角度）→ 删指针或接真实时间

---

## 10. 各身份首版工作流

均为**身份包内的模板**，不含个人目标。

- **科研**：主时钟（课程/组会）、论文阅读、实验准备、会议材料、写作与证据归档
- **创业**：围绕当前里程碑检索公开潜在合作对象 → 相关性证据 → 冷启动邮件草稿；
  **每封逐项批准后**才经官方 Outlook 插件发送
- **自媒体**：复用科研/创业产出生成选题、脚本、素材包；content-ops 作为外部执行适配器，
  保留 `POST /v1/jobs` + 认证只读 `GET /v1/jobs/{id}`
- **投资**：仅美股与 ETF；盘前/盘中/收盘三份报告 × 日内/1–4周/长期基本面三视角；
  每条数据带时间、来源、置信度、**反证与失效条件**；
  Longbridge 只读 allowlist（行情/新闻/财报/公告/交易日历），账户与交易接口拒绝加载
- **健康**（capacity，非身份）：动态安排健身、做饭、进食准备；支持 minimum 档与显式覆盖，
  覆盖成本进周复盘

跨线复用只生成**候选任务包**（例：科研结果 → 创业论证 → 自媒体内容 → 行业投资观察），
批量批准后才进正式队列。

---

## 11. 审批与安全边界

- `requiredApproval` 成为**唯一真相源**，UI 必须调用它而不是抄一份
  （现状：生产零调用，审批页硬编码抄了一遍）
- 签名需要改：现在只吃一个 action 字符串，不含目标、可逆性、金额、收件人。
  接真实外部动作前必须改成吃 payload
- 外部写入仍全部关闭，直到 Gate 2 有真实只读证据

### 11.1 Entra 现状（已实测）

应用注册**成功**，单租户（受支持的帐户类型 = 仅我的组织）。第一关过了。

client id 与 tenant id 不是机密（OAuth 公开标识符），但仍放进 `.env.local`
（`.env*` 除 `.env.example` 外已 gitignore），**不进版本库**。

还没做、且顺序不能颠倒的三步：

1. **重定向 URI** —— 桌面/原生客户端走 `http://localhost` 回环。
   本项目是本地单用户应用，**不要**建客户端机密（公共客户端 + PKCE，不落任何密钥文件）。
2. **API 权限** —— 只加委派、只加读：`Calendars.Read`、`Tasks.Read`、`User.Read`、`offline_access`。
   **先不加任何 ReadWrite**，Gate 3 之前不需要。
3. **同意** —— 加完权限后点一次"代表我自己同意"。这里才是真正的关卡：
   UW 租户若对未验证发布者关闭了用户同意，会提示需要管理员批准。
   **这一步失败不算设计问题，是租户策略**，届时 Gate 2 的结论就是
   「需要 UW IT 管理员同意」而不是「功能没做」。

> 注意：这个应用注册在 **UW 租户**里，能读的是 UW 账号的日历与待办。
> 个人 Outlook 的 `Crossline` 日历（Gate 3 的写目标）是**另一个账号**，
> 需要单独的多租户/个人账号配置。两件事不要混在一个 client id 上。

---

## 12. 最小闭环验收口径

必须全部为真，且由**真实运行**而非测试桩证明：

1. 一条自然语言捕获，经真实 Codex 分析产出 `awaiting_plan_approval`，带 thread/turn 审计 id
2. 该条目**出现在首页**（断链 ① 已修）
3. `materialContract` 非空时能真正进入 `preparing` 并产出真实材料引用（断链 ② 已修）
4. 人工执行 → 暂停含中断原因 → 完成 → 提交证据 → 里程碑闸门；判 `pass` 后按 §13-7
   的四条补偿控制自动验收，其他结果进入人工处理
5. 飞轮 Skill 联网产出至少一条带来源 URL 的候选关系，经批量批准后落库
6. 精力读数在有观测时给出 3 档之一、无观测时为 `uncalibrated`，且从不输出连续分数
7. 预算门在模拟 70/85/100% 时真实降级
8. 换掉整个 `packs/` 目录，系统仍能跑（通用性测试）
9. `pnpm test` / `typecheck` / `build` / `test:e2e` 全绿

---

## 13. 裁决记录

**已确认：**

1. **证据规则** —— 绑定里程碑的条目**必须有证据**，且须经 `crossline-milestone-gate`
   审查。非绑定条目允许 `completed_without_evidence` 并如实标记。
2. **本机活动采集默认关闭**，首次进入 Today 时显式询问，与摄像头同源的处理。
   未授权时精力读数走 `basis: ["self_report","execution_history"]`，不因此报错。
3. **材料准备写入项目目录下 Crossline 单开的材料文件夹**
   （`<projectRoot>/.crossline-materials/<workOrderId>/`）。
   不写入项目其余位置；越界写入是 typed blocker。

4. **里程碑必须自带可量化指标**（`successCriteria`），闸门逐条判定；
   全部是 `judgement` 的里程碑创建即被拒。见 §4.4 与 §7。
5. **Entra 应用注册成功** —— 单租户（仅我的组织）。见 §11.1。

6. **里程碑指标由 LLM 提案、用户拥有**；允许全 judgement，但每条 judgement
   必须写 `failsWhen`（可证伪），否则创建时拒绝。见 §4.4。
7. **里程碑绑定条目判 `pass` 后人工不再确认** —— AI 自动验收。
   四条补偿控制见 §4.4，它们是这条裁决的组成部分而非可选项。
8. **候选关系池**：每日自动比较合并，保留 10 条，高亮 3 条；
   排序依据是可数事实而非模型打分；淘汰用 `archived` 不硬删。见 §15.6。
9. **飞轮分每日热扩展 + 每周复盘规划**，排程读真实 `resetsAt` 而非固定时段。见 §15。
10. **停转信号只提示不自动跑**。见 §16。

11. **预算的美元口径只进设计，不进系统**。`$100/月 · 70/85/100` 保留为策略声明；
    代码只读运行时真实暴露的成本信号。**模型档位按能力名（`routine`/`capable`）抽象，
    不绑定厂商** —— 后续换更便宜的内核只改一处映射。读不到成本信号时 fail-closed。
12. **夜间占用上限 80%**，并加 `idleMs` 活跃度把关（熬夜时推迟）。见 §15.3。
13. **夜间触发取 01:00–04:00 之间最早的那次 `primary.resetsAt` + 5 分钟**。
14. **机器 24 小时不关机** —— worker 常驻，不需要唤醒任务；
    但"昨夜未运行"仍须如实显示，不得把旧信息当新的。

**设计已完备，无待裁决项。**

---

## 14. 明确不做

- 不修改 Codex 内核协议来重做现有 plugin/skill 能力；运行时来源见[自有 fork 记录](codex-fork-runtime.md)
- 不做 DAG、不做流程图编辑器、不做任务拆解关系图
- 不做任何合成指数、综合评分、跨身份总分
- 不做医学推断、健康建议、连续疲劳分数
- 不引入新的运行时依赖（本机活动用 Windows 自带 PowerShell + Win32）
- 不启用任何真实外部写入，直到 Gate 2 有证据
- 不为"视觉完整"补任何占位数字

---


## 15. 飞轮：每日热扩展 + 每周复盘规划

### 15.1 配额是可读的真实量，不用猜

运行时直接暴露配额（已查实）：

```ts
GetAccountRateLimits → rateLimitsByLimitId["codex"] = {
  primary:   { usedPercent, windowDurationMins, resetsAt }   // 约 5 小时滚动窗
  secondary: { usedPercent, windowDurationMins, resetsAt }   // 周窗
  credits, planType, rateLimitReachedType
}
ThreadTokenUsage = { total, last, modelContextWindow }       // 每线程真实 token
```

**所以不排"1am–6am"这个猜的时间段，直接排在 `primary.resetsAt` 之后。**
这比固定时段严格更好：刷新时刻会漂移（它是滚动窗，跟你上次用量走），
固定 3am 有时踩在刷新前、白白失败。

### 15.2 每日热扩展（Daily）

- **触发**（裁决 §13-13）：取 **01:00–04:00 之间最早的那一次 `primary.resetsAt`**，
  在它之后 +5 分钟起跑。区间内没有刷新则**当晚不跑**，不硬凑。
  排在最早的那次，是为了把整段睡眠时间留给"用完再自然恢复"。
- **前置闸门**（按顺序，任一不过就搁置并记录原因）：
  1. `secondary.usedPercent >= 周窗上限` → 搁置（你的"周额度用完则搁置"）
  2. `rateLimitReachedType != null` → 搁置
  3. `primary.usedPercent` 已超夜间预算 → 搁置
  4. **`idleMs` 显示你正在用电脑** → 推迟（见 §15.3）
- **模型**：中等能力档即可（你说的"较强就可以"）。**不绑定具体厂商**，见 §15.4。
- **产出**：信息域扩展 —— 针对**当前未完成的里程碑**，联网找能推进它的新信息
  （方法、工具、公开数据、可借力的他人工作），每条带来源 URL + 时间戳 + 失效条件。
- **早上可见**：Today 顶部一条"昨夜扩展"，点开是当晚产出。

> **必须约束（你的原话是"这些信息理论上应该支持用户完成 milestone"）**：
> 每条扩展信息**必须挂在一个具体里程碑上**，挂不上的不产出。
> 没有这条，夜间飞轮会退化成一个无人读的 RSS。

### 15.3 夜间预算 80% + 活跃度把关

**裁决 §13-12：夜间占用上限 80%。** 机器 24 小时不关机（裁决 §13-14），
所以休眠唤醒不是问题，worker 常驻即可。

80% 本身是合理的 —— 那段时间你在睡觉，额度闲着也是浪费，而窗口会在你起床前后自然恢复。
但它有一个真实的失效场景：**你熬夜到 2 点还在干活**。
飞轮 1:30 触发、吃掉 80%，你 2:00 就被自己的飞轮锁死了。
这不是假想 —— 本次会话就发生在 23:00–00:00 之间。

**对策：复用已经批准的本机活动信号。** 起跑前读一次 `idleMs`：

```
idleMs < 20 分钟  → 你还在用电脑，推迟 30 分钟重试（最多推 3 次，之后当晚放弃）
idleMs >= 20 分钟 → 正常起跑
```

这条不需要新机制 —— §5 的活动采集已经在跑。唯一的前提是
**你得授权本机活动采集**（默认关，首次进 Today 询问）。未授权时退化为：
按固定时间起跑，并在早上如实显示"未做活跃度检查"。

另两条控制保留：

- **跑之中用 `ThreadTokenUsage` 实时累计**，逼近 80% 即收尾，
  不跑完也交付已得的部分 —— 宁可给半份扩展，不要给零份。
- **早上如实显示**"昨夜扩展占用了本窗口 X%"，不藏。

### 15.4 预算：美元只进设计，不进系统

**裁决 §13-11。** `$100/月 · 70/85/100 三档`作为**策略声明保留在本文档里**，
但**不写进代码** —— 当前 ChatGPT 账号认证下没有按 token 的美元计费，
写一个读不到来源的美元数正好是本项目在删的那类假精度。

同时你明确了**可能换更便宜的模型做内核，不长期绑定 GPT**。这对设计有直接约束：

- **模型档位用能力名而非厂商名**（`routine` / `capable`），
  由配置映射到具体模型。换内核 = 改一处映射。
- **运行时闸门只读运行时真实暴露的量**。当前是
  `primary/secondary.usedPercent` 与 `ThreadTokenUsage`；
  换了内核若提供的是美元，就读美元。**接口按"成本信号"抽象，不按"美元"抽象。**
- 读不到任何成本信号时 → `uncalibrated`，夜间飞轮**默认不跑**（fail-closed），
  而不是假设还有额度。

### 15.5 每周复盘规划（Weekly）

- **触发**：每周固定入口（与周复盘同一个页面），可手动提前。
- **模型**：中等偏强档。
- **输入**：全部里程碑 + 各主线近期真实产出 + 本周执行数据 + 候选关系池 + 联网检索。
- **产出**：
  1. 各里程碑**完成进度**（基于 `successCriteria` 逐条实测，不是感觉）
  2. **向你提问**的清单（需要你判断才能继续的点）
  3. 剩余进度的**重排提案**（批量审批）
  4. 本周所有**自动验收的里程碑**逐条列出（§4.4 补偿控制 3）
- **注意**：周复盘是**对话式**的（你说的"与用户进行询问和复盘"），
  不是一份只读报告。提问必须能在页面上直接回答并落账。

### 15.6 候选关系池的自动整理

裁决 §13-8：每日冷触发时自动比较、合并/删除，保留 10 条，高亮最高收益 3 条。

**"高亮收益最高的 3 条"不能用 LLM 打分排序** —— 那正是 §1 禁止的。
改为按**可数事实**排序，LLM 只负责写出"为什么"的散文：

| 排序依据（全部可数） | 含义 |
|---|---|
| 目标里程碑当前是否**停滞**（N 天无进展） | 停滞的最需要外力 |
| 是否**复用已存在的产物**（零新增成本） | 成本可测 |
| 是否**无反例** | `counterexample` 为空 |
| 关系**历史成本**（executions 真实分钟） | 可测 |

三条高亮 = 按上述事实排序取前三，页面直接显示**这几个事实本身**，
而不是一个"收益指数"。

**合并/删除的纪律**：
- 合并保留双方来源与证据引用（provenance 不丢）
- **不硬删，标 `archived`**（与全局"删除留墓碑"一致）
- 池满 10 条时，淘汰的是**最老且无证据**的，不是"分数最低"的

---

## 16. 停转信号（裁决 §13-10：只提示，不自动跑）

某条主线连续 N 天无里程碑通过 → Today 出现一条**提示**，不自动花钱：

> 科研线 12 天没有里程碑通过。要不要现在找一次突破口？
> 上次通过：X；当前阻塞在：Y（来自最近一次闸门的 `incomplete`）

点了才跑。提示本身由可数事实生成（天数、上次通过时间、最近的 blocker），
不需要模型。

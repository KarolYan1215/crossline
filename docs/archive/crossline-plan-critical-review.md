# Crossline 改进计划批判性评审

> **归档文档**：对最早改进计划的批判性评审。其结论被 v2 设计吸收，现仅作决策背景。 当前文档索引见 [docs/README.md](../README.md)。


## 结论

`composed-floating-fox.md` 找到了当前原型最重要的三个根因：AI 执行链未接通、执行与证据账本未落地、系统以默认值和静态文案伪装真实状态。这三项必须立即采纳。

但该计划不能原样实施。它把“结构合规”扩大成了“AI 成功可被 100% 判定”，把一个不可逆、持续学习的个人系统放进 ABAB 反转实验，又准备在缺少个人校准数据时输出看似精确的精力分数。这三处会重新制造 Crossline 最想消灭的问题：**表面确定，实际不可验证**。

推荐采用“垂直闭环优先”的改写版：

`稳定 sidecar 与授权 → Capture → 一次 automation-stripper 调用 → 结构校验 → 人工批准 → 执行遥测 → 真实证据 → 人工验收 → 显式 blocker`

只有这条闭环在真实任务上跑通后，才接第二个 Skill、精力模型、飞轮发现和优化器。

## 判断标准

本评审区分四种结论：

- **根本问题**：不修复就无法兑现产品核心承诺。
- **必要工程修复**：会造成数据错误、安全或可恢复性问题，但不是产品理念本身。
- **可验证假设**：方向合理，证据不足以直接固化为默认规则。
- **实现偏好**：存在多种同样合理的实现，不应包装成研究结论。

## 计划中应立即采纳的部分

| 计划判断 | 是否根本 | 结论 | 原因 |
|---|---:|---|---|
| AI 层没有生产接线 | 是 | 立即采纳 | 当前 sidecar 只支持登录/账户读取，`thread/start`、`turn/start`、Skill 输入输出和事件消费均无生产调用者。没有这条链，Crossline 不是 AI 工作流系统。 |
| 正则猜身份/时长并静默回落 | 是 | 立即删除 | `apps/web/lib/crossline.ts:206-240` 会产生貌似完整但未经 AI 或用户确认的数据，直接破坏信任边界。 |
| `executions` 与 `evidence_claims` 不写入 | 是 | 立即采纳 | 没有真实执行与证据，时长学习、里程碑验收、周复盘和飞轮关系都没有观测基础。进度监控本身有中等效果，而且物理记录时效果更强，但这只能支持“记录”，不能证明当前 KPI 已达成。[^1] |
| WorkOrder 状态绕过状态机 | 是 | 立即采纳 | 这是账本与状态不一致的直接来源。状态迁移、事件追加和派生写入应处于同一 SQLite transaction。 |
| 删除静态 KPI、连接器假状态和伪分布 | 是 | 立即采纳 | 这是“永不假装成功”的产品底线，不是视觉润色。 |
| 计划差异批量批准，外部副作用逐项批准 | 是 | 采纳 | 高负荷下人会出现自动化自满和自动化偏差；逐条批准所有低风险变化会制造确认疲劳，而外部发送/发布仍需要细粒度确认。[^2] |
| 参考历史执行估时 | 是 | 采纳并收窄 | 规划谬误研究显示，人会忽略过去相似任务；显式联系历史经验可降低乐观偏差。[^3] 大规模日历研究也表明内容、上下文和历史与时长相关。[^4] |
| 删除摄像头精力推断 | 是 | 立即采纳 | MediaPipe Face Landmarker只提供面部地标能力，不是经过验证的“精力”测量。眨眼受视觉任务、认知负荷和眼表状态共同影响；同一信号无法稳定映射为全局精力。[^5] |
| IndexedDB outbox、全站重放、终止性错误不重试 | 必要工程修复 | 采纳 | IndexedDB面向离线结构化数据且异步；Background Sync 兼容性有限，因此仍需前台重放兜底。4xx 输入错误应进入可见 dead-letter/blocker，而不是无限重试。[^6] |

## 必须改写后采纳的部分

### 1. “100% 判定 AI 成功或失败”必须缩小定义

JSON Schema 可以保证已支持 schema 的**结构形状**，不能保证字段里的事实、拆解或估时正确。OpenAI 对 Structured Outputs 的官方限制也明确指出：结构匹配仍不能阻止值本身出错，拒绝或 token 截断也可能中断输出。[^7]

因此工程承诺应改为：

- 已知运行故障、超时、拒绝、结构不合规和权限失败，必须 100% 进入 typed blocker；
- 不允许这些失败产生正式 WorkOrder、计划或证据；
- 结构合规但语义错误属于“未检出的语义失败”，通过证据校验、规则检查和人工抽样估计，不能宣称为 0；
- “静默失败率为 0”只能定义为**系统已经观测到失败却未报告**，不能定义为所有真实错误均被发现。

这一区分是根本性的。否则系统会再次把“可解析”误报成“正确”。LLM-as-a-judge 研究也观察到位置、表面质量等偏差，不能把第二次模型调用视为确定性语义裁判。[^8]

### 2. P0 与 P1 不应串行，应合并为一个垂直切片

原计划先完成协议生成、完整通知归一化和九个 Skill 契约，再处理状态机与证据落点，会得到一个“能调用模型但不能证明任务完成”的半系统。

第一个里程碑只需要：

1. 长生命周期 Codex sidecar；
2. `automation-stripper` 的最小输入/输出 schema；
3. 一个真实 capture；
4. `captured → analyzing → awaiting_plan_approval` 的事务化迁移；
5. 人工批准、一次执行区间和一条证据；
6. 人工接受或显式 blocker。

Anthropic 的生产建议同样强调从最简单的增强 LLM/工作流开始，只在收益明确时增加自治复杂度。[^9] 这支持“少量独立 Skill”，不支持预先搭完整编排框架。

### 3. 协议生成要绑定运行时，而不只是源码 SHA

当前仓库固定了上游源码 commit `5b1d656…`，实际被 Crossline smoke 启动的是 `Codex Desktop/0.133.0`；`0.154.0-alpha.6.2` 仅是历史协议生成时观测到的另一运行时。源码、运行时与生成协议是否对应不能靠文件声明推断。

应记录四件事：运行时版本、上游 commit、生成协议 hash、契约测试结果。`generate-ts`/`generate-json-schema` 应由计划部署的同一个二进制生成。官方 app-server 已提供账户、线程、turn、Skills 与通知协议，所以首版仍不应 fork 内核。[^10]

### 4. “禁止 fallback”改成“禁止无标注的自动替代”

计划中的 A/B/C 分类方向正确，但措辞过硬。用户即使在 Codex 不可用时也必须能保存 capture、补充资料、查看历史和主动选择人工处理。

正确边界是：

- 不允许系统在 AI 失败后自动用正则结果冒充 AI 结果；
- 允许显式、可追溯的人工模式；
- 允许带来源、样本量和置信度的先验，但先验不能直接取得“已分析”状态；
- 降级后的能力损失必须在界面可见。

### 5. 时长先验与个人历史应采用分层回退

`(identityId, taskKind)` 对单用户可能过稀，直接计算 p25/p50/p85 会在小样本下非常不稳定。先采用“身份包先验 → 相近任务族 → 个人同类历史”的分层回退，并显示来源与 n；样本足够后再使用稳健分位数。用户不必在 Capture 填时长，但应能事后纠正任务分类和异常中断。

“删除 0.75×/1.5×”应采纳；“有 7 或 30 条数据就一定可信”不应写死，阈值需要用估时误差和覆盖率校准。

### 6. 精力模块应从“估计精力”降级为“容量证据融合”

睡眠、清醒时长、自评和行为日志可以影响推荐置信度，但不能在未校准时生成医学化或生理精确的统一分数。睡眠的日内个体偏差与次日加工速度有关，支持个人基线；但这不等于能从单晚睡眠准确预测某一具体任务的表现。[^11]

两过程模型是有价值的概念框架，但 Process S/C 的参数来自生理和行为变量，且个体化预测仍需验证。[^12] 首版更诚实的输出是：

```text
level: low | medium | high | uncalibrated
confidence: low | medium | high
observations: sleep / time-awake / self-report / recent execution
blockers: missing / stale / conflicting
```

ActivityWatch 应主要用于识别清醒区间、切换和中断，不应把“屏幕时间”线性解释为疲劳或低生产力。它本身也声明仍在开发中，连接器必须把不可用和 schema 漂移视为正常 blocker。[^13]

### 7. 跨身份“飞轮”应是可证伪关系，不是默认善意

多重角色既可能带来资源增益，也可能造成干扰；研究并不支持“关联越多越好”。[^14] 目标系统研究还显示，一个手段同时服务更多目标时，对每个目标的感知工具性可能被稀释。[^15]

因此关系图应保存：关系类型、证据、反例、成本、最近验证时间和状态。只有已批准且有重复证据的关系才能影响排程。候选关系不进入 Today 的执行卡片，这一界面判断应采纳。

## 不应采纳的部分

### 1. 不采用完整 ABAB 作为系统有效性的主实验

ABAB 反转设计要求干预效果可以撤回；SCED 方法资料明确指出，当行为或干预影响不可逆时，反转设计不适用。[^16] Crossline 会持续积累时长先验、用户习惯、技能使用能力和任务结构知识，即使关闭 AI，系统和使用者也无法回到原始 A 相位。附件已经承认这个问题，却仍把 ABAB 作为主方案，逻辑不一致。

更合适的是：

- 前 7–14 天 shadow baseline，只记录、不改变计划；
- 逐功能阶梯引入：先 AI 拆解，再材料准备，再精力匹配；
- 对可逆的微决策做随机 switchback，例如“显示/不显示下一行动建议”，而不是关闭整个系统；
- 主要看个人趋势与过程控制，不宣称一般因果效应。

相位长度不能先写成“每段 2–3 周”；应由数据频率、自相关和最小有意义效应决定。

### 2. 不采用外部注意力数字作为产品目标

“12.2 working spheres”“23 分 15 秒恢复”等来自特定研究定义和样本，适合提供背景，不适合作为单用户阈值。注意残留研究支持减少未完成任务的切换，并支持 ready-to-resume 计划，但没有证明所有 Crossline 身份切换都应与同一个分钟数比较。[^17]

首版应使用个人基线：未完成切换率、启动延迟、证据产出、计划接受率、手工重排、系统操作耗时和健康红线违反次数。

### 3. 不采用“17% 创造力成本”作为架构常数

检索到的 17% 来自一篇匿名投稿对特定创意任务和格式的结果，不能外推为所有结构化输出的固定损失。更稳健的结论只是：结构约束能提高可解析性，但可能改变语义质量，必须对 Crossline 自己的任务集做 A/B 评估。[^18]

### 4. 不保留所有死代码

“全部保留，按 Gate 接线”不是安全策略。无法解释其近期消费者的代码会增加契约漂移和测试负担。对每个未接线模块应选择：本 Gate 接通、放入明确的 experimental 边界，或删除后依靠版本控制恢复。当前仓库尚无 commit，首要动作不是大删代码，而是先建立可审查基线。

### 5. 不强制每次中断都填写 ready-to-resume

研究支持简短的返回计划可以减轻中断后的注意残留。[^19] 但“每次离开 active 都强制填写”是未经验证的交互假设，也可能增加摩擦。应在不可中断任务、长任务或系统检测到身份切换时提示，并允许 AI 起草、用户一键确认。

## 附件未充分覆盖的根本问题

### OAuth sidecar 生命周期

本次真实授权暴露了新问题：浏览器已经收到回调 code，但旧会话的 `localhost:1455` 监听器不存在，因此页面显示拒绝连接。重新调用 `account/login/start` 后，`127.0.0.1:1455` 恢复监听。

官方 app-server 文档说明，本地回调由 app-server 托管，并通过 `account/login/completed` 与 `account/updated` 通知完成。[^10] 因此 sidecar 不应由易受开发热重载或请求生命周期影响的 Next route 负责长期存活。推荐：

- 将 sidecar 所有权移到 Windows worker 或独立 supervisor；
- Web 只通过本地 IPC/HTTP 读取状态和发起登录；
- 持久化当前 `loginId`、开始时间和状态，但不持久化授权 code；
- 消费 `account/login/completed` / `account/updated`，在 UI 显示真实状态；
- 支持取消与重新发起；若回调模式仍不稳定，提供官方 `chatgptDeviceCode` 作为备选。

这是 P0 之前的 P-1，否则所有真实 AI 闭环都依赖一个不稳定的授权前提。

### 本地数据不是天然可信

SQLite、ActivityWatch 和本地文件仍可能包含敏感标题、窗口名、研究路径和身份关系。最小闭环需要明确数据最小化、字段级保留、导出审计和删除语义；“本地优先”只能降低暴露面，不能替代权限模型。

## 修订后的实施顺序

1. **P-1 Sidecar 生命周期与授权**：worker/supervisor 持有进程；状态通知、重试、取消、device-code 备选；契约绑定运行时版本和 hash。
2. **P0 最小垂直闭环**：automation-stripper + 事务化状态机 + 人工批准 + execution + evidence + acceptance；任何故障显式 blocker。
3. **P1 真实性清零**：删除静态 KPI、假连接器状态、伪分布和假证据；页面只显示真实值、先验标签或未知。
4. **P2 个人估时**：任务族先验、真实执行区间、异常原因、稳健更新；先 shadow，不直接移动计划。
5. **P3 容量证据**：睡眠/清醒时长/自评/ActivityWatch；不使用摄像头，不输出医学或伪精确疲劳分数。
6. **P4 第二个 AI 能力**：材料准备或证据预审二选一，以真实节省时间决定；不按预设顺序接完所有 Skill。
7. **P5 连接器与离线**：Graph 只读 Gate、IndexedDB outbox、冲突中心；验证后才启用唯一 Crossline 写回目标。
8. **P6 长期学习与飞轮**：仅用已批准关系和真实证据产生候选；以阶段引入和微随机实验评估。

## 首版验收口径

首版不要承诺“AI 百分百正确”，而应承诺以下可测试属性：

- 已知运行/权限/结构故障全部可见且不污染正式状态；
- 真实 capture 可以完成一次 AI 拆解、人工批准、执行、证据与验收闭环；
- UI 不显示任何无法追溯到数据库、连接器或明确先验的精确数值；
- AI 关闭时仍可保存和人工处理，但系统明确标注为手动路径；
- 摄像头数据路径被移除；
- 一个真实用户连续使用 14 天后，系统能报告自身成本与收益，而不是先宣称提高效率。

## Sources

[^1]: Harkin et al., “[Does monitoring goal progress promote goal attainment? A meta-analysis of the experimental evidence](https://pubmed.ncbi.nlm.nih.gov/26479070/),” *Psychological Bulletin*, 2016.
[^2]: Parasuraman & Manzey, “[Complacency and Bias in Human Use of Automation: An Attentional Integration](https://doi.org/10.1177/0018720810376055),” *Human Factors*, 2010.
[^3]: Buehler, Griffin & Ross, “[Exploring the planning fallacy](https://doi.org/10.1037/0022-3514.67.3.366),” *Journal of Personality and Social Psychology*, 1994.
[^4]: White & Awadallah, “[Task Duration Estimation](https://doi.org/10.1145/3289600.3290997),” WSDM, 2019.
[^5]: Google, “[MediaPipe Face Landmarker for Web](https://developers.google.com/mediapipe/solutions/vision/face_landmarker/web_js)”; Charles & Nixon, “[A systematic review of physiological measures of mental workload](https://pmc.ncbi.nlm.nih.gov/articles/PMC6696017/),” 2019.
[^6]: MDN, “[Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)” and “[Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).”
[^7]: OpenAI, “[Introducing Structured Outputs in the API](https://openai.com/index/introducing-structured-outputs-in-the-api/),” limitations section.
[^8]: Shi et al., “[Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge](https://arxiv.org/abs/2406.07791),” 2024.
[^9]: Anthropic, “[Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents),” 2024.
[^10]: OpenAI, “[Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),” authentication and thread/turn protocol.
[^11]: “[Daily fluctuations in sleep duration and quality affect next-day processing speed](https://pubmed.ncbi.nlm.nih.gov/41091823/),” 21-day intensive longitudinal study, 2025.
[^12]: Borbély et al., “[The two-process model of sleep regulation: a reappraisal](https://doi.org/10.1111/jsr.12371),” *Journal of Sleep Research*, 2016; Honn et al., “[Assessment of the unified model of performance](https://pubmed.ncbi.nlm.nih.gov/35521938/),” 2022.
[^13]: ActivityWatch, “[Official documentation](https://docs.activitywatch.net/en/latest/).”
[^14]: de Vries et al., “[The Duality of Multiple Roles](https://link.springer.com/article/10.1007/s41542-026-00253-6),” 2026.
[^15]: Zhang, Fishbach & Kruglanski, “[The Dilution Model](https://doi.org/10.1037/0022-3514.92.3.389),” *Journal of Personality and Social Psychology*, 2007.
[^16]: Dallery et al., “[Optimizing behavioral health interventions with single-case designs](https://pmc.ncbi.nlm.nih.gov/articles/PMC4167892/),” 2013; Smith, “[Single-Case Design, Analysis, and Quality Assessment](https://pmc.ncbi.nlm.nih.gov/articles/PMC5492992/),” 2012.
[^17]: Leroy, “[Why is it so hard to do my work?](https://www.sciencedirect.com/science/article/pii/S0749597809000399),” 2009.
[^18]: Schall & de Melo, “[The Hidden Cost of Structure](https://aclanthology.org/2025.ranlp-1.124/),” RANLP 2025. The separate “over 17%” figure appears in an anonymous submission and is not treated here as a stable universal estimate.
[^19]: Leroy & Glomb, “[Tasks Interrupted](https://doi.org/10.1287/orsc.2017.1184),” *Organization Science*, 2018.

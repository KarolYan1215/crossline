# Crossline implementation todo

> **归档文档**：2026-09 的实现清单与缺陷记录。现状以 README.md 的发布闸门与 CLAUDE.md 为准。 当前文档索引见 [docs/README.md](../README.md)。


设计依据：`docs/archive/crossline-redesign-v2.md`（14 条裁决齐备）。
v1 的 `docs/archive/crossline-mvp-implementation-plan.md` 中与 v2 冲突的部分已失效。

## 已完成（v1 期间）

- [x] P-1a 在隔离的 Crossline home 中完成 Codex 认证
- [x] P-1b 让 app-server 所有权持久化，并暴露可验证的状态/登录
- [x] P0b WorkOrder、执行、证据与验收全部事务化
      （已由独立审查 PASS-WITH-GAPS，两条阻塞已修）
- [x] P1a 删除假精度、假状态与摄像头路径
      （UI 字面量、0.75×/1.5× 假区间、`camera_proxy`、`purgeExpiredEnergyObservations`）

## v2 实现顺序

- [x] **R1 删除** —— `packages/workflows`、`optimizeTaskSelection`/HiGHS。删掉的代码不必迁移。
- [x] **R2 数据模型** —— WorkOrder 吸收 Task（含三条领域规则与 `recurrence.minimumMinutes`）；
      `StoredMilestone.successCriteria`；`milestone_relations` 补
      evidence/counterexample/costMinutes/lastValidatedAt/`refuted`；migrate-on-open 迁移。
      `StoredTask`、`contribution`、`switchingCost`、旧完成 API 与假证据快捷入口均已删除；
      旧 `tasks` 表仅在打开旧库时读取，备份并迁移后删除。
- [x] **R3 修两条断链** —— 首页改读 `work_orders`（分析成功的条目不再消失）；
      `preparing` 的真实入口（`materialContract` 非空不再永久卡死）。
- [x] **R4 Skill 交付层** —— 仓库内本地 plugin marketplace，`plugin/install` 到隔离
      CODEX_HOME，`skills/config/write` 按任务开关。三层：通用编排核心 / 身份包 / 用户覆盖层。
      plugin skills 使用运行时命名空间；配置写入串行化并在任务后恢复；真实 app-server
      smoke 已验证 9 个 skills 可发现。运行时已按后续要求改为[自有 fork 构建](codex-fork-runtime.md)，含一处 Windows 状态库迁移兼容补丁。
- [x] **R5 里程碑闸门** —— `crossline-milestone-gate` Skill + 确定性层自洽校验
      （`GATE_VERDICT_INCONSISTENT`）+ 自动验收的四条补偿控制。里程碑绑定条目不能再
      走人工快捷验收；自动验收可撤销，关系反证会回标相关验收供周复盘置顶。
- [x] **R6 材料准备** —— `<projectRoot>/.crossline-materials/<workOrderId>/`；
      唯一持久化入口先验证全部相对路径，拒绝覆盖不同内容；越界、缺失授权根目录与失败
      都是 typed blocker。成功引用落 `materials` 表，失败保持 `preparing`，不阻断人工自备。
- [x] **R7 UI 迁移** —— 参考 `karols-wandering-again.html`：暗色模式双轨、Noto Sans SC、
      28px 网格、`--now` 仅用于此刻、形状编码状态、抽屉式详情；
      B 主视图 / C 审批收口 / A 周日详情；补移动端断点与 `.execution-actions` 样式；
      修 nav 隐藏 Workbench、术语泄漏、tablist ARIA/方向键、假表盘。参考 HTML 不在仓库，
      因此只实现设计文档已明确的可验证 token 与交互，不猜其未记录细节。
- [x] **R8 精力与排程** —— `idleMs`/`fgHandle` 采集（默认关，首次进 Today 询问，同意状态三值
      且随备份导出）；`deriveCapacity` 纯函数给三档 + uncalibrated，带 basis 与 blockers；
      无个人基线（< 14 天）一律 uncalibrated 并说明还缺什么；本机活动只落每日聚合，
      句柄不落库；`CapacityReading` 结构上无法进入排程决策（planner 零引用）。
- [x] **R9 飞轮** —— 夜间调度锚定真实 `resetsAt`、成本闸门、`idleMs` 活跃度把关、
      先占位再花钱、候选池 10 条/高亮 3 条按可数事实排序、停转信号只提示；
      Today 如实显示"昨夜跑没跑及原因"。
- [x] **R9b 扩展接线与周复盘** —— 抽出通用 `runCodexSkill`（analysis 退化为薄包装，
      行为不变），飞轮 Skill 是唯一被授予联网检索的 Skill；每条发现必须带真实来源 URL、
      读取日期与失效条件，且必须挂在已存在的里程碑上，否则拒收；周复盘页逐条列出本周
      全部自动验收并可撤销，空态如实说明而不编造内容。
- [x] **R10 成本信号** —— `CostSignal` 只有"窗口用掉多少/何时重置"，无货币无厂商
      （有测试读源码断言核心不含厂商名与金额）；`packages/codex` 是唯一知道运行时给的是配额的
      适配层；读不到 → `COST_SIGNAL_UNAVAILABLE` 拒绝，绝不退化成 0%；夜间份额是窗口上限
      而非每次新额度；`budgetPolicy` 70/85/100 接上真实周窗百分比，economy 下 capable 降为 routine；
      模型档位由 `CROSSLINE_MODEL_ROUTINE/CAPABLE` 映射，未设置即交给运行时默认。
- [x] **R11 连接器**
      **离线重放**：队列迁到 IndexedDB 并从组件中抽出；终端 4xx 不再被永远重试，
      改为进入可见的死信，保留原文、原因与时间，可复制可丢弃；408/429/5xx/网络失败仍重试；
      一条坏记录不阻塞它后面的。重放策略是纯函数，存储可注入，无需新增依赖即可测试。
      **Entra 只读**：修掉单租户 authority bug（/common 会被 AADSTS50194 拒绝），
      新增 `CROSSLINE_MS_TENANT_ID`。2026-09-15 真实跑通：设备码登录 UW 账号，
      `/me/events` 5 条、`/me/todo/lists` 2 条，HTTP 200，只回条数不回内容。
      这证明"这台机器能读"，**不**证明"Crossline 会读" —— 见下方未修条目。
- [x] **R12 Ops** —— **worker 常驻**：`data/worker.lock` 带心跳的单实例锁（活着的持有者拒绝第二份，
      心跳过期即接管，干净退出即释放；EPERM 视为存活）；启动脚本改为幂等，计划任务加"登录 +
      每 15 分钟"双触发器 —— 启动器 spawn 完就退出，任务级 restart 永远不会触发，所以看门狗
      必须是重复触发器 + 幂等启动器。
      **备份/恢复**：补上 `importSnapshot`，恢复不再只是解压 —— 真的重建一个 SQLite 账本并按
      正常查询路径读回校验。只能建进空工作区，拒绝写实时账本、拒绝覆盖已有文件。
      2026-09-15 真跑过一次完整加密演练：DPAPI 解密 → 解压 → 重建 → 读回，8 events / 6 work
      orders / 4 milestones / 28 行，与实时账本一致。
      **审计导出**：快照本就覆盖 events；新增回归测试对着 `sqlite_master` 断言每张表都在导出里，
      以后加表忘了加导出会在测试里失败，而不是在某次恢复时才发现。
- [x] **Gates** —— §12 九条**全部由真实运行通过**。
      可重跑的证据脚本：`gate-analysis-check.ts`（1–2）、`gate-loop-check.ts`（3–4）、
      `gate-flywheel-check.ts`（5）、`gate-capacity-budget-check.ts`（6–7）；第 8 条由
      `apps/web/lib/generality.test.ts` 换包证明，第 9 条是四条命令本身。

      | # | 口径 | 结果 |
      |---|---|---|
      | 1 | 真实 Codex 分析产出 `awaiting_plan_approval` + 审计 id | **通过** —— thread `01a0a762-09c6…` / turn `01a0a762-206c…` |
      | 2 | 该条目出现在首页 | **通过** —— WorkOrder 落库，identity 由 Skill 选定 |
      | 3 | `materialContract` 非空 → `preparing` → 真实材料引用 | **通过** —— 真实 Skill 写出 `method-summary.md`，落 `materials` 表 |
      | 4 | 执行→暂停→完成→证据→里程碑闸门→自动验收 | **通过** —— 判 `pass` 后无人工确认直接 `accepted` |
      | 5 | 飞轮 Skill 联网产出带来源 URL 的候选关系 | **通过** —— 3 条跨主线候选关系，各带主张、反证条件与来源；批量批准真实落库 |
      | 6 | 精力读数三档或 `uncalibrated`，从不输出连续分数 | **通过** —— 真实账本零观测 → `uncalibrated` + 缺失说明 |
      | 7 | 预算门在 70/85/100% 真实降级 | **通过** —— 70 告警 / 85 economy（capable→routine）/ 100 manual_core_only |
      | 8 | 换掉整个 packs 仍能跑 | **通过** —— 换成教学/木工/乐队后种子、关系、信任检查、Today 全部正常 |
      | 9 | test / typecheck / build / e2e 全绿 | **通过** —— 209 tests / 41 files、8 包、build、e2e 6 passed |

      第 8 条原本不成立，为此修掉两处泛化缺陷（见下）。

## 受 v2 影响而改写的旧条目

| 旧条目 | 去向 |
|---|---|
| P0a 真实 automation-stripper 分析 | 并入 Gates；代码侧已通，卡在配额与 R2 的里程碑指标 |
| P2 从先验与真实执行学时长 | 降级：R2 之后才有干净数据；不再用 0.75×/1.5× |
| P3 诚实容量证据 | → R8 |
| P4 材料准备 + 证据预审 + 预算门 | → R5 / R6 / R10 |
| P5 离线重放与只读连接器 | → R11 |
| P6 证据绑定的里程碑关系 + 周洞察 | → R2 / R9 |
| Ops | → R12 |

## 实现期发现并修掉的缺陷（不在原计划内）

- **首页顺序不确定**：`listWorkOrders` 的 `ORDER BY updated_at, id` 在 `updated_at`
  打平时落到随机 UUID，导致 Today 每次刷新可能换序。种子 id 改为确定性，
  并让 Dashboard 自己排序，不让数据库行序泄漏进页面。
- **事件账本读出顺序不确定**：`ORDER BY created_at, event_id` 让随机 UUID 决定
  同毫秒事件的先后 —— 一个号称 append-only 的审计账本失去了顺序意义。改为 `ORDER BY rowid`。
- **未知精力被默认成 medium**：种子 WorkOrder 没有 `humanCore` 时回退成 "medium"，
  把猜测显示成事实。改为种子写入真实 energy，缺失时显示"未标定"；未标定值也不再
  进入 planner 的低精力推荐条件。
- **原生 plugin skill 有命名空间**：`skills/list` 返回 `crossline:crossline-*`，不是迁移前
  顶层目录的裸名称。安装与按任务调用都以运行时返回的真实名称为准。
- **每日聚合被当成不可变观测写入**：`saveEnergyObservation` 是 `ON CONFLICT DO NOTHING`，
  对自评是正确的幂等，但会让每日滚动聚合的后续更新被静默丢弃。拆成 `upsertDailyActivity`，
  两种语义分开：人说过的话不可改写，派生汇总可滚动更新。
- **e2e 在 R4–R7 期间一直是红的**：三条过期断言（`APPROVED` 文案本地化、`approved` 计数未限定
  作用域、两张 R7 改版后的快照）。分阶段"针对性验证"不含 e2e，而 R7 恰好是改 UI 的那一步。
- **`crossline-evidence-reviewer` 残留**：R5 加了闸门但没删它，marketplace 有 10 个 skill 而
  CLAUDE.md 写 9 个。全仓零引用，已删除。
- **夜间拒绝原因的顺序错误**：成本信号读不到时 `resetsAt` 自然为空，原实现先查窗口，
  于是报"今晚窗口内没有配额刷新"——那是后果不是原因，会把排查引向错误方向。
  改为信号不可读时优先按自身原因拒绝。
- **重构通用 runner 引入三处回归，被现有测试全部抓到**：Skill 调用的 `$` 前缀丢失
  （`String.replace` 会把替换串里的 `$$` 折叠成一个 `$`）、`SKILL_MISSING` 前缀映射
  把 `ANALYSIS_SKILL_MISSING` 变成 `ANALYSIS_MISSING`、调用方校验器抛出的领域码
  （如 `ANALYSIS_SCHEMA_INVALID`）被折叠成 `RUNTIME_FAILED` 从而掩盖了是哪道信任检查拒绝的。
- **周复盘页的测试用手写 stub 而非真实 store**，只实现了 `listWorkOrders`，页面一读别的就崩。
  改用内存 `CrosslineStore`，接口漂移不会再静默通过。
- **离线队列终端失败被永远重试**：`if (!ok) remaining.push(command)` 让一个 400
  在每次联网和每次页面加载时重发，永不停止且用户看不见。改为 `classifyReplay` 判定，
  终端 4xx 进死信并在离线页显示原文与原因。
- **Graph authority 默认 /common**：对单租户注册（"仅我的组织"）会被 AADSTS50194 拒绝 ——
  也就是工作/学校账号这个连接器唯一要服务的场景。改为按租户 ID 选端点。
- **备份从来没人还原过**：`backup-crossline.ps1` 加密、校验 SHA-256 都做了，但恢复脚本只解密解压，
  `ImportedIntoDatabase = $false`。能解压不等于能还原成可用账本 —— 没人成功还原过的备份是文件，
  不是备份。补 `importSnapshot` 并把恢复做成真的重建 + 读回校验。
- **e2e 与 Codex supervisor 抢同一个端口 3211**：worker 一旦按 R12 常驻，`pnpm test:e2e` 要么起不来，
  要么更糟 —— web 侧调 supervisor 时调到 e2e 自己的服务器上。e2e 挪到 3310。
- **导出行序不确定**：`SELECT * FROM x WHERE workspace_id = ?` 没有 ORDER BY，同一个未改动的库
  两次导出可能不相等。与之前修 `listEvents` 的是同一类缺陷，改为 `ORDER BY rowid`。
- **关系是一支没有主张的箭头**（补 Gate 5 后半段时暴露）：`milestone_relations` 只存两个端点和
  kind，没有"它声称什么"，也没有"什么能证伪它"。这样的候选关系根本没法审 —— 批准它等于盖章。
  补 `explanation` / `refuted_when` 两列（旧行留 NULL 而不是编一个理由），飞轮提议必须两者齐备
  才收，周复盘逐条把主张、反证条件和来源摊开显示。
- **我代批的里程碑标准 12 条全是产出物**（本轮自查发现）：上一轮 architect 给出的
  "保存一份清单""至少记录 3 个动作""存在一份验证记录"——全部是"写完文档就算达成"。
  闸门只看证据，产出物又最容易举证，于是里程碑可以在一步没动的情况下判过。这正是
  Goodhart 定律。补 `evidenceOf` 标注 + Skill 契约写明"至少一条必须是结果"，
  界面对"全是产出物"的里程碑显式标红。改写后新提议是 outcome=2/3，旧的 4 条仍是 0/3。
- **计划冲突是个死局**：`approvePlanVersion` 见到 pending 的 `conflict` 就拒绝，而全仓没有
  任何地方能把它移出 `pending`。也就是说一旦产生冲突，那份计划将**永远无法批准**。
  在写入第一条日历冲突之前就必须补上解决入口，否则是我亲手造一个死锁。
- **写连接器做不了只读同步**：`MicrosoftGraphConnector` 被硬锁在名为 `Crossline` 的目标上
  （那是 Gate 3 的写沙盒），而 Gate 2 要读的是 UW 账号自己的日历。没有放松这个锁——
  它是安全边界；改为新增一个**根本没有写方法**的 `GraphReadSource`，安全性从条件判断变成结构性质。
- **增量 delta 被当成完整集合，第二次 tick 就清空计划**（本轮最严重）：带游标的 delta 只返回
  **变化**，没提到的条目意思是"没变"而不是"没了"。原实现每一页都当成权威全集，于是第二次同步
  把三个真实块全部报成删除并从计划里抹掉 —— 同步每天都会摧毁自己前一天的成果。
  改为只有**首次读取**（无游标）和**服务端强制 resync** 两种情况才是全集，其余按增量合并。
  三次连续真实 tick 验证：第 2、3 次完全安静。
- **窗口滚动被报成"日历中已不存在"**：昨天的块每天都会滚出窗口，于是每天早上都产生一条误报；
  每周的例会更是每周"被删除"一次。窗口移动不是变化，早于今天的缺席不再报告。
- **change id 被截断，截掉了 kind 后缀**：Graph 的事件 id 约 150 字符且同一邮箱内共享大段前缀，
  `.slice(0, 200)` 把 `:add`/`:move` 削掉，于是 move 会 upsert 到之前的 add 行上，
  C 视图显示"新增"而文案是"变为"。前缀再长一点就会让两个不同事件塌成同一行。改为哈希 id。
- **重复日程导入后全部无标题**（真跑 UW 日历才暴露）：`calendarView/delta` 把重复事件的单次实例
  作为**部分对象**返回——只有 id / seriesMasterId / type / start / end，标题在主事件上。
  首次真跑 21 条里 12 条无标题；对一个以重复课程为主的大学日历，等于大半个日历导进来是空白块。
  改为按 series 解析标题并缓存，每个系列只查一次。
- **连接页对唯一连上的连接器说"未配置"**：整页是硬编码的静态列表，对实际发生的事一无所知。
  改为从账本读同步游标与导入块数 —— 声明状态和观测状态是两种不同的断言，只有后者有用。
- **绿色被用在了非"此刻"的地方**：`.now-state strong` 把"精力未标定"渲染成绿色，
  而整套设计里绿色是保留给此刻的唯一实时信号。一旦到处都绿，它就不再意味着任何东西。
- **`.lane-track` 一名两用**：我把它当成 9×9 状态小方块写了样式，而它实际是计划块的容器，
  结果计划页的标题被压成一列竖排。
- **星图在暗色模式下是白色方块**：节点与连线颜色写死在组件里，不跟随主题。
- **worker 不读 .env.local，日历同步永远打不开**：我把整套同步建好了，而 worker 的 cwd 是自己的
  包目录、全仓又只有 graph-readonly-check 自己调了 loadEnvFile —— client id 永远不存在，
  同步静默地从不启动，而且**一行日志都没有**，分不清"没配"和"坏了"。补上 env 加载与
  `graph.not_configured` 日志。这和之前"没人读 .env.local"是同一个错，我犯了第二次。
- **登录从来没有被持久化**：`msal-cache.lock` 是 0 字节。脚本结尾用 `process.exit()`，
  会杀掉尚未落盘的异步写 —— 于是每次都要重新扫码，后台 worker 也永远无法无人值守同步。
  改用 `process.exitCode`，并让脚本自己检查缓存是否真的写下来了。
- **"未标注"被当成"全是产出物"**（浏览器里一眼看出来的）：标签正确显示「未标注」，
  下面的警告却断言「全部是产出物」。未标注 ≠ 产出物 —— 系统在断言它并不知道的事。
- **星图吞掉滚轮**：React Flow 默认滚轮缩放，而里程碑管理区在星图下方，用户根本滚不下去。
- **计划块声称了从未发生的导入**：视图渲染「UW Outlook · 只读」「Codex · 草案」，
  而同一页顶部写着"当前没有任何连接器被授权"。`SEED_SOURCE = "示例数据"` 的修复只对新库生效，
  已有行从来没被修过。差异说明同样陈旧（"输入将在 08:50 前由 AI 准备完成"）。
  两者都补了幂等修复，且只修已知的种子 id —— 真实导入的块绝不能被改标成示例。
- **两条不同的捕获显示成同一条**：`id.slice(0, 8)` 对时间戳前缀的 id 无效，
  `p0a-1789447376966` 和 `p0a-1789447609591` 都被截成 `p0a-1789`。改取尾部八位。
- **飞轮 Skill 从来没能启动过**（Gate 5 暴露，本轮最严重的一条）：`web_search` 被写成
  `"enabled"`，而这个运行时的取值是 `disabled | cached | live`，于是 `thread/start` 整个被拒。
  飞轮是唯一被授予联网的 Skill，也就是说它唯一的区别性能力从实现那天起就是死的，而 R9/R9b
  已经把它标成完成 —— 因为没有任何一次真实运行去碰它。改为 `"live"` 后一次跑出 6 条带来源的发现。
- **配置被拒的报错被吞掉两层**：`thread/start` 的 drop-and-retry 只认"unknown configuration
  field"，值不合法时把原始错误原样抛出，再被 runner 折叠成 `SKILL_RUNTIME_FAILED`。
  一个一个词的配置错误因此表现为"运行未完成"，不插桩根本查不出来。改为
  `SKILL_CONFIG_REJECTED` 并带上运行时原话（那是配置诊断，不是模型输出）。
- **turn 失败被报成 `SKILL_REFUSED`**：运行时拒收请求不是"模型拒答"。这个词把读者指向完全错误
  的方向。拆成 `SKILL_TURN_FAILED` 并带上 `turn.error.message`。
- **模型把 JSON 包在 ```json 围栏里**，`JSON.parse` 直接失败。这是所有 Skill 的共性问题，
  且是传输习惯而非编造内容，所以在解析前剥掉围栏，之后每一道信任检查照常跑。
- **材料路径重复嵌套**：SKILL.md 写"写在 `<projectRoot>/.crossline-materials/<id>/` 之下"，
  模型据此把前缀也放进 `relativePath`，持久化层又以该目录为根解析，文件落到深一层。
  没越界所以什么都没报错，只是位置错了。契约改为"相对于作业自己的材料目录"，
  并让重复前缀显式失败（`MATERIAL_PATH_REPEATS_ROOT`）而不是静默错放。
- **结构化输出是严格模式**：每个 object 必须有 `additionalProperties: false` 且所有属性都在
  `required` 里。一个带可选字段的 object 表达不了四选一的 `measure`，改成真正的 `anyOf` 联合。
- **种子把身份 id 写死，换 packs 后系统直接瘫痪**（Gate 8 暴露）：`starterMilestones` /
  `starterWorkOrders` / 关系种子全是固定的 research/startup/media/investment，换一套 packs 后
  种子会造出没有对应 pack 的里程碑，`validateAnalysisContext` 于是以
  `ANALYSIS_CONTEXT_INVALID` 拒绝**每一次**分析 —— 一个号称通用的系统只能跑作者这四条主线。
  改为种子跟随 packs，例文按 id 查表、查不到就用 pack 自己的 label 生成，端点缺失的关系跳过。
- **主时钟与容量包也是写死的**：`PRIMARY_CLOCK_ID` 默认 `"research"`，Today 用
  `identityId !== "health"` 排除容量包。改为读 pack 自己声明的 `masterClock` 与 `kind`。
- **Skill 说明了拒绝原因，我们把它丢了**：真实运行里 Skill 因"捕获引用了 OneNote 但它不在可用
  输入里"而正当停下，用户只看到"运行未完成；请检查阻塞原因。"。校验器改为把 Skill 的原话作为
  `detail` 带出，作为文本展示而非参与任何判定。
- **Skill 契约没说"逐字"**：SKILL.md 只写 "cite the input fragment"，而确定性校验要求 quote 是
  捕获原文的精确子串。第一次真实运行就因此被 `ANALYSIS_EVIDENCE_INVALID` 拒绝。
  按第一性原则修的是契约（写明 verbatim、禁止改写/翻译/摘要），不是放松校验。
- **`pnpm export -- <path>` 跨 shell 行为不一致**：PowerShell 吞掉 `--`，POSIX shell 透传，
  于是同一条文档命令在 bash 下会把快照写进一个名叫 `--` 的文件。两个入口都过滤掉字面量 `--`。

## R13 里程碑设置与日历接入

- [x] **里程碑增改查** —— 星图页下方补齐管理区：新建、修改、批准草稿、归档。
      修改写入新版本（主键是 `(id, version)`，`listMilestones` 只取 MAX(version)），
      闸门判过的那一版永远可追溯。
- [x] **architect 提议 runner** —— supervisor 新增 `/v1/milestones/propose`，
      提议一律落成 `draft`：分析只认 approved、闸门只判 approved，所以草稿天然惰性。
      批准是用户动作 —— 系统不能替人选择他在朝什么努力。
- [x] **「怎么设里程碑」写进 Skill** —— 重写 `crossline-milestone-architect`，
      三种模式（提议里程碑 / 补标准 / 关系归 scout），并把方法论写进契约：
      方向与度量分离、产出 vs 结果、宁可写反证条件也不编造阈值、
      指标一旦成为目标就会被优化（先问"只优化这条会怎么做"）、周级而非日级或季级视野。
- [x] **`SuccessCriterion.evidenceOf`** —— 每条标准标注衡量的是产出物还是真实结果。
      判断归 LLM（确定性层无法区分），确定性层只要求标注齐备，界面把"全是产出物"当警告显示，
      但**不阻止保存** —— 标准归用户所有。
- [x] **Graph 只读同步** —— `GraphReadSource`（新类，非改造写连接器）+ worker 每 tick 同步，
      游标存 `external_bindings`；410 → 全量重来并按"这就是全集"删掉本地多余项；
      `@removed` 墓碑先于新增生效；跨天/无时间的条目计入 skipped 而不是静默丢弃。
- [x] **现实变化 → 计划冲突** —— 草稿计划就地更新；**已批准的计划永不被改写**，
      现实挪动会开一个新草稿版本、差异全部记为 `conflict`，由 C 视图逐条处理。
- [x] **冲突可解决** —— 补上 `resolvePlanChange` 与 C 视图的采纳/排除按钮。

## R14 UI 迁移与真实日历接入

- [x] **UI 迁移到参考稿风格** —— 参考 HTML 这次真的拿到了（之前不在仓库，只能按设计文档实现一半）。
      重写 `globals.css`：参考的完整色板（paper/ink/graphite/shade/mist/chalk/block/now/now-ink）、
      真正的暗色第二套配色（系统偏好 + data-theme 覆盖）、28px 发丝网格、零圆角零阴影、
      1px mist 分隔的单元格而不是卡片、mono 大写微标签、Archivo Black 只用于展示数字与章节标题。
      保留了应用现有的全部 class 名，所以这是一次样式表迁移而不是组件重写。
- [x] **Graph 只读同步真实跑通** —— 持久化令牌、游标、重复事件标题解析、现实块进入计划。
- [x] **连接页改为报告观测状态** —— 之前对唯一连上的那个连接器说"未配置凭据，未执行探测"。

## R15 周视图数据模型与同步语义

- [x] **计划携带一周现实** —— `PersistedScheduleBlock` / `RealityBlock` 加 `day`。
      导入块必有日期；示例块**故意不带**日期，跟随正在查看的那天，否则明天就成了过去还假装是真实承诺。
      同步窗口从"只今天"扩到 7 天（`CROSSLINE_PLAN_WINDOW_DAYS`），B 仍是当天条带，A 是整周。
- [x] **A 视图样式迁移** —— FullCalendar 的圆角蓝主题映射到同一套 ink-on-paper，
      真实块实心、示例块虚线，与 B 视图同一套区分。
- [x] **里程碑标准归属** —— 默认 `acceptedBy` 改为 `local-owner`；已有四条追加
      `milestone.criteria_adopted` 事件记录归属转移（账本 append-only，原提议事件保留可读）。

## 身份与私有部署（阶段二–七，独立于 v2 设计文档，依据本地实施计划）

- [x] **真实登录、workspace 隔离、离线多设备、Tailscale 私网访问** —— Better Auth
      （邮箱密码 + Google，`session.cookieCache` 关闭使撤销立即生效）；`requireAccessContext`
      补上此前完全不存在的 workspace 归属校验（`isolation.test.ts` 文档注释点名的那个缺口）；
      `apps/web`/`apps/worker` 全量消除 `local-owner`/`personal-crossline` 硬编码
      （`no-hardcoded-identity.test.ts` discovery 测试兜底）；web→worker 之间补 HMAC capability
      token（此前任何本机进程都能直接打 3211 端口）；离线队列改造成真实 Dexie，
      按 workspace 分库加密，冲突（`PROPOSAL_VERSION_CHANGED`）与永久拒绝分开展示；
      `CROSSLINE_DEPLOYMENT_MODE` 三态化，`private` 模式经 `tailscale serve` 反代到 tailnet
      并打开安全响应头。证据：`scripts/gate-identity-check.ts`（两账号互相看不到对方数据、
      撤销 session 立即失效、无入站防火墙规则、含 `auth.db` 的备份恢复回路，全部真实跑通）、
      `docs/user-guide.md`、`docs/private-network-deployment.md`、`CLAUDE.md` "Identity, sessions,
      and private deployment" 一节。顺带修了两个真实缺陷：`listPlanChanges` 此前不按 workspace
      过滤（真实跨租户读取漏洞）、`apps/worker/src/export.ts` 默认 workspace id 硬编码成阶段三后
      已不存在的字符串；以及补上一个此前完全没有前端入口的功能：`revokeDeviceLease` 早就存在
      于存储层且有测试，但没有路由和界面能调用到它。

## 已知未修（明确记账，不算在任何 [x] 里）

- **Graph 连接器生产零调用**：设备码、DPAPI 缓存、只读 scope 都写好了，也用
  `scripts/graph-readonly-check.ts` 真跑通了，但产品代码里没有任何地方调用
  `MicrosoftGraphConnector`。缺的是增量同步、落库、与本地计划的冲突处理 —— 那是
  Gate 2 的后半截，不是 R11 的范围。不要因为脚本能跑就当连接器已接入。
- **里程碑指标目前是机器代批的**：四条种子里程碑各有 3 条可测量标准，但账本里记的是
  `acceptedBy: "assistant_on_behalf_test_phase"`，不是你的判断。设计说指标归你所有 ——
  在「主线」页的里程碑编辑处可以看到当前标准，
  逐条改数值或 judgement 描述才算真正落到你名下。

# Harness 收敛（2026-11-25）

本人要求（2026-11-25）：语义判断尽量交给模型，确定性代码只守能力边界和核验；停止「一事一规则」的堆积；默认模型按性价比定，对话框里能直接换模型；隐私资料卡只放填表和登录用的个人信息与网站密码，**不接任何付款**；只读侦察放云端，代填留本机。

## 0. 前提核对（批判）

- 2026-11-24 的盘点读的是本地旧 `main`（c2ba69e）。`origin/main` 在 11-22 已经把 `owner`、`category`、`graded`、`request` 改成模型字段（`work-owner.ts`、`agent-dispatch.ts`、`info-request.ts` 的词表已删）。剩下的语义正则只有：
  - 「对外动作」两份词表：`work-owner.ts` 的 `ACTS`（带 `ACT_NOUNS`/`DRAFTING`/`PURPOSE` 三个补丁正则）和 `external-action.ts` 的 `EXTERNAL_ACTION_PATTERN`，外加 `workflows.ts` 里再补的一段；
  - `isPreparationOnlyCriterion/Milestone` 的 `READINESS`/`PERSON_RESULT`；
  - `interview-rules.ts` 审计里仍 active 的 IR-022（delete）、IR-025、IR-028（model）。
- 安全闸门本来大多就是按能力判的：表单按 host 与动作（`judgeAction`）、日历按 `connectorWritePolicy`、tools 模式根本没有对外写的函数。**唯一 fail-open 的是机主本机的 shell 助手**：`decideCommand` 默认 allow，`danger-full-access`，自己承认「tripwire, not a sandbox」。所以「对外动作」词表今天在 shell 路径上其实是在兜安全，不能先删词表、后补边界。顺序必须是：先把 shell 的出口收紧（§3），再把词表降级为分歧探测（§1）。
- 「只读侦察放云端、代填留本机」已经是现有架构：设备模式 + 算力节点（docs/device-mode.md、docs/compute-node.md）。托管 worker 对配对了节点的账号跑发现（`opportunityAgentOn = 机主 || nodeComputeOn`），报名表只在节点的浏览器里开。缺的不是代码，是本人的本机还以完整模式运行。见 §6。

## 1. 语义正则收敛

- 写工作的 Skill（倒推、步骤规划、收集分析）在每一项上多给一个必填布尔 `external`：这件事是否离开本机或替本人对人做出承诺。owner 仍由模型给。
- `workOwner`：`external === true` → 本人；字段缺失（旧数据）才回到词表。词表只剩**一份**（`external-action.ts`，合并 `ACTS` 与 `EXTERNAL_ACTION_PATTERN`），用途改为分歧探测：模型说不对外、词表说对外时**照模型**，记一行到 `owner-disputes` 遥测（JSONL，不进账本、不新增事件类型），作为回放夹具的来源。能这样放手的前提是 §3：助手即使拿到一件对外的事，也没有对外的能力。
- `agent-dispatch.ts` 的 `delegateWhole`、`workflows.ts`、`goal-backplanner.ts` 的 `high_risk` 读同一个 `external`，不再各自匹配文字。
- `isPreparationOnly*`：只服务 11-22 以前的里程碑（architect 已经不再写纯准备的里程碑）。保留为旧数据读法，注明退场条件。
- 审计收尾：IR-022 删除；IR-025、IR-028 交模型（Skill 规则 + 校验只查结构）；把 `status` 改成 retired。

**已做（2026-11-25）**
- [x] `EXTERNAL_FIELD`（`external-action.ts`）进 `BACKPLAN_SCHEMA` 条目、`stepPlanSchema` 步骤、`ANALYSIS_OUTPUT_SCHEMA`（收集分析没有逐部分的 owner，`external` 放在整件上）；三个 Skill 各加一句；存为 `payload.external`（倒推、分析）或步骤上的 `external`。旧回答缺字段照常通过。
- [x] 词表合并为一份 `EXTERNAL_ACTION_PATTERN`（并集，保留 `ACT_NOUNS`/`DRAFTING`/`PURPOSE` 的清洗），删掉 `work-owner.ts` 的 `ACTS`/`isExternalAct` 和 `workflows.ts` 补的上传/付款。`readExternal(model, …texts)` 返回 `{external, by, disputed}`。
- [x] `workOwner`（含 `payload.external`）、`delegateWhole`、倒推 `high_risk` 先读模型；`WorkOwnerVerdict.disputed`。分歧由 worker 写 `<CROSSLINE_DATA_DIR>/telemetry/owner-disputes.jsonl`（`owner-disputes.ts`；没有数据目录时打一行 JSON 到 stdout），倒推、拆步骤、收集分析三处调用。
- [x] **偏离**：`workflows.ts` 的 `validateWorkflowManifest` 仍让词表覆盖清单的 `external`——清单由将要执行它的助手自己写（自己给自己定权限），而且真实清单把「只读采集」也标成 external；等 §3 的 shell 出口收紧后再改成照模型。
- [x] `isPreparationOnly*` 加注释写明退场条件（没有早于 11-22 的未完成已批准里程碑时删）。
- [x] IR-022 退役（`unsureAnswer` 删除；`checklistAnswered` 改看整理是否已读过那条回答，IR-186）；IR-025 退役（`attributeProblem` 缩成只查形状的 `attributeShapeProblem`，IR-188；措辞规则写进整理 Skill，IR-187）；IR-028 退役（按课号/「项目作业考试」名字判断课程删掉，只对记了 `grading` 的项目出上课时间题；要不要问写进访谈 Skill，IR-189）。

## 2. 闸门 fail-closed（按能力 / host / 金额）

- 不新建统一闸门模块：各路径已有各自的能力闸门，再包一层只是改名。改的是**默认值**：
  - [x] shell 命令（已做 2026-11-25：`createAgentAnswerer` 抛错 → `guard.error`、超过 2 秒 → `guard.timeout`，都按拒绝）：`decideCommand` 在「无出口」运行里，任何联网命令 deny（见 §3）；闸门本身出错或超时一律 deny。
  - 表单：未知页面类型、未知动作、读不到价格 → 停下交本人（已是）；金额 > 0 → 永远停在付款页之前（已是，`pageStop`/`autoSubmitProblems`），本次加测试钉住。**已做**：卡号字段在问模型之前就停（`payment`），只写价格的页面停在提交前（「页面出现价格或付款字段」）；提交前总核抛错或超时算没跑（停在提交前），填表模型抛错算没答（`engine_failed`）。测试在 `form-engine.test.ts`。
  - 金额：本系统**没有**付款路径，`requiredApproval` 对任何付款动作返回 `never`（已有 `broker_order`），不新增。

## 3. 出口白名单与 Rule of Two

- **浏览器（报名表）**：已有导航白名单（`registrationHost` + 别名）、关弹窗、禁下载、拒私网地址。加一条：填写期间，对白名单以外站点的非 GET 请求一律 abort（Playwright `context.route`）。这挡住第三方埋点把刚填进去的个人信息发走；交给本人接管时解除。每次拦截写进现有的 `opportunity.form.blocked`。**已做**：`driveFormContext` 的 `egress`（同一 host 只记一次，`why: "egress"`），节点也有（`FORM_METHODS` 加了 `egress`）；引擎开跑时开、停下交本人或停在提交前时关。WebSocket 不经 `context.route`，没有拦；GET 带查询串的外发也不拦（设计如此）。
- [x] **shell 助手**（只机主本机）按运行的输入分档，三项（私人数据、不可信内容、对外通信）同一次运行最多占两项（已做 2026-11-25：`classifyAgentRun` + `decideCommand` 的 `egress`，见 docs/claude/personal-agent.md；本机运行时的 Windows 沙箱 unelevated 档只靠代理变量拦网、elevated 档要本人做一次管理员设置，所以两档都是「只有 guard」，审计写 `isolation: "guard-only"`；2026-11-25 第二轮起 Windows 上改由 MXC 执行，见 §9.1–2）：
  - 输入含不可信内容（网页、邮件正文、下载文件）的运行：Codex Windows 沙箱 `workspace-write`、`network_access=false`、`web_search` 关；产出留在任务目录，等本人看过才外用。
  - 需要联网调研的运行：`web_search` 用 cached，联网命令只放行包管理器（pip/npm/pnpm/git fetch/clone），其余联网命令 deny。
  - Windows 沙箱不可用时退回 guard：上面两档的联网命令全部 deny，并在审计里写明「无沙箱，只有 guard」。

## 4. 账本治理：停止一事一规则

- 新增 `pnpm review:ledger`：从代码静态找出「只写不读」的事件类型和设置键，从本机账本统计近 30/90 天每种事件的写入量，列出候选。每月跑一次，删掉零读取的，删前看一遍。
- 规则写进 CLAUDE.md：**新事件类型、AskKind、设置键、环境变量，必须写明谁读它、归在哪个家；能做成已有事件上的一个字段就不新开类型。** 走查修复先问「能不能给模型更好的上下文」，再问「要不要加规则」。
- ✅ 2026-11-25 首次运行（代码静态）：写入的事件类型 237 种，其中 64 种代码里没有读者；设置键 194 个，2 个只写不读（`apply.logins` 当时正在开发，`onboarding.extract.inject`）。逐条看过后结论：**只写不读不等于没用**——`site.read`（用本人登录读网站的访问记录）、`work_order.drill_swept`（带改前快照）、`estimate.adjusted`（本人的改动）、各类 `*.removed/restored` 是审计，导出和周复盘按类型整读；`work_order.family_backfilled`、`opportunity.watches.migrated`、`lessons.imported_from_codex_memory` 靠事件的幂等键保证只跑一次，删了会重跑。真正的纯遥测只删了两种：`energy.advice.computed`、`sources.versions_found`（状态本来就在设置里）。其余候选留给每月评审逐条判断，不批量删。
- 批判：堆积的大头不是事件类型（审计本该细），而是**每种事件背后那条只为一次走查写的分支**。治理靠 CLAUDE.md 的新规则卡住入口，比事后删更有效。

## 5. 隐私资料卡：个人信息 + 网站密码（不付款） ✅ 已实现 2026-11-25

- **边界变更（本人 2026-11-25 决定）**：此前「系统不碰密码」。现在本人可以在 设置 → 报名资料卡 里存网站登录（host、用户名、密码）。
- 存放：只在本机 worker 的 DPAPI 密钥库（`login-<host>`），账本只记「这个 host 有一条登录」；不进账本、导出、备份，不同步到托管服务器，不进模型、日志、截图、事件。
- 使用：只在报名表引擎遇到登录页、页面 host 与条目 host 完全一致（或已知别名）、https、顶层页面（不填进别的源的 iframe）时，由引擎自己填用户名和密码并按登录。模型只知道「这个站有可用登录」。验证码、二次验证、一次性码仍交本人。
- 付款：不做。表单遇到付款页照旧停下交本人。
- 落地：`packages/core/src/login-vault.ts`（`loginFor`、`SECOND_FACTOR`、`redactLogin`），worker `form-profile.ts`（`saveLogin`/`removeLogin`/`savedLogins`），`/v1/apply-logins`（只在有屏幕的机主本机，否则 `LOGIN_VAULT_LOCAL_ONLY`），网页 `POST /api/apply-logins`、`DELETE /api/apply-logins/<host>`，报名资料卡「网站登录」。引擎（`tryLogin`）只在本机窗口用；节点的方法表里没有 `login`。记录见 docs/claude/registration-forms.md。

## 6. 24/7

- 本机改用设备模式 + 算力节点：托管 worker 24 小时跑发现、早报、倒推；本机节点在线时取走报名表任务在本机浏览器里填，离线时排队。资料卡与登录库都在节点本机。
- 不新写代码；本次只核对节点模式下资料卡敏感项和登录库确实留在节点。
- 核对结果（2026-11-25）：**登录库**确实不出本机——托管 worker 一律拒存（`LOGIN_VAULT_LOCAL_ONLY`），节点协议也不带 `login`。**敏感项不是**：节点账号的 `/v1/apply-profile` 由托管 worker 处理，敏感项存进服务器的密钥库（`CROSSLINE_SECRET_KEY` 的 AES 文件），填写时由服务器上的引擎读出，作为 `fill` 的参数经节点连接发到节点浏览器。要做到「敏感项在节点」，需要节点自己的密钥库和在节点上代入占位符，这是新代码——已于同日按 §9.3 做（节点的 `NodeVault` 与占位符代入）。

## 7. 助手写脚本交付（把编排交给模型写的代码）

- [x] （已做 2026-11-25：`apps/worker/src/reproduce.ts`，只在机主 shell 运行上；无网是 guard 级别——静态查脚本 + 代理指向死端口，不是沙箱。）助手已经能在 shell 里写脚本、画图（`data_code_sim`）。缺的是**可复现交付**：交付物是 HTML、图表或数据时，助手必须同时留下 `run.*` 脚本；worker 在无网沙箱里重跑一次，产物哈希一致才算交付，不一致就退回。核验的是重跑结果，不是助手的自述。

## 8. 模型

- 见 §8 调研结论（模型性价比）与对话框切换：在主对话框（`chat/composer.tsx`）放紧凑的模型选择，作用于新槽位「对话」（`crossline-concierge`）与「助手任务」（`crossline-agent`、`crossline-agent-tools`）。
- 模型档位（2026-11-25 已做）：top `gpt-6.2-sol` medium、mid `gpt-6.1-terra` medium、low `gpt-6-luna` high。本人 2026-11-25：**手动升级也用最新的 sol**（选同一模型、调高思考强度），不默认用 astra；astra 只在本人自己在选择器里选它时用，代码里没有任何指向它的路由。

## 9. 本人决定（2026-11-25，第二轮，待做）

1. ✅（已做 2026-11-25：Windows 上运行时以 `-c features.prefer_mxc=true` 启动（`appServerLaunchFlags`），因为 `windowsSandbox/readiness` 只反映进程启动时的选择；shell 运行前读 readiness 和 `config/read` 的 `windows.sandbox`（`readWindowsSandbox`、`shellSandboxFrom`、`decideShellIsolation`）。有 MXC：线程用命名权限档 `crossline-shell`（`:root` 只读、任务目录与 worktree 可写、`~\.ssh` 等密钥和浏览器资料夹 deny——有 deny 才挡住 Codex 对已批准命令的「去掉沙箱重跑」、TEMP 与 pip/npm 缓存指到任务目录 `.tmp`），不再 `danger-full-access`；起线程后核对 `activePermissionProfile` 与网络开关，不符就不跑。没有 MXC：配置为 elevated 且 ready 就用它；否则读不可信内容的运行拒跑（`AGENT_SANDBOX_UNAVAILABLE`，自动化会把原因告诉本人），调研运行照跑但 shell 一律不联网（`egress: "none"`，这样它既不联网也不碰不可信内容）。审计与 `agent.task.requested/completed` 的 `isolation` 记 `mxc | elevated | guard-only`；`reproduce.ts` 的重跑在同一沙箱里经 `codex sandbox -P crossline-reproduce` 进行（只拷贝可写、同样 deny、无网络）。护栏拒绝一切带 `networkApprovalContext` 的批准请求。非 Windows 主机照旧只有 guard。实测：本机 `codex sandbox` 跑同一档（写家目录、读 `.ssh` 被拒，外网解析失败），重跑脚本经真 MXC 复现通过；app-server 不带启动参数时 readiness 为 `notConfigured`、带了为 `ready`，`--strict-config` 接受这套线程配置。没有实测：经 app-server 的一整轮真实模型运行在 MXC 里执行命令；elevated 档。）**沙箱用 MXC，不装 elevated。** Codex 0.163 自带 MXC（`mxc-sandbox`，Microsoft `BaseContainerRunner`）：不要管理员、不建沙箱用户、不改 ACL，原生拒绝直连外网，只放行回环上的管控代理。2026-11-25 在本人电脑实测（`codex sandbox -c features.prefer_mxc=true`）：`curl https://example.com` 得 `Could not resolve host`，写 `%USERPROFILE%` 得 `PermissionDenied`；`codex doctor` 报 `sandbox backend mxc`。shell 助手默认走 MXC（`features.prefer_mxc=true`），审计从 `isolation: "guard-only"` 改记实际后端。某台电脑 MXC 不可用（`windowsSandbox/readiness` 非 ready）时：旧 elevated 已装好就用它；否则要联网或碰不可信内容的运行**拒跑并提示**，不联网、只读本人资料的照常。
2. ✅（已做 2026-11-25：`egress: "packages"` 的线程在 `crossline-shell` 档里 `network = { enabled = true, domains = { 三个域名 = "allow" } }` 并开 `features.network_proxy`（`windowsShellConfig`、`PACKAGE_DOMAINS`）；`none` 则 `network.enabled = false`、不开代理。实测本机 `codex sandbox` 同一配置：`pypi.org` 200，`example.com` 经代理 403。git clone 等其他外连因此也走不通，调研运行的说明已改。）**装包只放行包仓库域名**：`egress: "packages"` 的运行经 Codex 管控代理，只允许 `pypi.org`、`files.pythonhosted.org`、`registry.npmjs.org`，其余外网由 MXC 挡住。
3. ✅（已做 2026-11-25：节点的 `NodeVault`（设备模式用本机 DPAPI 密钥库，独立节点用自己的 DPAPI 文件），`hello.vault`；保存、删除经节点连接（`vaultPut` 只回读回值的 sha256）；填表时引擎只拿 `{{profile.<slot>}}`，由电脑代入并在回传前打码；旧的服务器副本在电脑连上时搬走，哈希一致才删。见 docs/claude/registration-forms.md。没有实测真实节点连接。）**托管节点账户的敏感资料只存本机**：电话、生日、学号、地址、证件号只进电脑上的 secret store，托管服务器只记有/无（`apply.sensitive`）。已存在服务器上的：电脑下次连上时搬进本机，按哈希核对成功后再删服务器那份（删除不可撤销，核对不过不删）。纯托管账户本来就跑不了代填（`FORM_NEEDS_SCREEN`），不受影响。
4. ✅（已做 2026-11-25：本来就排队——网页的报名直接排队，worker 只在有窗口时开跑；补上 `/v1/forms/queue` 对有电脑的账户在电脑离线时也收；`computerAskDue` 截止日 0 点（UTC）前 48 小时内仍在排队就推一次 `form_computer`（`interrupt`），记 `computerAskedAt`。节点账户的每一份报名都要电脑的浏览器，所以没有另写「需不需要登录或敏感项」的判断。）**24/7 与「保险箱只在本机」：等电脑醒来。** 侦察照常在云上 24/7；需要登录或敏感项的代填排队，电脑醒来后在本机跑（仍是可见窗口、仍按 §13 的提交规则）。截止前 **48 小时**电脑仍没醒，推送提醒本人开机或自己去交（`push-policy`：需要本人现在行动）。
5. ✅（已做 2026-11-25：`workLeavesMachine(title, model)` 在 `packages/core/src/workflows.ts`；步骤的 `external` 现在随计划存进 `task_steps.detail_json`，之前存计划时会丢；三处显示与分类改用它，闸门不变。）**`stepLeavesMachine`：闸门留词表兜底。** 分类与显示（任务弹窗「对外 · 本人操作」、机会页区分准备与提交 `opportunities.ts`、`step-owner.ts`）改读模型的 `external` 字段，词表只记分歧（`owner-disputes`）；安全闸门（助手写的 workflow 清单 `workflows.ts` / `workflow-authoring.ts`、自动化邮件草稿 `automations.ts`）保留「模型说对外 **或** 词表命中」——清单本身是模型写的，只信它会放松边界。

### §9 实测（2026-11-25，本人电脑）

- 本机独立节点已卸载（本人：独立节点是给其他用户的，本机只用安装版本地 app，它自带节点的功能）。安装版升到 0.3.4（`package-installer.ts --personal`，带原有的 `--ms-client-id`/`--ms-tenant-id`，经 WMI 跑 `install-personal.cmd`，`data\` 先备份到 `backups\before-personal-20261125-073610`）。
- Codex 以 `-c features.prefer_mxc=true` 启动，`state\codex-home\.sandbox\sandbox.<日>.log` 从 `selection: disabled` 变为 `selection: mxc`。
- 网站登录：经 `/api/apply-logins` 存一条测试登录（假主机 `vault-check.example.com`、生成的密码）→ 账本 `apply.logins` 只有主机和时间，全库搜密码 0 处，事件只带主机；`data\secrets\<ws>\login-vault-check_example_com.bin` 是 DPAPI 密文；删除后文件与账本条目都没了。
- shell 助手真实回合：今日输入框建任务（模型判 `external: false`），`/api/agent/dispatch` 交给助手；`agent.task.requested` 记 `isolation: "mxc"`、`profile: research`，`audit.json` 为 `egress: "packages"`、2 条命令、`reproduced: true`（worker 在沙箱里重跑 run.py，HTML 哈希一致），49 秒。测试任务已归档。
- 本机是完整模式，敏感资料本来就在本机密钥库，服务器→电脑的迁移与 48 小时提醒在这台电脑上不适用（单元与真 Chrome 测试见 `form-vault.test.ts`）。
- 打包时发现 `scripts/package-node.ts` 的白名单漏了 `apps/worker/src/browser-port.ts`（ffffbd2cbc 引入，只用 `node:net`），已补；独立节点安装包 1.2.2 能构建，但没发布。

## 10. 工具模式 Rule of Two（2026-11-25，本人决定，已做）

目的：切断「邮件文字不经本人就进日历」这条链路。§3 只管了机主本机的 shell；工具模式（托管账户的助手、自动化）原来忽略 `input.untrusted`，开着 web 搜索和连接器，`add_to_inbox` 的捕获无条件进分析、自动批准、排程、写日历。

- **工具登记表 `TOOL_SPEC`**（`packages/core/src/tool-spec.ts`，参照 `GATE_SPEC`）：助手工具模式的每个函数、小帮手的每个查询（`CONCIERGE_TOOL_SPECS`）和运行时的 `web_search`/`web_fetch`/`connectors`，各标 `reads: untrusted|private|none`、`effect: none|local_write|ledger_write|outbound`。不在表里的按 `untrusted` + `outbound`（`toolSpecOf`，fail-closed）。Rule of Two 只从这张表算（`withheldByRuleOfTwo`）：读过别人写的内容、又持有本人私人数据的运行，所有 `outbound` 的函数都拿掉。测试保证工具箱和小帮手的每个函数都在表里（`agent-tools.test.ts`、`tool-spec.test.ts`）。
- **污点按运行传播**（`agent-tools.ts` 的 `taint()`、`agent-task.ts` 的 `runWithTools`）：
  - 开始时就被交给别人写的内容——`input.untrusted`、`input.reader`、`collect-*` 或 `flow-*` 结果目录、输入里的 `.eml/.msg/.html` 等或 `Downloads` 下的文件（`untrustedSourcesOf`）——整个运行从一开始就不开 web 搜索和连接器。
  - 运行中读到别人写的内容——`mail_search`（结果带正文开头）、`mail_read`、读到外部文件的 `read_document`（文件名或位置是邮件、网页文件或下载目录，`untrustedFile`）——而运行还开着 web 时：这次读取**不回答**（`TAINT_HELD`），本轮停下，同一个对话以 `resumeThreadId` 续跑，续跑的线程没有 web 搜索和连接器，模型在那里重读。理由：托管搜索是 OpenAI 那边执行的，线程开着 web 就没法在轮中途撤销，只有换一个不带 web 的线程才算真的关掉。写出的文件、已排队的收件箱行都留着。
  - 被污染运行的收件箱行在 `capture.created` 上带 `provenance: {run, by, tainted, sources}`（`store.capture` 的第四个参数，不新增事件类型）；分析把它抄到工作单的 `payload.provenance`。`agent.task.completed` 和 `audit.json` 带 `tainted: [来源]`。
  - 来源名（`TaintSource`）：`mail`、`page`、`site`、`document`、`download`、`flow`。**`flow`** 就是 `flow-*` 结果目录，skill-supply 读这个名字。
- **按风险分流**（`autoApprovalEligible` 读 `payload.provenance`，web 的 permission mode 读同一条规则）：
  - 高风险 = 对外或承诺（模型的 `external === true`，或 `mentionsExternalAction` 词表命中，取或）**或** 金额与付款、链接、登录与账号密码证件（`taintedRisk` 的三条确定性规则；这是安全边界，钓鱼邮件要的就是这些，而读邮件的模型正是被骗的那一方）。高风险不自动批准、不排程、不写日历，留在待确认作为现有的「任务提案」，本人按了才继续；也不并进本人已批准的任务、不吸收别的任务为其部分（`analysis.ts` 的 `held`）。没有新增 ask kind。
  - 低风险照常自动生效，`work_order.auto_approved` 的理由写「来自助手读邮件，低风险，默认生效」，铃铛里那条「已自动生效」的消息逐项写明「来自助手读邮件」（`auto_approved` 本来就只进铃铛、不推送），24 小时内可在待确认撤销。
  - 本来就要等本人的（`needsPerson` 等）照旧，理由不变。没读过不可信内容的运行，行为完全不变。
- **邮件分拣**（`mailbox.ts`）的 todo/date 捕获本来也会不经本人进日历，现在带 `provenance: {run: "mail-triage", by: "mail_triage", sources: ["mail"]}`，走同一套分流，铃铛写「来自邮件分拣」。注意：课程邮件里的「提交 HW4」会因「提交」命中词表而等本人确认——这是本人要的「对外或承诺取或」，与 W-257（本人自己的作业不因「提交」卡住）不冲突，因为 W-257 管的是本人自己写进来的任务。
- 沙箱模式（`sandbox`）和节点也用同一个工具箱，收件箱行同样带来源；但它们的 web 工具在 shell 旁边，运行中途不切线程，只记录。

**没做 / 限制**
- 托管 web 搜索的结果不经过 Crossline，工具模式看不到，所以「读网页」本身不算污点来源；网页只在开始时作为 `input.untrusted: ["page"]` 或保存的网页文件计入。
- ChatGPT 连接器（Gmail、Drive）的内容表里记为 `private`（本人自己的账户），读它不污染运行；被污染的运行不再开连接器。
- 聊天摘要、录音转写这类「别人的话」的文件，`read_document` 不算外部来源（录音来的捕获另有 `RECORDING_CAPTURE_PREFIX` 一律等本人）。
## 10. Skill 供应链 ✅ 已实现 2026-11-25

本人决定（2026-11-25）：公开 skill 继续自动安装，不改成审批制，只加强扫描；读过不可信内容的工作流修订要本人采纳；shell 与文件工具不能写 skill 目录。实现记录见 `docs/claude/skill-library.md`（「Skill supply chain」「Shell and file tools never write a skill folder」「A revision that read someone else's words waits for the person」三条）。

- **隔离区**：下载先进 `%LOCALAPPDATA%\Crossline\skill-quarantine\<ws>\`，写入后读回核对 sha256 与路径，所有检查都读这份副本；通过才写进账本与 skill-library，失败或安装后删除，残留一天后清掉。
- **lock.json**（`<skill-library>\<ws>\lock.json`）：每个 skill 一条，记来源 URL、commit、每个文件的 sha256、扫描器版本（`SKILL_SCANNER_VERSION`）、发现、注入审查结论、时间、信任级（`builtin`/`mine`/`grown`/`public`）、`status`（`ok`/`disabled` 及原因）。
- **运行时只选 lock 完好且哈希一致的公开 skill**（`verifiedPublicIds`）：没有条目、条目被禁用、扫描器版本旧、或账本里的文件哈希与条目不一致，都不给运行。
- **每日重扫**（`rescanPublicSkills`）：用当前扫描器重扫所有已装公开 skill；扫描器版本一变当天立即重扫，重扫前这些 skill 不用；lock 之前装的 skill 按钉住的 commit 重新拉取，逐文件比对。发现问题就禁用并记 `skill.public.rejected`（`stage: "rescan"`），直到新 commit 通过。没有模型或 GitHub 不通：等下一轮，期间不用。
- **新 commit 走完整流程**：隔离区 → 代码扫描 → 自然语言注入审查 → 审查；失败保留旧版本（以前是删掉），事件记被拒的 `commit` 和保留的 `kept`，同一个被拒的 commit 不再拉取。
- **自然语言注入审查**：`crossline-validation-reviewer` 的独立一次调用（无工具、无网络、无私人上下文，只读 SKILL.md 与所有文本文件），结构化回答四项：劫持指令、外传数据、索取凭据、隐藏字符；每个「是」都要带所在文件里的原文引用，引用不在文件里视为要修正。保留原来的 `scanSkillFiles` 和原来的审查。
- **修订带污点要本人采纳**：修订读的结果文件夹里有不可信来源，新版本存为待定（`pendingRevision`），差异写进运行目录的 `REVISION-DIFF.md`，这次运行的结果回到待确认（复用助手结果卡，`agent.task.reopened` `why: "untrusted_revision"`，没有新 ask kind）；本人点采纳才生效，退回、系统代为采纳、文件被改、版本已变都丢弃。只依据本人反馈与失败记录、没读过不可信内容的修订仍自动生效。
- **shell 不能写 skill 目录**：`decideCommand` 与 `decideFileChange` 拒绝（`skill.write`）写 `skill-library`、`skill-quarantine`、仓库 `skills\marketplace`、运行时插件缓存；MXC 的 `crossline-shell` 档里这几处（含仓库整个 `skills\`）是 `deny`。档由 `packages/codex/src/agent-mode.ts` 的 `windowsShellConfig` 生成，不在 `skill-runner.ts`，所以没改那个文件。

**与 taint-tools 会话的衔接（合并时接上）**：本会话不改 `agent-task.ts`，污点只从现有字段和文件判断（`revisionTaint`）。taint-tools 把 `flow-*`、`collect-*` 标为不可信后，只要它落在以下任一处，这里自动认得：`agent.task.requested` 的 `untrusted`（标签数组或 `true`）或 `profile: "untrusted-input"`；结果文件夹里的 `untrusted.json` 或 `.untrusted`。现在已经按 `inputs` 路径里的 `collect-*`（标 `site`）、`flow-*`（标 `workflow-output`）和 `agent.task.completed.searches > 0`（标 `web`）判断，taint-tools 合并后这几条可留作兜底。

**未做 / 后续**：Skill 库页面还不显示 lock 的禁用状态与原因；「全部按推荐」（`apps/web/lib/answer-all.ts`）会以本人名义采纳待确认的结果，包括待定修订——要不要把待定修订排除在「全部按推荐」之外，留给本人定。
## 10. 联网外泄（本人决定 2026-11-25：拆出不带隐私的搜索子调用）

**问题**：此前每个 Skill 线程默认开 Codex 的 hosted `web_search: live`（`withSourceDefaults`），去标识只靠一句提示（`SOURCE_ORDER_INSTRUCTION`）。拿着整场访谈、画像、120 条事实、上传文件全文的模型，可以把这些写进搜索词或带查询串的网址发出去；provider 路径的 `web_fetch` 经 `safeGet` 只拒私网地址，带查询串的 GET 照样放行；调用方事后打开模型引用的网址核实来源，也会替模型把它拼的网址发出去。

**做法**（`packages/core/src/web-egress.ts`，`packages/codex/src/skill-runner.ts`，`apps/worker/src/private-guard.ts`、`cited-urls.ts`）：

1. **默认不再 live**。没写 `allowWebSearch` 的运行（小帮手 concierge、倒推、步骤规划……所有 Skill）线程上 `web_search: disabled`，改拿动态工具 `web_research(queries, purpose)`（`webResearch: true`，路由能搜索且能调函数时）。`allowWebSearch: true` 只留给输入里几乎没有私人上下文的运行（见第 6 条）；`false` 照旧不联网。
2. **子调用 `crossline-web-scout`**（low 档，`SKILL_TIERS`/`SKILL_NEEDS`/`REQUIRED_SKILLS` 已登记）。它只收 `{version, today, purpose, queries}`，开 live 搜索，返回 `{results: [{query, title, url, excerpt, published}], notes}`，`readAt` 由代码打。它没有本地文件查阅、没有 `web_research`、也不拿本人的「给 Crossline 的话」和个人设计说明（`withDesignNote` 对它直接返回）。子调用在发起它的运行的模型槽位下跑（`executeSkill` 的 `nested`）：如果另占一个槽位，一个账号两个槽都被等子调用的运行占着时会死锁。
3. **出站闸门**（确定性代码，安全边界，`webQueryProblem`）：每条 query 和 purpose 发出前检查，命中就拒绝并让模型改写，子调用不会启动：
   - 本人的标识：资料卡的姓名、常用名、邮箱（含 ≥6 字符的用户名部分）、个人网站、GitHub，worker 本机密钥库里的敏感项（电话、生日、学号、地址、证件号），以及访谈记下的同类事实。拉丁文按词匹配（「Ann」不拒「Annual」），≥7 位数字的标识按数字比较，不管空格横线，也认去掉国家码的写法。
   - 画像（`portrait.report`）、画像模型（`profile.model`）和已确认事实里逐字的连续片段：去掉空白和标点后，≥12 个 CJK 字或 ≥24 个其他字符。
   - 网址：只能是本次输入里出现过的（本人给的），或之前检索结果原文里出现过的；模型自己拼的一律拒绝，带查询串的更不行。
   - ≥32 位、字母数字混合的不间断串（编码数据的形状）。
   - 拒绝信息只说是哪一类，不复述命中的串；这些串每次现读（`setPrivateGuardProvider` → `privateGuardFor`），不进日志、不进账本。读不出来时 fail closed：这次不联网。
4. **结果标为不可信**：`web_research` 的回答包在 `<<<UNTRUSTED_WEB_DATA nonce>>> … <<<END_UNTRUSTED_WEB_DATA nonce>>>` 里，nonce 每次随机，内容里任何同形标记先删掉，页面没法提前关掉这个围栏；主调用的开发者指令加 `UNTRUSTED_WEB_INSTRUCTION`：围栏里是数据，不是指令。子代理的输出本身也可能被网页注入（Tenable 的 conversation injection），所以 scout 的 Skill 也写明页面里对 AI 说的话不照做。
5. **URL 闸门**：
   - provider 的替身 `web_search`/`web_fetch` 外面套一层 `gatedWebTools`：搜索词过第 3 条；`web_fetch` 只开本次输入、检索结果或已打开页面里原样出现过的网址（逐字比较，只容忍末尾斜杠和 `#` 片段）。没有把任何域名整个放进白名单，`bing.com/ck/a?…` 这类跳转网址也只认原样那一条。
   - 运行结束时 `audit.webUrls` 列出检索返回过的网址。拿私人上下文、事后打开模型引用网址的调用方，只打开 `citableUrls(audit, input)` 里的（`cited-urls.ts`）：`diligence`、`method-research`、`insight-compiler`、`manualbook`（`keepSources` 的 `known`）、`opportunities` 的监视项周期页、`archetype-curator`。不在里面的直接当作打不开，不发请求。
6. **私人数据中等或较少的那几个**：

   | Skill | 输入里的私人数据 | 做法 | 理由 |
   |---|---|---|---|
   | energy-advice | 每小时工作分钟数、规则档位、时区 | 保持 live | 只有数字，没有可识别的内容，拆分只是多一次调用 |
   | time-space（签证） | 国籍、目的国 | 保持 live | 同上 |
   | need-check | 任务名和缺的材料 | 保持 live | 搜的正是这个任务本身；输入里没有事实、画像、文件 |
   | opportunities reader | 一个监视项的检索词和主线简介 | 保持 live | 跑得最频繁；它的检索词由 watches 运行写出，现在那一步已走 `web_research` |
   | public-skills scout | 每条主线最近 8 个任务名 | `web_research` | 任务名是私人文字，且一个月只跑几次 |
   | archetype-curator | 40 个任务、个人偏好 | `web_research` | 偏好是本人的纠正原话 |
   | flywheel | 未完成里程碑、已验收任务 | `web_research` | 里程碑是本人的计划 |

   保持 live 的这几个加了**事后检查**：hosted 搜索在 Codex 那边执行，代码拦不住第一条请求；runtime 一报出 `webSearch` 项（query、queries、openPage 的 url），就用第 3 条的 `privateLeak` 查，命中就以 `SKILL_TOOL_FORBIDDEN`（`detail: web_search:private`）立刻结束这次运行，日志只记类别。这是**发现**，不是**阻止**，所以只给几乎不带私人数据的运行用。
7. 改成 `web_research` 的调用方：onboarding-session（访谈本身，开局与冷恢复；续轮默认）、onboarding-research、method-research、diligence、opportunities（watches）、step-planner（research）、insight-compiler（无搜索宿主时 `allowWebSearch: false`）、manualbook（资料检索）、public-skills、archetype-curator、flywheel；小帮手 concierge 和其余没写 `allowWebSearch` 的 Skill 走默认，同样是 `web_research`。`SKILL_NEEDS` 的 `webSearch` 标记不变：这些 Skill 在 provider 上仍然要靠 scout 的替身搜索才有网。

**残余风险（批判）**
- 确定性闸门只挡得住原样或简单变形的私人串。一个被注入的模型仍可以用改写、同义词、首字母、措辞选择把信息一点一点编进「一般主题」的检索词里（低带宽隐蔽信道）；只有不给它私人上下文才能根除，这正是保持 live 的那几个 Skill 的取舍依据。
- 部分地址（只写街道门牌）、短名字（单字、不足 4 个字母）不算命中。
- hosted 搜索的 openPage 网址没法和结果核对（runtime 不回传结果），只查私人串；scout 自己不带私人上下文，这一点可以接受。
- 一个会话在升级前以 live 开的访谈线程（内存里最多留 1 小时），升级后续轮再搜会被当作不允许的工具拦下，重试即可。

**验证**：`packages/core/src/web-egress.test.ts`（标识、逐字片段、网址、编码串、围栏），`packages/codex/src/skill-runner.test.ts`（默认改为 `web_research`、scout 不拿查阅、闸门拒绝时 scout 不启动、读不出 guard 时 fail closed、替身 `web_fetch` 只开结果里的网址），`apps/worker/src/web-research-split.test.ts`（真实 runner + 假 runtime：主线程 `web_search: disabled` 且有 `web_research`，含姓名的 query 被拒，scout 线程 live、提示里没有姓名和事实，回答带围栏，`audit.webUrls`；live 运行里出现姓名的 `webSearch` 项结束运行）。本机真跑：`scripts/web-research-check.ts`（2026-11-25，本机 Codex 登录，额度 5 小时窗口已用 27%）：material-researcher 拿着虚构的私人上下文（姓名、学号、导师要求），主线程没有搜索，调了一次 `web_research`（3 条一般主题的英文 query，purpose 不含个人细节），scout（`gpt-6-luna`）85 秒返回 5 个页面，主运行 124 秒完成，引用的 4 个来源都在 `audit.webUrls` 里。
## 10. 主动提问（2026-11-25） ✅ 已实现

本人原话：「模型如果有不确定的问题，给模型一个主动提问工具，允许其向用户提问获取信息（前提是用户应该知道这个信息）。」借鉴 LangGraph `interrupt`、MCP elicitation 与 Horvitz 混合主动（docs/competitors.md「主动询问的范式」）：有把握就做，只有本人知道的才问，问的时候先按假设往下做，不让运行停下来等人。

- **工具**：`ask_person({question, why, knownBy: "person", options?, answerType: text|long_text|date|choice, assumption, blocking})`，规格与校验在 `packages/core/src/info-request.ts`（`ASK_PERSON_TOOL`、`readPersonQuestion`），运行时在 `apps/worker/src/ask-tool.ts`（`createAskTool`，可叠加的 `withAskTool(tools, ctx)`：只做数组拼接，不改运行的工具组装）。只问本人的计划、偏好、事实与处境；能在输入、本人文件、账本或网上查到的，以及别人掌握的事实（那是 `request`，起草消息由本人发出），一律不问。工具描述、各调用方的说明和三个 SKILL.md 都写明了。`assumption` 必填，运行按它完成本次输出；`blocking` 只用于缺了答案输出就不对的情况。
- **注意力**（代码拦截，不靠模型自觉）：问题账本（`question_ledger`，访谈、待确认、拆步骤的问题都在里面）里已答过的相似问题（`questionSimilarity ≥ SAME_QUESTION` 0.6，同一项目内）直接把答案还给模型，本人不再被问；还开着的相似问题并入同一张卡（同 id 再记一条 `join`，答案到了按每个等待方各自重跑）；每次运行新问题最多 `PERSON_QUESTIONS_PER_RUN` 2 个，超出的调用被拒，模型按假设继续。问题的家是待确认，卡片 `skill_question`（`apps/web/lib/skill-questions.ts`）：不 blocking 且一周内不到期的进周复盘（`inReview`），不进角标。只有 blocking 且相关任务或里程碑 48 小时内到期才推送（`pushesPersonQuestion`，`push-policy` 新增 `person_question`，`interrupt`）。
- **回答**：写成已确认的事实（`profile_facts`，slot `person_answer_<hash>`，`sourceRef` `ask:pq:<id>`，即「本人回答」），问题账本记 `answered`；选「就按假设」记 `assumed`，不重跑（运行早已按它做了）。blocking 的等待方在答案到达后重跑：任务 → `task.steps_replan_requested`（带回答）；里程碑 → `goal.backplan_rerun_requested`；教程 → `requestTutorial`；材料准备 → `retryMaterialPreparation`。都是已有的重跑入口。
- **安全**：调用方告诉工具这次运行是否读过不可信内容（`untrusted`：拆步骤开了网页调研、倒推带了网上来的已批准洞见）。这样的运行提的问题不许带链接、网址或 markdown 链接（`hasLink`，拒绝并告诉模型用自己的话问），卡片上标「来自读过外部内容的运行」并提醒本人核对。并行会话 taint-tools 的污点标记合并后，可把 `untrusted` 改读它的标记。
- **接入**：`step-planner`（与拆步骤计划里的 `questions` 分工：`ask_person` 只问「步骤现在就会错」的事实，能等周复盘的仍写进 `questions`，同一问题不两头问；拦截时也读得到已答的步骤问题）、`goal-backplanner`（只有本人知道的输入用 `ask_person` 并按假设拆分，`blockers` 的 `what`/`whoHas` 留给别人掌握或要去获取的东西）、`manualbook` 的设计器（只问会改变本人学哪几步、怎么学的事）。三处都经 `optionalTools` 提供：不能调用函数的路线不提供工具，运行照旧。
- **Accretion 账**：新增一个事件类型 `person.question.asked`（读者：待确认卡片 `skill_question`；`ask-tool.ts` 找可并入的开放问题）和一个 ask kind `skill_question`（读者：`collectAsks`/`answerAsk`）。没有复用 `agent.question.*`：那条线是助手运行中等 10 分钟的同步提问，15 分钟后被自检过期，这里的问题要留到本人回答；状态和答案复用问题账本，答案复用 `profile_facts`，重跑复用现有事件，没有新设置项和环境变量。
- 测试：`apps/worker/src/ask-tool.test.ts`（已答拦截、每次上限、同题并入与重跑对象、按假设不重跑、不可信运行禁链接、推送条件、工具拼接）、`apps/web/lib/skill-questions.test.ts`（卡片、回答成为事实、blocking 任务重排与里程碑重新倒推、周复盘、任务关闭后不再问）。
## 10. 评测与消融（2026-11-25）

本人要求：规则删不删用数据决定；关键 Skill 测一致性。CI 不跑模型评测（仓库公开、没有凭据），确定性部分进 vitest。怎么跑、怎么登记见 `docs/claude/operational-scripts.md`「规则登记、评测与消融」。

**基础设施（已做）**
- `RULE_SPEC`（`packages/core/src/rule-spec.ts`）：23 条，覆盖 `line-attributes`（`guessKind` 等 3 条）、`feasibility`（`FAR_WORDS`、报价里的时间 2 条）、`completion`（旧数据标题规则）、`money-events`（VETO、金额标签、商户键、退款词 4 条，`kind: money`，本人决定**保持强制**，覆盖一律无效）、`rough-dates`（2 条）、`activity-state`（隐私窗口为 `invariant`、窗口分类）、`agent-failure`（3 条）、`importance.hoursFromText`、`profile-gaps`（5 条）。纯兜底的三条标 `fallback`（`completion.legacy-title`、`opportunity.far-words`、`attribute.guess-kind`），只在模型字段缺失时生效，生效时 `ruleFired`；默认模式下判定结果与之前逐字相同（core 1298 个测试照过）。
- `ruleFired` → `<数据目录>/telemetry/rule-fired.jsonl`（worker 与 web 启动时装 sink；同进程同 key 只记一次；钱只记事件类型和位置，不记金额与标题）。`CROSSLINE_RULE_MODE` / `setRuleModes` 运行时改模式。
- lint（`scripts/rule-spec-lint.test.ts`）：`packages/core/src` 里带中文交替的正则字面量，新增的必须 `// rule: <id>` 或 `// not-nl: <why>`；现有 289 条为基线（`rule-spec.baseline.json`），只拦新增。另两条：每个登记项在自己的文件里有 `rule:` 锚点，每个 `rule:` 锚点都指向登记项。
- `scripts/pass-k.ts`、`scripts/golden-from-corrections.ts`、`scripts/ablate.ts`（纯逻辑在 `scripts/eval-lib.ts`，测试 `scripts/eval-lib.test.ts`）。

**pass^k 实测（k=3，本人电脑，安装版运行时，模型 `gpt-6-luna`，额度短窗读数 20%（第一套开跑前）→ 23%（最后一套开跑前））**

| Skill | 样例 | pass^3 | pass@1 | 分歧率 | 说明 |
|---|---|---|---|---|---|
| 邮件分拣 `crossline-mail-triage` | `mail-intake-1120.json` 3 例 | 0.667 | 0.667 | 0 | `movie-night` 三次都判 `event`（不进待办、captures 0），夹具期望 `unlisted`（录制答案走 todo + serves none）。结果对本人无害，失败在于期望只认一条路径——夹具该放宽成「不进待办」还是让 Skill 回到 todo，留给夹具的主人判断。另两例三次全过。 |
| 里程碑关口 `crossline-milestone-gate` | 手写证据 3 例 | 1 | 1 | 0 | 交付齐全 → 三次 `pass`；只说「做完了」、只交一半 → 三次 `insufficient`。 |
| 拆步骤 `crossline-step-planner` | 3 个任务 | 1 | 1 | 0.667 | 判定（不写本人没说过的订正/错题）三次全过，但**结构**不稳：作业题 2 步或 3 步；本人记了「订正、错题本」的期中复习 2 步或 3 步，且三次都没用上本人的做法。 |

**golden（本人纠正）**：用 2026-11-25 18:15 的备份恢复出副本（`restored\e1125`，活账本未动），抽出 **2 条**：1 次撤销（本人自己的操作，非系统所为）、1 次拒绝提案。同一账本里关口判定 55 次、0 次 override，没有改估时、改截止日或选完成方式。样本太少，现在还不能用本人纠正给任何一条规则下结论。

**消融（确定性，不调模型）**
- `opportunity.far-words`：`opportunity-mail-social-and-lines.json` 8 例，规则改变 0 例答案，enforce 与 record 与标签一致都是 7/8。不一致的那例是 Badger Hacks：`kind: application` 走「实习/项目」分支得 `program`，标签是 `competition`——这条规则本身没机会出手。按退场条件，等遥测 30 天没有触发就删。
- `completion.legacy-title`：只有虚构示例（真实账本没有本人选过完成方式），不下结论。
- `money.*`、`activity.private-window`：拒绝消融（设计如此）。

**下一步（数据够了再做）**：遥测攒 30 天后按 `ablate.ts --telemetry` 看三条兜底的触发次数，零触发即删；邮件分拣把 `movie-night` 的期望改成「不进待办」后再测；拆步骤对本人记录的做法利用不足，值得给 Skill 更好的上下文，而不是加规则。
## 10. 机会放宽（2026-11-25）

本人原话：

> 机会资格尽可能宽松，按照模型来，并且要求只要有可能能够到的，或者符合部分要求的，哪怕只是方向相同，只要阶段和方向没问题都推给我（找实习的时候不要推正职，推的岗位只要有相关性，在尽可能节约用户注意力、agent 替用户完成大部分内容的情况下，这个收益非常高，消耗少量注意力博取大量可能的机会），不要只推严格满足的，严格满足的往往已经落后于发展进度。
> 任务去重的硬预过滤交给模型。

### 做了什么

- **资格交给模型。** `crossline-opportunity-reader` 每条给 `fit`：`stageFit`（fits / stretch / wrong_stage）、`directionFit`（same / adjacent / unrelated）、`reachable`、`partialRequirements`、`agentCanPrepare`、`why`。判断标准写在 SKILL.md「How it fits the person」，是目标不是正则。输入 v4 带 `person`：确认过的资料事实（不含姓名、邮箱、电话、地址、证件号等标识，不含「假设」，≤30）和各条活跃监视项的「标题：判断」（`seeking`，≤12）。
- **代码只验结构**（`fitOf`）并照判（`verdictFromFit`）：只有 `wrong_stage`、`unrelated`、`reachable: false` 不推；其余都是 eligible，fit 存在 verdict 上。没有 fit（列表里的 CFP、旧行）算 eligible，不再问。
- **删掉的确定性规则**：`judgeEligibility`、`meets`、`applicantFrom`、`degreeStageOf`、`DEGREE_STAGES`、`FACT_HINTS`、欧盟/国家词表与 `countriesIn`/`countryMeets`、`STEM_FIELD`/`OPEN_TO_ALL`/`ANY_FIELD`/`broadMeets`、`eligibilityQuestion` 和维度标签、db 的 `rejudgeOpportunities` 与 worker 的 `rejudge`、条款里的 `accepts`。保留：`phishingSigns`（安全）、引文核验、`eligibilityAnswer`（只为旧卡片上的问题）。
- **分歧只记不拦。** 代码看监视项全是找实习、模型却没判正职为 `wrong_stage`（`stageConflict`）时，照模型，写一行 `rule-fired`：`ruleFired(rule, detail, dataDir?, now?)` 在 `apps/worker/src/rule-fired.ts`，追加到 `<CROSSLINE_DATA_DIR>/telemetry/rule-fired.jsonl`（无数据目录时打到 stdout），不进账本。这是一致性评估那边规划中 `ruleFired` 的本地替身，接口相同，合并时只换 import。
- **`reachable: false` 也不推**（国籍或绿卡、安全审查、年龄、别校成员）。按「有可能能够到」理解为够不到的不推；若本人要连这些也看，改 `verdictFromFit` 一行即可。**待本人确认。**
- **任务去重**：`task-merge.ts` 删掉「截止日相差 7 天以上」和「服务的里程碑截止相差 21 天以上」两条硬「不同」。同标题的这两种情况现在是「不确定」（score 1），交给已有的模型复核；相似度只挑候选。`partOf` 的数字检查保留：它只管代码自己合并部分任务，那一对仍会交给模型。

### 注意力

- 不加推送，不加 ask 种类。没有新事件类型、设置键或环境变量；只有一份开发者读的 JSONL（`rule-fired`）。
- 晨报只有一行计数（「新机会与动态 N 条，见周复盘」），放宽后条数变多，晨报仍是一行。
- 待确认只放 7 天内要动的（`OFFER_LEAD_DAYS`），其余进周复盘；两处都按 `offerOrder` 排：先同方向再相邻，再按最近截止，再按相关度。
- 相邻方向的机会，就算线只弱关联（相关度 0.25–0.6，`offerPushable`），也进待确认或周复盘，不进视野外；严格的监视项（strictness ≥ 1）仍挡相邻方向。
- 卡片写「还差：…」和「可代为准备：…」，本人一眼看出要补什么、agent 能做什么。
- **数量上限没改。** 理由：打扰的入口（晨报一行、待确认 7 天窗口、推送只给当天截止）都不随条数变；条数多了只是周复盘变长，而它按方向和截止排好。回放的每日打扰没有变化（见下）。

### 去重的花费上限

每次去重最多送模型复核 36 对（`REVIEW_PAIRS_PER_RUN` = 3 × `MAX_REVIEW_PAIRS`，即 3 次调用）。按相似度从高到低取，其余留到第二天。放开后最坏的情况是同标题的周期任务两两都进复核；36 对一天够用，花费封顶 3 次调用（没有实测本人账本上放开后的对数）。

### 回放（opportunity-world，确定性部分）

| | 放宽前（25 个场景） | 旧代码跑新场景（27 个） | 放宽后（27 个） |
|---|---|---|---|
| 场景判对 | 25/25 | 25/27 | 27/27 |
| 精度（① 一周） | 100%（12/12） | 92.9%（13/14） | 100%（13/13） |
| 召回（① 一周） | 100% | 100% | 100% |
| 每日打扰（7 天均值 / 最多） | 1.43 / 2 | 1.43 / 2 | 1.43 / 2 |
| 60 天长跑探索占比 | 14.7% | 13.1% | 13.1% |

忠实模型和对抗模型结果一样；①+② 引擎精度、召回也都是 100%（14/14）。

样例：

- `fulltime-while-intern`：Synth Silicon「Hardware Engineer, New Grad (Full-time)」，要求毕业后 2 年以上全职经验，本人在找实习。旧代码条款里没有学历阶段，判 eligible，推送（错）。现在读取器判 `wrong_stage`，ineligible，不推，只在周复盘里计数。
- `adjacent-direction`：「Lakeshore Robotics Founders Fellowship 2027」，创业线，置信度 0.35，相关度 0.55 < 0.6。旧代码判为纯推送，但按代码会进视野外。现在读取器判 `adjacent`，卡片写「还差：需有机器人方向的原型。可代为准备：申请陈述草稿、项目简介。」，进入待确认或周复盘（标为 `partial`）。
- `travel-grant`：以前读取器给出自由文本条款时，卡片会问本人；现在不再问，卡片列出还差什么（`partial`）。

真模型回放（`--live`）这次没有跑：需要 Codex 额度和独立的 Codex home。读取器的提示词与 schema 改了，下次真跑应先看 `fit` 的分布，特别是 `wrong_stage` 有没有判得过严。

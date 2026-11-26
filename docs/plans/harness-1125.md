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

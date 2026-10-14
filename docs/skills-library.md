# Skill 库：公开 skills 与本人的主线 skill

2026-10-14 与本人四轮问答确定。起因：真实账号走查中，助手把小红书首篇笔记做成了科研报告体。本人的内容打法（「制造冲突、贩卖焦虑，再卖 solution 变现」）从未被记录，助手只有通用的 `crossline-agent` 规则，验收闸门只按任务契约判，于是一份不符合本人打法的产物照样通过。

## 现状（实现前）

- 助手每次拿到：`crossline-agent`（交付成品、守边界、自检）、任务说明与归本人的部分、本主线/项目已确认事实、已上传文件、已有产出。
- 拿不到：本人的偏好与纠正（`preference_entries` 只进收集分析、步骤规划、里程碑设计）、每周调研结论、任何「这类事怎么做」的手册。
- `learned_archetypes` 只管步骤结构，不管内容打法。
- 运行时：worker 把仓库里的 `crossline` 插件装进 CODEX_HOME，每次运行用 `skills/config/write` 只启用目标 skill（`findNativeSkill` / `setNativeSkill`）。格式是 Agent Skills 开放标准（`SKILL.md` + 可选 `scripts/`、`references/`、`assets/`），Codex 原生支持。

## 已定的决定

| 问题 | 决定 |
|---|---|
| 结构 | 两套分开：**公开 skills**（别人开源的，整合复用）与**本人的主线 skill**（每条主线一个，由本人的话整理） |
| 公开 skills 的组织 | 不按任务类型细分，按大类；同一 skill 可跨主线复用（例如 superpowers 这类） |
| 公开 skills 的获取 | 首次按每条主线检索一套高度相关的；之后每月对照本人的任务情况再检索补充；任务需要而库里没有时，按任务情况上网，自己构建或复用开源 skill |
| 来源范围 | 全网搜索结果，加 AI 风险审查 |
| 自带脚本 | 自动扫描后允许 |
| 更新 | 自动更新，不经本人批准 |
| 删除 | 公开 skill 一个月未被调用自动删除；本人的主线 skill 永不自动删除 |
| 与平台规则冲突 | 以本人打法为主，把控灰色地带，外部规则只避开红线 |
| 验收闸门 | 契约通过、但违背本人主线 skill 时判「部分」，写明违背哪条 |

## 设计

### 1. 本人的主线 skill（`crossline-mine:<line>`）

- 每条主线一个 `SKILL.md`，由新 Skill `crossline-insight-compiler` 从这些材料整理：该主线已确认的访谈事实、`preference_entries`、助手结果的采纳/退回备注（`agent.task.reviewed` 的 note）、闸门「部分」的说明、里程碑回顾。每一条规则都标出来源（哪句话、哪次验收），没有来源的不写。
- 内容只写「本人怎么做这类事」：打法、偏好、红线（只写会导致处罚的硬红线，例如小红书《社区公约 2.0》的「反对制造对立」中针对性别、地域等群体对立的条款），不写泛泛的方法论。
- 有新材料时自动重写，旧版本保留在账本（`skills.mine.<line>` 设置 + `skill.mine.rewritten` 事件），可在设置里回到任一版本或直接编辑。
- 永不自动删除。

### 2. 公开 skills（`crossline-public:<id>`）

- **检索**：新 Skill `crossline-skill-scout`（联网）按主线描述、长期目标和近期任务情况检索；首次每条主线一套，之后每月一次，外加任务需要时的即时检索。
- **取回**：只取回仓库里该 skill 的目录（`SKILL.md`、`references/`、`scripts/`、`assets/`），记下来源 URL、提交哈希、许可证、各文件 sha256。许可证不允许复用的不收。
- **扫描**（代码判定，不靠模型）：脚本里出现联网、删除、读写工作目录之外、读取密钥或凭据路径（沿用 `agent-guard` 的 secret 规则）、修改系统设置、提权、下载并执行等模式的，记为高风险；`SKILL.md` 里出现要求忽略指令、外传数据、绕过审批等语句的，记为注入风险。
- **AI 审查**：`crossline-validation-reviewer` 读取扫描结果与全文，给出「可用 / 只用文字 / 拒绝」和理由。高风险或注入风险一律至少降为「只用文字」（去掉 `scripts/`）。
- **安装**：通过的放进运行时的第二个插件 `crossline-public`（与仓库里的 `crossline` 插件分开），不进仓库。
- **记录**：`skills.library` 设置里每个 skill 一行：`{id, kind: public, lines[], category, source, commit, license, files[{path, sha256}], scan, review, installedAt, lastUsedAt}`。
- **删除**：`lastUsedAt` 超过 30 天的，worker 每天清理一次，记 `skill.public.removed`。

### 3. 调用

- 助手、步骤规划、教程撰写运行时，除目标 skill 外，再启用：该任务主线的 `crossline-mine:<line>`，以及按任务大类匹配到的公开 skills（最多 3 个，按与任务情况的相关度）。每次启用都更新 `lastUsedAt`。
- 公开 skill 的脚本只在**助手**（有 shell）运行时可用，并照旧经过 `agent-guard` 拦截与审计；结构化 Skill（无 shell）只读它们的文字。

### 4. 验收闸门

- `crossline-milestone-gate` 的输入加上该主线的 `crossline-mine:<line>` 全文；输出加一项 `fit: { fits: boolean, violated: string[], why }`。
- 契约全部覆盖但 `fits === false` → `verdict` 为 `partial`，`violated` 逐条写明，作为退回说明给本人看。`validateMilestoneGateResult` 按此校验（契约通过 + 不符合打法 ≠ pass）。

### 5. 界面

设置 → 「Skill 库」：本人的主线 skill（全文、来源、版本、编辑、回到旧版）；生长的工作流（时间、来由、步骤、哪步归本人、检查结论、启用/关闭/保留/删除）；公开 skills（来源、许可证、扫描与审查结论、上次调用、手动删除）。

### 6. 生长的工作流（`crossline-grown:<id>`，2026-10-14 本人追加）

本人的要求：skill 要能扩充并固化成工作流，替本人做更多琐碎的事（剪辑、代发布这一类）；能力要泛化，由模型自己长出来、长好后通知本人；也能定时执行或提醒。参照 Manus 一类代理产品把一次做成的事沉淀为可复用技能、并按时间表运行的做法。三套 skill 由此变成四层：仓库里的 `crossline`（系统自己的 Skill）、`crossline-mine`（本人的打法）、`crossline-grown`（为本人长出来的做法）、`crossline-public`（别人的方法）。

- **什么会长成工作流**：同一主线上同一类工作的助手结果被本人采纳两次、且标题相近（重复出现的琐事）；或本人在输入框里说「以后每周五把素材剪成一条 vlog」「每天九点提醒我发笔记」（新动作 `workflow.request`）。每件事或每个要求只尝试一次（30 天冷却）。
- **谁来写**：助手本身，在它的任务目录里，用 **Codex 运行时自带的 `skill-creator` 系统 skill**（装在 `CODEX_HOME/skills/.system`，按开放标准写 SKILL.md、scripts、references），同时写一个 Crossline 读的 `workflow.json`。脚本要在任务目录里用示例输入真的跑通（例如剪辑用 ffmpeg）。复用而不是重写：写 skill 的方法是 Codex 的，执行、审计、拦截沿用助手已有的整套（`agent-guard`、任务目录、命令记录、所有者限定、按类别授权）。
- **怎么检查**：写出的 `skill/` 目录按公开 skill 的同一套标准处理——代码扫描（脚本风险、注入语句）、`crossline-validation-reviewer` 审查、高风险脚本只用文字、注入直接拒绝；`workflow.json` 另由 `validateWorkflowManifest` 校验。**任何会离开本机的步骤（发送、上传、发布、投稿、付款）都是本人的**：清单标给助手的，安装时改归本人并在通知里说明（`stepLeavesMachine` 按动作判断，「发布前核对清单」「在发布前停止」不算）——这是「代发布」在这里的含义：工作流做到成片、封面、文案都备好，在发布前停下，发布那一下由本人点。真正替本人对外发布需要新开写出路径，属于 CLAUDE.md 列出的安全边界，未做。
- **装进哪里**：运行时第四个插件 `crossline-grown`；记录在 `skills.grown`，文件在 `skills.grown.files.<id>`，事件 `skill.grown.created / updated / ran / removed / rejected / attempted`。长好后立即启用并通知本人（对话里一条系统消息；没开着页面时推到桌面和手机），本人可在设置里关闭、保留或删除。
- **何时用**：任务的主线与文字和某个工作流相关时，在助手、步骤规划、教程撰写里与主线 skill 一起启用（排在公开 skill 前面，合计最多 3 个）。
- **定时**：`workflow.json` 的 `schedule` 采用 Codex 自己的 `ScheduledTaskSchedule` 形状（daily / weekdays / weekly + 时间）。Codex 的这个字段只在远程插件清单里出现、本地运行时并不执行，所以调度由 worker 做（`workflowSchedulePass`）：到点（本人时区，当天未执行过，且不晚于三小时）时，`remind` 发一条提醒，`run` 让助手带着该工作流做本期的事；助手被暂停、正忙或没获准这类工作时改为提醒本人并说明原因。
- **单纯的定时提醒不走助手**：「每周五下午六点提醒我发小红书」只需一个时间和一句话，输入框的 `workflow.request` 带上 `reminder`、`time`、`weekdays` 时立即建成一个只提醒的工作流（`createReminderWorkflow`，本人建的，默认保留），不必等助手、也不需要任何授权。
- **定时执行的结果**：按工作流做的本期产出照常进 待确认 的助手审阅（类别已获信任时直接通过），并给本人发一条「本期……已做好，留给本人：发布……」的消息；没做成也说明原因。
- **新的助手工作类别**：「剪辑音视频和图片（不发布）」`media_edit`，与其他类别一样逐类授权（关闭 / 逐次审阅 / 自动）。
- **清理**：30 天没用也没执行的工作流移除并通知本人；本人点过「保留」的永不移除。

### 7. 规划把 AI 工具算进去（2026-10-14 本人追加）

本人的要求：整个工作流设计要充分利用其他 AI 工具；Crossline 给本人规划具体行为和执行力度时，也要考虑前沿 AI 工具能带来的效率。原先的步骤拆分按「本人亲手做」估时，一个会用工具的人一天能做的事被低估，助手能整份做的事也常被排成本人的步骤。

- **本人可用的 AI 工具**（`packages/core/src/ai-tools.ts`，`aiToolsFor` 在 `packages/db/src/skills.ts`）：三个来源——系统自带（Crossline 助手：整份做琐事；联网调研）、使用记录里检测到的（Codex、Claude Code，只在本人开启「Codex 与 Claude Code 使用记录」时读）、本人在设置 → Skill 库「可用的 AI 工具」里添加的（例如剪映：自动字幕、粗剪；NotebookLM：读长文档）。存于 `ai.tools`。
- **步骤拆分**：步骤规划的输入多了 `aiTools`；每个本人的步骤带 `aiAssist {tool, how, minutesSaved}`——用哪个工具、具体怎么用（操作或提示词）、比手工省多少分钟——**估时按用了工具的时间**。助手能整份做的步骤直接归助手；工具只拿走机械部分，不替本人做核心（作答、论证、决定），学习类步骤仍要本人自己提取和解题，工具可以出题、核对、解释错误。列表外的工具名在规范化时丢掉（`normalizeAiAssist`），省下的分钟不超过该步时长的三倍。任务卡对话框的每一步显示「工具 · 怎么用（约省 N 分钟）」。
- **教程**：教程撰写拿到 `aiTools` 和该步的 `aiAssist`，在计划指定的地方写出具体操作或提示词，以及要检查工具返回的什么。
- **工作流生长**：生长任务里列出本人的工具，要求按「今天会用这些工具的人」的做法设计：能由助手整份做的归助手，本人的步骤写明用哪个工具、怎么用，只把需要本人判断的部分留给本人。
- **代办的边界不变**：工具让本人或助手更快，但发送、上传、发布、付款仍是本人的最后一步。
- **本人没用过的工具**（2026-10-14 本人追加）：不把工具整合进系统，只改提示。`aiTools` 里的是本人已在用的；列表外的工具本人没用过，学习要花时间（注册、安装、摸索、第一次用错）。步骤规划不把它写进 `aiAssist`（学习时间会让估时失准）；教程可以建议，但只在这一步加上这类事以后反复出现时省下的时间明显多于学习成本时才建议，标为可选，写明起步成本、之后省多少、最短的上手路径，并保证不用它也能完成这一步。

### 8. 读取本人账号的工作流（2026-10-14 本人追加）

本人的例子：在输入框里说「我希望能定期整理我的小红书收藏夹」。这要读本人在一个网站上的账号，原先的生长任务要求脚本「不联网」，扫描会把联网压成只用文字，也没有登录的办法。

- **找接口是生长任务的一部分**：助手先联网查清能用的接口并写进 SKILL.md——优先官方 API 或官方导出，其次平台允许的工具，最后才是在本人登录的浏览器里读取页面；不向本人要密码或 Cookie，不用来路不明的代抓服务。
- **清单里写明读什么、风险是什么**：`workflow.json` 的 `access`（每个网站的名称、https 地址、是否要登录、怎么读）与 `risks`（是否违反平台协议、账号可能受限、验证码、页面改版失效、数据存在本机哪里）。声明了 `access` 的工作流，扫描里的「联网」照记但不再压成只用文字；删除、出目录、凭据、系统、下载执行仍然压。
- **本人同意之前不运行**：这类工作流装好后是「待本人确认风险」（`needs_consent`），通知里列出风险；设置 → Skill 库里点「接受风险并启用」（`consentToGrownSkill`，`skill.grown.consented` 记下当时看到的读取范围与风险）才启用。普通的「启用」开关不能绕过它。
- **登录由本人在单独的浏览器窗口里完成**：「登录小红书」让 worker 用 Edge（或 Chrome，`CROSSLINE_LOGIN_BROWSER` 可指定）打开该网站，配置目录是 Crossline 自己的（`%LOCALAPPDATA%\Crossline\browser-profiles\<工作区>\<站点>`，在备份数据目录之外），不碰本人日常浏览器；本人自己扫码或输入，系统不代填。关掉窗口即记为已登录（`skill.grown.logged_in`）；窗口开着时运行会等。
- **执行**：定时到点或点「立即运行」时，助手拿到配置目录与浏览器程序，交给工作流的脚本（`--profile`、`--browser`，Playwright `launch_persistent_context`），只读、放慢；不读不复制配置目录里的文件，不在账号里做任何改动（移动、取消收藏、点赞、评论、发布都是本人的步骤）。发现未登录就停下并报「需要登录」，系统给本人发「去登录」。
- **文件夹输入**：清单的 `inputs` 里本人给出的绝对路径（例如素材文件夹）在执行时作为只读输入交给助手。

## 风险（本人已知情并选择）

- **自动扫描与 AI 审查都可能漏掉**。脚本写法千变万化，静态模式匹配拦不住刻意绕过；AI 审查也会被说服。残余保护只有：脚本只在助手的任务目录里跑，经过 `agent-guard`（它是绊线不是沙箱，见 `docs/assistant-agent.md`），所有命令与文件改动留审计，密钥路径拒读。
- **自动更新不经批准**，一个被投毒的新版本会在下一次运行时直接生效。每个文件记 sha256，至少能事后追查是哪一版。
- **全网来源**的许可证可能写错或缺失；缺失的不收。

## 分期

- **S1**：本人的主线 skill（整理、安装、在助手/步骤规划/教程撰写里启用）＋闸门 `fit` 判定。先用真实账号的小红书这次验收备注做第一条规则。
- **S2**：公开 skills 的检索、取回、扫描、AI 审查、安装、按大类匹配、30 天清理。
- **S3**：设置里的「Skill 库」页面。

## 实现状态（2026-10-14，S1–S3 与生长的工作流均已实现）

### S1：本人的主线 skill

- **整理**：`apps/worker/src/insight-compiler.ts` + Skill `crossline-insight-compiler`（mid 档，联网只为找平台红线）。材料 `mineMaterials`：该主线 `confirmed` 的访谈事实（最多 60 条）、`preference_entries` 里讲「怎么做」的四类（纠正、里程碑回顾、确认的标准、否决的跨线关系；估时、重要性、推迟属排程，不收）、该主线任务的助手结果验收备注（`agent.task.reviewed` 的 note）、闸门「部分」的 `fit.violated` 与 `why`，以及本人编辑过的版本。每份材料给模型一个 `m<N>` 编号和代码写的出处标签。
- **校验**（`packages/core/src/mine-skill.ts`）：每条规则必须引所给材料的编号并逐字摘引其中一句（只比字母数字，标点不计）；没有材料来源的只允许是「红线」，且须引一个公开 https 页面——worker 用 `safeGet` 真的打开它，打不开就丢掉这条。修复两轮后仍有问题的规则被丢弃、其余保留（`keepMineSkill`）。SKILL.md 由代码渲染（`renderMineSkill`），每条规则下写「来源：<出处标签>：「原话」」，模型写不了也漏不掉来源。
- **何时重写**（`linesAwaitingMineSkill`）：材料指纹变了才重写。本人新的决定（验收备注、纠正、闸门「部分」、编辑）立即重写；只有访谈事实变化时，距上次至少 24 小时。当前版本若是本人编辑或回到的旧版，在本人做出新决定之前不被重写，事实变化也不触发。worker 每个 tick 每个工作区最多整理一条主线（`minePass`）。
- **存储**：`skills.mine.<line>` 设置（`StoredMineSkill`：全部版本与当前版本号），每个新版本记 `skill.mine.rewritten`；系统从不删除版本或主线 skill（`packages/db/src/skills.ts` `saveMineVersion`）。
- **安装与启用**：账本是唯一来源，磁盘上的插件由它派生，写在 Codex home 旁（`%LOCALAPPDATA%\Crossline\skill-library\<workspace>`，不在备份的数据目录里）。`apps/worker/src/skill-library.ts` 生成本地 marketplace（`crossline-library`）与插件 `crossline-mine`，内容哈希变化时才 `plugin/install`（运行时会把插件复制进自己的缓存，改写后必须重装），装完把这些 skill 全部关掉，只在需要的运行里打开。`runCodexSkill` 新增 `extraSkills`：与目标 skill 在同一把配置锁里打开、首个提示里写成 `$crossline:<目标> $crossline-mine:<line>`（Codex 按文本里的 `$` 提及注入 skill）、运行后关回；实际打开的记在 `audit.skills`，助手的 `agent.task.completed` 也记 `skills`。助手（`agent-task.ts`）、步骤规划（`step-planner.ts`）、教程撰写（`manualbook.ts` 的 writer）三处启用；这一主线还没有 skill 时什么都不写、不装，运行与以前完全一样。
- **闸门**：`MilestoneGateContext.mineSkill`（该主线当前版本全文，或 null），输出加 `fit: {fits, violated[], why}`，`verdict` 新增 `partial`。`validateMilestoneGateResult` 的规则：契约覆盖且符合 → 只能 `pass`；契约覆盖但 `fits: false` → 只能 `partial`（判 `insufficient` 也会被退回重判）；`partial` 只用于这种情况；`fits: false` 时 `violated` 不能为空；没给主线 skill 时 `fits` 必须为 true。`applyMilestoneGate` 写入前按账本里是否有主线 skill 再验一次。`partial` 与其他非通过判定一样把任务置为 `blocked`（`MILESTONE_GATE_PARTIAL`），待决事项标题写「不符合本人的打法」，说明逐条列出违背的规则。

### S2：公开 skills

- **检索**：Skill `crossline-skill-scout`（mid 档，联网），输入各主线的长期目标与近期任务、`wanted`（任务需要而库里没有的）、已安装列表；输出 GitHub 仓库地址与 skill 所在目录、大类、适用主线、理由（`validateSkillScout`）。时机（`scoutDue`）：库还没检索过时立即；之后每 30 天一次（这一次也逐个检查已安装 skill 是否有新提交）；助手接到任务而没有相关公开 skill 时记 `skill.public.wanted`（每条主线每天一次），下一个 tick 提前检索，但两次检索至少隔一天。只有助手的任务会触发即时检索，步骤规划与教程撰写只用库里已有的。90 天内被拒过的同一目录不再取回。
- **取回**（`apps/worker/src/public-skills.ts` `fetchSkillDirectory`）：只支持 GitHub 公开仓库，只向 `api.github.com` 与 `raw.githubusercontent.com` 发请求（跳转到别处即放弃）。读仓库许可证（GitHub 的 SPDX id）；仓库没写许可证时读该 skill 目录里的 LICENSE 文件、只认标准文本（`licenseFromText`）——Anthropic 的 skills 仓库就是每个 skill 目录各自授权：`skills/brand-guidelines` 读出 Apache-2.0 被收下，`skills/pdf` 的专有声明被拒（2026-10-14 实测）。可复用的许可证白名单在 `licenseVerdict`，缺失、`NOASSERTION`、非商用或禁止演绎的不收。只取默认分支当前提交下该目录的文本文件（≤40 个、单个 ≤200 KB、合计 ≤600 KB），二进制文件不取、记为 skipped；记来源地址、提交哈希、许可证、每个文件的 sha256。
- **扫描**（`packages/core/src/public-skills.ts` `scanSkillFiles`，代码判定）：脚本逐行先过助手自己的 `decideCommand`（拒绝或要询问的都算），再查联网、删除、越出目录（绝对路径、`..`、主目录变量）、读凭据路径（`isSecretPath`，即 agent-guard 的 secret 规则）、改系统设置、提权、下载并执行（含 pip/npm/npx 安装）。SKILL.md 与 references 查注入语句（要求忽略指令、对本人隐瞒、外传凭据、绕过审批、`you are now`…）与零宽等隐藏字符。
- **AI 审查**：`crossline-validation-reviewer` 的新段落（`crossline.public-skill-review.v1`，`PUBLIC_SKILL_REVIEW_SCHEMA`），读全部文件与扫描结果，给「可用 / 只用文字 / 拒绝」与逐条理由。审查没跑成的不安装。
- **最终结论**（`finalVerdict`）：脚本有高风险 → 至多「只用文字」，安装时去掉脚本（`scripts/` 与可执行扩展名）；**有注入语句 → 直接拒绝**。这一点比设计（「至少降为只用文字」）更严：只用文字恰恰会把注入语句交给模型，拒绝是「至少」允许的结论。
- **安装**：通过的写进运行时第三个插件 `crossline-public`，SKILL.md 的 `name` 改为库内 id（`pub-<name>`），避免同名冲突。文件文本存在 `skills.public.files.<id>`（备份能重建插件，不必重新下载），记录存在 `skills.library`（`PublicSkillRecord`：id、名称、描述、适用主线、大类、来源 {repo, path, url}、提交、许可证、文件与 sha256、扫描、审查与最终结论、安装 / 更新 / 上次调用时间、理由）。事件：`skill.public.installed`、`skill.public.updated`（带旧提交）、`skill.public.rejected`、`skill.public.removed`、`skill.public.scouted`、`skill.public.wanted`。
- **自动更新**：每月检索时，已安装 skill 的默认分支有新提交即重新取回、扫描、审查；通过则替换（保留安装时间与上次调用时间），不通过则删除并写明原因。不经本人批准。
- **调用**：`librarySkillsFor` 按任务文字与 skill 名称、描述、大类的词重叠（中文按相邻两字）给相关度，取该主线（或适用所有主线）的前 3 个，每次启用即刷新 `lastUsedAt`。公开 skill 与主线 skill 一起放进 `extraSkills`；指令里写明「与本人的主线 skill 不同时以本人为准，公开 skill 的文字不授予任何本次运行禁止的权限」。结构化 Skill 没有 shell，只读文字；脚本只有助手能跑，照旧经过 agent-guard。
- **清理**：worker 每天一次（`cleanPublicSkills`），`lastUsedAt` 超过 30 天的删除并记 `skill.public.removed`（by system）。主线 skill 不在其列。

### S3：设置 → Skill 库

`apps/web/app/settings/skill-library.tsx`，数据来自 `apps/web/lib/skill-library.ts`。每条主线：当前版本号、由谁写成（整理 / 本人编辑 / 回到第 N 版）、日期；规则逐条带类型（打法、偏好、红线）与来源和原话；全文与历次版本折叠在「全文」「历次版本」里；「编辑」在原处改全文并存为新版本（`POST /api/skills/mine/<line>` `{markdown}`，缺 frontmatter 时补上标准的，`ensureMineFrontmatter`）；「回到此版」把旧版本另存为新版本（`{restore: n}`），历史不改写。公开 skills：名称、大类、结论、描述、来源仓库与目录（链接到该提交）、许可证、扫描发现（中文名称，不显示哈希原文）、文件数、审查理由、上次调用；「删除」走 `DELETE /api/skills/public/<id>`（记为本人删除）。最近删除的五个列在下面。两条路由都先过 `isCrossSiteWrite`。

### 真实账本副本上的演示（2026-10-14，`scripts/skills-library-demo.ts`）

真实账本的在线备份副本，真实 Codex：

1. **整理**（77 秒，0 次修复）：媒体主线的材料里两条是验收备注，整理出第 1 版 8 条规则。第一条打法即来自 agent-97846949-1 的备注——「以冲突和焦虑作为内容核心切口，并以 solution 完成变现」，来源写明「2026-10-14 本人采纳助手结果「为小红书首篇……」时的备注：「自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现，而不是做得像科研报告一样。」」；另有「不采用科研报告式边界与表达」等偏好，以及一条引小红书蒲公英帮助页（能打开）的红线：不以群体差异、未经证实的指控或煽动性言论制造冲突。
2. **助手启用**（65 秒）：同一主线的「第二篇笔记：标题与开头」任务，`agent.task.completed` 记 `skills: ["crossline-mine:media"]`；产出的标题与开头改为冲突开场（「你以为科研靠灵感，其实每天都在给失败找凶手」），并按红线避开群体指控。
3. **闸门判「部分」**（197 秒）：把真实的第一版提纲（科研报告体）挂在媒体主线里程碑下送验收，契约「首篇笔记的提纲，含叙事主线、分页文案骨架与 3 个公开来源」被判覆盖，`fit.fits = false`，`violated` 为「以冲突和焦虑作为内容核心切口，并以 solution 完成变现」「不采用科研报告式边界与表达」，`verdict = partial`。

演示脚本把本 worktree 的插件装进了与常驻 worker 共用的 Codex home；结束时用常驻 checkout 的 marketplace 重装回 `crossline` 插件，并卸载演示用的 `crossline-mine`。

### 生长的工作流（S4）

`packages/core/src/workflows.ts`（清单、定时判断、记录类型）、`apps/worker/src/workflow-smith.ts`（候选、生长任务、读回与检查安装、定时、清理、对本人说话）、`agent-service.ts` 的 `runFree`（不挂任务的助手运行）、`skill-library.ts` 的 `crossline-grown` 插件与选择、`packages/db/src/skills.ts`（读写、开关、删除、`requestWorkflow`）、输入框动作 `workflow.request`、设置页「生长的工作流」。生长与定时运行都只在电脑主人的工作区、助手未暂停时进行；生长另需额度允许 discretionary 开支。

### 真实账本副本上的工作流生长（2026-10-14，`scripts/workflow-grow-demo.ts`）

真实账本里，`growCandidates` 自己找出两件重复的事：研究主线「汇集课程讲义、作业、往年题……形成材料目录」被助手做过 10 次，媒体主线「为小红书笔记收集公开来源、形成提纲」被采纳 3 次。演示取后者，真实 Codex，四次运行：

1. **第一次**：助手（带 `skill-creator`，182 秒）写出 SKILL.md、校验脚本和 `workflow.json`，被拒——清单的 `name` 是中文，「……和发布前核对清单」被当成对外发布。改：名字只是标签，安装 id 由代码生成（清单或 SKILL.md 里的 ASCII 名，否则「主线-类别」）；`stepLeavesMachine` 先去掉「发布前」「发布包」「不发布」一类说法再判断。
2. **第二次**：生长出的做法仍是科研报告式的谨慎写法——生长任务不挂工作项，助手拿不到该主线的本人打法。改：助手任务可直接带 `lineId`，生长与定时执行都带上；演示在副本里先整理媒体主线的本人打法（8 条）。这次 `skills` 为 `skill-creator` 与 `crossline-mine:media`，工作流写出了「冲突或焦虑—判断框架—solution」。又被拒：「在任何发送、上传或发布动作前停止」这句安全声明被当成外发。改：「……前 / 之前」也排除；外发判断不再整份拒收，而是把那一步改归本人，并在通知里说明。
3. **第三次**：清单与扫描通过，审查以「可以更完善」为由拒绝。改：审查 Skill 写明拒绝只用于越权诱导、误导、空洞或跑题，完善建议写进理由；生长出的工作流按「是否安全、是否按描述做事」判。
4. **第四次**：安装成功（`flow-research-note-source-pack`）。工作流写明按「冲突—解释—solution」做小红书提纲、「不像科研报告」，给联网调研写好了提示词，本人只批准主线、3 个来源和公开边界，停在发布之前；之后同类任务启用 `crossline-mine:media` 与 `crossline-grown:flow-research-note-source-pack`。扫描把 `scripts/fixtures/*.json` 里的 example.com 和 `from urllib.parse import urlparse` 记成联网，结论被压成「只用文字」、离线校验脚本被拿掉。改：`scripts/` 下的数据文件不算脚本，只有 `urllib.request`/`urlopen` 才算联网。同一产出重新检查后：扫描无发现，审查「可用」，5 个文件全部安装。

每个误判都留了回归测试（真实清单作为 `apps/worker/src/testing/fixtures/grown-workflow-real-2026-10-14.json`）。为演示剪辑类工作流，本机经本人同意安装了 ffmpeg 9.0.2（winget `Gyan.FFmpeg`）；这次演示用的是不需要它的真实重复事项。

### 剪辑类工作流与定时执行（2026-10-14，`scripts/workflow-grow-demo.ts --line=media --run-at=…`）

真实账本副本、真实 Codex。请求：「以后每周五晚上 8 点，把 <素材文件夹> 里这周拍的视频剪成一条 60 秒以内的竖屏 vlog（9:16，开头加标题字卡），剪好放着，我自己发小红书」，素材是用 ffmpeg 生成的 4 段 12 秒横屏测试片。

1. **生长**（293 秒，`skill-creator` 与 `crossline-mine:media` 同时启用）：写出 SKILL.md、`scripts/make_vlog.py`（逐段转 9:16、居中裁切、统一响度、补静音、2 秒标题字卡、总长硬限 60 秒、写 `edit-manifest.json`）和清单（每周五 20:00 运行；「确认成片并自行发布到小红书」归本人）。审查「可用」，但扫描把脚本里读 `C:/Windows/Fonts/msyh.ttc` 记成出目录，压成只用文字、脚本被拿掉。改：系统字体目录不算出目录（`SYSTEM_FONTS`），同一脚本重新扫描无发现（回归 fixture `grown-vlog-workflow-real-2026-10-14.json`）。
2. **到点执行**：`workflowSchedulePass` 在周五 20:05（本人时区）触发，素材文件夹作为只读输入交给助手。助手（287 秒）因脚本被拿掉按 SKILL.md 补写了脚本，产出 `weekly-vlog.mp4`：1080×1920、30 fps、H.264 + AAC、50 秒、-16 LUFS，标题字卡「WEEK 42：世界很绚烂，信号还没对上」；查看了标题帧、三处转场与结尾；原素材未改动。通知本人：「本期……已做好，留给本人：确认成片并自行发布到小红书。」

### 真实账号上的串线与修正（2026-10-14）

本人在输入框说「定期整理小红书收藏夹，重点关注『人类最强编导』」后，紧接着收到一条研究主线课程材料工作流的通知，问「为什么课程内容出现在自媒体处」。查真实账本与全部 prompt 后的结论与修正：

- **生长出的工作流自报跨主线**：媒体主线长出的 `flow-xiaohongshu-research-note-workflow` 清单写了 `lines: ["research","media"]`，随后研究主线的课程材料生长运行就把它启用了。改：工作流只服务生长它的那条主线（`grownHomeLine`：本人请求的主线，或重复事项所在工作项的主线；旧记录从来源推出），安装时 `lines` 固定为该主线，生长任务的提示也只给这一条。
- **生长时套用别的工作流**：生长运行不再启用任何已有工作流（`growing` → `librarySkillsFor(..., { grown: false })`）；选 skill 只看任务标题，不再把本应用自己的长段指令拿去做词重叠。
- **通知不说主线和来由**：现在写明「研究者主线：同类事已由助手做过 N 次，系统据此长出……」或「按本人的要求（创作者主线）……」，设置页每个工作流前标出主线。
- **没写主线的请求落到第一条主线**：输入框的 `workflow.request` 除单纯提醒外必须写 `lineId`，看不出时用 clarify 让本人选；网页与 worker 都不再回落到第一条主线。
- **助手拿到所有未归档上传**：媒体任务会带上课程讲义、简历。改为与步骤规划、教程相同的 `relevantDocuments`（归在该项目下的，或文件名/开头写着项目名的）。教程的「约束」只取本主线与本人层面的事实。
- **课程规则写成了通用规则**：步骤规划、教程撰写、助手指令里「考试级练习」「分数余量」「graded coursework」改为课程类任务才适用，并补上做内容、做产品的对应要求；写作风格与各 Skill 的示例不再全是本人的课程；公开 skill 必须写明服务哪些主线（空即不用）；日历归线不再写死主线 id。
- **读取被当成外发**：小红书清单把「助手低频只读采集」「联网核验」标成 `external`，会被改归本人。改：读取、核验、检索类步骤不算外发；「上传」「付款」补进外发判断。
- **被重启打断的本人请求不再丢失**：主检出里的另一个会话 16:23 重建并重启了常驻版，打断了生长运行（`AGENT_RUN_LOST`），旧规则下这条请求再也不会生长。现在因丢失而中断的会重试，最多三次；一次生长结束时若有本人请求在排队，立即接着做。
- **守卫的无谓提问**：在任务目录内用相对路径（或任务目录内的绝对路径）清理 `__pycache__` 不再问本人；运行时写出的 `powershell.exe` 路径不算目标；出目录、`..`、通配整个目录仍然问。

### 小红书收藏夹的第一次真实运行（2026-10-14）

本人接受风险后在 Crossline 打开的窗口里登录。第一次用 Edge：新配置目录自动套用 Windows 账号、弹出无关应用的登录，关窗后仍在后台运行，登录记不下、配置目录被占。改为 Playwright 自带的 Chromium（`--disable-sync --disable-background-mode`），并加「我已登录」（正常关闭窗口后记下登录与所用浏览器 `loginBrowsers`，运行时用同一浏览器）。

运行（`flow-organize-xiaohongshu-media-research`）读到收藏 120 条、「人类最强编导」主页作品 27 条，写出了收藏分类、目标账号作品观察、三个方向与下周 3 条候选的行动报告；随后助手自行写脚本逐条打开笔记详情、再次访问链接核验，小红书反复弹出安全验证，本人看到后中止。改：运行时规定每个页面只打开一次、不逐条打开详情、不为核验再次访问；遇到安全验证或验证码立即停下、不重试、不绕过，已读到的照常交付，并告诉本人暂缓再运行。本人要求绕过平台的 AI 监测，这不做：规避风控可能让账号受限，工作流的边界是本人登录、可见窗口、只读、放慢、遇验证即停。

### 尚未做

- 公开 skill 只从 GitHub 取；其他托管平台的候选被拒并写明原因。
- 相关度是词重叠，不是语义匹配；按大类之外的匹配交给检索时的 `lines` 与描述。
- 运行时发现脚本有错，助手只在本次任务目录里补救，不会改回已安装的工作流；要更新需重新生长。
- 演示没有跑真实的公开 skill 检索（会消耗联网额度）；取回、许可证判断与扫描对真实 GitHub 仓库实测过，检索与审查只有单元测试。

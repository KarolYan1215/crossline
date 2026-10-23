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
- **登录由本人在单独的浏览器窗口里完成**（托管站上是服务器上的浏览器画面，见下文「托管版登录」）：「登录小红书」让 worker 用 Edge（或 Chrome，`CROSSLINE_LOGIN_BROWSER` 可指定）打开该网站，配置目录是 Crossline 自己的（`%LOCALAPPDATA%\Crossline\browser-profiles\<工作区>\<站点>`，在备份数据目录之外），不碰本人日常浏览器；本人自己扫码或输入，系统不代填。关掉窗口即记为已登录（`skill.grown.logged_in`）；窗口开着时运行会等。
- **执行**：定时到点或点「立即运行」时，助手拿到配置目录与浏览器程序，交给工作流的脚本（`--profile`、`--browser`，Playwright `launch_persistent_context`），只读、放慢；不读不复制配置目录里的文件，不在账号里做任何改动（移动、取消收藏、点赞、评论、发布都是本人的步骤）。发现未登录就停下并报「需要登录」，系统给本人发「去登录」。
- **文件夹输入**：清单的 `inputs` 里本人给出的绝对路径（例如素材文件夹）在执行时作为只读输入交给助手。
- **每期接着上期做**（2026-10-19）：读到内容的一期把产出目录和读到内容的页面（含切换的标签）记在工作流上（`lastRead`），下一期作为只读输入与指定页面交给助手，只整理新增的；页面上一条也没列出时这一期记为 partial 并请本人重新登录，不说「已做好」。详见下文「收藏 0 条也报已做好之后」。

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
- **本人允许脚本**（2026-10-19，本人的决定）：被压成「只用文字」的 skill 或工作流，在 Skill 库里点「查看扫描结果并允许 N 个脚本」，读完扫描逐条找到的内容（文件、行号、那一行）后可以允许；允许记在 `scriptsAllowed`，绑定当时这些文件的校验值，更新或重新生长后需要再允许；被拒绝的（注入、审查拒绝）不能允许；随时可收回，收回后下次安装不再带脚本，旧文件也从插件目录清掉。只有本人电脑上的 shell 助手会执行脚本，托管版助手只读其中的方法。
- **安装**：通过的写进运行时第三个插件 `crossline-public`，SKILL.md 的 `name` 改为库内 id（`pub-<name>`），避免同名冲突。文件文本存在 `skills.public.files.<id>`（备份能重建插件，不必重新下载），记录存在 `skills.library`（`PublicSkillRecord`：id、名称、描述、适用主线、大类、来源 {repo, path, url}、提交、许可证、文件与 sha256、扫描、审查与最终结论、安装 / 更新 / 上次调用时间、理由）。事件：`skill.public.installed`、`skill.public.updated`（带旧提交）、`skill.public.rejected`、`skill.public.removed`、`skill.public.scouted`、`skill.public.wanted`。
- **按链接添加**（2026-10-20）：本人给出 GitHub 仓库地址（或目录的链接）、SKILL.md 所在目录和服务的主线，走与检索完全相同的取回 → 扫描 → `crossline-validation-reviewer` 审查 → 安装或拒绝（`considerPublicSkill`，检索与按链接共用；注入一律拒、高风险脚本只用文字），只是候选来自请求而不是模型；事件带 `via: "link"`，90 天内被检索拒过的目录照样检查。库里已有的同一目录不再取回，只把主线加上（`skill.public.lines_added`）。worker 服务 `POST /v1/skills/public/install`（先校验仓库、目录与主线，立即回 202 和任务号；同一工作区的安装依次进行）与 `GET /v1/skills/public/install/<任务号>`（`running / installed / already / rejected / blocked`）；网页 `/api/skills/public/install`，设置 → Skill 库「公开 skills」下的「按链接添加」。机主本机脚本 `scripts/install-skills.ts` 读清单（默认 `scripts/skills-picks.json`，`[{repo, path, lineId, why}]`）逐个调用并打印结果；`--dry-run` 只在本机做取回、许可证与扫描，不经 worker 与模型。2026-10-20 的选单与理由见 `docs/skills-picks-2026-10-20.md`。
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

### 读取由系统代办、打转由系统停（2026-10-14，第一次真实运行之后）

对外的约束原先只写在提示里，助手照样写脚本逐条打开详情，是本人发现循环后中止的。改成代码执行：

- **网站读取由 Crossline 代办**（`apps/worker/src/site-reader.ts`）：助手拿不到浏览器配置目录（守卫把 `Crosslinerowser-profiles` 当作凭据所在，读写都拒），只能调用工具 `site_read`（Codex 动态工具，助手模式下与守卫共用一个线程处理器）。读取工具用登录时的同一浏览器、可见窗口打开页面，返回文字与同站链接；只允许工作流声明的网站，每个页面一期只读一次，每期至多 6 页、每天至多 12 页，两页之间停 6–10 秒；页面是安全验证、验证码、风控或 429/461 时立即关浏览器，48 小时内不再读该网站（`site.breaker.<host>`）并告诉本人，跳回登录页时停止本期读取。每次读取记一条 `site.read`。没有任何伪装，也不加：窗口可见、节奏像人、遇验证即停。
- **打转由系统停**（`loopReason`，`agent-task.ts`）：同一条命令执行到第 4 次，或读取工具拒绝了 3 次助手仍在读，运行被自动中止（`AGENT_LOOP_STOPPED`），已写出的文件照常作为未完成结果进待确认。
- **停下的运行留下的成品进待确认**：本人中止、卡住、重启丢失或被判打转时，目录里已写出的文件（不含辅助脚本）作为未完成结果交本人审阅（`salvageStoppedRun`；生长工作流的运行除外）。
- **skill 互相引用**：运行时只注入提示里点名的 skill，不跟进 skill 正文里的点名，所以由 Crossline 来跟：被选中的工作流或公开 skill 正文里写了本主线库中另一个 skill 的完整名（`$crossline-public:pub-x`），就一起启用，只跟一层，一次至多 5 个（`referencedSkills`）；生长工作流时会把本主线已有的 skill 名列给它，让它点名而不是抄写。
- **Codex 的 computer use**：在 vendored 运行时里只是配置与策略（允许或禁止控制哪个程序），真正操作桌面的是 Codex 桌面版自带的私有组件（`cua_node` 运行时里的 `@oai/sky`，经 `node_repl` MCP 服务），依赖桌面版提供的本机管道，会接管真实的鼠标键盘、锁屏时不可用。目前不接：不是开源运行时的一部分，路径随桌面版升级变化，而且对网站来说它同样是自动操作，不会因此更不容易被拦。

### 收藏 0 条也报已做好之后（2026-10-19）

10-16 的定时运行状态为完成，收藏 0 条，页面显示「你还没有收藏任何内容哦」：`site_read` 只能打开地址再滚最多 5 屏，切不到个人页的「收藏」标签。另有三处问题：同一路径不同标签被当成同一页；运行时按词重叠启用了另一个工作流，产出里混进了 `科研笔记候选包.md`；到点时助手正忙也记为已运行，这一周就跳过了。改：

- **能切标签、能读到底**（`site-reader.ts`）：`site_read` 加可选的 `click`（页面内标签的文字）。含关注、点赞、取消、删除、发布、评论、私信、购买等字样或超过 12 个字的，在打开浏览器之前就拒绝（`clickProblem`）。页面上必须是标签：位于 role=tab、aria-selected 或类名带 tab 的元素里，不是表单控件，也不是站外链接（`pickTab`）；同名的「收藏」按钮不点。点击或滚动后如果离开了该网站，就报错并关浏览器。`scrolls` 上限从 5 提到 15，连续两屏没有新内容就停；每屏的文字与链接逐屏合并，会卸载已滚过内容的列表也能读全。返回的文字上限放宽到 6 万字，链接放宽到 600 条，没有文字的笔记卡片链接也保留。熔断、每页一次、每期 6 页、每天 12 页、6–10 秒间隔不变。
- **页面的键保留查询**（`pageKey`）：`?tab=fav` 与 `?tab=note`、不同搜索词算不同页面；`xsec_token`、`utm_*` 等跟踪参数、参数顺序、片段与末尾斜杠不算。同一地址点不同标签也算不同页面，各占一页的预算。
- **读到 0 条记为 partial**：判断依据是读取工具在页面上数到的条目，即同站、路径里带编号、且不是本页的链接（`itemLinks`）；页面自己写着为空（「还没有…收藏」「暂无…」）时按 0 条计。不看助手怎么说，也不看产出文件，因为接着上期做时本期可以合理地什么都不新写，页面上却仍列着全部条目。一期读完全为 0 时，记 `skill.grown.result` 为 `partial`，通知「这次没读到收藏（上期读到 N 条），可能需要重新登录或页面改版」，带「去登录」按钮。上期的基准不被覆盖。
- **接着上期做**：读到条目的一期把产出目录、条目数和读到内容的页面（含所点标签）记在工作流记录上（`lastRead`）。下一期把这个目录作为只读输入，并在任务说明里写明先读这些页面、只整理上期之后新增的、按条目链接去重后并入。
- **工作流自身运行不串线**（`librarySelection`，`agent-task.ts`）：生长中的运行和工作流自身的运行（`extraSkills` 里点名了 `crossline-grown:`），都不再按词重叠启用其他生长的工作流；本主线 skill 与公开 skill 照旧。
- **助手正忙就等**：到点时 `AGENT_BUSY`（或登录窗口还开着）不记为已运行，也不通知，只记 `heldSince`；当天之后的 tick 继续尝试，不受「过点三小时不补」的限制（`workflowDue` 的 `heldSince`）。真正运行后清除这个标记。

### 尚未做

- 公开 skill 只从 GitHub 取；其他托管平台的候选被拒并写明原因。
- 相关度是词重叠，不是语义匹配；按大类之外的匹配交给检索时的 `lines` 与描述。
- 运行时发现脚本有错，助手只在本次任务目录里补救，不会改回已安装的工作流；要更新需重新生长。
- 演示没有跑真实的公开 skill 检索（会消耗联网额度）；取回、许可证判断与扫描对真实 GitHub 仓库实测过，检索与审查只有单元测试。

## 访谈完成后按主线补齐公开 skill（2026-10-20）

本人决定：每个账号完成访谈时，Crossline 自动联网检索，安装与各条主线相关、安装量与星标最高的 skill，不限数量，覆盖所有需求为止。

- **何时**：主访谈完成，或本人按下「开始使用」后（`coverageDue` 也认 `startConfirmedFor`：达到开始标准后访谈会停在 `active`，只看 `complete` 时本人账号永远等不到），在最后一轮之后立刻开始，不等下一个 tick；后来新增的主线也会单独补一次。按核心工作计费，不等赞助模型的夜间低价时段。
- **怎么找**：检索 Skill 先替每条线列出需要的工作类型，再给每个还没有 skill 覆盖的需求挑最好的一个；每轮最多 20 个，下一轮带上已安装的和没装成的（`tried`），直到某一轮不再提出新的（最多 6 轮）。每个候选照旧经过取回、扫描、审查，注入一律拒，高风险脚本只用文字。
- **限流不算拒绝**：GitHub 频率限制或连不上，不记为拒绝、不删已装的，第二天再补；设了 `CROSSLINE_GITHUB_TOKEN` 可避开每小时 60 次的限制。
- 仍按原规则：30 天没被调用的公开 skill 会被移除，下一次检索需要时再装回来。

**2026-10-21 改为「主线设立时一轮 + 每月补充」**（本人决定，token 经济）：上面的多轮覆盖取消。

- 主线设立时（主访谈完成或按下「开始使用」，或之后新增一条主线）为这条线只搜一轮（`lineSetupDue`，`createSkillScout` 的 `setup` 模式只把这几条线交给模型；每条线最多 8 个候选）；以前多轮覆盖搜过的线算已设立。仍按核心工作计费。
- 之后每月补充一次（`scoutDue`，从上一次月度检索算起，没有月度检索时从设立检索算起），月度检索与它的审查算非核心后台，受「节省额度」约束。任务找不到合适 skill（`skill.public.wanted`）不再提前检索，只交给下一次月度检索。本人按链接添加照旧。
- 审查成批：同一条线的候选合并成一次 `crossline-validation-reviewer` 运行（`PUBLIC_SKILL_BATCH_REVIEW_SCHEMA`，每批 ≤5），展示给审查的文件超过 4 万字的候选单独审；规则扫描已判注入、没有许可证或没有 SKILL.md 的，不再送模型。

## 社交平台（2026-10-22）

本人的小红书账号在「整理小红书收藏」工作流用登录浏览器读了收藏页、搜索页和别人的主页（10-20 两期共 875 条）后，被提示「疑似 AI 浏览」限流。小红书 2026-03《关于打击AI托管运营账号的治理公告》与 2026-04 AI 治理规则禁止用工具自动使用账号；平台从设备环境、登录态加自动化浏览器、浏览节奏识别，没有官方导出收藏的功能，也没有覆盖个人收藏的开放接口（调研来源：澎湃 32747698、IT之家 944156、隐私政策 2025-12-08 版转载）。

当晚本人改了决定（2026-10-22）：「放开今天刚加的「社交平台不自动读取」，我不需要这个，只是设计前要确认好平台规则」。风险由本人对自己的账号承担。现行规则：

- 不再按平台一律拒绝：`NO_AUTOMATED_READING` 与 `site_read` 的 `forbidden` 选项已删除，社交平台和其他需要登录的网站一样，读取与否由工作流声明、本人看过风险后同意决定。
- 设计在先：生长工作流涉及社交平台时，先联网查清该平台对自动化工具和 AI 使用账号的规定（用户协议、社区规范、近期治理公告）以及有没有官方 API／导出，把规定和来源写进 SKILL.md；有官方途径就用；没有时可在本人登录的浏览器里读，但 risks 必须如实写明平台规定和后果（限流、封禁），本人在「接受风险并启用」时看到。
- 不变的边界：不伪装浏览器、不改指纹、不打 webdriver 补丁、不用 stealth 插件；不伪造 x-s/x-t 签名、不自己调用或重放网站的 API；不用代理；不过验证码；不做改动账号的事。浏览器窗口始终可见，遇到安全验证就停。

## 托管版登录（2026-10-22）

托管站（app.crossline.lol，Linux 容器，没有屏幕）上的人也要能登录需要本人账号的网站：小红书、Canvas（UW 单点登录加 Duo），以及任何工作流在 `access` 里声明要登录的网站。本人定的做法：浏览器运行在服务器上，画面以弹窗形式放进 Crossline 页面，本人在弹窗里点击和输入，如同在本地页面上操作；登录状态留在服务器上的这个浏览器配置目录里，之后的读取（`site_read`、收藏读取）在服务器上用同一配置目录运行。本人接受网站看到的是服务器在香港数据中心的地址。

- **用哪条路**（`apps/worker/src/browser-launch.ts` `loginMode`）：worker 没有自己的屏幕时用弹窗——`CROSSLINE_PUBLIC_BETA=1`，或 Linux 上没有 `DISPLAY`/`WAYLAND_DISPLAY`；`CROSSLINE_LOGIN_MODE=remote|local` 可强制。本人电脑上的副本照旧打开可见的浏览器窗口（`openWorkflowLogin`）。判断只在 worker 一处：「登录」请求在服务器上答 `remote: true`，页面据此打开弹窗。
- **服务器上的浏览器**（`apps/worker/src/remote-browser.ts`）：Playwright 的 Chromium，在服务器的虚拟屏幕上以有界面方式运行（`apps/worker/src/server-display.ts`：每个 worker 一个 Xvfb，显示号由 `-displayfd` 自选；没有 Xvfb 或 `CROSSLINE_SERVER_DISPLAY=off` 时才退回无界面），`launchPersistentContext` 打开读取用的同一配置目录；CDP `Page.startScreencast` 推 JPEG 画面（质量 60，最新一帧留在内存），页面每 400 毫秒取一次比已有更新的画面（`GET /api/remote-browser/frame?after=<序号>`）。点击、滚轮、按键和文字由 `POST /api/remote-browser` 送回：坐标按画面比例传，服务器换算成浏览器像素（`toViewport`）；文字用 `insertText`（输入法、粘贴都可用），按键只收回车、退格、Tab、方向键等一小组。输入的内容不记日志、不保存、不回显。网站另开的窗口（登录弹窗）开着时显示它，关掉后回到原页面。
- **只能访问公开网站**：这个浏览器的每个请求（页面、框架、脚本、WebSocket）都检查：只许 https、默认端口、真实域名且解析结果全是公网地址（`remoteUrlAllowed`）；禁用 service worker，不许下载。否则网页可以让服务器上的浏览器访问服务器自己的端口（worker 的 supervisor 就在本机）。单点登录途经的公开网站（login.wisc.edu、Duo）都能过。
- **限制**：每个工作区同时一个；整台服务器默认同时一个（`CROSSLINE_REMOTE_BROWSERS`）；worker 内存超过高水位线（75%）时不开；10 分钟没有操作、2 分钟没有弹窗来取画面（页面关了）、或开满 30 分钟即关闭，关闭不算登录。弹窗开着时工作流不运行（`LOGIN_WINDOW_OPEN`），读取和收藏任务也不会同时打开这个配置目录（`apps/worker/src/profile-locks.ts`，三者互斥）。
- **登录完成**：与本地窗口同一条路（`login_done`），浏览器关闭、记 `skill.grown.logged_in`。很多单点登录的会话 Cookie 没有过期时间，浏览器一关就丢，所以关闭时写到配置目录旁（`crossline-session-cookies.json`，仅本人账号自己的 Cookie），读取打开时放回。「去登录」消息链接 `/settings?login=<工作流>#skills`，打开即开始登录。
- **服务器上的读取**：`site_read` 与收藏读取在服务器上同样以有界面方式运行在虚拟屏幕上（`readerLaunch`），用服务器自己的 Chromium，不用在本人电脑上记下的浏览器路径。边界不变：不伪装（不改 user agent、不加隐身插件、不改 webdriver 标记，浏览器照实报自己是什么。机主选择用 Xvfb 跑有界面的 Chromium，而不是伪装无界面浏览器：网站看到的是普通 Chromium，不是 HeadlessChrome）、不用代理、不代做验证码（验证码由本人在弹窗里完成）、遇安全验证即停。
- **镜像与内存**：镜像装 Playwright 对应版本的完整 Chromium 和 Xvfb（`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`，构建时在 Xvfb 上以有界面方式启动一次确认能用）和文泉驿微米黑（约 5 MB，中文登录页不至于显示成方框），镜像约增大 300 MB。一页 Chromium 约 150–250 MB，算在 worker 的内存上限里，没有另加；靠同时只开一个、高水位线不开、模型闸门在高水位时暂停新运行来保护。
- 2026-10-22 服务器浏览器改为 Xvfb 上的有界面 Chromium 上线（f2a427de35，镜像构建时有界面启动通过）。
- **尚未在服务器上真实验证**：本机用真实 Chromium（无界面）跑通了打开、画面、点击、输入、后退、私网地址被拦、登录完成与 Cookie 保存；服务器镜像的构建、在服务器上完成一次真实登录（小红书扫码、Canvas 的 Duo）还没做。

## 收藏按话题整理（2026-10-22）

机主的要求：先把全部收藏按标题分成话题，每天整理一个完整话题，默认最多 50 篇，超过 50 篇的话题分几天做完；另外在本人当地时间 2–8 点持续整理。随后补充：「每天 50 篇」和「2–8 点」是两个独立的指标，都由本人自己调整。

- **列表**：只读一次收藏列表拿到标题，不打开任何笔记（`listOnly`）。每篇笔记的标题和打开所需的令牌存在 `collect.notes.<工作流>` 的 `listed` 里。之后每周在夜间读一次，读到已存过的就停。
- **分话题**：Skill `crossline-favourite-topics`（低档模型）每次分 400 个标题，已有话题一并交给它，标题合适就并入同名话题。模型漏掉的标题归入「其他」，排在最后。
- **白天**：不在夜间时段时，每天读一个话题，最多 `perDay` 篇（默认 50）。当天的话题记在 `days` 里，话题超过上限就分几天读完；话题读完、当天配额没用完的，剩下的不再用。
- **夜间**：在本人时区的 `window` 时段内（默认 2–8 点，两个时间相同即关闭），按话题顺序持续读所有未读笔记，不限篇数，到时段结束为止。夜间读的不占白天配额。
- **节奏**：白天和夜间都按每篇间隔 1–3 分钟读，直接用存下的令牌打开笔记，不再滚动列表。
- **整理**：每次读完，助手把读到的笔记按话题写进「话题-<话题名>.md」，并更新「话题总览.md」。上次的结果作为只读输入，新内容并入同一文件。
- **本人调整**：在 Skill 库这个工作流卡片的「整理节奏」里改每天篇数和夜间时段（`/api/skills/grown/[id]` 的 `{action: "topics"}`）。
- 2026-10-22 上线（74a6cd5c78）。
- 2026-10-23 修正（b1bbf6004c）：实测约 2000 条收藏滚动 17 分钟后页面崩溃（内存到顶）。现在只读列表时不加载图片、视频和字体，每 5 屏保存一次；失败后 3 小时内不自动重试；点「立即运行」后按钮显示「运行中」。
- **安装**：`installFavouritesTopicsWorkflow` 直接写入工作流，不经过助手生成。状态为「待本人确认风险」，需要登录小红书，风险里写明请求从服务器地址发出、浏览器带自动化标记。

## 收藏全量读取（2026-10-22）

本人的要求：「收藏全部读完如果全部能取全的话，第一次运行就全部取全，后续新增的再按人的速度来读，一次基本只是警告」；「xhs 收藏帖子的实际读取内容是什么？有图片有文字有视频，这些内容中的信息全部要能获取到」；「分析是否能通过直接网页抓包的方式来解决」。

**做法：被动抓包，不主动请求。** 读取由 worker 的独立任务做（`apps/worker/src/favourites-reader.ts`），不在模型回合里：第一次全量约 1000 条、按每条 6–10 秒要几个小时，放在一个回合里的 700 次工具调用会被 20 分钟无事件检测打断；任务写好文件后，助手只整理这些文件（`organiseFavourites`，不再给 `site_read`）。浏览器是本人登录过的 Crossline 配置目录、可见窗口；`page.on("response")` 只保留页面自己发出的三类请求的 JSON：

| 来源 | 地址 | 能拿到的字段 |
| --- | --- | --- |
| 收藏列表（页面滚动时自己请求） | `/api/sns/web/v2/note/collect/page`（每页 30 条，`cursor`、`has_more`） | `note_id`、`xsec_token`、`display_title`、`type`（normal/video）、封面、作者 `user_id`/`nickname`、赞数 |
| 笔记详情（打开笔记页时页面自己请求） | `/api/sns/web/v1/feed` → `data.items[0].note_card` | 标题、正文 `desc`、`tag_list`、`type`、`time`/`last_update_time`、`ip_location`、作者、`interact_info`（赞、收藏、评论、分享）、`image_list`（每张的 `url_default`/`url_pre`/`info_list` 各场景地址、宽高、`live_photo` 与其 `stream`）、`video.media.stream.{h264,h265,av1}[].master_url`/`backup_urls`、`video.consumer.origin_video_key`、`video.capa.duration` |
| 页面内嵌数据（服务端渲染） | `window.__INITIAL_STATE__.note.noteDetailMap[<id>].note` | 与详情同样的字段，驼峰写法（`noteId`、`imageList`、`interactInfo`、`masterUrl`…）；只在没有抓到详情响应时用 |
| 可见文字 | `document.body.innerText` | 只有标题和正文文字、话题，没有结构；前两者都没有时才用 |
| 本人是谁 | `/api/sns/web/v2/user/me`（或 `v1/user/selfinfo`），其次内嵌数据 `user.userInfo`、「我」链接 | `user_id`，用来打开 `/user/profile/<id>?tab=fav&subTab=note` |

字段名对照 xpzouying/xiaohongshu-mcp（`types.go`、`feed_detail.go`）与 NanmiCoder/MediaCrawler（`media_platform/xhs/client.py`、`store/xhs/__init__.py`），两种写法都认（`packages/core/src/xhs-notes.ts`）。这些路径没在真实账号上核对过，以 `scripts/xhs-read-trial.ts` 的输出为准。

**节奏与只读一次。**
- 第一次（补齐，catch-up）：打开收藏页，滚到底（页面说 `has_more: false`，或连续 3 屏没有新条目），然后逐条打开没读过的笔记，同一个可见窗口，每条之间 6–10 秒（`CATCH_UP_GAP_MS`），不设每期、每日上限。中途停下的补齐，下次接着补齐。
- 之后（增量）：滚收藏列表，遇到整页都已读就停；只读新收藏，每期最多 15 条（`INCREMENTAL_BATCH`），每条之间 30–120 秒随机（`INCREMENTAL_GAP_MS`）。
- 每条读完、文件写好就记进 `collect.notes.<workflow>`（读过 / 已失效），所以停下时已读的都留着；已失效的笔记（`NOTE_GONE_TEXT`）不再打开。
- 第一次安全验证、限流答复（状态 461/471/429、`code` 3000xx、「访问频次异常」等）或验证页地址就整期停下、关浏览器，小红书 7 天内不读（`site.breaker.xiaohongshu.com`，`site_read` 同样遵守）；要求登录就停下并请本人登录（不设暂停）。笔记正文里出现「验证码」不算：只有没拿到笔记数据时才看页面文字。

**每条笔记的全部内容。** 图片（全部，含实况照片的视频）和视频由浏览器自己的请求（`page.request`，带页面的 cookie，笔记页为 referer）存进 `notes/<id>/`，单个文件上限 500 MB。之后（`apps/worker/src/note-media.ts`）：图片和视频关键帧交给 Skill `crossline-media-describer`（low 档）看图，输出描述与图中全部文字；一次最多 12 张、整条笔记一起，约 1000 条笔记（平均 4 张图）约 350 次运行；视频用 ffmpeg 抽 16 kHz 音轨，由录音用的本机 Whisper 转写，再抽 4 张关键帧一起描述。AVIF/HEIC 先用 ffmpeg 转 JPEG。每条写成 `note-<id>.md`（标题、正文、标签、作者、时间、类型、互动、每张图的描述与文字、视频转写与关键帧、原链接），目录写 `index.md`。看图只在 Codex 自己的登录上运行（`SKILL_NEEDS` 的 `vision`）。本机 ffmpeg：winget 的 Gyan.FFmpeg 9.0.2 已在 PATH；`CROSSLINE_FFMPEG` 可另指。

**试读。** `pnpm exec tsx scripts/xhs-read-trial.ts --workspace <id> [--notes N] [--catch-up] [--media]`：用这台电脑上该工作流的配置目录，在账本副本上读，文件写到临时目录，逐条打印每个来源给了什么；只有遇到安全验证时把 7 天暂停写回实时账本。

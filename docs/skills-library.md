# Skill 库：公开 skills 与本人的主线 skill（设计，未实现）

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

设置 → 「Skill 库」：本人的主线 skill（全文、来源、版本、编辑、回到旧版）；公开 skills（来源、许可证、扫描与审查结论、上次调用、手动删除）。

## 风险（本人已知情并选择）

- **自动扫描与 AI 审查都可能漏掉**。脚本写法千变万化，静态模式匹配拦不住刻意绕过；AI 审查也会被说服。残余保护只有：脚本只在助手的任务目录里跑，经过 `agent-guard`（它是绊线不是沙箱，见 `docs/assistant-agent.md`），所有命令与文件改动留审计，密钥路径拒读。
- **自动更新不经批准**，一个被投毒的新版本会在下一次运行时直接生效。每个文件记 sha256，至少能事后追查是哪一版。
- **全网来源**的许可证可能写错或缺失；缺失的不收。

## 分期

- **S1**：本人的主线 skill（整理、安装、在助手/步骤规划/教程撰写里启用）＋闸门 `fit` 判定。先用真实账号的小红书这次验收备注做第一条规则。
- **S2**：公开 skills 的检索、取回、扫描、AI 审查、安装、按大类匹配、30 天清理。
- **S3**：设置里的「Skill 库」页面。

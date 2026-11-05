# 把 Karpathy 的 LLM Wiki 模式融进 Crossline（草案，2026-11-04）

状态：草案，等本人拍板。

## 1. 先说差别

Karpathy 的 LLM Wiki（[gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)）的结构：

- 只读的原始资料，由 LLM 编译成 markdown wiki。
- 一份 schema 文件（AGENTS.md）约定写法。
- 三个操作：ingest、query、lint。
- Obsidian 只是阅读器。
- 它管的是“知识”，没有任务、排程、提醒和验收。

Crossline 本来就是一个“编译器”：访谈、文件、录音、邮件被编译成事实、线、里程碑、线技能和 lessons。区别在两点：

- Crossline 的产物存在 SQLite 里，有引用校验和状态机。
- 人和外部 agent 都看不到一份可读、可带走的全貌。

所以要融合的**不是**“改成以 markdown 为真相”。Logseq 做了两年双向同步也没做成（[论坛](https://discuss.logseq.com/t/is-there-still-a-bi-directional-approach-of-db-markdown-or-only-export-to-markdown-remains/26051?page=2)）。要融合的是三样东西：

1. **可读的投影**：账本投影成 Obsidian 兼容的 vault。人能翻阅、批注、带走；用户自己的 Claude Code/Codex 读文件就能拿到上下文，不需要 MCP。
2. **ingest / lint 的纪律**：增量编译（Crossline 已有，线技能 v2 就是增量编译）；加一个“知识 lint”，查矛盾、过期、孤立、重复的事实。
3. **query 回存**：输入框里一个好的回答可以“存为笔记”，回到知识里。

## 2. 不做什么

- 不让 markdown 成为真相。账本是唯一真相，人的编辑只算提案。
- 不让外部 agent 直接写入事实。它写的东西最多变成一张待确认卡，标 inferred、带引用、走 validator。
- 不嵌入 qmd：约 2 GB 本地模型加原生编译；我们已有 `doc_chunks` FTS5。qmd 只在文档里推荐给用户的外部 agent。
- 不依赖 Obsidian 官方 CLI 或 Local REST API：两者都要求 Obsidian 开着。
- 不用 Dataview（衰退），改用 Bases。不用 gray-matter（可执行 frontmatter）。不用 GPL/AGPL 代码（remark-obsidian、Basic Memory）。

## 3. vault 的样子

位置：本人选一个文件夹，校验规则同“授权文件夹”：不是盘根、用户目录或系统目录。

```
<vault>/
  AGENTS.md            给 agent 的说明：哪些是生成的、别改生成区、怎么提建议
  index.md             目录：线、项目、里程碑、近期任务、资料
  log.md               只追加：每天一节，记账本里发生的事（来自 events）
  me/
    portrait.md        画像（私密下半份可选）
    profile.md         已确认事实，按 slot 分组，观察条目语法
  lines/line-research.md …       描述、长期目标、项目、线技能规则及来源
  projects/<id>.md
  milestones/ms-<id>.md          截止、标准、前后依赖和跨线关系用 [[wikilink]]
  tasks/wo-<id>.md               未完成的，加最近 30 天完成的；步骤是 - [ ] 清单
  sources/doc-<id>.md            文件名、摘要、所属项目；原文不复制
  reviews/2026-W45.md            周回顾
  notes/                         “存为笔记”的问答，以及本人自己写的笔记
  inbox/                         丢进来的文件 = 收集（等于一个授权文件夹）
  views/tasks.base  milestones.base     Bases 表格和看板，免插件
  views/flywheel.canvas  lines.canvas   JSON Canvas 飞轮图和主线图
  .claude/skills/  （可选）kepano/obsidian-skills
```

### 文件约定

格式借鉴 Basic Memory（[文档](https://docs.basicmemory.com/raw/concepts/knowledge-format.md)），代码不用。

- 文件名用稳定 id（`ms-<id>.md`）。标题放 frontmatter 的 `title` 和 `aliases`，链接写成 `[[ms-<id>|标题]]`。改名不会断链。
- frontmatter 字段：`crossline_id`、`type`、`line`、`status`、`updated`、`generated_hash`。
- 事实写成观察条目：`- [deadline] ECE 548 期末 12/14 (来源: syllabus.pdf)`。推断的事实加 `#推断`。
- 生成区用标记包住：`<!-- crossline:begin -->…<!-- crossline:end -->`。标记之外（例如 `## 我的笔记`）属于本人，**永不覆盖**。人可以批注，又不需要双向同步。

## 4. 写入（第一期：单向）

纯函数 `renderVault(snapshot) → Map<path, content>`，放在 `packages/core`，可测。写入 pass 的规则：

- 账本 `changeToken()` 变化后去抖 60 秒。
- 只写 hash 变了的文件，用 write-file-atomic；Windows 上 rename 遇到 EPERM 时重试，防 Obsidian 或杀毒软件占用。
- 按 workspace 串行。
- 写之前读回现有文件，保留标记外的内容。
- 账本里已删除或已归档的对象，文件移到 `archive/`，不删除。

**谁来写**：

- **本机安装版**：worker 直接写。
- **本人（托管主账本）**：device mode 的设备 worker 拉托管站的投影包，写到本机 vault。新增 `GET /api/vault/bundle`，设备 token 加 `vault` scope。不在服务器上生成目录。
- **托管报告栈**：不提供。最多给报告买家一个 zip 下载。

**隐私白名单**：

- 默认不导出：窗口标题、录音转写原文、财务记录金额、健康数据、邮件内容、凭据类文件。各自另开开关。
- 加一个 discovery 测试，写法照 `activity-privacy.test.ts`：投影代码碰了禁区字段就失败。
- vault 是明文目录，会被 git、同步盘、第三方 agent 读到。设置页要写明这一点。

## 5. 读回（第二期：只做提案）

| 人在 Obsidian 里做的事 | Crossline 怎么处理 |
|---|---|
| 勾选步骤 `- [x]` | 待确认卡“标为完成？”。或者按本人选择直接生效，可撤销 |
| 改了生成区里的截止日期或标题 | diff 变成待确认卡，用现有 ask 和预览机制 |
| 在标记外写笔记 | 不回写账本；访谈抽取可以把它当资料读（同 `notes` 会话） |
| 丢文件进 `inbox/` | 就是授权文件夹，已有流程 |
| 外部 agent 在 `notes/` 写推断 | 当资料读，事实只能是 inferred，不覆盖已确认 |

监听用 chokidar 6（纯 JS，Windows 上不用处理原生二进制）。

## 6. 知识 lint（第三期）

每日 pass，规则优先，模型可选：

- 同一 slot 的事实互相矛盾，例如两个不同截止日期。
- 事实过期：给事实加有效期（valid-time），过期的提示重新确认。
- 孤立对象：没有任务的项目、没人引用的资料。
- 近重复：已有 dedupe 的思路扩展到事实。

结果写成 `lint.md`，加一张“知识体检”卡，不自动改账本。

## 7. 风险

1. 双写漂移：靠“账本为真、人改即提案”压住，不要中途改口做自动合并。
2. 隐私：明文目录的泄露面比 SQLite 大得多。白名单和测试必须先于功能。
3. 写放大：文件多、git 历史膨胀。限制任务范围（只放未完成 + 30 天），只写变了的文件。
4. 价值存疑：本人是否真的会在 Obsidian 里看？建议先只做投影（§4），用两周再决定做不做 §5 和 §6。

## 8. 拆分

| 会话 | 内容 |
|---|---|
| V1 | `renderVault` 纯函数 + 隐私白名单测试 + 本机 worker 写入 pass + 设置卡（选文件夹、开关） |
| V2 | device mode：投影包接口 + 设备 worker 写入（依赖 V1 的 renderVault） |
| V3 | 读回提案（勾选、日期）+ chokidar 监听 |
| V4 | 知识 lint |

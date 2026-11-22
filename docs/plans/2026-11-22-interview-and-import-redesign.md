# 访谈前准备、访谈与材料导入：重做方案（2026-11-22，已逐条确认，未实施）

本人 2026-11-22 提出 13 条要求，经三轮问答逐条确认。本文只是方案，还没有改任何代码；是否实施、何时实施由本人决定。

总原则（本人原话）：

> 我们的系统就是一堆 skills + 一个看板 + 一堆连接器，不要自作聪明设置复杂的无法泛化的硬代码机制。

依据：读 origin/main `76e1501cec` 的代码；读本人的 personal-modeling skill（`C:\Users\karol\Desktop\Thoughts\.claude\skills\personal-modeling\`）；读 vendor/codex 0.163 与 `docs/codex-upgrade-0.163.md`；读本人 2026-07-29 起在 Codex 里的人生设计访谈原对话（只读本机记录，约 85 轮）；网上调研（访谈方法、量表授权、上传、去重、密钥扫描、按需读取、日历订阅）。调研与盘点的完整笔记在本会话组的共享笔记目录，不入库。

---

## 一、已确认的决定

| # | 问题 | 决定 |
|---|---|---|
| D1 | 量表 | IPIP-NEO-120（五大人格 5 维 30 子面，公有领域）+ TwIVI（价值观 20 题，任何用途免费）。BFI-2 商用要申请，HEXACO 按次收费，PVQ-RR 禁商用，都不用 |
| D2 | 对话形态 | 改回 Codex 原生：一条长线程，回复是自由文本，卡片和账本写入走工具，不再每轮强制 12 字段 schema |
| D3 | 文件夹 | 本机：授权文件夹不等于导入，模型按需浏览、按需读。托管：读不到本机文件夹，先筛后导入 |
| D4 | 访谈底本 | 以本人原 Codex 人生设计访谈的逻辑为底本（d.school《Designing Your Life》+ 心流 + 积极心理学），去掉只适用于本人的部分，改写成贴合 Crossline 的 Skill |
| D5 | 顺序 | 量表 → 人生经历 → 现状 → 未来（指南针、能量、锚问题、奥德赛） |
| D6 | 语气 | 对所有人都客观、理性、冷静，不冒犯也不糊弄。**不再让本人选语气**（取代 onboarding v3 的语气选择） |
| D7 | 主线 | 开场先由本人列出主线，访谈全程可改；末段为每条主线写五年奥德赛和几个诱人且可实现的愿景，近期小任务和原型行动纳入首批工单 |
| D8 | 岔题 | 先接下岔题，交给调研层，访谈结束后汇报结果 |
| D9 | 账本形态 | 自由笔记加少量结构字段。笔记数量不限，每条带依据（原话、材料或文献，不能是点选）；结构字段只留排程真要用的 |
| D10 | 右栏与开始门槛 | 活画像，本人决定何时开始。删除固定清单和时长估计，硬门槛只剩「有主线、至少一个里程碑」 |
| D11 | 旧版本文件 | 原件留库，访谈只看摘要和与新版的差异，需要时模型按需读原件 |
| D12 | 16 型标签 | 系统不生成。本人提前做过这类测试，可以把结果当自述带进来 |
| D13 | 来源显示 | 画像和右栏不显示「依据 N 条」和置信度，这些只留在账本。当场核实信念时给数据和链接 |
| D14 | AI 历史对话 | 支持。本人给出文件夹或导出文件，系统自动识别其中的对话格式 |
| D15 | 敏感个人文件 | 授权文件夹里跳过。直接上传的照常导入，但证件号、卡号、账号由代码打码后才交给模型。密钥和密码一律由代码拒收，这条不变 |
| D16 | 调研层 | 和访谈直接相关的当场核实；不直接相关的放后台深查，访谈结束后汇报 |
| D17 | 中途插话 | 默认排队，本轮结束后接上；本人也可以像 Codex 那样插进当前轮（steer） |
| D18 | 全系统范围 | 一期全做，包括全系统「应交模型却写死」清单，做完跑 e2e |
| D19 | 模型与思考强度 | 显式允许本人选择模型和思考强度（见第三节第 5 条） |

**我反对过、本人已知情的几点**（记录在此，免得实施时被当成疏漏）：

- personal-modeling 是「语料先行」，原 Codex 访谈是「对话先行」。两者合用时，材料读出的画像只能当待本人确认的假设，本人的纠正标【自报】。
- 「旧内容只摘要」会丢证据，所以改成 D11：原件留库。
- 密钥过滤必须由代码先做，排在任何模型筛选之前。模型看到密钥就等于已经泄露给模型提供方。
- 托管服务读不到本机文件夹，D3 的「按需读」只在本机成立。
- 文本推断人格的效度很低（r 约 .1–.45），所以量表放在前面，访谈用行为证据去验证量表，而不是反过来让模型猜分数。

---

## 二、新的访谈流程

### 1. 访谈前的准备页（一页，可跳过的都能跳过）

1. **主线**：本人先列几条主线，比如「科研」「创业」，一句话即可，以后随时可改（D7）。
2. **材料**：先放能自我介绍的材料，比如简历，然后是文件夹、录音和 AI 历史对话。上传和导入在后台进行，不挡任何一步，访谈期间也能继续传（见第四节）。
3. **日历**（可跳过）：教程重做，见第四节第 7 条。
4. 排程以后要用的信息（固定事件、硬约束、截止日期），只要从材料里读到，整理层就**提前写进账本**，不等访谈。

### 2. 量表（访谈第一步）

- 开头明说：「首先，让我们完成一份量表」。整页做完 IPIP-NEO-120 和 TwIVI，可分页，也可暂停后接着做。
- 末尾留一个自由补充框。它是**补充**，不是替代点选（现在 `profile-cards.tsx:48-50` 的单行框是替代）。
- 计分由代码完成，属于确定性的数学，留在代码里：百分位加常模说明。
- 做完后，模型读分数、补充和已有材料，写一段分析给本人看，不标置信度。这段分析提出几个待访谈验证的假设，然后才开始访谈。
- 本人提前做过 16 型这类测试的，可以填结果，按自述记（D12）。

### 3. 访谈主体（全部写在 Skill 里，代码不排阶段）

覆盖顺序如下（D5）。Skill 只写要覆盖什么，模型按本人的回答灵活调整和追问，问清楚为止。

1. **人生经历**：按章节和关键场景回顾，包括高峰、低谷和转折点（McAdams 生命故事访谈的骨架）。苏格拉底式追问：当时几岁，具体哪件事，那一刻什么感觉，为什么这么做。从中提炼性格、价值观、特质、工作习惯、思维模式、方法论和意识形态，并对照量表的假设。
2. **你在这里**：先问最想解决、最焦虑的问题，判断它是可以动手设计的真问题，还是只能接受的重力问题。然后做反向推演：现状不变时，五年后的一个普通周二怎么过，再推到十年后，再推到这一生的尽头。
3. **指南针**：工作观（为什么工作，工作与金钱、他人、世界的关系）、人生观，以及两者是否一致。
4. **能量**：什么时候进入心流，什么事回血，什么事抽干。把擅长和热爱分开，用「逃避什么」作为行为证据。
5. **锚问题**：死守很久、早已行不通却不肯放手的方案或身份，重写它背后真正想要的东西。
6. **每条主线的五年奥德赛**（D7）：为每条主线写一份五年发展计划，给出几个诱人且实际可实现的愿景，再落成结构字段：
   - 本季度要验证的核心问题 → 里程碑
   - 一条不愿牺牲的底线 → 硬约束
   - 一个月内能做出来的小东西、原型行动 → 首批工单

   这一段也可以增删主线。
7. **结束**：汇报后台调研的结果（D8、D16），整理层定稿画像。

### 4. 每一轮怎么回（写进 Skill，不写成代码校验）

照原对话里有效的做法：

- 先给这一轮的模式起个名字，再用「只看行为、不听说法」的角度解读，点出逻辑漏洞和自我设限，分清重力问题与可设计的问题。需要时把问题重写成一句可以验收的话。
- 最后恰好问一个主问题，并带具体约束，比如「说一个具体场景」「只能选一个」「给出年龄和一件事」。
- 回复要按本人的材料来写，有分析量，不是模板。现有 Skill 第 7 条「两三题」和第 11 条「短句、平实」是回复偏短的原因，要重写。
- 本人陈述一个可以核实的信念时，当场联网核实，用「你的认知｜判定｜数据与纠偏」给出数据和链接（D13、D16）。
- 每个问题都可以跳过或说「不想谈」，自由文本随时可写。去掉「好，往下」按钮和必填的 `next`。
- 原 prompt 里只适用于本人的东西不进 Skill：预置画像、「心理承受能力很强」、具体人名。

### 5. 上限

- 每次访谈最多 1000 轮：worker 在 turn 入口数本人消息（`onboarding-session.ts:228` 附近）。
- 删除 `INTERVIEW_ROUNDS_EXPECTED = 12`（`interview-quota.ts:13`），以及登录页「约 30 分钟」、右栏「约 60 分钟」。
- token 成本不是约束（本人原话：第一优先是建立完整的个人模型）。

---

## 三、三层：Codex 原生 + Skill + 整理层 + 调研层

只在 Codex 原生能力上加四样东西：我们的 Skill/prompt、整理层、调研层、1000 轮上限。

### 1. 访谈线程（原生）

- 一条长线程。冷恢复用 `thread/resume`，不再在空闲 60 分钟后从账本重建（`SKILL_THREAD_LOST`）。
- 最终消息就是回复，是自由文本。卡片（量表除外）、安全标记、账本写入走 dynamic tools。只有不带 outputSchema 才能 steer。
- 联网搜索用原生 `web_search`（live），用于当场核实。
- 中途插话（D17）：默认放进下一轮的队列。本人主动选择时走 `turn/steer`（带 expectedTurnId）。`thread/queue/add` 是实验接口，先用 worker 自己的队列。
- 压缩用原生自动压缩。`COMPACT_PROMPT` 改成保留材料原话和账本指针，不再「不必保留文件正文」（`onboarding-session.ts:885-891`）。远端压缩不读 compact_prompt，所以账本才是事实来源。
- 每轮的大 JSON 用户消息（`onboarding-session.ts:646-664,719-730`）缩成一行说明，状态由模型按需 `read_ledger`。
- 保留的校验：自伤与安全、编造日期、逐字引语、网址真实性、披露脱敏。其余拒绝退回降为记录，删除前先用回放对比。

### 2. 整理层

- 单独一条线程，不 fork 访谈线程。每轮或每几轮读新回答，写进账本，再用 `thread/inject_items` 或 `additionalContext` 回灌访谈线程。回灌接口是实验接口，失败时退回为访谈线程自己 `read_ledger`。
- 写什么（D9）：
  - **自由笔记**：参照 personal-modeling 的 24 个维度，数量和长度不限。每条附依据（原话、材料位置或文献），**点选不能当依据**。这要修 `onboarding-refs.ts:124-125` 里 `pointChanges` 没过滤 TAP_LINE 的问题，它就是截图里「依据 1 条」其实只是一行点选的原因。本人纠正过的内容标【自报】。
  - **结构字段**，只留下游真要用的：主线、里程碑、硬约束、固定事件、精力规律、近期任务。
- 动态维护：同一维度出现新证据时，改写而不是追加重复条目。矛盾的说法两条都留，并标出时间。

### 3. 调研层

- 当场核实：在访谈线程里用原生搜索（见上）。
- 后台深查：岔题和与访谈不直接相关的调研交给后台调研线程，访谈结束时汇总汇报。删除每轮最多 3 个、全程最多 4 个的上限（`onboarding-research.ts:17,25`，`onboarding-cards.ts:22`），保留单线程并发与 spend 上限。删除「回复不得抄调研数字」的退回（`onboarding-reply.ts:36`）。
- 鼓励模型主动调用调研层，拿证据和数据检验本人的信念。

### 4. 右栏与开始门槛（D10、D13）

- 右栏按维度显示整理层已写下的活画像，不显示依据数、置信度和时长。「整理中」显示真实的后台状态（`stage-view.tsx:63-70` 已有）。
- 「开始使用」随时可按。按下时，模型说明哪些部分还薄，本人可以继续，也可以直接开始。
- `gateUntilReady` 的硬门槛只剩：至少一条主线、至少一个里程碑，因为排程离不开它们。

### 5. 模型与思考强度（D19）

现状：本人选不了模型。路由由 `packages/codex/src/model-policy.ts` 按档位决定，只能用环境变量 `CROSSLINE_ROUTE_<SKILL>="model[:effort]"` 固定；设置页只显示用量，不显示模型名（`settings/page.test.tsx:46`）。访谈的对话、整理、调研和画像已在 `NEVER_DOWNGRADED` 里。

改为：

- 访谈输入框旁边放模型和思考强度的选择，像 Codex 那样。模型列表来自原生 `model/list`（`packages/codex/src/model-catalog.ts`），思考强度只列所选模型支持的档位。改动从下一轮生效，按原生的 per-turn model/effort 传。
- 设置页 → 模型：给整理层、调研层和其他 Skill 各设一个默认的模型和思考强度，未设的沿用现有路由。
- 本人选定的模型优先于路由表。额度紧时 economy 降档**不作用于**本人显式选定的模型；额度耗尽时照实告诉本人，不偷偷换模型。
- 用量页按模型显示用量，去掉「不显示模型名」的限制。

---

## 四、上传与导入

1. **多选与拖放**：文件可以多选；拖放多个文件夹用 `webkitGetAsEntry` 递归，`readEntries` 每次最多返回 100 条，要循环读完。本机 Chromium 另提供 `showDirectoryPicker`。`webkitdirectory` 一次只能选一个文件夹，所以只当兜底。
2. **并行**：前端不再每 10 个一批串行 await（`onboarding-workspace.tsx:196-218`），改为并发上传。服务端不再逐个串行提取（`lib/sources.ts:70-77`），worker 并行提取。一个文件失败不影响整批（`lib/sources.ts:37-53`）。本机 Whisper 转写受 CPU 限制，仍串行，但不挡别的。
3. **管线**，顺序固定：
   1. **代码先过滤密钥和凭据**，直接上传也要过。这补上 `worker/index.ts:285-294` 的缺口：直接上传现在不做 `credentialText`/`sensitiveText` 检查。
   2. **敏感个人文件**（D15）：在授权文件夹里跳过；直接上传的，由代码把证件号、卡号、账号打码后再交给模型。
   3. **模型按文件名、格式和大小筛选**：只对文件夹做，直接给的文件一律导入（本人要求第 4 条）。
   4. **去重**：
      - 精确重复用 sha256（已有）。
      - 近似重复：代码用 MinHash 或 SimHash 圈出候选，模型判断是否同一文档的不同版本，按修改时间和内容里的版本信号选出最新版。
      - 最新版全文进访谈；旧版原件留库，访谈只拿到摘要和差异，需要时按需读（D11）。
      - 删除「同内容留名字最短那份」的规则（`worker/source-folders.ts:107-117`）。
4. **授权文件夹不等于导入**（D3）：本机给访谈线程一个只读工具，可以在授权根目录内列目录、读文件，越界的路径一律拒绝。托管服务先筛后导入。`FOLDER_MAX_FILES` 与凭据、敏感过滤保留（`core/source-folders.ts:136-249`）。
5. **AI 历史对话**（D14）：本人给出文件夹或导出文件，系统自动识别格式，包括 ChatGPT 数据导出的 `conversations.json`、Codex rollout（`.jsonl` / `.jsonl.zst`）和 Claude Code 的 `.jsonl`。只抽取本人说的话和逐段对话摘要，去掉系统指令、AGENTS 和工具输出，密钥过滤照常。系统不主动扫描本机目录，只读本人指定的位置，用的是与文件夹授权同一个同意。
6. **少确认**：
   - 点了上传就是上传，不再有「预览后再点上传 N 个文件」（`folder-picker.tsx:34-53`）。
   - 删除不弹确认（`left-column.tsx:45-50`），改为软删除，提示里可以撤销。
   - 保留的确认：Whisper 模型的首次下载（下载需要本人按一次，这是边界），以及开始前的最终确认。
7. **日历教程**：放进准备页，先选服务商，步骤默认展开，不再折叠在 details 里（`calendar-subscriptions.tsx:74-93`）。ChatGPT Google 日历连接器卡片也放到这一页（现在只在设置页，`connections.tsx:58`）。注明 Google 订阅外部源有 12–24 小时延迟，以及工作或学校账号可能禁用私密地址。
8. **回合中可上传、可发言**：去掉回合中输入框的 disabled（`onboarding-workspace.tsx:429`），上传与回合互不加锁。新文件先落盘成为 `read_file` 的来源，下一轮告诉模型；本人选择插进当前轮时，走 steer。

---

## 五、要删除或改写的硬代码

### 访谈（★ 为本人这次抱怨的直接原因）

| 位置 | 现状 | 处理 |
|---|---|---|
| `core/onboarding-turn-schema.ts:81,90-103` | 阶段顺序和模块阶段写死 | 顺序移进 Skill；枚举只留给账本分区用；`PROFILE_MODULE_STAGES` 和 `DEEP_STAGES` 删 |
| `skills/.../crossline-onboarding/SKILL.md` 与 `stages/*.md` ★ | 15 条核心规则中，第 7 条和第 11 条让回复偏短，第 14 条要求 `next`；orientation 和 lines 是开始标准的事实清单 | 按第二节重写 |
| `worker/onboarding-session.ts:572-573`，`core/onboarding-pace.ts:146-161` ★ | `next` 为空就退回；`nextTaken`；用中文正则猜「想开始」 | 删 |
| `web/onboarding-workspace.tsx:321-326` ★ | 只有「好，往下」一个按钮 | 删，改为跳过加自由文本 |
| `core/profile-instruments.ts:61-160`，`onboarding-depth.ts:24`，session `:762-772,843-850` ★ | 43 题的题库、实发 14 题，约连续 6 轮每轮塞量表卡 | 换成访谈前的整页量表（D1） |
| `worker/onboarding-session.ts:760-775` | `holdCardsForStart` | 删 |
| `core/interview-checklist.ts:168-175,274-288`，`db/interview.ts:53-56` | `profile_cards` 是开始项；深阶段没走完就判开始标准不成立 | 按 D10 改 |
| `web/stage-view.tsx:45-57,175-178` ★ | 写死五行 START_GROUPS；`minutesLeft` 估出「约 60 分钟」 | 删，改为活画像 |
| `web/interview-status.ts:88-100` → `onboarding-workspace.tsx:276-294`，`core/profile-gaps.ts:90-310` ★ | 每轮把全部 gap 题文塞进批次，绕过「模型点名才出」 | 删 app 插题，缺口由整理层写进账本，模型读 |
| `core/interview-quota.ts:13`，`login/page.tsx:55`，`local-login.tsx:72` ★ | 12 轮预期；「约 30 分钟」 | 删，改为 1000 轮上限 |
| `worker/onboarding-session.ts:51-54,885-891` ★ | 单文件 14k、每轮 60k、12 份的预算；压缩时丢文件正文 | 放宽预算；改写 COMPACT_PROMPT |
| `worker/onboarding-extract.ts:445-461` | 画像节随阶段定稿 | 改为整理层动态维护 |
| `core/onboarding-refs.ts:124-125` ★ | `pointChanges` 没过滤 TAP_LINE | 修 |
| `onboarding-cards.ts` 中的 IR-130/131/133、`undecidedDay` 正则 | 出卡时退回 | 删；逐字引语、网址、hypothesisId、sameAbout、LIKE_ANSWERED/MAX_ASKINGS 保留 |
| `onboarding-research.ts:17,25`，`onboarding-cards.ts:22`，`onboarding-reply.ts:36` | 调研次数上限；回复不得抄调研数字 | 见第三节第 3 条 |
| `web/opening-card.tsx:118-186` | 「中间穿插几张点选卡片」「画像不能跳过」 | 重写 |

这一组改动牵动 `packages/core/src/interview-rules.ts` 的规则登记表，以及 `onboarding-session.test.ts` 里「核心规则 ≤15 条、阶段规则 ≤10 条」的守卫（IR-146）。删除哪条规则就同时删它的登记和测试，并在 `docs/onboarding-validation-audit.md` 记录原因。

### 全系统「应交模型却写死」（D18：一期全做）

按对本人的影响排序：

1. `work-owner.ts:60-197` 用正则串重判 owner（`steps.ts:436-480`）→ 以 backplanner/step-planner 给出的 owner 为准，只留 ACTS 底线
2. `auto-approval.ts:25,30,67-72` 的 PERSONS_CALL/NEEDS_ACCESS → 模型字段 `needsPerson{kind,quote}`
3. `agent-dispatch.ts:43-55,92,128-131` 用关键词计票定类别 → 模型给 `category` 枚举
4. `info-request.ts:38-48` 的 `infoRequestTraits` → `request{kind,who,fact}`，保留「发送归本人」
5. `task-merge.ts:42-66,85,116`，`event-merge.ts:50-60` 用 Dice 系数加同义词加课号 → 代码圈候选，模型选
6. `completion.ts:81,106` 的 FORMAL_STEP 覆盖模型判断 → 删
7. `milestone-plan.ts:77,165-167,187-191,215-235` 按课程语法拒收 → 移进 architect/gate 的 SKILL
8. `mail.ts:325-333` 的 `isMailReminderTitle` 只认中文 → mail-triage 的 kind
9. `mail-events.ts:28-42` 的 `isAttending` → `attends` 字段
10. `task-title.ts:64-80` 的 SITTING（会误伤 presentation）→ `sitting`/`startsAt`
11. `task-title.ts:22-36` 的 `courseCodeOf`/`withCourse`（会把「Fall 2026」当课号），`belonging.ts:16-50` → task-titler / folder-classifier
12. `familiarity.ts:71-100` → step-planner 的 familiarity
13. `importance.ts:31-37`，`step-planner.ts:301-313` 的 `importantByRule` → 模型建议权重
14. `opportunity-tags.ts:131-142,182-189` 的校园社交词表 → `lowValue`
15. `rest-events.ts:11-20`，`confirm.ts:148` 的 EXERCISE → calendar-classifier 标记

其余也列入一期：`drill-forms` 的 methodQuestion、ACCEPTS_OUTPUT/JUDGES、`profile-gaps` 的 FROM_MATERIAL、`date-pairs` 的 homeworkNumber、`imported-dates` 的 FINAL_EXAM、`skill-library` 的 MEDIA_LINE、`diligence` 的 CONSTRAINT_WORDS、`isCancelledEvent`、archetypes 的 11 个原型。

**学生和课程假设**（本人要求第 6 条，访谈写账本时就会碰到）：

- `date-schema.ts:15` 的 DATE_KINDS 共 9 类，其中 6 类是课程类 → 改为通用类别，课程只是其中一类
- `db/overdue.ts:21-27`、`optimizer.ts:254` 的文案、milestone-plan 的修正文字、`asks.ts:462-540,960-964`、`interview-checklist.ts:247-264`（成绩怎么算）、`profile-gaps.ts:233-244`、`agent-dispatch.ts:111` 的 GRADED_NOTE
- 页面文案：`left-column.tsx:68`、`opening-card.tsx:21,26,124,157,180`、`calendar-subscriptions.tsx:88`、`source-folders.tsx:180`、`setup-guides.ts:363`、`calendar-apps.tsx:40`、`start-confirm.tsx:70`、`profile-panel.tsx:11,17,27`
- Skill：`stages/orientation.md:10`、`crossline-folder-classifier/SKILL.md:26`

### 留在代码里的（不交模型）

`connectorWritePolicy`、`GOOGLE_TOOLS`、表单的 `judgeAction`/`autoSubmitProblems`、`longbridgeToolAllowed`、`agent-guard.ts`、凭据与敏感过滤（`source-folders.ts:136-240`，含 Luhn 与 `redactSecrets`）、`EXTERNAL_ACTION_PATTERN`、`stepLeavesMachine`、逐字引语与网址与 DAG 校验、planner 和 energy-model 的数学、horizon、granularity、nudges 的时机、push-policy、量表计分。它们要么是安全边界，要么是确定性计算。

---

## 六、不变的安全边界

- 密钥和密码由代码拒收，排在模型之前，直接上传也一样。
- 没有新增任何对外写路径。日历、邮件、表单、交易的边界照 `CLAUDE.md`。
- 摄像头、麦克风、设备位置不受影响。
- 读 AI 历史对话只读本人指定的文件夹或文件，与文件夹授权同一个同意；系统不自动扫描本机目录。托管服务只接受上传的导出文件。
- 网上搜索不带本人的个人信息：调研线程的查询只放主题，不放姓名、学校、邮箱。

---

## 七、实施顺序

1. **先修两处安全问题**：直接上传的密钥检查；`pointChanges` 的 TAP_LINE 过滤。
2. **上传管线**：多选与多文件夹拖放、并行、过滤顺序、近似去重、不再确认、撤销删除、回合中可上传。
3. **原生线程**：去掉每轮 schema、工具化、排队与 steer、1000 轮上限、`thread/resume`、COMPACT_PROMPT，以及模型与思考强度的选择。先录下当前访谈的回放，改完对比。
4. **Skill 重写**：crossline-onboarding 的 SKILL 与 stages、整页量表与分析、删除第五节的访谈硬代码、改写 IR 登记表和测试。
5. **整理层与账本**：自由笔记加结构字段、活画像右栏、开始门槛。
6. **调研层**：当场核实与后台深查分开，结束时汇报。
7. **准备页**：主线、材料、AI 历史对话导入、日历教程。
8. **全系统清单**：第五节的 15 项加其余项，加学生假设。
9. **文案中性化**。
10. **验证**：`pnpm typecheck`、`pnpm test`、回放（`apps/worker/src/testing/fixtures/`，每个新发现的缺陷留一个 fixture）、`pnpm test:e2e`（布局改动要重生成 `-win32` 与 `-linux` 两套截图），最后 `pnpm verify`。

文档同步：`docs/claude/profile-first-loop.md`、`docs/onboarding-agent-session.md`、`docs/onboarding-validation-audit.md`、`docs/claude/interface-and-model-routing.md`，以及 `docs/walkthrough-ledger.md` 里的相关路径。

---

## 八、风险

- 去掉 schema 后，较弱的模型提供方可能不调工具，现有的一致性检验覆盖不到这种情况。
- steer 与显式压缩、闸门计数可能冲突；`thread/queue/add` 和 `additionalContext` 是实验接口。
- 1000 轮会经历多次压缩，质量没有测过，只能靠账本兜底。
- IPIP-NEO-120 需要中文译本，常模来自英文样本。整页量表约 20 分钟，这是本人选择的注意力成本。
- MinHash 会误判近似重复，所以必须由模型确认。
- 一期全做的回归面很大，第 3 步和第 8 步各自都要靠回放和 e2e 把关。

## 九、实施时再定的小事（不挡方案）

- IPIP-NEO-120 中文译本的来源。
- steer 的按键与界面：照 Codex 的交互，具体键位实施时对照 Codex 当前版本。

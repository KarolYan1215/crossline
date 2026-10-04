# 结构化输出

每个 Skill 都要求 Codex 以 JSON 回答，而不是自由文本。这份文档讲：我们怎么约束它、怎么校验它、校验不过怎么办、出了问题怎么查，以及目前的实测数据。

核心原则：**schema 保证形状，校验器保证内容，修正循环给模型第二次机会，但模型明说「我停下来」的时候不逼它继续。**

## 四层

| 层 | 在哪 | 守住什么 |
|---|---|---|
| 1. schema | `packages/core/src/*-schema.ts`，通过 `turn/start` 的 `outputSchema` 交给运行时（严格模式） | 字段齐全、类型对、枚举对、长度上限 |
| 2. 严格模式检查 | `structuredOutputProblems`（`packages/core/src/structured-output.ts`），`structured-output.test.ts` 对每个导出的 `*_SCHEMA` 自动检查 | 每个属性都在 `required`、对象 `additionalProperties:false`、联合用 `anyOf`、嵌套 ≤ 8 层、属性 ≤ 2000。严格模式遇到不认的 schema 会让整个 `thread/start` 失败且不说原因（飞轮曾因此几周跑不起来），所以在发给运行时之前就查 |
| 3. 校验器 | 每个 Skill 的 `validate*` | 逐字引文、id 必须真实存在、日期必须在引文里、URL 必须真打开、流程必须无回路、`pass` 与各条判定必须自洽……模型「证明了形状」不等于「内容对」 |
| 4. 修正循环 | `runTurnsUntilValid`（`packages/codex/src/skill-runner.ts`） | 任何一层拒收，就把拒收原因作为同一线程的下一轮发回去，最多两次（每个 Skill 的路由可以改上限），次数记入 `audit.repairs` |

## 修正循环的规则

- **什么算拒收**：校验器抛错，**或者最终消息根本不是 JSON**（被截断、一直重复到上限）。后者以前会直接以 `SKILL_SCHEMA_INVALID` 结束，没有第二次机会——而这恰好是这个循环存在的理由。
- **什么不算**：超时、额度用完、模型拒绝回答、调用了被禁止的工具。再问一次解决不了这些。
- **模型自己说「停」不算错**：所有以 `_BLOCKED` 结尾的错误（`ANALYSIS_POLICY_BLOCKED`、`BACKGROUND_FACTS_BLOCKED`……）是 Skill 明说「缺一个我被告知不许猜的输入」。把它当拒收发回去，等于逼模型删掉 blocker 然后编造缺的东西——真实运行里对「整理一下」这条捕获，**两次里两次**都是这样。现在这类错误直接结束，原因原样给人看，由人补充后重新分析。
- **拒收原因要具体**：校验器的 `detail` 会点名出问题的字段或引文，因为空泛的错误码既不能让模型改对，也不能让人重试。
- **有两个清理在校验之前**：`cleanAnswerStrings`（去掉不可见字符，对所有 Skill 的所有字符串生效，`*quote` 字段除外，因为引文要和人的原文逐字比较）；以及分析契约里的 `trimFiller`（尾部重复字符、复读的句子、泄漏的外文字母和 `}],` 尾巴）。它们只会删掉模型本来就没答的东西，删掉不损失信息。

## 实测

`scripts/structured-output-check.ts` 对真实 Codex 跑各 Skill，每例两次，记录通过率、修正次数、token 和耗时（2026-10-03，一次约 12 分钟）：

| 用例 | 运行 | 通过 | 修正 | 输出 token | 说明 |
|---|---|---|---|---|---|
| 采访 · 内容丰富的第一条 | 2 | 2 | 0 | 9.4k | 约 2 分钟一轮 |
| 采访 · 追问 | 2 | 2 | 0 | 5.8k | |
| 采访 · 含糊的话 | 2 | 2 | 0 | 10.2k | |
| 分析 · 具体 | 2 | 2 | 0 | 2.7k | |
| 分析 · 含糊（「整理一下」） | 2 | 2 | **2** | 3.1k | 见下 |
| 分析 · 只有链接 | 2 | 2 | 0 | 1.7k | |
| 事实压缩 · 有内容 | 2 | 2 | 1 | 0.7k | 引文太短，修正后给了更长的逐字引文 |
| 事实压缩 · 无可学 | 2 | 2 | 0 | 0.1k | |
| 里程碑设计 | 1 | 1 | 0 | 7.2k | 约 3 分钟 |

通过率 100%，但修正次数不是零，而且**集中在含糊输入上**。读这张表的方法：通过率说明有没有兜底，修正次数说明 schema 或提示词有没有问题。

### 这次实测找到的两个真问题（都已修）

1. **退化文本会一路存进账本。** 「整理一下」两次运行里，`why`（理由）字段都在一句完整的话后面挂了一长串交替的零宽字符（U+200B / 200C / 200D），夹一个马拉雅拉姆字母和一个泄漏的 `numerusform】【。`。旧的「同一字符重复八次」裁剪认不出交替模式，所以它通过了校验、被存进了任务的材料要求，人会读到。现在不可见字符统一清掉，尾部的外文字母和括号尾巴被裁掉；逐字取自真实运行的夹具是 `apps/worker/src/testing/fixtures/analysis-degenerate-zero-width-padding.txt`。
2. **修正循环在「逼模型编造」。** 同样是「整理一下」：模型第一轮老实地报告「缺少待整理的材料」（blocker），修正循环把它当成错误发回去，第二轮模型就删掉 blocker、编出一个「待整理材料」要求。见上文「模型自己说『停』不算错」。

### 观察到的规律

- 退化出现在**自由文本字段的末尾**（`why`、`rationale`）。这和之前的结论一致：约束收得越紧，终止符附近越容易退化，所以长度上限在放宽到 300 后配合修正循环，而不是继续收紧。
- 采访一轮 8–15 KB 输出、约 2 分钟，没有出现退化；大输出本身不是问题，含糊输入才是。
- 里程碑设计一轮约 3 分钟、7.2k token，一次通过。

## 出问题怎么查

1. **看账本**：设置页「模型用量」按 Skill 列出调用次数、失败次数和修正次数；`model_usage` 表里 `error_code` 列是失败原因。一个 Skill 的修正次数长期大于零，说明它的 schema 或提示词需要改，而不是需要更多重试。
2. **看原始回答**：设 `CROSSLINE_RECORD_DIR` 后，每个回答（包括被拒收的）都会写成文件。把有问题的那份放进 `apps/worker/src/testing/fixtures/`，用 `recordedAnswer(name)` 驱动整条 worker → 校验 → 账本路径，写一条测试。**每个新发现的缺陷都应该留下一份夹具。**
3. **重新测量**：`pnpm exec tsx scripts/structured-output-check.ts [每例次数]`，会花真实额度，不会作为副作用运行。
4. **新 Skill 的 schema**：导出名以 `_SCHEMA` 结尾，`structured-output.test.ts` 会自动检查，不需要登记。
5. 规则速记：每个对象 `additionalProperties:false` 且全部属性进 `required`；「可选」用 `anyOf` 加 `null`，不要用缺省字段；联合用 `anyOf` 不用 `oneOf`；`web_search` 只认 `disabled | cached | live`。

## 关于让 Skill 用 shell

目前所有 Skill 都没有 shell（只读沙箱、`environments: []`）。2026-10-03 的探针 `scripts/shell-sandbox-probe.ts` 在四种权限设置下（只读沙箱；命名权限档拒绝一个目录；只允许一个目录；现状）都让模型执行读、写、联网命令，**每条都在执行前被拒绝**（`blocked by policy` / `MCP tool call requires approval, but approval policy is never`）。原因在运行时源码里：Windows 上没有启用 Windows 沙箱后端时，带文件系统限制的权限档下的命令在 `approvalPolicy: never` 时一律禁止（`core/src/exec_policy.rs`）。要启用它需要 Windows 沙箱的一次系统级设置（调整文件夹 ACL，可能需要管理员），而且即使启用，Windows 上能强制执行的是**拒绝读取的名单**（比如 `data/`、`.env`、`~/.codex`），不是「只许读这一个目录」的白名单——名单之外的东西仍然读得到。所以没有给任何 Skill 开 shell；需要读用户本地资料时，由 worker 抽取文本再交给模型，这样模型读到什么也是我们能逐字核对的。

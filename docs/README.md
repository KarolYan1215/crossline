# 文档索引

仓库里的文档分三类：现行的（和代码一起维护）、给开发者的约定、已归档的历史记录。

## 现行文档

| 文档 | 回答什么 |
|---|---|
| [../README.md](../README.md) | 这是什么、整体闭环、各页面做什么、AI 能力和它们的确定性校验、安全边界、发布闸门 |
| [getting-started.md](getting-started.md) | 从 `git clone` 到被采访、批准里程碑、验收第一件事的完整走查（含配置与启动） |
| [user-guide.md](user-guide.md) | 账号与登录、Tailscale 私网、离线与冲突、Codex 令牌、日历、备份恢复，采访 / 转写 / 屏幕活动 / 用量的机制与隐私承诺，以及主线、计划、设置与个人偏好的用法 |
| [copy-style.md](copy-style.md) | 界面与 prompt 的固定术语、文案规范和每阶段的审查标准（A 摩擦与可用 · B 阅读负担 · C 语言 · D 视觉） |
| [one-input.md](one-input.md) | 首页一个输入框：对话、命令、理解卡、动作注册表、主动气泡与精力模型（设计稿，待审） |
| [flywheel-and-views.md](flywheel-and-views.md) | 跨主线飞轮（产物优先的联合规划）、今日页图谱与左侧面板、计划页统计、原子化身份定语（已审定） |
| [review-2026-10-10.md](review-2026-10-10.md) | 系统评审：真实账本两周数据、临时账号走查、竞品对标，问题清单（P0/P1/P2）与已修复项、八个重点问题的回答 |
| [review-2026-10-13.md](review-2026-10-13.md) | 系统评审：10-10 修复后真实账本三天零回流、后台开销反增、待决 85 项；逐条复核 10-10 问题；竞品与大厂对标；第一性原理方案 R1–R7（参与度三档、决定预算、回归流程、及时准备）；自带 Codex 与多模型接口设计；云端未验证项的本机结果 |
| [personal-agent.md](personal-agent.md) | 个人代理（已实现，2026-10-19）：任何模型下的工具型助手（读写整理文件、本人的文件/任务/日历、网页、邮箱、收件箱）；IMAP 只读邮箱与新邮件整理；一句话建成的自动化（定时、每隔几小时、新邮件、网页变化、新文件、任务完成或到期触发），可按话修改、可从重复杂事长出来 |
| [domain-lines.md](domain-lines.md) | 极简版：主线可带领域（健康 / 财富），开场先问版本、每个领域一条；健康与财富按固定清单访谈；记账与健康记录（一张表）及其自动录入来源（邮件、手机通知、钱包、截图、健康数据、完成确认）与取舍（2026-10-19 定稿） |
| [skills-library.md](skills-library.md) | Skill 库（已实现）：本人每条主线一个由本人的话整理的 skill，验收闸门按它判「是否符合打法」；助手用 Codex 自带的 skill-creator 把重复的琐事长成工作流（可定时执行或提醒，发出与发布始终由本人完成）；公开 skills 的检索、扫描、AI 审查与 30 天清理 |
| [skills-picks-2026-10-20.md](skills-picks-2026-10-20.md) | 2026-10-20 的公开 skill 选单：本人常做的 12 类事各选 1–3 个（含星标、安装数、许可证、本机预检结果），以及看过但不选的和原因；清单在 `scripts/skills-picks.json` |
| [loop-and-scout.md](loop-and-scout.md) | 闭环与机会侦察：排期自动生效与锁定、后台最优排程、完成确认、日历整理（工作 + 生活邮箱）、上手提速、画像海报与定制形象、名人库、机会侦察（已定稿 2026-10-12）；实施计划在 [plans/](plans/)（P-A 闭环、P-B 上手、P-C 海报、P-D 形象、P-E 名人库、P-F 侦察） |
| [beta-launch.md](beta-launch.md) | 公开测评（32 题 + 漫画形象海报 + 关系与双人卡）和托管内测（香港 / 东京服务器、邀请码、国产模型与 ¥30 上限、本人迁移）的定稿方案与文案草稿（五轮问答，2026-10-14，待审） |
| [energy-and-ecosystem.md](energy-and-ecosystem.md) | 竞品尽调（Tiimo、Pikko、RISE、Visible、Muse、Manus 等）后的精力模型 v2（睡眠债、睡眠惯性、当日容量）、效率系数学习、手机接入与 Siri 收集、拆分提速、测评传播与分期（已定稿 2026-10-14） |
| [assess-deploy.md](assess-deploy.md) | 公开速测 `apps/assess`（32 题类型、类型海报、双人卡）：接口与规则、数据与保留期、邮件、Docker 构建、部署到香港/东京 VPS（未部署） |
| [assess-redesign.md](assess-redesign.md) | 公开速测重设计提案（2026-10-17，待拍板）：四条对立轴的问题、调研来源、方案 A/B/C 对比、推荐方案 B（八个倾向单极测量、双极呈现）的新题草稿与迁移清单 |
| [local-installer.md](local-installer.md) | 本机安装版（给内测者，不 clone 代码、用自己的 ChatGPT 额度）：目录结构、启动器与托盘、Codex 登录、使用记录回传与诊断快照、更新、已知限制与工作包 |
| [walkthrough-ledger.md](walkthrough-ledger.md) | 内测走查账本：以内测用户身份走查线上站点时已走过哪些路径、还有哪些没走、每次的发现与修复状态（走查前先读，只走没走过或改过的） |
| [onboarding-v3.md](onboarding-v3.md) | 登录页与访谈页 v3：安装版走查的审查发现，三栏访谈、引导开场、语气选择、混合节奏、iCal 订阅与授权文件夹，各阶段进展（2026-10-14） |
| [calendar-write-setup.md](calendar-write-setup.md) | Crossline 日历的写入授权（只写名为 Crossline 的日历），以及分享到 Google 日历 |
| [setup-google-oauth.md](setup-google-oauth.md) | 开启「用 Google 账号登录」的一次性配置 |
| [setup-siwc.md](setup-siwc.md) | Sign in with ChatGPT：能做什么、怎样打开、订阅额度共享还差什么 |
| [competitors.md](competitors.md) | 竞品与证据（2026-10-06）：各产品的机制、借鉴点与可信度，以及设计所依据的研究 |
| [model-scheduling.md](model-scheduling.md) | 模型调度（已实现，2026-10-19）：每账号两个并行、账号轮流、短活先跑与等久升级、有人在等内存够即开始、开发者模型的限流与被拒换模型、简单活用快模型、低价时段、缓存命中与测量 |
| [model-providers.md](model-providers.md) | 接入本人自己的 Codex 与其他 API 模型：现有耦合清单、接口设计、分阶段与风险（设计稿，待审） |
| [assistant-agent.md](assistant-agent.md) | 带 shell 的助手：设计、守卫、信任与审阅流程 |
| [context-selection.md](context-selection.md) | 只把当前任务需要的信息放进上下文：文件段落的全文索引、候选与模型自选的两个查阅工具、各处预算、实测 |
| [structured-output.md](structured-output.md) | 模型的结构化输出怎么约束、怎么校验、怎么修正，出问题怎么查，现有的实测数据 |
| [codex-fork-runtime.md](codex-fork-runtime.md) | 固定在 `vendor/codex` 的 Codex 运行时：来源、补丁、构建、哈希校验、升级方式、supervisor 令牌 |
| [private-network-deployment.md](private-network-deployment.md) | 通过 Tailscale Serve 跨设备访问（`CROSSLINE_DEPLOYMENT_MODE=private`） |
| [external-deployment.md](external-deployment.md) | 真正的公网暴露为什么还被禁止，以及解禁前要满足的清单 |

## 开发者约定

- [../CLAUDE.md](../CLAUDE.md)：架构、命令、每条规则背后的「当时踩了什么坑」，给 Claude Code 和新接手的人读。改动代码时同步更新它，而不是另写文档。
- 动手写「让模型做某事的脚本」之前，先看 CLAUDE.md 末尾「What is deliberately not ours to build」：Codex 已经提供的不要重写，必须自己做的是确定性校验。

## 归档（`archive/`）

2026-09 到 10 月初的设计与验收记录。思想和决策背景仍有价值，但页面、路径、数字以现行文档和代码为准。

| 文档 | 内容 |
|---|---|
| [archive/crossline-mvp-implementation-plan.md](archive/crossline-mvp-implementation-plan.md) | v1 个人 MVP 执行计划（与 v2 冲突的部分已作废） |
| [archive/crossline-plan-critical-review.md](archive/crossline-plan-critical-review.md) | 对最早改进计划的批判性评审 |
| [archive/crossline-redesign-v2.md](archive/crossline-redesign-v2.md) | v2 重构设计与 14 条裁决（「数学只作用于可测量的量」等原则仍有效） |
| [archive/implementation-todo.md](archive/implementation-todo.md) | 实现清单与实现期发现并修掉的缺陷记录 |
| [archive/acceptance-protocol.md](archive/acceptance-protocol.md) | 「这条路通不通」的验收协议 |
| [archive/codex-test-plan.md](archive/codex-test-plan.md) | 交给 Codex 自动跑的测试方案，含证伪设计赌注的红队层 |
| [archive/codex-browser-drill.md](archive/codex-browser-drill.md) | 两项浏览器实测脚本 |
| [archive/ux-review-2026-10-01.md](archive/ux-review-2026-10-01.md) | 2026-10-01 的用户视角测评 |
- [onboarding-prompts.md](onboarding-prompts.md)：访谈对话层、整理层与画像报告的 prompt 结构、目的、实际上下文，对照本人真实访谈找出的问题与 2026-10-20 的修改。
- [ledger-sync.md](ledger-sync.md)：本机与服务器账本的长期同步。
- [review-2026-10-20.md](review-2026-10-20.md)：2026-10-20 全系统走查与调研（Muse、Codex/Claude Code、可穿戴、公域用户）。

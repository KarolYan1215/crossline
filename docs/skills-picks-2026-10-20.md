# 公开 skill 选单（2026-10-20）

为本人常做的事挑选可装进 Skill 库的公开 skill。清单同时写在 `scripts/skills-picks.json`，由 `scripts/install-skills.ts` 逐个经「按链接添加」安装（见 `docs/skills-library.md` §2「按链接添加」）。本文只是候选：每一个仍要过取回、许可证、代码扫描与模型审查，结论以安装结果为准。

## 怎么选的

- **本人常做的事**：只读本机账本（工作区 `bf8be609…`）的 89 个任务与 343 个步骤，以及四条主线（研究者：神经形态计算的软硬件协同、器件与论文；创业者：为多主线超级个体做工具；创作者：小红书图文与视频；投资者：美股科技股、受控风险）。归成下面 12 类。
- **找候选**：skills.sh 排行（[skills.sh](https://www.skills.sh/)，以及每日汇总 [LinklyAI/best-skills](https://github.com/LinklyAI/best-skills) 2026-10-20 的 [best-100.csv](https://raw.githubusercontent.com/LinklyAI/best-skills/main/data/2026-10-20/rankings/best-100.csv)）、Anthropic 官方 [anthropics/skills](https://github.com/anthropics/skills) 与 [anthropics/financial-services](https://github.com/anthropics/financial-services)、OpenAI [openai/skills](https://github.com/openai/skills)、Awesome 列表（[ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)、[travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)），以及按类别的网页检索。ClawHub 上的条目多为个人账号的单个 skill（天气、Slack、Notion 一类），与这些任务无关，没有选。
- **数字**：星标为 2026-10-20 用 GitHub API 读到的仓库星标（整个仓库，不是单个 skill）；安装数为当天 skills.sh 该 skill 页面显示的数。
- **排除**：需要付费 API key 才能用的、会发送/发布/付款的、许可证不允许再分发的，以及 Crossline 取回规则装不进的（目录超过 40 个文件或 600 KB、SKILL.md 没有 frontmatter、仓库与目录都没有可识别的许可证）。
- **本机预检**：每个入选目录都用 `pnpm exec tsx scripts/install-skills.ts --dry-run` 走过一遍与 worker 相同的取回、许可证判断与代码扫描（不经模型、不写账本），结果写在每条后面。扫描为「高」的会被压成「只用文字」（去掉脚本），本人可在 Skill 库里看过扫描结果后允许脚本。

## 选单

| # | 任务类别 | 主线 | skill（仓库 / 目录） | 星标 · 安装 | 许可证 | 用途 | 本机预检 |
|---|---|---|---|---|---|---|---|
| 1 | 文献综述与论文写作 | 研究者 | [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) `skills/scientific-writing` | ★53.2k · [2.3K](https://www.skills.sh/K-Dense-AI/scientific-agent-skills) | MIT | 起草与修改论文、评审材料，逐条标证据来源并按报告规范自检 | 扫描高（`check_references.py` 查 DOI 联网）→ 预计只用文字 |
| 1 | 同上 | 研究者 | 同仓库 `skills/literature-review` | ★53.2k · 2.2K | MIT | 用 arXiv、Semantic Scholar 等免费来源系统检索、筛选、核对引用 | 扫描高（示意图脚本会在上级目录找 `.env` 读 OpenRouter key）→ 预计只用文字；该步需要付费 key，去掉脚本后不受影响 |
| 2 | 实验数据分析与科研作图 | 研究者 | 同仓库 `skills/scientific-visualization` | ★53.2k · 2.3K | MIT | 投稿级图表：多面板、误差与缺失值的画法、配色与对比度检查 | 扫描高（联网、删除）→ 预计只用文字 |
| 2 | 同上 | 研究者 | 同仓库 `skills/statistical-analysis` | ★53.2k · 2.2K | MIT | 检验选择、前提检查、效应量与功效，按 APA 格式报告 | 扫描低 |
| 3 | 学术报告幻灯片 | 研究者 | [Gabberflast/academic-pptx-skill](https://github.com/Gabberflast/academic-pptx-skill) 仓库根目录 | ★1,253 · [1.1K](https://www.skills.sh/Gabberflast/academic-pptx-skill) | MIT | 组会、评审、答辩的论证结构、动作标题与图表纪律（只有文字） | 扫描低；目录里的 PDF 不取 |
| 4 | 课程学习与考试复习 | 研究者 | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/productivity/teach` | ★298k · [842.5K](https://www.skills.sh/mattpocock/skills/teach) | MIT | 按学习目标拆知识点、记学习记录与术语表，适合 ECE 548/555 的期中与小测复习 | 扫描低 |
| 5 | 电路与器件设计仿真（Cadence、6T SRAM） | 研究者 | **不选** | — | — | 没有找到许可证可用、内容可靠的模拟电路或 Virtuoso skill；K-Dense 的 `lab-hardware-cad` 是实验室硬件 CAD，不对口 | — |
| 6 | 路演、BP 与融资叙事 | 创业者 | [ferdinandobons/startup-skill](https://github.com/ferdinandobons/startup-skill) `startup-pitch` | ★1,208 · [692](https://www.skills.sh/ferdinandobons/startup-skill) | MIT | 10/5/2/1 分钟路演稿与投资人邮件，问答准备与评分表，要求数字真实可核 | 扫描低 |
| 6 | 同上 | 创业者 | K-Dense `skills/market-research-reports` | ★53.2k · 1.9K | MIT | BP 里的市场规模与行业证据，TAM/SAM/SOM 互相校验，每个数字可追溯 | 扫描高（删除）→ 预计只用文字 |
| 7 | 竞品、用户研究与假设检验 | 创业者 | ferdinandobons/startup-skill `startup-competitors` | ★1,208 · 635 | MIT | 竞品的产品、定价、用户口碑与增长信号，产出对比矩阵与 battle card | 扫描低 |
| 7 | 同上 | 创业者 | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) `skills/customer-research` | ★55.7k · [112.0K](https://www.skills.sh/coreyhaines31/marketingskills) | MIT | 整理试用反馈与访谈记录，提炼用户原话与需求 | 扫描低 |
| 7 | 同上 | 创业者 | mattpocock/skills `skills/productivity/grill-me` | ★298k · 1,392,524（[best-100.csv](https://raw.githubusercontent.com/LinklyAI/best-skills/main/data/2026-10-20/rankings/best-100.csv)） | MIT | 逐条追问一个计划或设计，用来压力测试 MVP 计划与可验证假设 | 扫描低 |
| 8 | 小红书选题与图文文案 | 创作者 | coreyhaines31/marketingskills `skills/content-strategy` | ★55.7k · 160.4K | MIT | 内容支柱、选题优先级与系列化 | 扫描低 |
| 8 | 同上 | 创作者 | 同仓库 `skills/marketing-psychology` | ★55.7k · 161.2K | MIT | 标题与开头用到的心理机制（损失厌恶、框架效应等），与本人「冲突—解释—solution」的打法一起用；本人的主线 skill 优先 | 扫描低 |
| 9 | 短视频脚本与剪辑 | 创作者 | [n0an/ffmpeg-skill](https://github.com/n0an/ffmpeg-skill) `ffmpeg` | ★13 · — | MIT | ffmpeg 配方：裁切、拼接、字幕、竖屏、响度，给已有的 vlog 工作流作参考（只有文字） | 扫描低。星标很少，选它只因同类里没有更好的可用项 |
| 10 | 投资研报与持仓论点 | 投资者 | [anthropics/financial-services](https://github.com/anthropics/financial-services) `plugins/vertical-plugins/equity-research/skills/earnings-analysis` | ★40.5k · [3.3K](https://www.skills.sh/anthropics/financial-services) | Apache-2.0 | 财报季点评：超预期或不及预期、关键指标、预估与论点更新 | 扫描低。文中「24–48 小时内发布」指研报时效，不是发布动作 |
| 10 | 同上 | 投资者 | 同仓库 `plugins/vertical-plugins/equity-research/skills/thesis-tracker` | ★40.5k · 1.1K | Apache-2.0 | 持仓与关注清单的投资论点、催化剂与里程碑，判断论点是否仍成立 | 扫描低 |
| 11 | 进展汇报与沟通邮件 | 研究者 | [anthropics/skills](https://github.com/anthropics/skills) `skills/internal-comms` | ★182k · [78.9K](https://www.skills.sh/anthropics/skills) | Apache-2.0（目录内 LICENSE.txt） | 给导师、助教的进展更新与确认邮件的格式；只起草，发送归本人 | 扫描低 |
| 12 | 表格整理（成绩记录、账户结单） | 研究者、投资者 | **不选** | — | — | 最常用的 `anthropics/skills` 的 `xlsx` 是 Anthropic 专有许可，不允许再分发 | — |

一个 skill 只服务清单里写的那条主线；同一目录对另一条主线也有用时，再按链接添加一次即可（不会重新取回，只把主线加上）。

## 看过但不选的

| skill | 原因 |
|---|---|
| anthropics/skills 的 `docx`、`pptx`、`xlsx`、`pdf` | 目录内 LICENSE 为 Anthropic 专有许可，不允许再分发 |
| anthropics/skills `doc-coauthoring` | 仓库没有许可证，目录里也没有 LICENSE，取回规则不收 |
| K-Dense `scientific-slides` | 生成幻灯片的核心步骤要 OpenRouter API key（付费） |
| [browser-use/video-use](https://github.com/browser-use/video-use)（★29.4k） | 转写依赖 ElevenLabs Scribe，需要付费 key |
| coreyhaines31 `video` | 围绕 HeyGen、Runway、Sora 等付费视频工具 |
| coreyhaines31 `social` | 有「从代理直接排期发布」一节，引导接入排期工具发帖 |
| coreyhaines31 `competitor-profiling` | 本机预检的注入扫描命中「proceed without asking」，会被直接拒绝；改选 `startup-competitors` |
| [Melvynx/video-agent-skills](https://github.com/Melvynx/video-agent-skills) `studio-script`（★32） | `references/humanize.md` 讲零宽字符时含隐藏字符，扫描判为注入，会被拒绝 |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | 仓库与目录都没有许可证；`remotion-best-practices` 还有 144 个文件 |
| [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides)（★31.0k）、[lewislulu/html-ppt-skill](https://github.com/lewislulu/html-ppt-skill)（★8.8k） | skill 在仓库根目录，整个仓库 163 / 239 个文件，超过 40 个的上限 |
| [op7418/guizang-social-card-skill](https://github.com/op7418/guizang-social-card-skill)（★7.6k） | AGPL-3.0 另附商业授权条款，托管使用有公开源码的义务 |
| [mindfold-ai/xhs-content](https://github.com/mindfold-ai/xhs-content) | 采集要用 `xhs-cli` 登录小红书、提取 Cookie |
| [rollingSirius/equity-research-skill](https://github.com/rollingSirius/equity-research-skill)（★463） | 根目录 47 个文件、611 KB，超过上限 |
| [kajisho5/ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill)（★2.0k） | 根目录 331 个文件 |
| [6missedcalls/video-editing-skill](https://github.com/6missedcalls/video-editing-skill) | SKILL.md 没有 name 与 description |
| Minerva67/xhs-ops-playbook 等小红书写作 skill | 没有许可证 |

## 扫描的两处误判（未改，记下）

- `competitor-profiling` 的「If the user provides URLs and context is available, proceed without asking.」是让模型少问问题，不是绕过审批，但注入规则一律拒绝。
- `studio-script` 的 `humanize.md` 是教人删掉零宽字符的说明，文件里因此带着这些字符。

两条都按现有规则处理（注入一律拒），没有为它们放宽扫描。

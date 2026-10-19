# 模型调度

谁的模型调用先跑、同时跑几个、开发者模型被拒时怎么办、哪些活等低价时段。2026-10-19 与本人三轮问答后定稿并实现。

## 改之前的问题

1. **同一账号同一档只能一个接一个。** 每个运行时按「高、中、低」三档各排一条队。10-17 批准一批里程碑后，反推任务和拆步骤都严格串行；换成开发者模型后，拆步骤中位 510 秒，10 个任务要 85 分钟。这条队原本是为了防止两次运行同时改运行时的配置文件，而改配置早有一把单独的短锁。
2. **排队看不到。** 日志只记总闸的等待（线上几乎都是 0），按档排队的等待没有记录。
3. **总闸不分账号，先到先得。** 一个人一次批准 12 个里程碑，后台位置就可能全被他的活占满。
4. **优先级固定。** 规划类一直有活时，调研和教程可能一直轮不到。
5. **有人在等的只留 1 个位置。** 总闸实际在限内存（模型在远端算），内存宽裕时也会让人等。
6. **开发者模型的上游限流没管。** 硅基流动按账号、按模型限制每分钟请求数和 token 数（最低一档 1000 次 / 4 万 token，按月消费升级），所有赞助账号共用一个 key。被拒后各次运行各自重试；「满载」时只会重试同一个模型。
7. **开发者模型所有 Skill 共用一个模型。**
8. **worker 的定时轮次逐个账号做完。** 一个账号的长积压（85 分钟的拆步骤）会挡住其他账号的记下的事和日历同步。
9. **缓存几乎命中不了 Skill 正文。** Codex 把 Skill 正文插在每次都不同的输入之后，开发者模型 V4.1-Flash 命中缓存的输入价是 0.04 元 / 百万 token，未命中 2 元，相差 50 倍。

## 定下的规则

| 方面 | 规则 | 代码 |
|---|---|---|
| 账号内并行 | 每个账号的后台调用最多 2 个同时（`CROSSLINE_ACCOUNT_CONCURRENCY`）；助手另走一条队，不占这 2 个名额；同一线程的连续回合仍一个接一个 | `model-gate.ts` `accountConcurrency`、`skill-runner.ts` `agentLanes`/`threadLanes` |
| Skill 开关 | 按引用计数：第一个用到的运行打开，最后一个用完的关回去（原先是关着的才关），同一 Skill 可同时跑两次 | `skill-runner.ts` `holdSkill`/`releaseSkill` |
| 账号间 | 同一优先级里，账号轮流拿位置（上次被服务最早的先） | `model-gate.ts` `ordered` |
| 先短后长 | 同一优先级、同一账号里，按各 Skill 最近 20 次用时的中位数，短的先跑 | `expectedServiceMs` |
| 等久升级 | 等满 15 分钟升一级，再等 15 分钟再升一级 | `AGING_MS` |
| 有人在等 | 访谈和输入框只要内存低于水位就立即开始，不占后台名额；内存高时排在队首。后台名额仍是总数减保留数 | `eligible` |
| 定时轮次 | 每个账号的后台活各自启动，不等别的账号；上一次还没跑完的账号这一轮跳过 | `apps/worker/src/index.ts` `workspaceTick` |
| 规划类 | 反推和拆步骤每次两件同时做，一批接一批直到做完（原先拆步骤每轮只做 2 件） | `eachLimited` |
| 开发者模型限流 | 本地网关按「上游地址 + 模型」限制同时在途的请求：从 6 起步（`CROSSLINE_UPSTREAM_CONCURRENCY`），被拒（429、503、「满载」）就减半，成功次数达到上限值就加一，最多 16；有人在等的请求排在前面 | `model-gateway.ts` |
| 被拒怎么办 | 有人在等：马上再试一次，仍被拒就换下一个通过该 Skill 检验的候选（最便宜的先）。后台：按 Retry-After 或 5/15/45/90 秒退避后再试同一个模型，都不行再交给 Codex 自己的重试。检验中的运行从不换模型 | `GatewayUpstream.fallback`、`sponsorFallbacks` |
| 简单活用快模型 | 任务标题、日历归类、文件夹归类、目标拆分、背景事实、邮件分拣这 6 个 Skill，用通过检验里最便宜的候选；访谈、输入框、分析、验收、拆步骤、里程碑、审查不换 | `SPONSOR_SIMPLE_SKILLS`、`sponsorModelForSkill` |
| 检验期间 | 重新检验没跑完时，继续用上次选中的模型，不暂停；从没留下选择时，用旧检验里真正调到模型的记录选一个 | `sponsor.json` `lastChosen` |
| key 余额用完 | 第一次「用量额度已用完」就停下这个候选，不写记录（10-19 第 6 版检验因此把所有候选记成全部不过）；之后每半小时试一次，充值后自动接着测；诊断打印余额 | `SPONSOR_KEY_EXHAUSTED`、`balance` |
| 低价时段 | 用开发者模型的账号，调研、跨线飞轮、画像重写（第一份不等）、技能检索与整理、精力建议、定期复检，等北京时间 2–8 点；教程只在下一个低价时段结束后离工作开始还有一天以上时才等。规划类、记下的事、有人在等的都不等。部署后的那次检验不等 | `sponsorOffPeak`、`hoursToOffPeakEnd`、`waitsForOffPeak` |
| 缓存 | 聊天桥接把 Skill 正文挪到同一段用户消息的最前面；线程中途 Codex 加的说明留在原处（作为带标记的用户消息），系统消息在整条线程里不变；开发者模型的线程不注入全部 Skill 的目录 | `chat-bridge.ts` `stableFirst`、`skills.include_instructions` |
| 测量 | 每次运行记一条 `skill.run`：排队（助手的队、同一线程的上一回合）、总闸等待、模型用时、输入、缓存命中、输出；诊断按 Skill 汇总（`deploy/server/skill-runs.py`） | `runRouted` |

## 开发者模型的候选

10-19 凌晨那一轮完整检验（每个模型 42 次）：

| 模型 | 通过率 | 每次成本 | 用时中位 / P95 | 需修正 |
|---|---|---|---|---|
| DeepSeek-V4.1-Flash | 100% | ¥0.041 | 16 s / 38 s | 5% |
| GLM-5.3-Flash | 97.6% | ¥0.013 | 21 s / 145 s | 5% |
| DeepSeek-V4-Flash | 100% | ¥0.054 | 12 s / 42 s | 19% |
| GLM-5.3 | 100% | ¥0.113 | 22 s / 73 s | 5% |
| GLM-5.2 | 100% | ¥0.148 | 22 s / 56 s | 2% |
| DeepSeek-V4-Pro | 100% | ¥0.170 | 39 s / 79 s | 5% |

按通过率、每次成本、P95 三项，只有 V4.1-Flash 和 GLM-5.3-Flash 在前沿上；另外四个都被 V4.1-Flash 压过，本人决定不再测。新加的五个是目录里按现价估算每次可能比 V4.1-Flash 便宜的：Qwen3.5-35B-A3B（约 ¥0.014）、Step-3.5-Flash（约 ¥0.019）、Qwen3.5-27B（约 ¥0.021）、Qwen3.5-122B-A10B（约 ¥0.029）、Ling-flash-2.0（约 ¥0.029），估算按 V4.1-Flash 每次约 2.1 万输入、1800 输出。Qwen3.6、Qwen3.8、Kimi K2.6/K2.7、GLM-5.1、DeepSeek V3.x/R1 按现价每次都比 V4.1-Flash 贵，不可能进前沿，没加。

以后每轮检验之后自动淘汰：同一版检验里，另一个候选通过率不低、每次成本（按现价）不高、P95 不慢，且至少一项更好，这个候选就不再测、不再用（`dominatedCandidates`，日志 `sponsor.pruned`）。淘汰写进 `sponsor.json` 的 `pruned`，检验版本以后再升级也不会把它测回来。一个候选前 5 次检验都因自己的原因失败（不是限流、满载、额度或卡住），就停在那里，已测的照样记下，它自然被淘汰（`sponsor.stopped_early`；Ling-flash-2.0 每次跑 5–7 分钟、次次失败，原本会占着检验名额几个小时）。检验时网关遇到限流按后台活退避重试，不因 Skill 是访谈就快速放弃：被硅基流动的每分钟 token 上限拒掉不说明模型好坏（Step-3.5-Flash 的样例访谈第 3 轮就是这样失败的）。推理强度试验跑在选中的模型和前沿上最快的另一个候选上。

## 查过但没做

- **硅基流动批量接口**：半价、不占在线限流，但只支持 DeepSeek-V3、V3.1-Terminus、R1，24 小时内出结果，文档没提结构化输出和工具调用；我们的运行几乎都是多轮带工具带修正的。
- **对冲请求**（同一请求发两份取先回来的）：费用翻倍，Codex 线程有状态，两份结果难以合并。只在被拒时换模型。
- **用模型预测输出长度**：按 Skill 历史用时排序就够了。

## 来源

- 硅基流动限流与等级：<https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation>
- 硅基流动批量推理：<https://api-docs.siliconflow.cn/docs/userguide/guides/batch>
- 按 token 计量的公平调度（VTC，OSDI 2024）：<https://usenix.org/conference/osdi24/presentation/sheng>
- 多租户调度与老化：<https://tianpan.co/blog/2026-05-07-scheduling-fairness-multi-tenant-llm-workloads>
- 按排序近似最短任务优先（NeurIPS 2024）：<https://arxiv.org/abs/2408.15792v1>
- 自适应并发限制（Netflix）：<https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581>
- DeepSeek 上下文缓存的命中规则：<https://api-docs.deepseek.com/guides/kv_cache>

# 文档索引

仓库里的文档分三类：现行的（和代码一起维护）、给开发者的约定、已归档的历史记录。

## 现行文档

| 文档 | 回答什么 |
|---|---|
| [../README.md](../README.md) | 这是什么、整体闭环、各页面做什么、AI 能力和它们的确定性校验、安全边界、发布闸门 |
| [getting-started.md](getting-started.md) | 从 `git clone` 到被采访、批准里程碑、验收第一件事的完整走查（含配置与启动） |
| [user-guide.md](user-guide.md) | 账号与登录、Tailscale 私网、离线与冲突、Codex 令牌、日历、备份恢复，以及采访 / 转写 / 屏幕活动 / 用量的机制与隐私承诺 |
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

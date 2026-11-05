# 插件版：Crossline 作为 Claude Code / Codex 的 skills（草案，2026-11-04）

状态：草案。本人已定以下几条（见 `docs/editions.md`）：

- Claude Code 和 Codex 两个宿主一起做。
- 用法是开一个对话，访谈在原生 agent 里由 skill 引导完成。
- 看板在宿主的内置浏览器里打开。
- 产品本身只提供 skills。
- 模型调用用的是用户自己的额度。
- 后台工作由宿主定时任务跑 skills。
- 不出画像报告。

## 1. 模型变了，哪些东西必须跟着变

今天每个 Skill 都由 worker 通过 Codex app-server 调用，强约束全在我们这一侧：

- strict `outputSchema`；
- 验证不过就在同一 thread 内修复，最多两次；
- 逐字引用校验；
- 状态机。

插件版改由宿主 agent 在对话里执行 skill。我们拿不到 outputSchema，也控制不了重试次数。对策是**把验证器做成 CLI**：

```
crossline <command> --json <file|->   读写账本；先过现有 validator，再写入
  exit 0 → 写入成功，输出新状态摘要
  exit 2 → 拒绝，stderr 输出与今天 repair 消息相同的文本（指明哪一条、为什么）
```

SKILL.md 规定：每产出一份结构化结果，就交给 `crossline` CLI；被拒绝时按 stderr 修改后重交，三次都不过就停下来告诉用户。这就是今天的 repair 循环，只是从 thread 内移到了 CLI 的往返里。validator 不需要改（`packages/core` 的 `validate*` 本来就是纯函数）。

要接受的代价：

- **质量**：宿主模型对 schema 的遵守程度不受我们控制。本地 CLI 拒绝的那部分会多耗用户的额度。
- **提示词公开**：skills 和 SKILL.md 都是明文，都在用户手里。

## 2. 结构

```
crossline 插件（Claude：.claude-plugin/plugin.json；Codex：.codex-plugin/plugin.json）
  skills/      访谈、收集分析、反推、步骤规划、今日、复盘……（从现有 40 个里挑，见 §4）
  bin/crossline        CLI：账本读写 + validator；Node 单文件打包（同 scripts/package-node.ts 的做法）
  bin/crossline-serve  起本机看板 web（127.0.0.1，只读或少量操作）
  hooks/       SessionStart：注入今日一两行摘要
  Claude 专有：mod（Pane / band / 状态行）
  Codex 专有：MCP App 视图（若 Codex app 渲染）
```

账本：本机 SQLite，复用 `packages/db`。插件版不需要 worker 和 Codex 运行时，Node 依赖少了很多：不需要 onnxruntime、sherpa、Playwright，也不需要 HiGHS 后台求解，贪心排程够用。

## 3. 看板在内置浏览器

- **Claude Desktop 的 Code 标签页**：有浏览器面板，可以从 `.claude/launch.json` 起本机服务并打开。插件可以带一份 launch 配置，或者让 `crossline-serve` 打印 URL，让 agent 用浏览器工具打开。
- **Codex app**：有内置浏览器（[官方文档](https://developers.openai.com/codex/app/browser.md)）。2026-04 上线时只有 Mac，Windows 是否已经可用未核实。打开 localhost 时用的是 Browser 插件的 browser use 功能。
- **CLI（两家都是）**：没有内置浏览器，只能打开系统浏览器。
- 看板 web 用现有的 `apps/web`，以 local 模式启动：`CROSSLINE_INSTALL_MODE=local`，不需要登录。插件版裁掉依赖 worker 的页面和按钮，或者把它们显示为“由定时任务处理”。

## 4. 后台工作 = 宿主定时任务

| 今天的 worker pass | 插件版 |
|---|---|
| 收集分析、反推、步骤规划 | 定时任务（如每天 8:00、13:00、19:00）开一个对话：“运行 crossline 后台”，skill 依次处理积压 |
| 邮件分拣、录音、文件夹 | 不做，或者只在用户要求时做 |
| 日历同步、提醒、完成确认 | 不用模型，但需要常驻进程。宿主不常驻，所以插件版要么没有提醒，要么装一个不跑模型的小常驻（`crossline-serve` 开机自启） |
| 画像报告 | 不做 |

定时任务的条件：

- Claude Desktop 的定时任务只在 Desktop 开着时运行（[routines 文档](https://code.claude.com/docs/en/routines.md)）。
- Codex automations 用到本地文件时，要求电脑开着、app 也开着（[automations](https://learn.chatgpt.com/docs/automations?surface=app)）。

插件能否自带定时任务未核实，可能要 skill 引导用户自己建一个。

## 5. 风险

1. **质量下滑**：模型不受控。缓解办法是把 CLI 验证器做严，并在 SKILL.md 里写清楚怎么修。
2. **额度**：访谈 12 轮，加上每天三次后台对话，在用户自己的额度里很显眼，尤其是 Claude Pro。
3. **两个宿主的差异**：mod 只有 Claude 有；Codex 内置浏览器的 Windows 支持未核实；定时任务都要求 app 开着。
4. **提醒**：没有常驻进程就没有提醒。这是插件版和本地版之间最大的功能差。
5. **维护面**：同一套 skills 要同时适配 worker（strict schema）和宿主对话（CLI 验证）两种运行方式。建议 SKILL.md 共用，宿主版只多一段“如何调用 crossline CLI”。

## 6. 拆分（待本轮决定后）

| 会话 | 内容 | 依赖 |
|---|---|---|
| P1 | `crossline` CLI：账本读写 + 现有 validator 的命令封装 + 单文件打包 | 无 |
| P2 | 插件骨架两份清单 + 访谈 skill 的宿主版 + SessionStart hook | P1 |
| P3 | `crossline-serve` + 看板 local 精简模式 + 两个宿主打开看板的方式 | P1 |
| P4 | 后台 skill（积压处理）+ 定时任务引导 | P1、P2 |
| P5 | Claude mod（Pane/band/状态行） | P3 |
| P6 | 本地版和网页版的 `/mcp` 端点（与其他 agent 协同） | 无 |

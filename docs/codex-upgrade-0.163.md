# Codex 运行时从 0.155.0 升到 0.163.0（2026-10-20）

`vendor/codex` 从上游 `rust-v0.155.0`（`f0a1b8f0`）升到 `rust-v0.163.0`（`83086188`，2026-10-15 发布，查 GitHub releases 时仍是最新的正式版；0.164.0 还只有 alpha）。fork 唯一的改动（Windows 迁移校验和修复）保留：上游 0.163.0 仍不处理旧 Windows 版本写下的 CRLF 校验和，`codex-rs/state/src/migrations.rs` 里也没有等价的修复。补丁文件按新标签重新生成，`codex-baseline.json` 记着新的哈希。

## 协议差异：我们用到的方法

逐个比对了 `codex-rs/app-server-protocol` 在两个标签之间的变化（`common.rs` 的方法表和 `v2/` 下的类型），只看 worker 真用到的部分：

| 方法 / 通知 | 0.163.0 的变化 | 对我们 |
|---|---|---|
| `thread/start` | 新增 `daybreakEnabled`（实验）；响应多 `disabledPluginIds` | 无影响 |
| `turn/start` | 新增 `disabledPluginIds`、`parentTurnId`、`rootTurnId`；`personality` 作废；在一个还在进行的 turn 上再发 `turn/start` 会**转向**那个 turn | 无破坏。转向这一点正是 `threadLanes` 防住的：同一线程上一次只有一个 turn，压缩也排在这条线里 |
| `thread/resume` | 参数不变；响应多 `collaborationMode`、`disabledPluginIds`；**恢复已保存线程时会恢复它的权限与网络批准**（#53150 等） | 新的自动化续跑用它（见下） |
| `thread/unsubscribe`、`thread/loaded/list`、`turn/interrupt` | 不变 | — |
| `thread/compact/start` | 不变（0.155 已有）；压缩是一个独立 turn：`turn/started` → `item/started`（`contextCompaction`）→ `item/completed` → `turn/completed` | 新的显式压缩用它（见下） |
| `item/tool/call`、`item/tool/requestUserInput`、`dynamicTools` | `DynamicToolSpec` 不变（仍只有 `deferLoading`，没有只读标记） | 无影响 |
| 权限配置文件（`default_permissions`、`[permissions.<id>]`） | 不变 | 沙箱助手照旧 |
| `mcpServer/tool/call`、`app/*`、`model/list` | `Model` 多 `availableAccessPrograms`，`namespaceTools` 去掉（我们不读） | 无影响 |
| `account/*` | 新增 `account/gatewayOAuth/*`、`account/read.workspaceRouting`（实验） | 无影响 |
| `ThreadItem` | `commandExecution` 多两个只在服务端的字段；`mcpToolCall` 多 `mcpAppUi`；`subAgentActivity` 多 `model`/`reasoningEffort` | 无影响 |
| `CodexErrorInfo` | 新增 `flexUnavailable`、`tooManyDenials`（自动审查用），未知值序列化为 `"other"` | 我们把未知值都当 `SKILL_TURN_FAILED`，不变 |
| `thread/rollback` | **删除** | 我们没用过 |

功能开关（`features.*`）：`thread/start` 里关掉的那串在 0.163.0 都还在，没有改名；`send_message_to_user_async` 是新加的（我们早就写在关闭列表里，旧运行时不认识就丢掉）。新加的默认开启项（`daemon_auto_start`、`in_app_voice`、`worktrees`、`realtime_conversation` 等）都只作用于 TUI 或与结构化运行无关。

结论：TS 侧没有需要改的破坏性变化，新代码对 0.155.0 也兼容（`thread/compact/start` 和带覆盖参数的 `thread/resume` 在 0.155.0 里就有），所以旧二进制在被替换前照常能跑。

## 新加的两件事

**显式压缩长对话**（`packages/codex/src/skill-runner.ts` `compactThread`）。保留线程的对话（访谈对话层、输入框、里程碑设计）每个 turn 结束后，用这轮最后一次 `thread/tokenUsage/updated` 的 `last.totalTokens` 对 `modelContextWindow` 比较；超过 `COMPACT_AT`（默认 0.6，`CROSSLINE_COMPACT_AT` 可改）就在这条线程自己的队列里排一次 `thread/compact/start`，下一个 turn 等它做完再发。运行时本来就会在溢出时自动压缩，但那发生在本人下一句话的开头，本人要等；现在它发生在两轮之间。压缩在模型闸门里按这个 Skill 自己的优先级排队，用量记在这个 Skill 名下，结果写一行 `skill.compacted`（压缩前 token、窗口、耗时、成功与否）。没报窗口（`modelContextWindow` 为空）就不压缩；一次性运行不压缩。

**自动化在同一段对话里按时醒来**（`apps/worker/src/automations.ts` `fire`，`SkillRunOptions.resumeThreadId`）。上游没有原生的定时唤醒或线程自动化（app-server 协议里没有对应方法），所以仍用我们自己的调度。每个自动化记住自己的线程（`Automation.threadId`）和上次运行做了什么（`lastRun`：摘要、目录、产出文件）。下次触发时：助手运行带 `resumeThreadId`，`runCodexSkill` 用 `thread/resume` 以与新线程完全相同的设置（沙箱、批准策略、开关、开发者说明、模型）接着这个线程发新 turn——线程已卸载就从磁盘载入并应用这些设置，仍加载着而空闲就按新设置重载；动态工具随线程存在磁盘上，按这次任务目录重新应答。提示里写着「上次运行做了什么、产出在哪」，上次的产出作为只读输入给这次。运行时已经没有这个线程（`thread not found`、`no rollout found`）就新开一个，`audit.resumed` 记下是哪种，提示里的上次摘要就是它的历史。助手运行结束照旧立刻释放线程（10 分钟保留只给对话用），所以长间隔的自动化总是在触发时恢复。

## 上游 0.156–0.163 里还值得用的

已经小改用上的：

- `thread/resume` 带覆盖参数的冷恢复（上面的自动化续跑）；`openThread` 把新开和恢复合成一个函数，原来两份一样的「丢掉不认识的开关再试」循环也合并了。
- 恢复不存在的线程时运行时说 `no rollout found for thread id …`，现在和 `thread not found` 一样算 `SKILL_THREAD_LOST`。

没有改，原因写在这里：

- **用恢复自带的权限简化 `resubscribe`**。0.163.0 恢复已保存线程时会恢复沙箱与网络批准，但我们在 `thread/start` 里给的功能开关（关掉 shell、联网、MCP 服务、记忆……）是覆盖参数，不随线程保存。保留对话的冷恢复仍会丢掉这些开关，所以 `resubscribe` 对已卸载的线程照旧报 `SKILL_THREAD_LOST`，让调用方按自己的历史重建。要简化，得把每个保留线程的启动参数存下来，恢复时再传一遍（自动化续跑就是这么做的）。
- **只读工具并行**（#52245）。只对运行时自己的只读工具（技能、记忆、会话历史查询）生效；动态工具的规格里没有只读标记，我们的查询函数仍是一个一个来。要用得等上游给 `DynamicToolSpec` 加只读提示。
- **hooks 的 PreToolUse 代替部分 agent-guard**。hook 是配置文件里的外部命令，每次工具调用起一个进程，判断结果靠退出码；我们的守卫走批准请求，在 worker 进程里判断、有完整上下文、能记进账本。换过去只会多一个进程边界和一份要同步的规则。保持现状。
- **`thread/fork` 的 `experimentalPredictionMode`、`thread/goal/*` 的来源字段、`thread/items/read`、已读状态**。都是给多会话客户端的，没有调用方需要。
- **转向（steer）**。0.163.0 起在进行中的 turn 上发 `turn/start` 会并进这个 turn。我们从不这么做（每条线程一条队列），这一点要保持：任何新调用方都要经过 `threadLanes`。
- **`TooManyDenials` 错误**。属于自动审查（guardian），我们的批准审查人是 `user`，不会遇到。

## 二进制

- **Linux（托管服务器）**：上游发布资产 `codex-x86_64-unknown-linux-musl.tar.gz`，资产摘要 `beb339e8…` 下载后核对一致，解出的二进制 SHA-256 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`，写进 `CODEX_LINUX_RELEASE_BINARY_SHA256`。0.155.0 的 Linux 二进制哈希暂时放在 `CODEX_PREVIOUS_BINARY_SHA256` 里继续接受，服务器换好二进制后删掉。
- **Windows debug（常驻应用）**：在本次 worktree 里构建通过（21 分 34 秒，rustc 1.95.0 按 `rust-toolchain.toml`；`--locked` 复建得到同一个二进制 `09e01f25…`；`Cargo.lock` 只同步了 160 个版本号；补丁自带的 `runtime_migrator_accepts_existing_windows_checksums` 测试通过）。用这个二进制做了一次不调模型的协议探测：按结构化运行的设置 `thread/start`（只读、untrusted、带一个动态工具），跑一个 turn 后 `thread/unsubscribe`，再带同样设置 `thread/resume`，返回 `approvalPolicy: untrusted`、`sandbox: readOnly`、无说明文件；恢复不存在的线程返回 `no rollout found for thread id …`；`thread/compact/start` 被接受。0.163.0 自带的默认模型是 `gpt-6.1-sol`，我们按档位点名的 `gpt-5.6-*` 若账号不再提供，`fitRoute` 会换成账号有的。debug 构建把源码绝对路径编进二进制，只有在仓库根目录构建出来的哈希才是常驻应用实际核对的那个，所以 `CODEX_FORK_BINARY_SHA256` 还是 0.155.0 根目录构建的值。
- **Windows release（安装包）**：没有重做（V8 预构建包加三个多小时的 thin-LTO 链接），`CODEX_RELEASE_BINARY_SHA256` 仍是 0.155.0 的。

## 留给人做的事

1. **仓库根目录重建 debug 运行时**：先停常驻 worker，备份 `%LOCALAPPDATA%\Crossline\codex-home\state_5.sqlite`，在 `vendor/codex/codex-rs` 跑 `cargo build --locked -p codex-cli --bin codex`，把新 `codex.exe` 的 SHA-256 写进 `CODEX_FORK_BINARY_SHA256` 和 `codex-baseline.json` 的 `build.binarySha256`，再跑 `pnpm exec tsx scripts/codex-smoke.ts`（它现在要求 `crossline/0.163.0`）。`codex-code-mode-host.exe` 也要换成 0.163.0 的。注意：这个哈希也是供应方一致性记录的运行时版本（`RUNTIME_VERSION`），改了以后各个模型供应方（包括开发者赞助的 SiliconFlow 候选）的一致性测评会过期重跑，要花额度。
2. **托管服务器换 Linux 二进制**：把 `/srv/crossline/codex/codex` 换成上面那个 0.163.0 的二进制（核对 SHA-256），重启 worker 容器；确认后从 `CODEX_PREVIOUS_BINARY_SHA256` 删掉 0.155.0 的哈希。`codex-code-mode-host` 的 Linux 版本（`codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz`）若服务器上有，也一起换。
3. **安装包的 release 构建**：按 `docs/local-installer.md` 重做，更新 `CODEX_RELEASE_BINARY_SHA256` 和 `codex-baseline.json` 的 `release`。
4. **fork 仓库**：`KarolYan1215/codex` 上还没有 0.163.0 的提交；`scripts/verify-codex-fork.ts` 对 fork 新鲜 clone 的校验要等把上游 `rust-v0.163.0` 推到 fork 之后才能跑。
5. 真实运行时上验证一次压缩（`skill.compacted`）和一次自动化续跑（第二次触发的运行 `resumed: true`）。

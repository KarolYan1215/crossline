# Codex 运行时从 0.163.0 升到 0.172.0（2026-11-28）

## 为什么升

本人的 ChatGPT 是 Plus，有 sol，但访谈一直跑在 terra 上（2026-11-28 发现）。档位表的 top 点名 `gpt-6.2-sol`，而后端按客户端版本过滤模型目录：上游 `codex-rs/models-manager/models.json` 里 `gpt-6.2-sol` 的 `minimal_client_version` 是 `0.166.0`（rust-v0.170.0、rust-v0.172.0 两个标签里一致）。同一账号（account_id 前缀与套餐都一样）的两份目录缓存对得上：

| 缓存 | 取到的时间 | `client_version` | 有无 gpt-6.2-sol |
|---|---|---|---|
| `%LOCALAPPDATA%\Crossline\codex-home\models_cache.json`（我们的 0.163.0） | 2026-11-26 | 0.163.0 | 无（有 gpt-6.1-sol、gpt-6-sol） |
| `%USERPROFILE%\.codex\models_cache.json`（官方桌面应用） | 2026-11-28 | 0.171.0 | 有 |

OpenAI 帮助页也写着 Codex CLI 0.166.0 起才能用 GPT-6.2 Sol / Astra。

`fitRoute`（`packages/codex/src/model-catalog.ts`）原来对目录里没有的模型直接降一档，所以 sol 掉到了 terra。现在先找同一家族里目录列出的最新一个（`gpt-6.2-sol` → `gpt-6.1-sol` → `gpt-6-sol`，隐藏的不算），找不到才走档位阶梯。这一处不依赖升级：旧运行时上访谈也会跑在 `gpt-6.1-sol`。

## 源码

`vendor/codex` 换成上游 `rust-v0.172.0`（`3d86e43b`，2026-11-24 发布，当时最新的正式版）的树，再把 fork 对 0.163.0 的改动三方合并回去。fork 的改动只有四个文件：`state/src/{migrations.rs,migrations_tests.rs,sqlite.rs}`（Windows 迁移校验和修复）和 `utils/home-dir/src/lib.rs`（`~/.codex` 隔离）。唯一的冲突是 `migrations.rs` 的导入行（上游新加了 `use crate::sqlite::SqliteWriteQueryExt;`），两边都留。`sqlite.rs` 里调用修复的位置上游没动。`patches/codex-windows-migrations.patch` 按新标签重新生成。

## 协议差异：我们用到的方法

逐项比对了 `codex-rs/app-server-protocol` 和配置、功能开关在两个标签之间的变化，只看 worker 真用到的部分：

| 方法 / 字段 | 0.172.0 的变化 | 对我们 |
|---|---|---|
| 方法表 | 我们调用的都在，没有改名。新增 `thread/sample`、`thread/memory/read`、`thread/search/stream`、`modelProvider/list` 等；删了实验性的服务端请求 `currentTime/read` | 无影响 |
| `thread/start` / `thread/resume` | `cwd` 在类型上换成 `LegacyAppPathString`，线上仍是字符串；新增可选字段 | 无影响 |
| `turn/start` / `turn/steer` | 新增可选 `environments`、`responsesapiClientMetadataPatch`、实验性 `additionalContext`；`outputSchema`、`effort` 不变 | 无影响 |
| `ThreadItem` | 外层多了 `startedAtMs`/`completedAtMs`，`type` 位置不变；`agentMessage` 多 `moderation` | 无影响 |
| `imageGeneration` | `result` 变成 `{result}` 或 `{fileId}` 二选一；本机默认的附件存储仍内联给 `result` | 现在照常。换成非内联存储时 `skill-runner.ts` 会拿不到图，到时再改 |
| `CodexErrorInfo` | 新增 `apiKeySpendLimitExceeded`、`projectSpendLimitExceeded`、`organizationSpendLimitExceeded`、`modelNotFound`、`policyCapacityUnavailable` 等 | 三个花费上限现在和额度用完一样算 `SKILL_USAGE_LIMIT`（`analysis.test.ts` 有测试）；其余仍是 `SKILL_TURN_FAILED` |
| 错误文字 | `thread not found`、`no rollout found for thread id` 不变 | 无影响 |
| `model/list` | 我们读的字段都不变；新增可选参数 `modelProvider` | 无影响 |
| 自定义供应方配置 | `base_url`、`wire_api`（仍只认 `responses`）、`requires_openai_auth` 等都在 | 无影响 |
| `features.*` | 我们传的开关都在；`multi_agent` 标为弃用但仍接受；新增约 50 个 | 无影响 |

结论：TS 侧没有破坏性变化，旧的 0.163.0 二进制在被替换前照常能跑。

以后可以用但这次没做：`modelNotFound` 可以直接触发换模型；`ThreadUsage.nativeUsageUsdMicros` 能给 API key 登录报真实花费，可替代 `CROSSLINE_API_PRICE_PER_MTOK` 的估算。

## 二进制

- **Windows release（安装包、节点）**：2026-11-28 在 worktree `awesome-liskov-23faab` 构建，`codex.exe` `6b177309…`、`codex-code-mode-host.exe` `f4cbc0d2…`，写进 `CODEX_RELEASE_BINARY_SHA256` 和 `codex-baseline.json` 的 `release`；`cargo test --release --locked -p codex-state -p codex-utils-home-dir` 通过（248 + 5 + 1），fork 的两处补丁照常工作。0.163.0 的 release `a28abf32…` 移到 `CODEX_PREVIOUS_BINARY_SHA256`，已装的旧版照常能用。`Cargo.lock` 只同步了 174 个版本号，`--locked` 复建得到同一个二进制。rusty_v8 换成 152.2.0（`scripts/fetch-rusty-v8.ts` 按 lockfile 取，清单哈希核对通过）。用 `scripts/codex-smoke.ts` 验过：两个文件复制到空目录，`CROSSLINE_CODEX_PATH` 指向它，`LOCALAPPDATA` 和 `CROSSLINE_STATE_DIR` 都在临时目录，PATH 里没有 cargo 和 codex，返回 `crossline/0.172.0`、插件装好、技能都发现、只读 untrusted 的 `thread/start` 正常。生成的协议 970 个文件，哈希 `d2e1a9b1…`。
- 这次构建踩到的三个坑：
  - rusty_v8 现在是 git 依赖。它的子模块里有一个 269 字符的路径，libgit2 在 `LongPathsEnabled=0` 的机器上检出失败。没改系统设置，用 `subst Q: %USERPROFILE%\.cargo` 加 `CARGO_HOME=Q:\` 把路径缩短，检出一次后就撤掉了。
  - 16 个并行任务把内存用光（`rustc-LLVM ERROR: out of memory`），后面的报错都是 `can't find crate`。改成 `-j 4`。
  - C 盘只剩十几 GB 时写满了（os error 112）。删了主检出里 `target/debug/incremental`（23 GB 的增量缓存，最后写入在 10 月；删了只是下次 debug 构建慢些，不影响正在运行的 `codex.exe`）。
- **Linux（托管服务器）**：上游发布资产 `codex-x86_64-unknown-linux-musl.tar.gz`，摘要 `a2342a8f…` 下载后核对一致，二进制 `ad83b94c…`，写进 `CODEX_LINUX_RELEASE_BINARY_SHA256`。`codex-code-mode-host` 的 Linux 版资产摘要 `20b0a4bc…`，二进制 `1800682c…`。0.163.0 的 `399ff69c…` 暂时留在 `CODEX_PREVIOUS_BINARY_SHA256`。服务器上**还没换**。
- **Windows debug（仓库根目录的常驻版）**：没有重建，仍是 0.163.0 的 `e4c45291…`。`CODEX_FORK_BINARY_SHA256` 因此没变。它也是供应方一致性记录里的 `RUNTIME_VERSION`，所以各供应方的测评不会过期重跑。常驻版的目录里没有 gpt-6.2-sol，但现在会用 gpt-6.1-sol。

## 留给人做的事

1. **服务器和节点要一起换**。hub 要求节点的 Codex 版本和服务器完全一致（`NODE_CODEX_VERSION`，`apps/worker/src/node/hub.ts`）。服务器换成 0.172.0 之后，还在跑 0.163.0 的节点都会被拒绝接活，直到它们更新。所以发新的「Crossline 节点」安装包和换服务器二进制要同一时间做。节点包要本人的签名密钥（`CROSSLINE_RELEASE_KEY`）。
2. **托管服务器**：把 `/srv/crossline/codex/codex` 换成上面的 0.172.0（核对 `ad83b94c…`），有 `codex-code-mode-host` 的话一起换，再重启 worker 容器。确认后从 `CODEX_PREVIOUS_BINARY_SHA256` 删掉 `399ff69c…`，并更新 `docs/beta-launch.md` §10 里写的版本。
3. **本人的安装版**：按 `docs/local-installer.md` 打包，`--codex-dir` 指向这次的 `target/release`（或者先把这两个文件复制到主检出）。装好以后看 `state\codex-home\models_cache.json`，应该是 `client_version` 0.172.0，并且列出 `gpt-6.2-sol`。到那时可以把设置里访谈的临时选择（`gpt-6.1-terra` high）改回跟档位走。
4. **fork 仓库**：`KarolYan1215/codex` 还没有 0.172.0 的提交。`scripts/verify-codex-fork.ts` 已经改成 0.172.0、174 个版本号，要等把这个源码推到 fork 以后才能跑。
5. **仓库根目录的 debug 运行时**：可以不重建。要重建的话，先停常驻 worker，然后 `cargo build --locked -p codex-cli --bin codex`。这会让 `RUNTIME_VERSION` 变，各供应方的一致性测评会过期重跑，要花额度。

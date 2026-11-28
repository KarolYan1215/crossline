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
- **Linux（托管服务器）**：上游发布资产 `codex-x86_64-unknown-linux-musl.tar.gz`，摘要 `a2342a8f…` 下载后核对一致，二进制 `ad83b94c…`，写进 `CODEX_LINUX_RELEASE_BINARY_SHA256`。`codex-code-mode-host` 的 Linux 版资产摘要 `20b0a4bc…`，二进制 `1800682c…`。2026-11-28 换上服务器：先部署接受两个哈希的镜像，再由服务器自己从上游下载这两个资产（四个摘要都与上面一致），装成 `/srv/crossline/codex/codex` 和 `codex-code-mode-host`（root，755），旧的 0.163.0 留作同目录的 `codex.0.163.0`，重启 `crossline-worker` 和 `crossline-transcriber`。容器里 `/opt/codex/codex --version` 是 `codex-cli 0.172.0`，服务器的 `models_cache.json` 是 `client_version` 0.172.0，列出 `gpt-6.2-sol`。之后从 `CODEX_PREVIOUS_BINARY_SHA256` 删掉了 0.163.0 的 `399ff69c…`：要退回旧版，得先把这个哈希加回去再部署。
- **Windows debug（仓库根目录的常驻版）**：没有重建，仍是 0.163.0 的 `e4c45291…`。`CODEX_FORK_BINARY_SHA256` 因此没变。它也是供应方一致性记录里的 `RUNTIME_VERSION`，所以各供应方的测评不会过期重跑。常驻版的目录里没有 gpt-6.2-sol，但现在会用 gpt-6.1-sol。

## 上线情况（2026-11-28，本人同意后）

1. **托管服务器**：已换，见上面「Linux」一条。
2. **本人的安装版**：0.3.10（`--personal`，带 Graph），经 `install-personal.cmd` 装好，`data\` 先备份到 `backups\before-personal-20261128-042028`。装好后 `state\codex-home\models_cache.json` 是 `client_version` 0.172.0、列出 `gpt-6.2-sol`，当天的 sandbox 日志 `selection: mxc`。设置里访谈的临时选择（`gpt-6.1-terra` high）没动，要不要改回跟档位走由本人定。
3. **fork 仓库**：`KarolYan1215/codex` 打了标签 `rust-v0.172.0` → `3d86e43b`（fork 与上游共用对象）。
4. **节点**：hub 要求节点的 Codex 版本和服务器完全一致（`NODE_CODEX_VERSION`，`apps/worker/src/node/hub.ts`），服务器换好之后，0.163.0 的节点（1.2.1 及以前）被拒绝接活，直到更新。换的时候最近 4 小时没有节点连着。1.2.2 已打包（`package-node.ts` 的版本核对改成 0.172.0；`dist
ode-installerCrossline-Node-Setup-1.2.2.exe`，SHA-256 `035a5bf0…`，只在这台电脑上的 worktree `awesome-liskov-23faab` 里），但这台电脑上没有 `CROSSLINE_RELEASE_KEY`，`node-latest.json` 没签名，不能发布。本人签名、发布：`release-sign.ts sign dist\node-installer\node-latest.json`，然后按 `docs/compute-node.md` 的 `gh release create node-v1.2.2 …`。
5. **仓库根目录的 debug 运行时**：没有重建（本人同意）。要重建的话，先停常驻 worker，然后 `cargo build --locked -p codex-cli --bin codex`。这会让 `RUNTIME_VERSION` 变，各供应方的一致性测评会过期重跑，要花额度。

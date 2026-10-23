# Crossline 的 Codex fork 运行时

Crossline 的源码 fork 是 [KarolYan1215/codex](https://github.com/KarolYan1215/codex)，上游是 [openai/codex](https://github.com/openai/codex)。当前固定在上游正式标签 `rust-v0.163.0` 对应的 commit `83086188ae0614bd882818ff1aa23f3194962012`（2026-10-20 从 `rust-v0.155.0` 升上来；协议差异、改动和留给人做的事见 `docs/codex-upgrade-0.163.md`）。

fork 源码以 squashed Git subtree 的形式直接纳入本仓库，位于 `vendor/codex`（不是外部 submodule，也不是被忽略的本机 clone）。`patches/codex-windows-migrations.patch` 描述的 Windows 迁移校验和修复已经作为普通 commit 合并进 `vendor/codex/codex-rs/state/src/{migrations.rs,migrations_tests.rs,sqlite.rs}`，本机构建不需要再单独 clone 或 apply 补丁——直接编译 `vendor/codex` 即可。这份补丁文件本身仍然保留：`.github/workflows/verify.yml` 的 `codex-fork` job 和 `scripts/verify-codex-fork.ts` 用它对一个**独立的新鲜 clone**做供应链校验（同一 commit + 同一补丁能否独立复现同一份 `Cargo.lock`），这是刻意与"信任仓库里已经 vendor 的副本"分开的检查，不会因为源码已经在本仓库而失去意义。`codex-baseline.json` 记录构建与协议证据。

`vendor/codex` 携带它自己的 `LICENSE`（Apache-2.0）和 `NOTICE`（含一段派生自 MIT 许可的 Ratatui 的声明）；两者随 subtree 原样导入，没有改动。这份许可证只覆盖 `vendor/codex` 目录本身，与 Crossline 自己代码的许可状态无关——Crossline 是私有个人项目，仓库根目录没有另外的 LICENSE 文件。

首次构建（或 `vendor/codex` 更新后重新构建）：

```powershell
Push-Location vendor/codex/codex-rs
cargo build -p codex-cli --bin codex
Pop-Location
```

该发布标签的 `Cargo.lock` 把 160 个 workspace 内部包记为 `0.0.0`（0.155.0 时是 152 个），上面这次不带 `--locked` 的构建会把它们同步为 `0.163.0`；确认 `git diff -- vendor/codex/codex-rs/Cargo.lock` 只改了这些 `version` 字段（没有依赖树变化）后提交这份锁文件，再用 `cargo build --locked -p codex-cli --bin codex` 复验一次可复现。`vendor/codex/codex-rs/.gitignore` 已经忽略了 `target/`，构建产物不会被追踪。

现有 Crossline Codex 状态库的历史迁移校验和全部对应 CRLF，标签源码 checkout 却是 LF；未修复时 SQLx 会在启动阶段拒绝原有数据库。上面提到的迁移补丁只在旧校验和精确等于同一 SQL 的 CRLF 校验和时，把迁移元数据更新为当前源码校验和；未知差异仍由 SQLx 拒绝，其他平台保持上游行为。重建并运行前，先对 `state_5.sqlite` 做备份。

这个修复**绝不碰官方 Codex 桌面应用的 `%USERPROFILE%\.codex`**（2026-10-22）。官方 Windows 版本身就用 CRLF 校验和，修复一旦改写它们，官方应用启动时就会报 `failed to initialize sqlite state runtime`，界面显示「无法加载组织设置」。那次是 fork 的调试版在没设 `CODEX_HOME` 时被直接运行，落到了默认的 `~/.codex`。现在有两道防护：一是 Windows 上没设 `CODEX_HOME` 时，fork 的默认家目录改为 Crossline 自己的（`codex-rs/utils/home-dir` 的 `crossline_default_home`：先 `%CROSSLINE_STATE_DIR%\codex-home`，否则 `%LOCALAPPDATA%\Crossline\codex-home`，打包重定向的 LOCALAPPDATA 换回 `%USERPROFILE%\AppData\Local`，与 `codexProcessEnvironment` 同一规则）；二是校验和修复遇到直接位于 `%USERPROFILE%\.codex` 的数据库一律跳过（`state/src/migrations.rs` 的 `is_official_codex_home_db`），交给 SQLx 拒绝。`patches/codex-windows-migrations.patch` 包含这两处改动。

worker 只启动 `vendor/codex/codex-rs/target/debug/codex.exe`（`packages/codex/src/index.ts` 里 `resolveCodexCommand` 的默认路径），启动前核对固定的 SHA-256（`CODEX_FORK_BINARY_SHA256`）。`CROSSLINE_CODEX_PATH` 只允许指向具有相同 SHA-256 的绝对路径。缺少或替换构建产物时，启动会返回明确错误，不会改用 PATH 上的 npm CLI 或 Desktop。Rust debug 构建会把源码的绝对路径编入调试信息，所以**同一份源码在不同目录构建出的二进制哈希本身会不同**——从旧的本机 `.vendor/codex-fork` 迁移到现在的仓库内 `vendor/codex` 时二进制哈希随之改变是预期行为，`Cargo.lock` 哈希不变才是真正的可复现性证明。重建后若二进制哈希变化，须先核对源码、锁文件和协议，再更新 `packages/codex/src/index.ts` 与 `codex-baseline.json` 中的记录。

验证命令：

```powershell
git log -1 --format="%H" -- vendor/codex
Get-FileHash vendor/codex/codex-rs/target/debug/codex.exe -Algorithm SHA256
Get-FileHash vendor/codex/codex-rs/Cargo.lock -Algorithm SHA256
pnpm exec tsx scripts/codex-smoke.ts
pnpm verify
```

## 更新到上游新版本

`codex-fork` 这个 remote 和 `codex-fork-src` 这个 tag 都是本地引用，不会随 `git clone`/`git push` 传播，每台要做更新的机器第一次都要自己建：

```powershell
git remote add codex-fork https://github.com/KarolYan1215/codex.git   # 已存在则跳过
git fetch --depth=1 codex-fork <new-tag-or-commit>
git tag -f codex-fork-src FETCH_HEAD
git subtree pull --prefix=vendor/codex codex-fork-src --squash
```

0.163.0 那次 fork 上还没有这个标签，是直接从上游浅取一个 commit 再合并的：`git fetch --depth=1 https://github.com/openai/codex.git refs/tags/rust-v0.163.0`，然后 `git subtree merge --prefix=vendor/codex --squash <那个 commit>`。冲突只在补丁改过的两个文件的导入行和 `Cargo.lock`（取上游原样，构建时同步版本号）；补丁文件按新标签重新生成（`git diff <上游 commit> HEAD:vendor/codex > patches/codex-windows-migrations.patch`）。

用 `--depth=1` 的浅 fetch 加一个只包含单个 commit 的本地 tag，是为了不把上游几十万行历史（`git subtree pull` 默认会整个 fetch）拉进本仓库的对象库；`git subtree pull` 只需要 `codex-fork-src` 这一个 commit 的树内容来做三方合并，不需要它的祖先历史。拉取后重新走一遍上面的构建、校验和与 `scripts/verify-codex-fork.ts` 流程，再更新 `codex-baseline.json`。不要用 `git subtree add`，那是仅一次性导入用的命令，现在 `vendor/codex` 已经存在，会直接报 `prefix already exists`。

## Supervisor capability token（阶段四）

`apps/worker` 的 HTTP supervisor 只绑定 `127.0.0.1:3211`，但loopback 本身不是边界——同一台机器上任何进程都能直接 curl 这个端口，绕过 `apps/web` 自己的 Better Auth 登录检查，触发真实的 Codex 分析、材料准备、里程碑闸门判定，或是启动一次真实的 OAuth 登录。`packages/codex/src/capability.ts` 补的就是这一个洞：`apps/web/lib/codex-runtime.ts` 的 `requestCodexSupervisor` 在每次请求前，用调用方当前请求的真实 `AccessContext`（而不是任何硬编码值）签发一个 30 秒过期、绑定到 `${method} ${pathname}` 和 supervisor 当前 `supervisorBootId` 的 HMAC token，装进 `x-crossline-capability` 请求头；`packages/codex/src/index.ts` 在路由分发**最前面**统一校验（不是逐个路由处理器各自调用——这个 HTTP handler 是一个大函数里顺序 if 的调度，不是 Next.js 那种每个文件一个处理器的结构，统一在入口校验反而比在十一处各自重复更不容易漏掉）。`/v1/codex/status` 是唯一不校验 capability 的路由：调用方必须先读到 `supervisorBootId` 才能签出一个校验会通过的 token，这条路由因此必须留作校验的起点，它返回的信息本身也只是运行状态，不是账户密钥。

`CROSSLINE_SUPERVISOR_CAPABILITY_SECRET` 独立于 `BETTER_AUTH_SECRET`：登录密钥泄漏不应该连带让 supervisor 也失守。`apps/web/.env` 和 `apps/worker/.env` 必须配成同一个值；worker 缺这个变量时会跳过启动 supervisor 并记录 `CROSSLINE_SUPERVISOR_CAPABILITY_SECRET_MISSING`，而不是无保护地把端口打开。

### 暂不支持（阶段四缩小范围时的明确决定，不是遗漏）

- `dynamicTools` 仍然硬编码为空数组。
- Skill 运行排队按**模型档位**分道（`packages/codex/src/skill-runner.ts` 的 `serializeSkillRun`），不按 workspace 分桶；切换 Skill 启停改的是运行时唯一的配置文件，所以只有这一小步串行（`underConfigLock`）。
- `preparing`/`judging`/`analyses` 这几个并发追踪结构仍然只按 entity id（work order id / capture id）区分，不按 workspace 二次分桶。

以上三项都是为"真的有第二个 workspace 会调用同一个 worker"这个还不存在的场景准备的基础设施；当前只有一个 owner，提前做这些既测不出价值也验证不了正确性。等 `apps/worker` 真正需要循环处理多个 workspace 时（`packages/db` 的 `listWorkspaces()` 已经在阶段三加好），一并重新评估。

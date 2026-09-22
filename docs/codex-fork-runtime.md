# Crossline 的 Codex fork 运行时

Crossline 的源码 fork 是 [KarolYan1215/codex](https://github.com/KarolYan1215/codex)，上游是 [openai/codex](https://github.com/openai/codex)。当前固定在上游正式标签 `rust-v0.155.0` 对应的 commit `f0a1b8f0849d90960bc406b848f32e5a129b0457`。

fork 源码以 squashed Git subtree 的形式直接纳入本仓库，位于 `vendor/codex`（不是外部 submodule，也不是被忽略的本机 clone）。`patches/codex-windows-migrations.patch` 描述的 Windows 迁移校验和修复已经作为普通 commit 合并进 `vendor/codex/codex-rs/state/src/{migrations.rs,migrations_tests.rs,sqlite.rs}`，本机构建不需要再单独 clone 或 apply 补丁——直接编译 `vendor/codex` 即可。这份补丁文件本身仍然保留：`.github/workflows/verify.yml` 的 `codex-fork` job 和 `scripts/verify-codex-fork.ts` 用它对一个**独立的新鲜 clone**做供应链校验（同一 commit + 同一补丁能否独立复现同一份 `Cargo.lock`），这是刻意与"信任仓库里已经 vendor 的副本"分开的检查，不会因为源码已经在本仓库而失去意义。`codex-baseline.json` 记录构建与协议证据。

首次构建（或 `vendor/codex` 更新后重新构建）：

```powershell
Push-Location vendor/codex/codex-rs
cargo build -p codex-cli --bin codex
Pop-Location
```

该发布标签的 `Cargo.lock` 把 152 个 workspace 内部包记为 `0.0.0`，上面这次不带 `--locked` 的构建会把它们同步为 `0.155.0`；确认 `git diff -- vendor/codex/codex-rs/Cargo.lock` 只改了这些 `version` 字段（没有依赖树变化）后提交这份锁文件，再用 `cargo build --locked -p codex-cli --bin codex` 复验一次可复现。`vendor/codex/codex-rs/.gitignore` 已经忽略了 `target/`，构建产物不会被追踪。

现有 Crossline Codex 状态库的历史迁移校验和全部对应 CRLF，标签源码 checkout 却是 LF；未修复时 SQLx 会在启动阶段拒绝原有数据库。上面提到的迁移补丁只在旧校验和精确等于同一 SQL 的 CRLF 校验和时，把迁移元数据更新为当前源码校验和；未知差异仍由 SQLx 拒绝，其他平台保持上游行为。重建并运行前，先对 `state_5.sqlite` 做备份。

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

用 `--depth=1` 的浅 fetch 加一个只包含单个 commit 的本地 tag，是为了不把上游几十万行历史（`git subtree pull` 默认会整个 fetch）拉进本仓库的对象库；`git subtree pull` 只需要 `codex-fork-src` 这一个 commit 的树内容来做三方合并，不需要它的祖先历史。拉取后重新走一遍上面的构建、校验和与 `scripts/verify-codex-fork.ts` 流程，再更新 `codex-baseline.json`。不要用 `git subtree add`，那是仅一次性导入用的命令，现在 `vendor/codex` 已经存在，会直接报 `prefix already exists`。

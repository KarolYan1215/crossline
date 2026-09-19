# Crossline 的 Codex fork 运行时

Crossline 的源码 fork 是 [KarolYan1215/codex](https://github.com/KarolYan1215/codex)，上游是 [openai/codex](https://github.com/openai/codex)。当前固定在上游正式标签 `rust-v0.155.0` 对应的 commit `f0a1b8f0849d90960bc406b848f32e5a129b0457`。本仓库的 `patches/codex-windows-migrations.patch` 是 fork 的本地源码补丁；其他接线适配位于 `packages/codex`。`codex-baseline.json` 记录构建与协议证据。

本机的 fork checkout 位于被 Git 忽略的 `.vendor/codex-fork`。首次配置或重建时，在仓库根目录运行：

```powershell
git clone https://github.com/KarolYan1215/codex.git .vendor/codex-fork
git -C .vendor/codex-fork fetch --tags origin rust-v0.155.0
git -C .vendor/codex-fork checkout --detach f0a1b8f0849d90960bc406b848f32e5a129b0457
git -C .vendor/codex-fork apply ../../patches/codex-windows-migrations.patch
Push-Location .vendor/codex-fork/codex-rs
cargo build -p codex-cli --bin codex
Pop-Location
```

该发布标签的 `Cargo.lock` 把部分 workspace 包记为 `0.0.0`，Cargo 首次构建会将其同步为 `0.155.0`。确认锁文件只发生此类版本变更后，可用 `cargo build --locked -p codex-cli --bin codex` 复验。

现有 Crossline Codex 状态库的 54 条历史迁移校验和全部对应 CRLF，标签源码 checkout 却是 LF；未适配时 SQLx 会在启动阶段拒绝原有数据库。Windows 补丁只在旧校验和精确等于同一 SQL 的 CRLF 校验和时，把迁移元数据更新为当前源码校验和；未知差异仍由 SQLx 拒绝，其他平台保持上游行为。重建并运行前，先对 `state_5.sqlite` 做备份。

worker 只启动 `.vendor/codex-fork/codex-rs/target/debug/codex.exe`，启动前核对固定的 SHA-256。`CROSSLINE_CODEX_PATH` 只允许指向具有相同 SHA-256 的绝对路径。缺少或替换构建产物时，启动会返回明确错误，不会改用 PATH 上的 npm CLI 或 Desktop。重建后若产物哈希变化，须先核对源码、锁文件和协议，再更新 `packages/codex/src/index.ts` 与 `codex-baseline.json` 中的记录。

验证命令：

```powershell
git -C .vendor/codex-fork remote get-url origin
git -C .vendor/codex-fork rev-parse HEAD
Get-FileHash .vendor/codex-fork/codex-rs/target/debug/codex.exe -Algorithm SHA256
pnpm exec tsx scripts/codex-smoke.ts
pnpm verify
```

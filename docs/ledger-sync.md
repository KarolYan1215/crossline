# 本机与服务器账本的长期同步

本人要求（2026-10-20）：本机常驻版（`data/crossline.db`）和托管内测服务器上本人账号的账本始终一致，哪边新就用哪边整份覆盖另一边。此前只有单向搬运（`scripts/pack-for-server.ts` → `[migrate]` / `[migrate-apply]`，docs/beta-launch.md §10.6）。

## 规则

- **「新」按本人自己的最后一次动作算**（`CrosslineStore.lastPersonActivity`：输入框说的话、计时与确认、回答问题、记下或丢弃、改里程碑、报进度或精力），不按最后一次写入。两边的 worker 都在不停写（排程缓存、提醒记录、助手结果），按写入时间比，赢的永远是最近跑过 tick 的那一边，而不是本人用过的那一边。
- 两边的本人动作时间相同（同步刚做完就是这样）时什么都不做。
- 覆盖是**整份**：输的一边该工作区的每一张表都清掉再导入（`scripts/migrate-workspace.ts --replace`），文件（`materials`、`sources`、画像）一并复制。被覆盖的一边先把账本复制到一旁：服务器在 `/srv/crossline/backups/crossline.db*.<时间>`（保留 14 天），本机在 `backups/ledger-sync/<时间>/`。
- **机器专属的设置留在各自一边**（`migrate-workspace.ts --keep-settings`，默认清单 `MACHINE_SETTINGS`）：运行时机主标记、日历的读写账号与来源选择、已发布的日历事件账、推送订阅、文件夹授权与索引、屏幕活动与作息的同意、摄像头、手机健康 token、模型连接（供应商、检验记录、赞助）、邮箱、沙箱开关、后台配额阻断。原因：本机的 DPAPI 密钥与 Codex 登录本来就不随账本走（§10.6），把本机的 `calendar.sources` 带到服务器只会在那边立刻产生「日历无法读取」。
- 两边的数据库版本（`PRAGMA user_version`）必须相同，否则拒绝（`SCHEMA_MISMATCH`）：先把同一次提交部署到两边。
- 代价要说清：一小时一次、整份覆盖，意味着两边在同一小时里都有本人动作时，输的一边那一小时的动作会丢（脚本会在日志里标 `WARNING` 并写明时间）。事件账本按幂等键合并在技术上可行，但当前状态表是从事件派生加直接写入的混合，合并不是这次的范围。

## 怎么跑

- 本机：`pnpm exec tsx scripts/ledger-sync.ts [--direction auto|to-server|to-local] [--dry-run] [--check]`。第一次要给 `--email <服务器登录邮箱> --workspace <本机工作区 id>`，之后记在 `data/ledger-sync.json`。`--check` 只打印两边的时间戳和会选的方向。
- 服务器侧是 `deploy/server/ledger-sync.sh`（`stamp` / `pack` / `preview` / `apply`），每次由本机脚本 scp 到 `/tmp` 后 `sudo sh` 执行，每一步都在 web 容器所用镜像的一次性容器里跑；`[migrate]` / `[migrate-apply]` 提交也调用它。
- 本机 → 服务器：本机打包（在线备份，常驻应用不停）→ scp → 服务器停 web 与 worker、复制账本、导入、启动。
- 服务器 → 本机：服务器打包 → scp 下来 → 本机停两个 keeper 及其子进程和 3210/3211 上的进程（`taskkill /T`）、复制账本到 `backups/ledger-sync/`、导入、`start-crossline.ps1` 重启。
- 定时：`scripts/install-ledger-sync.ps1` 注册计划任务「Crossline Ledger Sync」，每小时一次（`-IntervalMinutes` 可改），日志 `data\logs\ledger-sync.log`。
- 第一次（2026-10-20）按本人要求强制 `--direction to-server`：服务器上本人账号里当时是 10-18 走查用的虚构访谈，本人动作时间反而比本机的真实账本新，`auto` 会选错方向。

## 时间戳脚本

`scripts/ledger-stamp.ts --db <crossline.db> (--workspace <id> | --email <地址>)` 只读地打印一个工作区的 `person`（本人最后动作）、`changed`（事件或设置最后写入）、`userVersion` 和几张表的行数；不经 `CrosslineStore`，所以不会在活的数据库上跑迁移。

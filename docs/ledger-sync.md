# 本机与服务器账本的长期同步

> **已停用（2026-10-22）。** 两边的 worker 各自跑同一套倒推、步骤规划和助手任务，同一个 ChatGPT 额度花两遍，一边的结果随后被覆盖。本人决定托管站是唯一的主账本，本机改为这个账号的「设备」，只发本机读到的东西：见 [device-mode.md](device-mode.md)。「Crossline Ledger Sync」计划任务已停用，`scripts/install-ledger-sync.ps1` 不再属于正常安装（不加 `-IKnowThisSpendsTwice` 会拒绝）。`scripts/ledger-sync.ts`、`pack-for-server.ts`、`migrate-workspace.ts` 保留，只用于手动的一次性搬迁。下文是停用前的记录。

本人要求（2026-10-20）：本机常驻版（`data/crossline.db`）和托管内测服务器上本人账号的账本始终一致，哪边新就用哪边整份覆盖另一边。此前只有单向搬运（`scripts/pack-for-server.ts` → `[migrate]` / `[migrate-apply]`，docs/beta-launch.md §10.6）。

## 规则

- **「新」按本人自己的最后一次动作算**（`CrosslineStore.lastPersonActivity`：输入框说的话、计时与确认、回答问题、记下或丢弃、改里程碑、报进度或精力），不按最后一次写入。两边的 worker 都在不停写（排程缓存、提醒记录、助手结果），按写入时间比，赢的永远是最近跑过 tick 的那一边，而不是本人用过的那一边。
- 「本人动作」包括页面上做的可撤销改动（可用时段、份额、权重、锁定、截止日）和撤销本身（`op.applied` / `op.undone`；worker 自己写的带 `bySystem`，不算）。之前不算，改了计划设置的那一边会被另一边的下一次同步整份覆盖。
- 两边的本人动作时间相同（同步刚做完就是这样）时什么都不做。
- 覆盖是**整份**：输的一边该工作区的每一张表都清掉再导入（`scripts/migrate-workspace.ts --replace`），文件（`materials`、`sources`、画像）一并复制。被覆盖的一边先把账本复制到一旁：服务器在 `/srv/crossline/backups/crossline.db*.<时间>`（保留 14 天），本机在 `backups/ledger-sync/<时间>/`。
- **机器专属的设置留在各自一边**（`migrate-workspace.ts --keep-settings`，默认清单 `MACHINE_SETTINGS`）：运行时机主标记、日历的读写账号与来源选择、已发布的日历事件账、推送订阅、文件夹授权与索引、屏幕活动与作息的同意、摄像头、手机健康 token、模型连接（供应商、检验记录、赞助）、邮箱、沙箱开关、后台配额阻断。原因：本机的 DPAPI 密钥与 Codex 登录本来就不随账本走（§10.6），把本机的 `calendar.sources` 带到服务器只会在那边立刻产生「日历无法读取」。
- 两边的数据库版本（`PRAGMA user_version`）必须相同，否则拒绝（`SCHEMA_MISMATCH`）：先把同一次提交部署到两边。
- 代价要说清：一小时一次、整份覆盖，意味着两边在同一小时里都有本人动作时，输的一边那一小时的动作会丢（脚本会在日志里标 `WARNING` 并写明时间）。事件账本按幂等键合并在技术上可行，但当前状态表是从事件派生加直接写入的混合，合并不是这次的范围。

## 不是全自动的地方

- 计划任务只在本机开机、本人已登录 Windows 时运行；电脑睡眠或关机期间不会同步，醒来后的下一次补上。
- 两边在同一个 15 分钟里都有本人动作时，输的一边那几分钟的动作会被覆盖（日志标 `WARNING`）。
- 只改了不算本人动作的东西（例如 worker 生成的步骤计划、草稿），不触发同步；它们随下一次本人动作一起过去。

## 怎么跑

- 本机：`pnpm exec tsx scripts/ledger-sync.ts [--direction auto|to-server|to-local] [--dry-run] [--check]`。第一次要给 `--email <服务器登录邮箱> --workspace <本机工作区 id>`，之后记在 `data/ledger-sync.json`。`--check` 只打印两边的时间戳和会选的方向。
- 服务器侧是 `deploy/server/ledger-sync.sh`（`stamp` / `pack` / `preview` / `apply`），每次由本机脚本 scp 到 `/tmp` 后 `sudo sh` 执行，每一步都在 web 容器所用镜像的一次性容器里跑；`[migrate]` / `[migrate-apply]` 提交也调用它。
- 本机 → 服务器：本机打包（在线备份，常驻应用不停）→ scp → 服务器停 web 与 worker、复制账本、导入、启动。
- 服务器 → 本机：服务器打包 → scp 下来 → 本机停两个 keeper 及其子进程和 3210/3211 上的进程（`taskkill /T`）、复制账本到 `backups/ledger-sync/`、导入、`start-crossline.ps1` 重启。
- 定时：`scripts/install-ledger-sync.ps1` 注册计划任务「Crossline Ledger Sync」，每 15 分钟一次（2026-10-20 起；`-IntervalMinutes` 可改；连接失败在 10 秒、30 秒后各重试一次），日志 `data\logs\ledger-sync.log`。
- 第一次（2026-10-20）按本人要求强制 `--direction to-server`：服务器上本人账号里当时是 10-18 走查用的虚构访谈，本人动作时间反而比本机的真实账本新，`auto` 会选错方向。
- **2026-10-20 的事故与修正。** 引入本功能的提交正文里写了带方括号的迁移标签原文，`server.yml` 按 `contains(message, …)` 匹配，于是那次推送直接执行了写入：旧版 `migrate-workspace.ts` 先在事务外清空目标再导入，导入在 `model_usage.id`（AUTOINCREMENT，全库唯一）上撞主键失败，服务器上本人账号被留空（被清掉的是虚构访谈，备份在 `/srv/crossline/backups/crossline.db*.20261020-102800`）。修正：清空与导入在同一事务里（`atomically` + `resetWorkspace` + `importSnapshot`，失败整体回滚，已在服务器上实际验证过一次回滚）；AUTOINCREMENT 表的 id 交给目标重编；目标自己的 `model_usage`（赞助额度按它计）保留、源的不导入；要保留的设置在导入前取出、导入后写回（`importSnapshot` 拒绝仍有行的表）；写入失败时保留上传包以便重试；Windows 上打包与解包固定用系统自带的 `tar.exe`（Git Bash 的 GNU tar 把 `C:` 当远程主机）。随后本机账本完整写入服务器（202 条事实、89 个任务、136 个里程碑、110 份文件，两边本人最后动作时间一致），计划任务「Crossline Ledger Sync」已注册。
- **提交信息里不要写方括号形式的服务器动作标签原文**（迁移、部署、体检……），除非就是要触发它：工作流在整条提交信息里找，正文也算。

## 时间戳脚本

`scripts/ledger-stamp.ts --db <crossline.db> (--workspace <id> | --email <地址>)` 只读地打印一个工作区的 `person`（本人最后动作）、`changed`（事件或设置最后写入）、`userVersion` 和几张表的行数；不经 `CrosslineStore`，所以不会在活的数据库上跑迁移。

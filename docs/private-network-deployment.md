# 私网跨设备部署（Tailscale，阶段六）

## 现状

Web 与 worker 依然只绑定 `127.0.0.1`；`private` 部署模式不改变这一点，只是让同一个 tailnet 里的其他设备能通过
`tailscale serve` 自己的 TLS 反代访问到它——应用本身感知不到反代的存在，也没有多开一个监听地址。真正暴露公网
的 `external` 模式仍然在 `apps/web/next.config.mjs` 里被构建时拒绝（见 `docs/external-deployment.md`）。

## 一次性手动步骤（Tailscale 侧）

1. [tailscale.com](https://tailscale.com) 用已有账号登录，创建 tailnet（免费个人版够用）。
2. 这台机器安装 Tailscale（`winget install Tailscale.Tailscale` 或官网 MSI），`tailscale up` 登录加入 tailnet。
3. 管理后台确认 MagicDNS 已开启（Settings → DNS）。
4. **在 tailnet 管理后台启用 Serve 功能**：`tailscale serve --bg 3210` 第一次运行如果提示
   `Serve is not enabled on your tailnet`，说明这是一个按 tailnet 开关的功能，不是本机安装就自动带的——去命令
   给出的 `https://login.tailscale.com/f/serve?node=<node-id>` 链接手动启用一次，然后重跑
   `tailscale serve --bg 3210`。这一步只能由 tailnet 管理员（即账号本人）在浏览器里点，命令行做不到。
5. `tailscale serve --bg 3210`（把本机 3210 端口通过 HTTPS 反代给整个 tailnet；具体子命令语法以
   `tailscale serve --help` 为准——已用安装的 1.102.4 版本核实过，`--bg <port>` 就是文档写的那个形式，不需要
   额外的 `--https=` 前缀）。
6. **不要**运行 `tailscale funnel`——Funnel 才是把 Serve 的目标进一步暴露到公网，这个仓库明确不需要它。

## 代码侧做了什么

- `apps/web/next.config.mjs`：`CROSSLINE_DEPLOYMENT_MODE` 从 `local | external` 两态扩成
  `local | private | external`；`private` 依然绑定 loopback，但打开一组之前完全没有的响应头
  （HSTS、CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`X-Frame-Options: DENY`）——这些头
  对纯 loopback 流量没有意义（浏览器之外没有别的东西能连进来），只有从这一步开始才有真实的跨网络访问者需要防护。
- `CROSSLINE_TAILSCALE_HOSTNAME`（阶段二已加）：设置为 `<hostname>.ts.net` 后自动加入 Better Auth 的
  `trustedOrigins`。`apps/web/lib/same-origin.ts` 的 `isCrossSiteWrite` 本身按请求自带的 `Host` 头动态比较，
  不需要维护一份主机名白名单，所以不用改。
- **Google OAuth 需要在 Cloud Console 手动补第二个授权回调 URI**：`https://<hostname>.ts.net/api/auth/callback/google`。
  这一步要登录 Google 账号在网页上做，不是代码或脚本能完成的。
- **身份透传核实过，按计划的假设是错的**：查了 Tailscale 官方文档确认 `tailscale serve` 确实会转发身份头给
  被代理的后端，但只有三个——`Tailscale-User-Login`、`Tailscale-User-Name`、`Tailscale-User-Profile-Pic`，
  **没有节点标识**。原计划里 `tailscale_bindings.node_key TEXT NOT NULL` 因此不可能被诚实地填上，已经用一次
  迁移（`packages/db` migration 6）改成可空列，唯一约束收窄成 `(workspace_id, tailscale_login)`。这个绑定
  **只是审计记录**：`apps/web/app/connectors/tailscale-trust.tsx` 让已经用正常账号登录的 owner 点一次"信任这个
  Tailscale 身份"，写进 `tailscale_bindings`，但不构成任何登录旁路——每个页面依然要求正常的 Better Auth
  session，这是计划里明确要求的（"不做成自动透传登录"）。
- `scripts/backup-crossline.ps1`/`restore-crossline-backup.ps1`：现在同时备份/恢复 `auth.db`
  （`scripts/checkpoint-auth-db.ts` 做 WAL checkpoint 后拷贝，`scripts/read-auth-db-counts.ts` 在恢复后读回
  `user`/`session`/`account`/`verification` 行数）。**真实跑过一遍完整演练**：种一个真实 workspace + 一个空
  `auth.db`，备份、加密、解密、解压、恢复两个库、读回所有表——见下面"已验证"。
- `apps/worker/src/export.ts` 顺带修的一个真实 bug：默认 workspace id 之前硬编码成 `"personal-crossline"`，
  阶段三之后这个字符串在真实账号的数据库里已经不对应任何 workspace 了——不设 `CROSSLINE_WORKSPACE_ID` 时会
  静默导出一个空快照。现在改成：只有一个 workspace 时自动选它，多个或零个时要求显式设置该环境变量并报错。

## 已验证

- `pnpm verify` 全绿（typecheck + test + build + e2e）。
- 备份+恢复演练用真实数据跑通：种一个真实 workspace（含一条里程碑）和一个刚建表的空 `auth.db`，
  `backup-crossline.ps1` 自动探测唯一 workspace 并导出、checkpoint 并拷贝 `auth.db`、打包加密、SHA-256 校验；
  `restore-crossline-backup.ps1` 解密、解压、用 `pnpm restore` 重建主账本并读回全部表（4 行，与写入一致），
  再用独立的 `read-auth-db-counts.ts` 读回 `auth.db` 的四张表（均为 0，因为这次演练没有真实用户注册，这是诚实
  的验证结果，不是漏了什么）。
- 防火墙：`Get-NetFirewallRule`（未授权 fallback 到 `netsh advfirewall firewall show rule name=all`）确认
  没有任何规则提及 3210、3211 或 "Crossline"——这个仓库从未创建过，Tailscale Serve 走的是它自己的虚拟网卡，
  不需要额外的入站规则。

## 还没有、需要用户完成的

- **`tailscale serve` 需要先在 tailnet 管理后台手动启用**（上面步骤 4）——命令行本身给出的启用链接，只能由
  账号本人在浏览器里点开确认，这不是可以脚本化或代替完成的一步。
- **Google Cloud Console 补第二个 OAuth 回调 URI**（上面"代码侧做了什么"第三条）——需要登录 Google 账号手动加。
- **从另一台真实在同一 tailnet 里的设备访问 `https://karols-laptop.tailb8a366.ts.net`，确认能登录、能正常使用**，
  以及**从不在 tailnet 里的网络访问同一地址确认连不通**——这两条需要真实的第二台设备，不是本机能验证的。

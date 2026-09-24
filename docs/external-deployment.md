# 外部部署门

Web 与 worker 默认都绑定 `127.0.0.1`。`CROSSLINE_DEPLOYMENT_MODE` 现在有三态：`local`（纯 loopback）、
`private`（阶段六解锁——依然绑定 loopback，只是通过 `tailscale serve` 自己的 TLS 反代从 tailnet 内其他设备
可达，见 `docs/private-network-deployment.md`）、`external`（真正的公网暴露，仍然会让 Next 构建失败）。这份清单只针对
`external`：`private` 走的是 Tailscale 自己的私网边界，不是本清单要解决的问题。

以下 7 项在阶段二、三、四已经完成到什么程度，随实现更新，不是当初写下时的原样：

1. ✅ 阶段二：Better Auth 会话（自有机密应用，不是复用 Graph 设备码的公共客户端）。
2. ✅ 阶段三：认证主体映射为真实 `AccessContext`（`principalId`/`workspaceId`），Web 层每条读写路径都从会话取得，
   `OWNER_ID`/`WORKSPACE_ID` 全局常量已删除（`apps/web/lib/no-hardcoded-identity.test.ts` 是这条的持续断言）。
3. ✅ 阶段三：`packages/db` 存储层按 `workspace_id` 限定，`packages/db/src/isolation.test.ts` 覆盖跨 workspace
   隔离回归；`listPlanChanges` 曾经的一处未隔离读取已修复。
4. 部分：`workspace_members.role`（`viewer`/`member`/`owner`）已存在并被 `requireRole` 使用，但目前唯一的注册
   路径只创建单人 owner workspace，没有邀请其他成员进同一 workspace 的入口——"默认拒绝未成员访问"这条本身成立，
   只是还没有第二个成员的真实场景验证过。
5. 部分：阶段六给 `private` 模式加上了 HSTS/CSP/`X-Content-Type-Options: nosniff`/`Referrer-Policy`/
   `X-Frame-Options`（`apps/web/next.config.mjs` 的 `headers()`），但那是给 Tailscale Serve 这个私网反代用的；
   本条要求的是公网场景下拒绝 `/v1/codex/*`、限制允许主机与来源的独立反向代理层，还没有搭建。
6. ✅：Graph 令牌、SQLite、备份和材料目录只在 `CROSSLINE_DATA_DIR`（本机私有卷）；没有任何路径把它们暴露给
   CI、浏览器或日志。
7. 未做：目前只有一个真实注册账号跑通过登录/验证/登出全链路（阶段二确认细节 #9）。用真实 OIDC 账户做两用户
   隔离、失效会话、权限撤销、跨站写入、反向代理直连拒绝和备份恢复演练，仍然需要第二个真实账号才能验证。

第 4、5、7 项做完并有真实验证证据后，才是重新评估解除 `external` 构建门的时机；把这份清单变成部署前自动检查
是那时候的事，不是现在。

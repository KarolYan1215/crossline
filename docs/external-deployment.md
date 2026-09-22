# 外部部署门

当前版本只能本机使用。Web 与 worker 默认都绑定 `127.0.0.1`，且 `CROSSLINE_DEPLOYMENT_MODE=external` 会让 Next 构建失败。

原因是数据访问仍固定为 `local-owner` / `personal-crossline`。在这个结构上只加登录页，登录后的不同人仍会读写同一账本；这不是授权。

解除构建门前，必须在同一个变更中完成并验证以下项目：

1. 用独立的机密 OIDC 应用建立服务端会话；不要复用 Graph 设备码的公共客户端。
2. 将认证主体映射为稳定的 `ownerId`，并让每条 Web 读写路径从会话取得 `ownerId` 与 `workspaceId`；删除 Web 层的全局常量。
3. 在存储层按 `(ownerId, workspaceId)` 限定每个查询和突变，补跨用户读取、写入和事件重放的隔离回归。
4. 以角色或成员关系授权身份、项目、里程碑和审批；默认拒绝未成员访问。
5. 外部入口只放在 HTTPS 反向代理或私有访问网关之后。应用和 Codex supervisor 均保持 loopback；代理只转发 Web，拒绝 `/v1/codex/*`，限制允许主机与来源，设置 HSTS、CSP、frame-ancestors、nosniff 与 Referrer-Policy。
6. Graph 令牌、SQLite、备份和材料目录只存在于服务主机的私有卷；CI、浏览器和日志不得读取它们。
7. 用真实 OIDC 账户做两用户隔离、失效会话、权限撤销、跨站写入、反向代理直连拒绝和备份恢复演练。

完成以上项目后，替换构建门并把该清单变成部署前自动检查。

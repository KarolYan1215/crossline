# 配置 Google 登录

本文是开启「用 Google 账号登录」的一次性配置。Google 控制台里的操作只能由你本人在浏览器里完成；密钥只写进 `apps/web/.env`，不要贴到聊天里。

## 0. 先知道的几件事

| 项 | 值 | 出处 |
|---|---|---|
| 本机地址 | `http://127.0.0.1:3210` | `apps/web/package.json` 的 `start`；`.env` 里 `CROSSLINE_WEB_BASE_URL` 留空时的默认值（`apps/web/lib/auth.ts`） |
| Google 回调地址 | `http://127.0.0.1:3210/api/auth/callback/google` | Better Auth 1.7.5 用 `baseURL + /api/auth + /callback/google` 拼出（`better-auth/dist/oauth2/utils.mjs`） |
| tailnet 地址 | `https://karols-laptop.tailb8a366.ts.net` | `docs/private-network-deployment.md`；`.env` 的 `CROSSLINE_TAILSCALE_HOSTNAME` |
| 要填的变量 | `CROSSLINE_GOOGLE_CLIENT_ID`、`CROSSLINE_GOOGLE_CLIENT_SECRET` | `apps/web/lib/auth.ts` `googleFromEnv`；两个都非空时登录页才出现「用 Google 账号登录」 |
| 申请的权限 | `openid`、`email`、`profile` | Better Auth 的 Google 默认值；代码没有加别的 |

三个限制，配置前先看：

1. **只在 `127.0.0.1:3210` 上能用。** `CROSSLINE_WEB_BASE_URL` 留空，基址固定为 `http://127.0.0.1:3210`，所以无论从哪个地址点按钮，Google 都会跳回 `127.0.0.1:3210`。用 `localhost:3210` 或手机上的 tailnet 地址打开时，状态 cookie 在另一个主机名下，回调会失败。tailnet 上用 Google 登录要改代码（让 Better Auth 按请求主机选基址，`baseURL.allowedHosts`），目前没做。第 3 步仍建议把 tailnet 回调地址一起登记好，代码改好后不必再进控制台。
2. **同一个邮箱就是同一个账号。** 如果这个 Google 邮箱已经注册过 Crossline，而且原账号的邮箱验证过，用 Google 登录会进入原账号，之后两种方式都能登录。两边有一边没验证过邮箱时，登录会被拒绝，防止别人用你的地址抢注。从没注册过的邮箱，会新建一个空账号并进入访谈（`packages/auth/src/index.ts` `accountLinking`）。
3. **测试模式只放行测试用户**，最多 100 人（第 2 步）。

## 1. 建项目

1. 打开 <https://console.cloud.google.com/>，用你的 Google 账号登录。
2. 顶栏项目选择器 → **新建项目**。名称填 `Crossline`，组织选「无组织」，点 **创建**。
3. 确认顶栏已切到 `Crossline` 项目。

不需要启用任何 API。只做登录时，`openid email profile` 不依赖某个 API。

## 2. 同意屏幕（Google Auth Platform）

1. 左侧菜单 → **API 和服务** → **OAuth 同意屏幕**。新版控制台会进入 **Google Auth Platform**，点 **开始**。
2. **应用信息**：应用名称填 `Crossline`；用户支持邮箱选你自己的地址。点 **下一步**。
3. **受众群体**：选 **外部**。个人 Gmail 账号没有「内部」这个选项。点 **下一步**。
4. **联系信息**：填你自己的邮箱。点 **下一步**，勾选同意政策，点 **创建**。
5. 左侧 **受众群体**：发布状态保持 **测试**。在 **测试用户** 下点 **添加用户**，加入你要用来登录的 Google 邮箱。给别人用时也加在这里。
6. 左侧 **数据访问**：现在**不用加**任何范围。`openid`、`email`、`profile` 是基本范围，不在这里登记也能用。

### 测试模式与以后要加的日历权限

| | 现在（只登录） | 以后（计划中的 Google 日历写入） |
|---|---|---|
| 范围 | `openid`、`email`、`profile` | 建议只加 `https://www.googleapis.com/auth/calendar.app.created`（「创建辅助日历，并查看、创建、更改、删除其中的活动」），与 Outlook 那边「只写名为 Crossline 的日历」的边界一致。若还要把 Google 日历当作只读约束，再加 `calendar.events.readonly` |
| 测试模式 | 只有测试用户能登录，上限 100 人 | 同左 |
| 刷新令牌 | 登录不需要 | 测试模式下，外部应用一旦申请了基本范围以外的权限，刷新令牌 **7 天过期**，每周要重新授权 |
| 发布到正式 | 只用基本范围时，发布无需 Google 审核 | 日历范围属于敏感范围，发布到正式需要提交 Google 审核（隐私政策、首页、演示视频）。Google 的范围参考页没有标出 `calendar.app.created` 的分级，以加入范围时控制台显示的为准 |

所以现在只做登录，不加日历范围。日历写入做出来后，再回到 **数据访问** 添加范围。

## 3. 建 OAuth 客户端

1. 左侧 **客户端** → **创建客户端**。
2. **应用类型**：选 **Web 应用**。名称填 `Crossline local`。
3. **已获授权的 JavaScript 来源**：可以不填。登录走服务器跳转，不用浏览器端 SDK。
4. **已获授权的重定向 URI**，逐条添加，一个字符都不能差：
   ```text
   http://127.0.0.1:3210/api/auth/callback/google
   https://karols-laptop.tailb8a366.ts.net/api/auth/callback/google
   ```
   第一条现在就用。Google 对本机回环地址放行 `http` 和 IP 地址。第二条留给 tailnet，见第 0 节限制 1。
   **不要**加 `http://localhost:3210/...`，代码不会用到它。
5. 点 **创建**。弹窗里显示 **客户端 ID** 和 **客户端密钥**。先别关窗口；也可以下载 JSON，放在仓库以外的地方。

## 4. 写入 `apps/web/.env`

用编辑器打开 `C:\Users\karol\Documents\ChatGPT\Multi-ID\apps\web\.env`，找到这两行（已经存在，值为空），把值粘进去：

```text
CROSSLINE_GOOGLE_CLIENT_ID=<客户端 ID，以 .apps.googleusercontent.com 结尾>
CROSSLINE_GOOGLE_CLIENT_SECRET=<客户端密钥，以 GOCSPX- 开头>
```

不加引号，等号两边不留空格。`.env` 已被 git 忽略，不会被提交。**不要**改 `CROSSLINE_WEB_BASE_URL`，它保持空即可。

## 5. 重启网页服务

这两个变量只在服务器启动时读取。登录页按请求渲染，所以**不需要重新构建**，重启网页服务即可。重启会让常驻应用断开几秒钟。

告诉 Claude「Google 配置好了」，由它检查变量是否非空（只看长度）、确认后重启，并陪你完成一次真实登录。

自己重启时，在仓库根目录的 PowerShell 里运行：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3210 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
powershell -ExecutionPolicy Bypass -File scripts\start-crossline.ps1
```

`start-crossline.ps1` 发现 3210 空闲就会启动 `apps/web/.next-prod` 里的构建。worker 由心跳锁保护，重复启动时会自行退出，不受影响。

## 6. 验证

1. 用 `http://127.0.0.1:3210/login` 打开登录页（不要用 `localhost`）。页面应出现 **用 Google 账号登录**。
2. 点击它，选第 2 步加过的测试用户，同意后应回到首页。
3. 常见失败：

| 现象 | 原因 |
|---|---|
| Google 页面报 `redirect_uri_mismatch` | 第 3 步的重定向 URI 有字符不一致（端口、`http`/`https`、末尾斜杠） |
| Google 页面报 `access_denied`，并提示应用在测试中 | 这个 Google 邮箱没有加进测试用户 |
| 回到登录页，提示「这个邮箱已有 Crossline 账号，但……没有确认这个邮箱」 | 原账号的邮箱没验证过，见第 0 节限制 2 |
| 按钮不出现 | 两个变量有一个为空，或改完没有重启 |

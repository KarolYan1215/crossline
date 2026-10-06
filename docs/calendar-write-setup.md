# Crossline 日历：写入授权与分享到 Google

> 硬约束：Crossline **不改动你人工设置的任何日历**。它只写一个名为 `Crossline` 的单独日历，且只写自己创建、带标记的事件。你在里面手动改过的事件，它之后不再碰。

## 1. 授权（一次）

Entra 应用的委托权限需包含 `User.Read`、`Calendars.ReadWrite`（学校租户无需管理员同意的前提下）。然后在仓库根目录运行：

```powershell
pnpm exec tsx scripts/graph-write-login.ts
```

按提示打开网址、输入设备码，同意页应写着「读取和写入你的日历」。成功后账号记入账本设置 `calendar.write.account`。之后重启 worker。

## 2. 写入

计划页点「同步到 Crossline 日历」。计划版本批准后才能写；只有点按钮才写，不会定时自动写。结果会说明新增、调整、移除、不变各几条，以及几条因你手动改过而保持原样。

## 3. 分享到 Google 日历

在 Outlook（网页版）→ 设置 → 日历 → 共享日历 → 选 Crossline → 发布，取得 ICS 链接；在 Google 日历 → 其他日历 → 通过网址添加。学校租户可能禁止对外发布；那时改用「共享给 Gmail 地址」或在 Outlook 里查看。Google 订阅 ICS 的刷新延迟可达半天到一天，这是 Google 的限制。

Google 日历里的事件目前**不会**被 Crossline 读成硬约束（尚未实现）。

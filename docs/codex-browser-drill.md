# Crossline · 浏览器实测脚本（交给 Codex 跑）

> **更完整的那一份在 `docs/codex-test-plan.md`**：它覆盖全部功能，并且带一层专门证伪设计赌注的
> 红队。这份只是其中两项的详细步骤，被 codex-test-plan 的作业 D8 直接引用。

这份文件是给 **Codex for Chrome** 的作业书，用来补完验收协议里我自己验不了的两项：

- **P2.5 / P2.6 — 日历冲突**：需要真的改一次 Outlook 里的日程。
- **P10 — 离线**：需要一个真正注册得上 Service Worker 的浏览器。

## 为什么必须是 Codex for Chrome，而不是桌面操控

| | |
|---|---|
| Codex 的**桌面操控**（自己的虚拟光标点桌面应用） | 2026-04 起 **macOS 优先**，Windows 仍在路线图上。你这台是 Windows 11，**别用这条路**。 |
| **Codex for Chrome** 扩展 | 2026-05-07 发布，**macOS 与 Windows 都支持**，直接在你已登录的 Chrome 会话里操作。这两项测试要的正是「已登录的 Outlook」和「真实 Chrome 的 Service Worker」。 |

所以：**在 Chrome 里装 Codex 扩展，把下面两段贴给它**。两段互相独立，可以分开跑。

## 跑之前（你自己做一次，30 秒）

```powershell
cd C:\Users\karol\Documents\ChatGPT\Multi-ID; pnpm build; powershell -ExecutionPolicy Bypass -File scripts\start-crossline.ps1
```

确认两个都通：

```powershell
curl.exe -s -o NUL -w "web=%{http_code}`n" http://127.0.0.1:3210/api/health; curl.exe -s -o NUL -w "codex=%{http_code}`n" http://127.0.0.1:3211/v1/codex/status
```

然后**在 Chrome 里打开一次** http://127.0.0.1:3210 —— 第一次打开才会装上 Service Worker，离线那段依赖它。

---

## 作业一 · P2.5 / P2.6：改真实日历，看已批准的计划怎么反应

> 这一段会**写你的真实 Outlook 日历**：新建一个测试日程，验完删掉。你已经授权了。
> Crossline 本身**永远不写**你的日历 —— 它的读取类 `GraphReadSource` 结构上就没有写方法。写这一下的是 Codex，不是 Crossline。

**要证明的两件事**（别让它把这两句改写成别的）：

1. 已批准的计划**不会被现实改写**。日历变了之后，旧版本原样保留，另开一个新草稿，新草稿里的差异**全部是 `conflict`**。
2. 冲突**不是死局**。在 C 视图里逐条处理掉之后，计划可以重新批准。

### 贴给 Codex 的指令

```
你在我的 Chrome 里操作。目标：验证 Crossline 在我的真实日历变化后的行为。严格按步骤，每一步把你看到的原文记下来，不要替我判断"应该没问题"。

前置：打开 http://127.0.0.1:3210/plan ，点 "C · 计划差异" 页签，记录顶部的 "PLAN v<N> · <状态>"。
如果状态不是"已批准"：先把所有"待处理"的差异逐条点"采纳"或"排除"，再点"批准本批变更"→"确认批准"，直到状态变成"已批准"。记录此时的版本号 N。

步骤 1（改日历）：打开 https://outlook.office.com/calendar/ ，**用 kyan47@wisc.edu 这个账号**，在**默认日历**（左边栏里名字就叫「日历」的那个）的**明天**新建一个日程：
  标题 Crossline conflict drill
  时间 15:00–16:00
保存。确认它出现在日历上。

  必须放进**被勾选**的日历里，否则这一步白做。连接页的「日历来源」列出每个已登录账号的全部日历，只有勾上的才读；新账号默认只勾它的默认日历。放进没勾的日历里，「立即同步日历」会如实报告「日历没有变化」——它没错，它确实没在它读的那些日历里看到变化。

  要加第二个账号：`pnpm exec tsx scripts/graph-add-account.ts`。个人 Microsoft 账号还需要先把 Entra 应用注册的「支持的帐户类型」改成包含个人帐户，并把 `CROSSLINE_MS_TENANT_ID` 改成 `common`。

步骤 2（让 Crossline 看见）：回到 http://127.0.0.1:3210/plan ，点 "C · 计划差异"，点右上角的"立即同步日历"按钮。等它变回可点状态，或页面自己刷新。

步骤 3（读结论）：截图并逐字记录：
  a) 顶部的 "PLAN v? · ?" —— 版本号是否比 N 大，状态是否变回"草案"
  b) 差异列表里和 "Crossline conflict drill" 有关的那几行，**每行左边的类型字样**（"新增"/"移除"/"冲突"）和右边的状态
  c) 页面顶部那句描述里"今天有几个 / 未来 7 天内有几个"的数字

步骤 4（解冲突）：把所有"待处理"的行逐条点"采纳"或"排除"（都可以，记录你点了哪个）。
然后点"批准本批变更"→"确认批准"。记录批准是成功了，还是弹出了红色的"批准失败"提示。

步骤 5（收尾）：回到 Outlook 日历，删除 "Crossline conflict drill"。
再回到 Crossline 的 C 视图点一次"立即同步日历"，记录这次出现了什么差异行。

报告给我：每一步的原文记录 + 结论"步骤 3 里的差异是不是全部标成了冲突"、"步骤 4 的批准有没有成功"。
如果任何一步的实际结果和上面的描述对不上，直接说对不上，不要找补。
```

### 我这边怎么复核（不依赖 Codex 的自述）

```powershell
cd C:\Users\karol\Documents\ChatGPT\Multi-ID
pnpm exec tsx scripts\ledger-inspect.ts plans
```

看三件事：旧版本还在且仍是 `approved`；新版本是 `draft`；新版本的 `changes` 里和 drill 相关的 `kind` 全是 `conflict`。

### 已知的边界（别误判成 bug）

- 同步窗口是**今天起 7 天**（`CROSSLINE_PLAN_WINDOW_DAYS`）。把日程建在下下周，Crossline 看不见，这是对的。
- B 视图只画**今天**。明天的日程要在 A 视图看。
- 删除一个日程后，如果删除发生在两次同步之间且触发了 410 重新同步，它是"本地有、远端没有"被丢掉的，不会有墓碑事件 —— 差异文案仍然会说"日历中已不存在"。

---

## 作业二 · P10：真正的离线

> 我在 Claude 的内置浏览器里验不了这一项：那个面板**注册不了任何 Service Worker**。我放了一行最简单的同源 `sw-probe.js` 去注册，报的是和 Crossline 自己的 `sw.js` 一模一样的
> `An unknown error occurred when fetching the script.`
> 这是嵌入式 webview 的已知限制，不是 Crossline 的问题 —— 但也因此，**"断网还能打开这个应用"这句话目前没有任何真实证据**。这段就是去拿那个证据。

**要分清的两件事**：

- **(a) 断网还能打开** —— 只有 Service Worker 能做到。这是这段唯一验不了就不能算过的部分。
- **(b) 断网能收集、恢复后自动补上** —— 只用 IndexedDB，不依赖 SW。**这部分我已经在真实账本上验过了**：停掉 web 服务 → 提交 → 提示"网络不可用，已保存并等待同步" → 队列里有一条 → 重启服务 → 刷新 → 队列清空 → 账本多一行。同一个 `clientCommandId` 连发两次只产生一行。终态 4xx 的命令进死信。

### 贴给 Codex 的指令

```
你在我的 Chrome 里操作。目标：验证 Crossline 在真正断网时还能打开、能收集、恢复后能自动补上。

前置：打开 http://127.0.0.1:3210 ，等页面完全加载。
打开 DevTools → Application → Service Workers，记录：
  是否有一个已激活（activated and is running）的 worker，它的 Source 文件名是什么。
如果这里是空的或报错，把报错原文抄给我，然后停下 —— 后面的步骤没有意义。

步骤 1（断网）：DevTools → Network 面板 → 把 "No throttling" 改成 "Offline"。
确认页面右上角或 Network 面板显示已离线。

步骤 2（离线打开）：按 F5 刷新页面。记录：
  页面是正常渲染出来了，还是显示 Chrome 的恐龙断网页？
  如果渲染出来了，标题和左上角的时钟是否都在？

步骤 3（离线收集）：在"快速收集"框里输入
  标题：离线实测 <当前时间 HH:MM>
  上下文：Codex 在断网状态下提交的
点 CAPTURE。记录按钮下方出现的那句提示原文。

步骤 4（看队列）：DevTools → Application → IndexedDB → crossline-offline → pending。
记录里面有几条，以及这条的 title 和 clientSequence。

步骤 5（恢复联网）：Network 面板改回 "No throttling"。**不要手动刷新**，等 5 秒。
再看 IndexedDB → pending。记录它是否已经变空。
然后刷新页面，记录"快速收集"上方的 INBOX 计数，以及 Workbench 页里有没有出现步骤 3 那条。

步骤 6（死信）：打开 http://127.0.0.1:3210/offline ，记录页面上"死信"区域显示的内容（可能是空的，空的也要说）。

报告给我：每一步的原文 + 结论"步骤 2 断网时页面是否打开了"。
步骤 2 是这次测试唯一的重点，其余几步我已经自己验过了，你的结果和我的对不上就直接说。
```

### 我这边怎么复核

```powershell
cd C:\Users\karol\Documents\ChatGPT\Multi-ID
pnpm exec tsx scripts\ledger-inspect.ts captures
```

步骤 3 那条应该恰好出现**一次**，状态 `captured`。

---

## 报告模板（让 Codex 按这个格式回）

```
## P2.5/P2.6
批准前版本：v_ / 状态_
步骤 3 后版本：v_ / 状态_
drill 相关差异行（逐字）：
步骤 4 批准结果：成功 / 失败（提示原文：）
步骤 5 删除后的差异行：
结论：全部标成冲突？ 是 / 否
     处理完能重新批准？ 是 / 否

## P10
Service Worker 状态：
步骤 2 断网刷新：打开了 / 恐龙页
步骤 3 提示原文：
步骤 4 pending 条数：
步骤 5 pending 是否清空：
步骤 6 死信区：
结论：断网可打开？ 是 / 否

## 对不上的地方
（没有就写"没有"）
```

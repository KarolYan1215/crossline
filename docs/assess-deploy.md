# 公开速测：构建与部署到 Cloudflare Pages

`apps/assess` 是独立于私有 App 的公开速测（设计见 [energy-and-ecosystem.md](energy-and-ecosystem.md) §7）。本文说明它包含什么、如何本地运行，以及如何部署到 Cloudflare Pages。**目前尚未部署。**

## 它是什么

一个静态页面，三部分，约 8 分钟：

1. **16 题思维模式速测**：四条轴（深耕/跨界、实证/直觉、造物/传播、规划/应变），每条轴 4 题、其中 2 题反向计分，Likert 1–5。计分在 `packages/core/src/assess.ts` 的 `quizScores`；类型由 `typeFromScores` 得出，和画像报告用的是同一张 16 型表。
2. **精简版慕尼黑时型问卷（MCTQ）**：工作日和休息日的入睡、醒来时间，加每周工作天数，以及休息日是否用闹钟。`mctqLite` 按 ropensci `mctq` 包的算法计算：
   - 睡眠中点 MSW、MSF；
   - 校正后的 MSF_sc：休息日睡得比工作日长时，`MSF − (SD_f − SD_week)/2`；休息日用闹钟时无法校正；
   - 带符号的社会时差 `MSF − MSW`，绕午夜时取较短方向。
   早晚型按 MSF_sc 分档（3:00 前偏早、5:00 起偏晚）。这是阅读约定，不是人群常模。
3. **3 分钟 PVT-B**（可跳过）：
   - 每次刺激前随机等待 2–5 秒；
   - 反应时间 ≥ 355 ms 或 30 秒未反应计为失误；
   - 反应时间 < 100 ms 或在刺激出现前点击计为抢按；
   - 报告中位数、平均反应速度（1000/RT）、失误次数和抢按次数（`pvtSummary`）。

结果页包括：

- 两张 3:4 卡片（类型卡、精力卡），各导出为 1080×1440；
- 一张长图，三张图都通过 `html-to-image` 生成；
- 打印样式，可存为 PDF；
- 指向内测登记页的二维码。

每张卡和长图都注明「基于自评与反应测试的估计，非医学诊断」。

精力卡的曲线把填写的作息展开成两周的夜晚，交给画像页所用的同一个能量模型（`energyRhythm`）。由于没有个人校准，曲线只反映作息时间，不反映个人状态。

**不显示百分位**：设计时打算用 Basner, Mollicone & Dinges 2011（PVT-B 验证研究，PMC3197786）中「睡眠充足基线」的均值和标准差，按正态近似计算百分位。2026-10-14 核对原文后发现，该文只在图中给出基线，没有给出可读的均值和标准差，所以不计算百分位。找到可引用的常模之前，结果页只报告本人的数值。

## 不连接任何东西

- 所有计算都在浏览器里完成。除了按需加载本站自己的脚本分片（生成图片和二维码时），页面不发出任何请求，答案不离开浏览器；不写账本，不调用模型，也不使用任何 GPT 账号。
- 只引用 `@crossline/core/assess` 和 `@crossline/core/energy-rhythm` 两个子路径，它们都是纯函数模块。新增依赖时要保持这一点：不能引入任何会读写账本或网络的模块。
- 私有 App 的 `external` 部署禁令（`apps/web/next.config.mjs`）不受影响。这里部署的是另一个应用。

## 本地运行

```powershell
pnpm --filter @crossline/assess dev      # http://127.0.0.1:3340
pnpm --filter @crossline/assess build    # 静态导出到 apps/assess/out/
pnpm vitest run packages/core/src/assess.test.ts apps/assess
```

`.claude/launch.json` 的 `assess` 配置启动的就是这个开发服务器。

## 部署到 Cloudflare Pages

1. 在 Cloudflare 控制台创建 Pages 项目，连接这个仓库。仓库目前没有远端，需要先推到 GitHub；也可以本地构建后用 `wrangler pages deploy` 直接上传，见第 4 步。
2. 构建设置：
   - Framework preset：None
   - Root directory：仓库根目录
   - Build command：`npx pnpm@12.6.0 install --frozen-lockfile && npx pnpm@12.6.0 --filter @crossline/assess build`
   - Build output directory：`apps/assess/out`
   - 环境变量：
     - `NODE_VERSION=22`
     - `NEXT_PUBLIC_WAITLIST_URL=<内测登记页地址>`：二维码指向它。未设置时会指向占位地址 `https://example.com/crossline-waitlist`，上线前必须设置。
3. `better-sqlite3` 等依赖会在 install 时编译。如果 Pages 构建环境装不上它，有两个办法：用第 4 步本地构建后上传；或者给这一步单独写一份只含 `apps/assess` 与 `packages/core` 的工作区清单。
4. 本地构建后直接上传（不需要连接仓库）：

   ```powershell
   pnpm --filter @crossline/assess build
   npx wrangler pages deploy apps/assess/out --project-name crossline-assess
   ```

5. 海外内测阶段先用 `*.pages.dev` 域名，不绑定正式域名。

## 上线前检查

- `NEXT_PUBLIC_WAITLIST_URL` 已设置，扫码能打开登记页。
- 在手机宽度下走完三部分：没有横向滚动，文字不小于 12px；保存图片能得到三张 PNG，打印预览里两张卡各占一页。
- 用浏览器开发者工具的 Network 面板确认：做题、做 PVT、出结果、保存图片的整个过程里，只有对本站 `/_next/static/` 的请求，没有发往其他域名的请求，也没有任何带答案的请求。

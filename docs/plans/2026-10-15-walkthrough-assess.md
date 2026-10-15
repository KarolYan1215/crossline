# 公开测评走查（2026-10-15）

以从小红书点进来的陌生人身份，走查 `apps/assess` 的全部页面：落地页 → 32 题 → 外貌 → 邮箱 → 结果页与海报 → 下载/分享 → 邀请链接 → 第二个人作答 → 双人卡 → 删除。桌面 1280 宽、手机 375 宽各走一遍。开发服务器 `localhost:3340`，数据在默认的 `apps/assess/data`。没有配 `ASSESS_IMAGE_API_KEY` 和 SMTP，所以形象一律是类型模板，邮件只记日志、不外发。

判断标准：陌生人愿不愿意答完、愿不愿意转发海报、愿不愿意拉朋友做双人卡。

## 走过的路径

| 路径 | 结果 |
|---|---|
| 落地页（桌面、手机） | 修复前只有一段文字和「开始」，看不到会得到什么；修复后见 F2 |
| 32 题：键盘 1–5、点选、第 17 题刷新 | 刷新后停在第 17 题，已答的保留 |
| 外貌：女生 / 男生 / 中性各一次 | 中性按结果 id 的哈希固定落到女或男模板，符合设计 |
| 邮箱门槛：空邮箱、本人邀请（同邮箱）、正常提交、取消勾选发信 | 空邮箱提示「请填写邮箱」；同邮箱提示「这是你自己的邀请链接…」；正常提交约 2 秒跳到结果页 |
| 结果页、海报 1080×1440、长图 1080×2730 | 实际像素正确；satori 布局测试覆盖 16 型海报和 256 种双人卡，无重叠、无出界、无小于 24 px 的字 |
| 邀请页（第二个身份） | 显示邀请人署名、形象、类型；答完直接到双人卡 |
| 双人卡 | 两个大形象并排、关系名、两条建议、共同主线，传播效果最好 |
| `?delete=1`（邮件里的删除链接） | 页面直接滚到确认框；删除后海报、邀请、双人卡全部 404 |
| 失效链接 `/t/…` | 「邀请链接已失效」+「自己测一测」，体面 |
| 自动审计（每页注入脚本） | 手机 375 宽：无横向滚动、无小于 12 px 的字、正文对比度全部 ≥ 7:1 |

## 发现与处理

| # | 问题 | 严重度 | 现象与复现 | 修复（文件） | 验证 |
|---|---|---|---|---|---|
| F1 | 开发服务器每个页面都是 500 | 高（阻断走查） | `pnpm --filter @crossline/assess dev` 后打开任意页，日志 `Module not found: Can't resolve 'fs'`，引用链 instrumentation → purge → store → better-sqlite3。`register()` 用的是「不是 nodejs 就 return」的写法，webpack 不会把后面的动态 import 从 edge 构建里剔除 | 改成 Next 文档的写法，import 放在 `=== "nodejs"` 分支里（`instrumentation.ts`） | 停掉重启开发服务器，冷启动首页、邀请页均 200，日志里没有 `fs` 错误 |
| F2 | 落地页看不到会得到什么 | 高（首屏 3 秒决定是否开始） | 首屏只有标题、一段说明和「开始」，没有任何形象或类型名 | 「开始」下面加「16 种类型，比如」：四个类型（每组一个、男女交替）的形象、类型名、自嘲副标题，手机两列、宽屏四列（`app/page.tsx`、`lib/samples.ts`、`components/test-flow.tsx` 的 `after`、`assess.css`）。缩略图 240×360、每张约 140 KB，由 `scripts/sample-thumbs.ts` 从模板缩出，放在 `public/samples/` | 桌面、手机截图确认；首屏仍能看到「开始」，示例图露出上半 |
| F3 | 海报上的形象太小，四行排位重复 | 高（海报是传播钩子） | 形象只有 236×354，约占画面 6%；四条轴下各有一行「…约超过 X% 的人（理论估算）」，字小、重复，方案 §1 只要求一行 | 形象放大到 300×450；去掉每轴的排位行，只在标题区写一行最突出的轴（`strongestAxis`：先取不在两可区的，再取偏离最多的），粗体，上方用组别色细线；长图保留每轴排位（`server/poster/render.ts`）。版式版本号升到 2，旧缓存不再命中（`server/poster/cache.ts`） | 16 型布局测试、字体子集测试通过；新增 `strongestAxis` 单测；对比修改前后的 GERA 海报 |
| F4 | 「小鹿 的思维模式类型」「小鹿 邀请你」中间多一个空格 | 低 | 中文昵称后面紧跟中文，不该有空格 | `lib/names.ts` 的 `withName`：昵称以字母或数字结尾才加空格；海报、邀请页标题、分享文案都用它 | `names.test.ts`；海报上「小鹿的」、「Kiki 的」 |
| F5 | 邮箱门槛没说清用途和删除方式 | 中 | 只有「保存 90 天，注册后可带入访谈，可随时删除」；陌生人不知道「访谈」是什么，也不知道怎么删；邮箱框没有占位；「邀请卡署名」在被邀请人那里其实是双人卡上的名字 | 写明「邮箱只用来：找回你的结果，以及朋友做完双人卡时通知你。不发营销邮件，不给任何人看」和「90 天后自动删除；结果页和每封邮件里都有「删除我的结果」」；字段改名「你的昵称（可选）」并注明印在哪里；勾选框改为「把结果链接发到我的邮箱」（邮件里只有链接，没有海报）（`components/email-step.tsx`） | `steps.test.tsx` 检查这几句；截图确认 |
| F6 | 没配 SMTP 时结果页仍说「你也会收到邮件」 | 中 | 邮件只记 `assess.mail_skipped`，页面却承诺发信；取消勾选的人也没被提醒保存链接，换设备就找不回 | `ResultView.mailOn`（`server/mail.ts` 的 `mailConfigured`）；发不出或没勾选时，海报上方一行粗体提醒收藏本页，页面底部给「我的结果链接（只给自己看）」和「复制」（`components/result-screen.tsx`、`components/share-invite.tsx` 的 `CopyLink`） | 取消勾选提交的结果页截图；`mailOn` 进入 fixtures 与类型检查 |
| F7 | 结果页没有通向完整 App 的入口 | 高（本轮目标） | 海报写着「在 Crossline 里把这几条线真的跑起来」，页面上却没有任何说明或入口 | 推荐主线和搭子之后加「把这三条线真的跑起来」：一句话说明 Crossline 做什么，「现在小范围内测，名额有限，按申请先后用你留的邮箱发邀请」，按钮「申请内测」→「已申请。邀请会发到你留的邮箱」。记录在新表 `beta_requests`（迁移 3，只存结果 id 和时间，随结果删除）；`POST /api/results/<结果令牌>/beta`；机主用 `scripts/beta-requests.ts` 列出申请人 | 路由测试（伪造来源 400、用邀请令牌 404、成功后 `betaRequested`）、存储测试（重复申请只记一次、删除结果后消失）；浏览器里点击后显示已申请，脚本列出 1 人 |
| F8 | 拉朋友的入口在页面中段 | 中 | 「邀请 TA 测」排在四条轴和搭子之后 | 移到海报正下方，标题改为「拉朋友测，看你们是什么关系」 | 截图 |
| F9 | 被邀请人做完只看到双人卡，不知道自己也有完整海报 | 中 | 双人卡页底部按钮是「也邀请别人测」 | 改为「看我自己的海报，再拉别人测」并注明那一页有海报、邀请链接和所有双人卡（`components/pair-screen.tsx`） | 文本检查 |
| F10 | 邀请页、双人卡页在手机上下载 1.8 MB 的原图 | 中（微信内 4G） | 形象原图 1024×1536、约 1.8 MB；邀请页 1 张、双人卡页 2 张，只显示 120 px 宽 | `/api/avatar/<邀请令牌>.png?size=small` 返回 360 宽（约 280 KB）；模板的缩图缓存在 `data/thumbs/`，个人画出来的形象每次现缩、不留副本（删除结果不留痕）；WebP 原样返回（`server/avatar/thumb.ts`、`app/api/avatar/[file]/route.ts`、`components/poster.tsx` 的 `smallFigure`） | 路由测试；浏览器里 `naturalWidth` 为 360 |
| F11 | 「答得太快」的提示像在指责人 | 低 | `TOO_FAST` 说「看起来不像逐题读过，请回到题目读完再答」；实际上计时到提交为止，等几秒再点就能过 | 改为「提交得太快了，需要确认是真人在答题。请等几秒再点「看结果」。」（`lib/flow.ts`） | 文本检查 |
| F12 | 每个 IP 每小时 30 次提交可能误伤 | 中 | 国内移动网络大量共用出口 IP（CGNAT），宿舍、教室也一样；帖子一火，同一出口 30 人以上很常见 | 提到 120 次；挡脚本靠的是每邮箱每天 5 次、40 秒下限和蜜罐（`server/security.ts`） | `routes.test.ts` 改为按 `submitsPerIp.limit` 计 |
| F13 | 外貌页「不会显示给任何人」不准确 | 低 | 形象本身会出现在海报、邀请页上 | 改为「这些选项只用来画你海报上的形象，选项本身不会给别人看」 | 截图 |
| F14 | 结果页「这次用的是类型的基础形象」读不懂 | 低 | 陌生人不知道「基础形象」 | 改为「形象用的是<类型名>的基础角色」；删除后的页面写明邮箱也一并删除；「你的数据」写明存了什么（四轴分数、邮箱、署名、外貌选项，不存每题答案） | 截图 |

## 未修与原因

- **推荐主线与飞轮的内容**（如探险家的「判断力换来新门票」）：另一会话在调研，按要求未动数据，只改了展示。
- **排位偏高**：理论估算用 N(50, 15)，偏离中线 38 分就是「约超过 99% 的人」。第二轮已按机主决定封顶（见下文）。
- **没有生产构建验证**：只在 `next dev` 下走查。`instrumentation.ts` 的改动在生产构建里同样适用，但没有重跑 Docker 构建。
- **微信内长按保存、iOS/安卓实机**：浏览器面板只能模拟宽度和触屏，长按保存仍需上线前在两种手机的微信里各试一次（docs/beta-launch.md §1.2 已列为上线前实测）。
- **加载状态**只是一行灰字「正在读取结果…」。开发模式下首次编译要好几秒，生产应在几百毫秒内，没有改。
- **文档**（第一轮）：本会话只能改 `apps/assess/**`；第二轮获准后已改 `docs/assess-deploy.md`、`docs/beta-launch.md` 的相关句子，CLAUDE.md 仍待补。`docs/assess-deploy.md`（`beta_requests` 表、`scripts/beta-requests.ts`、`public/samples/`）、`docs/beta-launch.md` §1 第 6 条和 §3 邮箱文案、CLAUDE.md 的 apps/assess 段落需要补一句，留给发起会话或机主。

## 需要机主决定（第一轮提出，决定与实现见下文「第二轮」）

1. **内测申请怎么接**：现在是结果页一个「申请内测」按钮，记下申请，机主用 `pnpm --filter @crossline/assess exec tsx scripts/beta-requests.ts` 看名单、手动发 Tailscale 邀请。如果更想走小红书私信或表单，换成链接只需改 `result-screen.tsx` 的 `.as-beta` 一节。说明文案「Crossline 把你同时推进的几条线拆成里程碑……」也请改定。
2. **排位封顶**：是否把理论估算封顶在 95%（见上）。
3. **落地页示例四型**：现在是改装师、雕刻家、探险家、钟表匠（`lib/samples.ts`），按副标题好笑程度挑的。
4. **邮箱门槛去掉「注册后可带入访谈」**：方案 §3 原文有这句，但陌生人看不懂「访谈」，这次删去了。如要保留，请给一个陌生人能懂的说法。

## 小红书海报样例

由 `scripts/poster-samples.ts` 用类型模板画出（与没配图片 key 时用户拿到的一样），在 `apps/assess/data/samples/`（不进 git）。二维码指向占位地址，发帖前用 `ASSESS_BASE_URL=<公网地址>` 重跑。

| 文件 | 类型 | 适合做什么 |
|---|---|---|
| `poster-GIRA.png` | 探险家 GIRA（女） | 封面首选：「八个副本同时开，存档点一个都没有」最好笑，四轴都很满，背包形象辨识度高 |
| `poster-GEMA.png` | 改装师 GEMA（男） | 程序员向：「能跑就行，技术债明天再还（明天从不到来）」 |
| `poster-SIMP.png` | 雕刻家 SIMP（女） | 创作者向：「一件作品磨三年，deadline 是什么能吃吗」 |
| `poster-GIRP.png` | 旗手 GIRP（女） | 「愿景讲得热血沸腾，日程表空得一片祥和」，适合创业话题 |
| `pair-GEMA-SIMP.png` | 改装师 × 雕刻家 双人卡 | 第二张或最后一张图，展示「拉朋友测」的玩法 |
| `poster-SERA.png` | 顾问 SERA（男） | 备用 |

## 验证

- `pnpm vitest run apps/assess packages/core/src/assess`：14 个文件，114 通过，1 跳过（原有的跳过）。
- `pnpm --filter @crossline/assess typecheck`：通过。
- 浏览器：桌面 1280、手机 375 各走完整条路径；修复后的落地页、邮箱页、结果页、邀请页、双人卡页重新截图和审计。

## 第二轮：机主决定的四项（2026-10-15）

| # | 决定 | 实现（文件） | 验证 |
|---|---|---|---|
| D1 | 内测入口保留「申请内测」，旁边加机主邮箱和「在各大平台私信我也可以」 | 邮箱是 mailto 链接，主题「Crossline 内测申请」，正文「我的速测类型：<类型名> <代码>」（`components/result-screen.tsx` 的 `BETA_EMAIL`、`betaMailto`） | 浏览器里读到链接：主题、正文都正确编码 |
| D2 | 排位封顶，加确定性扰动 | `shownRank`（`packages/core/src/assess-content.ts`）：≤95 原样；>95 显示 91–96，由 FNV-1a(`<结果 id>:<轴>`) 决定。`axisRank` 多一个 `seed` 参数，理论估算和真实分布都经过它。`publicType(scores, recorded, seed)` 在结果页、海报、长图、双人卡、提交路由里都传结果 id，所以同一份结果处处一致 | 核心单测：200 个种子落在 91–96 且六个值都出现，同种子同值，≤95 不变，真实分布同样封顶；`public-type.test.ts`：同一结果每次相同、不同结果有差异 |
| D3 | 邮箱门槛写「加入内测后，这次结果会自动带进 App」，并真的接通 | 文案在邮箱门槛和结果页内测一节；契约 `packages/core/src/assess-link.ts`（经 `@crossline/core/assess` 导出，`package.json` 未改）；路由 `apps/assess/app/api/link/route.ts`；`latestResultByEmail`（`server/store.ts`）；`linkLookups` 每 IP 每分钟 60 次、错误密钥也计数（`server/security.ts`）；新错误码 `UNAUTHORIZED`（401） | `app/api/link/route.test.ts`：未设密钥 404、六种错误密钥 401 且不泄露内容、取最近一份且不含署名/外貌/邀请令牌/他人类型、删除后 `found:false`、非法邮箱 400、限频 429 且换 IP 不受影响、解析器拒绝多字段/错代码/组别不符/越界分数/非法时间/`javascript:` 链接 |
| D4 | 每型第一组热门组合（含飞轮）上海报 | `TYPE_LINES` 换内容，结构不变。宋体子集缺 70 个新字，从 notofonts/noto-cjk 取源字体重跑 `scripts/assess-poster-fonts.ts`（只有宋体两个文件和字表变了）。飞轮框加宽到 256（十个字一行）；「在 Crossline 里把这几条线真的跑起来」移到单独一行，不再折行。版式版本升到 4。核心测试新增：飞轮每步 ≤10 字、身份名 ≤12 字 | 16 型布局测试、256 种双人卡测试通过；16 张海报拼图逐张看过，没有溢出或折行 |

**组合换完以后要知道的**：第一次套用的是旧版草稿（身份名粒度不一，类型之间重合的只有 12/120 对）；第三轮已按改写后的统一词表重套，双人卡按身份比较，重合多了。

**16 型海报**：`apps/assess/data/samples/poster-<代码>.png`（SEMP、SEMA、SERP、SERA、SIMP、SIMA、SIRP、SIRA、GEMP、GEMA、GERP、GERA、GIMP、GIMA、GIRP、GIRA），双人卡样例 `pair-GEMA-SIMP.png`。由 `scripts/poster-samples.ts` 画出，用的是类型模板，男女交替，每三型有一条轴放在两可区；二维码是占位地址。

**第二轮验证**：`pnpm vitest run apps/assess packages/core/src/assess` 15 个文件，122 通过、1 跳过；`@crossline/assess` 与 `@crossline/core` 类型检查通过。

## 第三轮：每个邮箱 3 次、组合按统一粒度重套（2026-10-15）

| # | 要求 | 实现（文件） | 验证 |
|---|---|---|---|
| E1 | 同一邮箱最多测 3 次，只保留最新一次；新结果删除旧结果（含海报缓存、邀请、双人卡），规则沿用「删除我的结果」 | `keepOnlyNewest`：记一次 `email_tests`（迁移 4，邮箱的 HMAC，沿用 `draw-key`），再对该邮箱其余结果逐个调用 `deleteResult`（`server/store.ts`）。`deleteResult` 现在还删海报缓存：缓存文件名以邀请令牌或双人卡令牌开头（`posterKey` 的 `owner`、`removeOwnedPosters`，`server/poster/cache.ts`；路由传 `cacheTag`） | 存储测试：旧结果、它的双人卡、它的海报文件都没了，别人的结果和海报还在；删除最新结果后计数仍是 2；表里没有明文邮箱 |
| E2 | 满 3 次时用通俗的话提示，并给出查看最新结果的入口 | 提交时 `testsTakenBy ≥ 3` → 409 `EMAIL_LIMIT_REACHED`，同时把最新结果的链接重新发到该邮箱（回答里不带令牌：填邮箱的人不一定是主人）。页面写「这个邮箱已测满 3 次，只保留最新一次的结果。最新结果的链接已重新发到这个邮箱；想再测，可以换一个邮箱。」，本机有记录时给「查看我的最新结果」按钮（`lib/flow.ts`、`components/test-flow.tsx`、`email-step.tsx`、`last-result-link.tsx`）。邮箱门槛预先写明「一个邮箱最多测 3 次，只保留最新一次」 | 路由测试：前两份及其邀请、双人卡 404；第 4 次 409 且只回错误码，邮件发给该邮箱、内容是最新结果链接；删掉最新后再提交仍 409 |
| E3 | `/api/link` 返回唯一的最新一份 | 不需要改路由：同一邮箱只剩一份 | 链接测试：替换后只返回新的那份 |
| E4 | 组合按统一粒度重套，海报身份大字、形态小字 | `TYPE_LINES.lines` 改为 `{ identity, form }`（`LineIdentity`、`LINE_IDENTITIES` 12 个词、`lineText`，`packages/core/src/assess-content.ts`）；`PublicType.lines` 跟着改为 `LineView`；海报上身份宋体 32 px 粗、形态黑体 24 px 灰色带括号；结果页同样大小两级；双人卡按身份比较共同主线。字体子集重跑，版式版本升到 5 | 核心测试：身份在词表里且互不相同、形态 ≤8 字、飞轮每步 ≤10 字；16 型布局和 256 种双人卡测试通过；16 张样例拼图逐张看过 |

同一邀请、同一邮箱再答一次的行为随之改变：以前保留第一次的双人卡，现在第二次的答案替换第一次（发起人只在第一次收到通知）。

**第三轮验证**：`pnpm vitest run apps/assess packages/core/src/assess` 15 个文件，125 通过、1 跳过；`@crossline/assess`、`@crossline/core` 类型检查通过。16 张海报重画在 `apps/assess/data/samples/`。

## 第四轮：与 App 联调（2026-10-15）

- 契约加可选字段 `figureUrl`：形象缩略图的绝对地址，`<ASSESS_BASE_URL>/api/avatar/<邀请令牌>.png?size=small`，和 `resultUrl` 一样只在设了 `ASSESS_BASE_URL` 时给出（`packages/core/src/assess-link.ts` 类型与解析、`apps/assess/app/api/link/route.ts`）。解析器拒绝非 http(s) 或非字符串的 `figureUrl`。邀请令牌本来就印在海报二维码里，不是新的泄露。
- 测试：`figureUrl` 的地址正确；`javascript:` 和数字被拒；没设 `ASSESS_BASE_URL` 时两个链接都不给。
- 本机 3340 由本会话重启，环境变量 `ASSESS_LINK_SECRET=beta-walkthrough-assess-link`、`ASSESS_BASE_URL=http://127.0.0.1:3340` 只在启动命令里，没有写进任何文件。
- 人设林知夏（`zhixia.beta@example.com`，昵称「知夏」，女生 · 扎起来 · 戴眼镜 · 自然 · 休闲）从 3340 页面答完 32 题：**GEMP 架构师**，四轴 scope 81 / basis 19 / output 19 / rhythm 19。`/api/link` 用正确密钥返回 `found:true` 和两个链接，缩略图 200（PNG，约 260 KB）；错误密钥 401。

## 第五轮：组合定稿上海报（2026-10-15）

- **数据**：`TYPE_LINES` 改为 `{ lines, loop, more }`，每条线 `{ domain, identity }`（`LineIdentity`），`more` 是另外三组；词表 `LINE_IDENTITIES`（§2.2 的 24 个身份加医生、律师、中医师），`lineText` 写出「人工智能的研究者」，`latinGap` 让「二次元的 coser」中间有空格（`packages/core/src/assess-content.ts`）。`PublicType` 多了 `more`。
- **执照类职业**（发起会话代机主定）：「医疗行业的职场人」改为「医生」，「法律服务的自由职业者」改为「律师」，「中医行业的职场人」改为「中医师」，都不带领域。
- **海报**：标题「你也许想做」；每行领域 24 px 灰、「的」随领域，身份 32 px 宋体粗。长图在飞轮说明后加「也可以这样组合」，三组身份 30 / 27 / 24 px。结果页同样两级字号。宋体子集重跑（700 字），版式版本 6。
- **验证**：16 型海报与长图、256 种双人卡的布局测试通过；`pnpm vitest run apps/assess packages/core/src/assess` 15 个文件，126 通过、1 跳过；两个包类型检查通过；16 张海报拼图和一张长图逐张看过。

**本轮自己定的事（按「让陌生人愿意转发」）**
1. **3:4 海报只放首选一组。** 文档 §4 记的是「其余三组排在下面，字号逐组递减」。3:4 海报已经排满（形象、四轴、飞轮、搭子、二维码），再塞三组会把首选和飞轮挤小，封面一眼读不完就不会被转发。所以另外三组放在长图和结果页，按递减字号排。
2. **只改「X 行业的职场人」式写法。** 「高等教育的教育者」「中学数学的教育者」「运动康复的自由职业者」保留：它们不是「行业 + 职场人」，改成「教师」「康复师」会和同类型其他线的粒度不一致。
3. **双人卡第二张样例选联络官 × 旗手**：两人共享「职场人」「社群主理人」，能展示「共同的主线」；第一张改装师 × 雕刻家没有共同主线，展示「正好互补」。
4. **封面三张**：探险家 GIRA、改装师 GEMA、旗手 GIRP（理由见汇报）。

**样例**：`apps/assess/data/samples/poster-<代码>.png` 16 张，双人卡 `pair-GEMA-SIMP.png`、`pair-GERA-GIRP.png`。

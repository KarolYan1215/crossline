# 类型模板（16 个基础角色）

`<CODE>-female.png` 和 `<CODE>-male.png`（1024×1536，全身，2:3）是每种类型的两个基础角色：海报上的默认形象，也是按外貌生成个人形象时的参考图（docs/beta-launch.md §4）。测评里选「女生」用女版、「男生」用男版、「中性」按结果固定分到其中一版。

## 现状（2026-10-15 定稿）

32 张都是本人审定的正式模板：本机 Codex（ChatGPT 画图）出图，方正的低多边形切面画风，组别莫兰迪色（工匠组灰绿、求索组豆沙玫瑰、架构组雾霾蓝、开拓组陶土）。设计依据见 docs/beta-launch.md §4.2。`manifest.json` 记录每张的来源：`candidate` 是定稿的候选图，`placeholder` 是代码画的占位图（只在没有正式图时用，不能上线）。

重画占位图（不调用模型、不花钱）：

```powershell
pnpm exec tsx scripts/assess-templates.ts placeholders
```

## 本人审定流程

1. 两种画法，二选一：
   - **本机 Codex（推荐，用本人的 ChatGPT 画图额度）**：不需要 key，加 `--via=codex`；可以同时开几个进程分摊，每个用不同的 `--port`：
     ```powershell
     pnpm exec tsx scripts/assess-templates.ts candidates --via=codex --port=3397          # 全部 32 张（每型男女各 1）
     pnpm exec tsx scripts/assess-templates.ts candidates 1 2 3 --via=codex --port=3398    # 只画这几个编号
     ```
   - **硅基流动**：在环境里设置硅基流动的 key（只放在本机环境变量或部署平台的密钥里，不要写进仓库）：
   ```powershell
   $env:ASSESS_IMAGE_API_KEY = "sk-..."
   ```
   出候选图用文生图模型，默认 `black-forest-labs/FLUX.1-dev`，可以用 `ASSESS_IMAGE_TEMPLATE_MODEL` 换。
2. 先看提示词（不花钱）：`pnpm exec tsx scripts/assess-templates.ts prompt DLWV`
3. 出候选图：每种类型男女各 1 张，存到 `candidates/<CODE>-female.png` / `<CODE>-male.png`。共 32 张，走硅基流动时按每张约 0.015 美元估算约 0.5 美元。已经存在的候选不会重画，加 `--force` 才重画；也可以只画几种：
   ```powershell
   pnpm exec tsx scripts/assess-templates.ts candidates            # 全部 16 种
   pnpm exec tsx scripts/assess-templates.ts candidates DLWV CLWU  # 只画这两种
   ```
4. 生成总览图 `candidates/sheet.png`（32 张逐一编号，女在前、男在后）：`pnpm exec tsx scripts/assess-templates.ts sheet`。本人逐张看候选图，按这几条挑：
   - 16 张放在一起像同一个系列（同一画风、同样的线条和比例）；
   - **不像 16Personalities 的人物**（他们是低多边形、切面上色；我们是平涂 + 墨线）；
   - 图里没有任何文字、字母、数字或标志；
   - 脸和发型是中性的，戴不戴眼镜都能改，方便之后按外貌改图；
   - 服装颜色是组别色，道具和类型名对得上；
   - 一眼能看出副标题说的那个缺点（笑点），缩到海报圆盘大小也认得出。
   都不满意就改 `scripts/assess-templates.ts` 里的 `LOOKS`（核心特征、服装、道具、笑点、姿态、表情，设计依据见 docs/beta-launch.md §4.2）或风格句，再加 `--force` 重画。
5. 把选中的候选复制成正式模板：
   ```powershell
   pnpm exec tsx scripts/assess-templates.ts redo 3 7 12 --via=codex   # 不满意的编号重画
   pnpm exec tsx scripts/assess-templates.ts pick all                  # 全部定稿（或 pick 3 7 只定这几个）
   ```
   会覆盖 `<CODE>-female.png` / `<CODE>-male.png` 并更新 `manifest.json`。定稿时会铺上组别底色、缩到 1024×1536：ChatGPT 画出来的是透明底，透明的参考图交给改图模型会变成黑底。
6. 提交 32 个模板和 `manifest.json`。`candidates/` 不进仓库（已写进 .gitignore）。
7. 落地页的四张示例图（`public/samples/<CODE>.png`，240×360，每张约 140 KB；选哪四型在 `lib/samples.ts`）是模板缩出来的。改了这几型的模板，重跑 `pnpm --filter @crossline/assess exec tsx scripts/sample-thumbs.ts`。邀请页、双人卡页的小图走 `/api/avatar/<令牌>.png?size=small`，在服务端按需缩到 360 宽（模板缓存在 `data/thumbs/`），不用手动生成。

## 部署时怎么带上模板

服务端按这个顺序找模板目录（`server/avatar/templates.ts`）：

1. `ASSESS_TEMPLATES_DIR`；
2. 源码旁边的 `apps/assess/templates`（开发、测试、脚本）；
3. 当前工作目录下的 `templates`；
4. 当前工作目录下的 `apps/assess/templates`。

Next 的 standalone 输出不会自动带上这些 PNG：打包后的模块里，`import.meta.url` 指向构建机上的源码路径。standalone 的 `server.js` 启动时会先切换到自己所在的目录（`.next/standalone/apps/assess`），所以只要把模板放到那里的 `templates/` 就行。两种做法任选一种（`next.config.mjs` 和 `Dockerfile` 归 W2）：

- 在 `next.config.mjs` 里加 `outputFileTracingIncludes: { "/api/**": ["./templates/*.png"] }`；
- 或者在 Dockerfile 里 `COPY apps/assess/templates ./apps/assess/templates`（放到 standalone 目录下对应的位置）。

部署后访问任意结果的 `/api/avatar/<邀请令牌>.png`，能看到模板图就说明带上了。

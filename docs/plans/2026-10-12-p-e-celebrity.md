# P-E 名人库（思想相近的名人）实施计划

> 执行方式：按任务顺序逐个做（superpowers:executing-plans 或 subagent-driven-development）。每个任务先写失败的测试，再写最少的实现，跑通后再进下一个。

**目标**：画像写完后，从一份写在代码里的固定名人库（约 64 位，五类：企业家 / 文学家 / 科学家 / 艺术家 / 哲学家）里，由小模型按完整画像挑一位「思想相近」的人和他库内的一句名言；分享卡与长图各有一块单独的展示（姓名、年代、领域 + 斜体名言：原文、译文、署名），「为什么是这位」只在长图里出现。名言在入库时用 `safeGet` 打开出处页核对原文确实在页面上，核对结果随代码提交，运行时不联网。

**依据**：`docs/loop-and-scout.md` §7「思想相近的名人」、§11 第 8 条、§12「P-E 名人库：独立。先建库与入库核对脚本，再接挑选调用和展示」。

**架构**：

- `packages/core/src/kindred.ts`：类型、库的结构检查 `libraryProblems`、名言比对 `quoteAppearsIn`、挑选的 wire contract `KINDRED_PICK_SCHEMA` / `validateKindredPick`、查找 `kindredById`。纯函数，不联网。
- `packages/core/src/kindred-library.ts`：库本身（数据）。
- `packages/core/src/kindred-verification.json`：入库核对结果，**只被测试读**；测试要求库里每条名言都有一条与当前原文哈希一致、`ok: true` 的核对记录，所以改一个字就得重新核对。
- `scripts/kindred-verify.ts`：入库核对脚本（联网），用 `apps/worker/src/safe-fetch.ts` 的 `safeGet` + `htmlToText`。`safeGet` 在 worker 里，不在 `packages/core`；脚本按仓库惯例相对路径导入（`scripts/manualbook-check.ts` 第 11 行的注释）。
- Skill `crossline-kindred-picker`（低档）+ `apps/worker/src/kindred-picker.ts`：画像 writer 成功后与插画器并行跑一次；tick 兜底补跑。结果存设置 `portrait.kindred`。
- `apps/web/lib/portrait.ts` 读出挑选并解析成库条目；`apps/web/app/portrait/kindred-block.tsx` 画展示块，插进分享卡（`.pt-card`）和 `SharePart`（页面与长图共用）。

**依赖**：

- 不依赖 P-A。
- **P-C（画像海报改版）**会重排分享卡与 `SharePart`（A「编辑杂志」版式）。本计划的展示块是独立组件，插入点以落地时的版式为准：P-C 已合并就插进新版式，否则插进现有 `apps/web/app/portrait/portrait-view.tsx` 第 250–262 行的 `.pt-card` 与 `SharePart`。P-C 的验收「分享卡只含类型名、形象、一句话、四个百分比、四个标签和名人一栏」里的「名人一栏」就是本计划的块；两份计划谁后合并，谁负责让那条测试列出它。
- **P-D（形象定制）**的 `portrait.character.prefs` 永远不进挑选调用（§7「输入是完整画像（不含定制形象的答案）」），本计划用测试锁住。

**约束**：pnpm（`pnpm vitest run <file>`、`pnpm typecheck`、提交前 `pnpm verify`）；`tsconfig.base.json` 的 `strict`/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`；结构化输出遵守 `packages/core/src/structured-output.ts` 的严格模式规则（`structured-output.test.ts` 按 `*_SCHEMA` 自动发现检查）。**不提交，除非本人要求**——文中「建议提交点」只是建议的切分。界面文案按 `docs/copy-style.md`：第三人称、不游戏化；措辞是「思想相近」，不是「你就是某某」；不放名人肖像。

**版权**：每条名言只收**一句**（结构检查强制：原文内部不含第二个句末标点，西文 ≤ 160 字符、中文 ≤ 60 字）；在世者只收公开讲话、访谈、著作中的公开言论和传记事实；译文由本应用自己翻译（标「译文」），**不抄出处页上的现成译文**，核对脚本若发现译文原样出现在出处页上就报警。简介只写公开的传记事实，≤ 40 字。

---

## 阶段 1：核心契约（纯函数，先测后写）

### 任务 1.1：库条目的类型与结构检查

**文件**
- 新建 `packages/core/src/kindred.ts`
- 新建 `packages/core/src/kindred.test.ts`
- 修改 `packages/core/src/index.ts`（`export * from "./kindred";`，放在 `portrait-type` 之后）

**先写失败的测试**（`kindred.test.ts`）：

```ts
import { expect, test } from "vitest";
import { libraryProblems, type KindredPerson } from "./kindred";

const person = (over: Partial<KindredPerson> = {}): KindredPerson => ({
  id: "seneca", category: "philosopher", name: "塞涅卡", nameOriginal: "Lucius Annaeus Seneca", era: "约前4—65", field: "斯多葛哲学",
  intro: "罗马斯多葛派哲学家、剧作家", living: false,
  quotes: [
    { id: "seneca-1", original: "Omnia aliena sunt, tempus tantum nostrum est.", lang: "la", translation: "万物都属于别人，唯有时间是我们自己的。",
      source: { work: "Epistulae morales ad Lucilium 1", year: "约 65" }, sourceUrl: "https://la.wikisource.org/wiki/Epistulae_morales_ad_Lucilium/Liber_I" },
    { id: "seneca-2", original: "…", lang: "la", translation: "…", source: { work: "…", year: "…" }, sourceUrl: "https://…" }
  ], ...over });

test("a well-formed person passes", () => expect(libraryProblems([person()])).toEqual([]));
test("ids are unique across people and quotes", () => expect(libraryProblems([person(), person()])).toContainEqual(expect.stringContaining("seneca")));
test("two or three quotes per person", () => expect(libraryProblems([person({ quotes: [] })])).toContainEqual(expect.stringContaining("2–3")));
test("a quote is one sentence", () => { /* original 含两个句号 → 报错，指名 quote id */ });
test("a non-Chinese quote needs a translation; a Chinese one needs none", () => { /* lang≠zh 且无 translation → 报错 */ });
test("the source page is a public https address", () => { /* sourceUrl 为 http:// 或 localhost → 报错（复用 publicHttpsUrl） */ });
test("a living person's quote names its year", () => { /* living: true 且 source.year 为空 → 报错 */ });
test("only the five categories", () => { /* category: "athlete" → 报错 */ });
```

**跑**：`pnpm vitest run packages/core/src/kindred.test.ts` → 失败（模块不存在）。

**最少实现要点**：

- `KINDRED_CATEGORIES = ["entrepreneur", "writer", "scientist", "artist", "philosopher"] as const`，中文名 `KINDRED_CATEGORY_LABEL`（企业家、文学家、科学家、艺术家、哲学家）。
- `KindredQuote = { id; original; lang: string; translation?: string; source: { work: string; year: string }; sourceUrl: string }`；`KindredPerson = { id; category; name; nameOriginal; era; field; intro; living: boolean; quotes: KindredQuote[] }`。
- `libraryProblems(library): string[]`，每条问题都写明人或名言的 id。句子判定：去掉末尾的句末标点后，原文里不得再有 `。！？.!?`（缩写如 "Mr." 遇到再加例外，不预先做）。长度：含 CJK 的 ≤ 60 字，其余 ≤ 160 字符。`publicHttpsUrl` 从 `./diligence-schema` 导入。

**跑**：同上 → 通过。

### 任务 1.2：名言比对 `quoteAppearsIn`

**文件**：`packages/core/src/kindred.ts`、`packages/core/src/kindred.test.ts`

**先写失败的测试**：

- 弯引号与直引号、全角与半角、大小写、空白和标点差异都算出现：`quoteAppearsIn("Omnia aliena sunt, tempus tantum nostrum est.", "… omnia aliena sunt; tempus tantum nostrum est …")` 为真。
- 少一个词不算：`"Omnia aliena sunt tempus nostrum est"` 对上面那页为假。
- 中文：繁简不做转换（出处页用 `zh-hans` 变体地址取简体），`"学而时习之，不亦说乎"` 在 `"子曰：「學而時習之…"` 里为假、在简体页里为真——这条测试写明「出处地址必须用 /zh-hans/ 变体」的理由。

**实现要点**：NFKC → 小写 → 只保留 `\p{L}\p{N}`（与 `date-schema.ts` 第 95 行 `squash` 同一思路，但去掉空格），再做子串判断。

**跑**：`pnpm vitest run packages/core/src/kindred.test.ts` → 通过。

### 任务 1.3：挑选的 wire contract

**文件**：`packages/core/src/kindred.ts`、`packages/core/src/kindred.test.ts`、`packages/core/src/structured-output.test.ts`

**先写失败的测试**：

- `KINDRED_PICK_SCHEMA` 通过 `structuredOutputProblems`（自动发现会捡到它；在 `structured-output.test.ts` 第一条测试的 `arrayContaining` 里加上 `"KINDRED_PICK_SCHEMA"`，防止改名后被发现漏掉）。
- `validateKindredPick({ personId, quoteId, why }, library)`：库外的人 → `KINDRED_PERSON_UNKNOWN`；名言不属于这个人 → `KINDRED_QUOTE_NOT_THEIRS`（detail 列出这个人的名言 id）；`why` 为空或 > 80 字 → `KINDRED_WHY_INVALID`；`why` 含「你就是」类说法 → `KINDRED_WHY_IDENTITY`（措辞是「思想相近」）。
- `kindredById(personId, quoteId)` 返回 `{ person, quote }` 或 `undefined`。

**实现要点**：schema 为 `{ personId: { type: "string", enum: 库内全部人 id }, quoteId: { type: "string", enum: 库内全部名言 id }, why: { type: "string", minLength: 1, maxLength: 80 } }`，`required` 全列、`additionalProperties: false`。枚举约 64 + ~160 个值，低于 `MAX_ENUM_VALUES = 500`。名言 id 枚举是全库的，所以「名言属于这个人」只能由校验器查，这正是 `KINDRED_QUOTE_NOT_THEIRS` 存在的原因。

**跑**：`pnpm vitest run packages/core/src/kindred.test.ts packages/core/src/structured-output.test.ts` → 通过。

> 建议提交点：「名人库：类型、结构检查、名言比对与挑选契约」。

---

## 阶段 2：建库（内容工作 + 本人审阅）

### 任务 2.1：名单草案交本人确认 〔本人操作〕

**文件**：无代码改动；把名单贴给本人。

**选人原则**（本人决定，2026-10-12）：每类只收**全球范围最杰出、传播最广、搜索热度最高**的一批，以 MIT Pantheon 的历史知名度指数（维基百科语言版本数与浏览量）为参照；哲学家每个学派只收最有代表性的一位，孔子不算哲学家；文学家不收中国古代诗人；企业家尽量选在世者、不集中于某一国；艺术家不偏重中日。

草案三稿（不限数量，不区分是否在世，在世者同样只引公开言论；本人修订 2026-10-12）：

- **企业家**：埃隆·马斯克、杰夫·贝索斯、比尔·盖茨、沃伦·巴菲特、马克·扎克伯格、黄仁勋、迈克尔·伯里（《大空头》原型）、理查德·布兰森、萨姆·奥尔特曼、奥普拉·温弗瑞、史蒂夫·乔布斯、亨利·福特、华特·迪士尼。备选：拉里·佩奇、查理·芒格。
- **文学家**：但丁、莎士比亚、塞万提斯、歌德、维克多·雨果、列夫·托尔斯泰、陀思妥耶夫斯基、马克·吐温、弗兰兹·卡夫卡、海明威、乔治·奥威尔、加西亚·马尔克斯、J.K. 罗琳。备选：查尔斯·狄更斯、鲁迅。
- **科学家**：伽利略、艾萨克·牛顿、查尔斯·达尔文、迈克尔·法拉第、玛丽·居里、尼古拉·特斯拉、阿尔伯特·爱因斯坦、约翰·冯·诺依曼、艾伦·图灵、理查德·费曼、斯蒂芬·霍金、卡尔·萨根、杰弗里·辛顿。备选：路易·巴斯德、尼尔·德格拉斯·泰森。
- **艺术家**：列奥纳多·达·芬奇、米开朗基罗、伦勃朗、莫扎特、贝多芬、文森特·梵高、克劳德·莫奈、巴勃罗·毕加索、萨尔瓦多·达利、弗里达·卡罗、安迪·沃霍尔、查理·卓别林、宫崎骏；电影导演：阿尔弗雷德·希区柯克、斯坦利·库布里克、史蒂文·斯皮尔伯格、马丁·斯科塞斯、昆汀·塔伦蒂诺、克里斯托弗·诺兰、詹姆斯·卡梅隆。备选：拉斐尔、黑泽明。
- **哲学家**（每派只收最有代表性的一位，偏重欧洲）：亚里士多德（古希腊）、老子（道家）、马可·奥勒留（斯多葛）、蒙田（随笔与怀疑论）、马基雅维利（政治现实主义）、笛卡尔（理性主义）、帕斯卡（宗教哲学）、斯宾诺莎（泛神论）、休谟（经验主义）、伏尔泰（启蒙）、卢梭（社会契约）、康德（德国古典哲学）、叔本华（意志哲学）、克尔凯郭尔（存在主义先驱）、马克思（马克思主义）、尼采、海德格尔（现象学）、维特根斯坦（分析哲学）、萨特（存在主义）、加缪（荒诞哲学）、西蒙娜·德·波伏娃（女性主义）、汉娜·阿伦特（政治哲学）、米歇尔·福柯（后结构主义）、斯拉沃热·齐泽克（拉康派）。备选：柏拉图、黑格尔。

**完成标准**：本人回复确认或增删。确认前不进任务 2.2。

### 任务 2.2：写库数据

**文件**
- 新建 `packages/core/src/kindred-library.ts`（`export const KINDRED_LIBRARY: KindredPerson[] = [...]`）
- 修改 `packages/core/src/kindred.test.ts`

**先写失败的测试**：

```ts
import { KINDRED_LIBRARY } from "./kindred-library";
test("the library is well formed", () => expect(libraryProblems(KINDRED_LIBRARY)).toEqual([]));
test("about 64 people across exactly the five categories", () => {
  expect(KINDRED_LIBRARY.length).toBeGreaterThanOrEqual(60); // 不设上限
  expect(new Set(KINDRED_LIBRARY.map((p) => p.category))).toEqual(new Set(KINDRED_CATEGORIES));
});
```

**做法**：

- 每人 2–3 条名言，**出处优先**：维基语录条目里「有出处」（Sourced）部分列出的原始作品，或维基文库 / 原始文献页；中文页一律用 `/zh-hans/` 变体地址（如 `https://zh.wikisource.org/zh-hans/論語/學而`），否则页面是繁体，比对必失败。`sourceUrl` 指向**能看到原文的那一页**，不是人物总页（总页常常只列「未核实」部分）。
- 「Misattributed / 误传」「Disputed / 有争议」部分里的句子一律不收。
- 中文原文（含文言）不写 `translation`；其他语言写本应用自己的中文译文。
- 在世者：只收有年份的公开讲话、访谈、著作（如股东信、毕业演讲、出版的书）。

**跑**：`pnpm vitest run packages/core/src/kindred.test.ts` → 通过。

> 建议提交点：「名人库：64 位、五类，每条名言带原文、译文与出处」。

---

## 阶段 3：入库核对（联网脚本，结果随代码提交）

### 任务 3.1：每条名言都必须有一致的核对记录

**文件**
- 新建 `packages/core/src/kindred-verification.json`（先放 `[]`）
- 修改 `packages/core/src/kindred.test.ts`

**先写失败的测试**：

```ts
import { createHash } from "node:crypto";
import verification from "./kindred-verification.json";
const hash = (text: string) => createHash("sha256").update(normalizedQuote(text)).digest("hex");
test.each(KINDRED_LIBRARY.flatMap((p) => p.quotes))("$id was found on its source page", (quote) => {
  const record = verification.find((item) => item.quoteId === quote.id);
  expect(record, "run scripts/kindred-verify.ts").toMatchObject({ ok: true, url: quote.sourceUrl, quoteSha256: hash(quote.original) });
});
```

`normalizedQuote` 是任务 1.2 的归一化，从 `kindred.ts` 导出。改了原文或出处地址，哈希或地址对不上，测试就提醒重新核对。

**跑**：`pnpm vitest run packages/core/src/kindred.test.ts` → 失败（记录为空）。这是预期的，任务 3.2 让它通过。

### 任务 3.2：核对脚本 〔联网〕

**文件**：新建 `scripts/kindred-verify.ts`

**做法**：

- 相对导入：`../packages/core/src/kindred-library`、`../packages/core/src/kindred`、`../apps/worker/src/safe-fetch`（`safeGet`、`defaultSafeGetDeps`、`htmlToText`）。
- 按 `sourceUrl` 去重后逐页取：`safeGet(url, defaultSafeGetDeps(), { maxBytes: 8_000_000, timeoutMs: 30_000 })`，同时最多 2 页，页与页之间间隔 1 秒（对维基站点礼貌）。`safeGet` 已在每一跳做公网主机检查、类型与大小上限。
- 对每条名言：`quoteAppearsIn(original, htmlToText(page))`；同时检查 `translation` 若原样出现在页面上就打印警告（译文必须是本应用自己的）。
- 写 `packages/core/src/kindred-verification.json`：`[{ quoteId, url, finalUrl, ok, reason?, quoteSha256, pageSha256, checkedAt }]`，按 `quoteId` 排序，便于看 diff。
- 参数：`--only <personId>` 只核对一人并合并进现有文件。有任何失败时打印失败清单并以非零退出。

**跑**：`pnpm exec tsx scripts/kindred-verify.ts`

**预期**：第一次通常有若干条失败（页面是繁体、句子在「未核实」部分、标点版本不同）。逐条修：换出处页、换名言或换人（用任务 2.1 的备选），再 `--only` 重跑，直到退出码为 0。然后 `pnpm vitest run packages/core/src/kindred.test.ts` → 通过。

### 任务 3.3：人工抽查 〔本人操作，可选〕

脚本只能证明「这句话在这页上」，不能证明这页本身没有张冠李戴。从每类随机抽 3 条，把出处链接给本人看一眼。

> 建议提交点：「名人库：入库核对脚本与核对结果（运行时不联网）」。

---

## 阶段 4：挑选调用

### 任务 4.1：Skill 目录、档位与必需清单

**文件**
- 新建 `skills/marketplace/plugins/crossline/skills/crossline-kindred-picker/SKILL.md`
- 修改 `packages/codex/src/model-policy.ts`（`SKILL_TIERS` 加 `"crossline-kindred-picker": "low"`）
- 修改 `apps/worker/src/required-skills.ts`（加 `"crossline:crossline-kindred-picker"`）
- 修改 `packages/codex/src/model-policy.test.ts`（第一条测试加一行断言它是 `low`）

**先写失败的测试**：`model-policy.test.ts` 断言 `tierForSkill("crossline-kindred-picker") === "low"`；已有的「every routed Skill actually has a skill directory」与 `apps/worker/src/required-skills.test.ts` 会在目录缺失时失败。

**SKILL.md 要点**（照 `crossline-goal-splitter/SKILL.md` 的结构，结尾带所有 SKILL.md 共有的「Language」一节）：

- 输入 `{version: "crossline.kindred.v1", portrait, library}`；输出 `{personId, quoteId, why}`，只能从 `library` 里选。
- 依据是画像整体的思维方式与价值取向（`compass`、`problem`、`energy`、`gap`、`type`），不是职业或主线的字面相同：不要因为对方做芯片就选做芯片的人。
- 名言选这个人的库内名言里与画像最贴合的一条。
- `why` 一句话、≤ 80 字、第三人称，说清是画像里的哪一点与这位相近；不写「你就是」「某某再世」，不评价名人本人。

**跑**：`pnpm vitest run packages/codex/src/model-policy.test.ts apps/worker/src/required-skills.test.ts` → 通过。

### 任务 4.2：挑选器

**文件**
- 新建 `apps/worker/src/kindred-picker.ts`
- 新建 `apps/worker/src/kindred-picker.test.ts`
- 修改 `packages/core/src/settings-keys.ts`（`PORTRAIT_KINDRED = "portrait.kindred"`）

**先写失败的测试**（用 `apps/worker/src/testing/fake-runtime.ts` 的 `fakeRuntime`，照 `diligence.test.ts` 的写法）：

1. 有 `portrait.report`（version 3）时，合法回答被存为 `portrait.kindred = { reportVersion: 3, personId, quoteId, why, at }`，并追加一条 `portrait.kindred_picked` 事件。
2. 回答库外的人：经修复轮次后仍不合法 → 返回 `{ state: "blocked" }`，不写设置，追加 `portrait.kindred_blocked`（payload 带 `reportVersion`）。
3. **隐私**：设置里有 `portrait.character.prefs`（P-D 的表单答案）时，发给模型的 prompt 里不含它的任何值；报告的 `character` 字段与 `sensitive` 列表也不进上下文。
4. 没有报告 → `{ state: "skipped" }`，不调用模型。

**实现要点**：

- 照 `apps/worker/src/goal-splitter.ts` 的形状：`createKindredPicker(store, workspaceId, cwd, getClient)` 返回 `async () => …`；`runCodexSkill` 带 `outputSchema: KINDRED_PICK_SCHEMA`、`validateOutput: (o) => validateKindredPick(o, KINDRED_LIBRARY)`，不给 `softAccept`（库外的人不能「将就保留」），`timeoutMs: 20 * 60_000`。
- 上下文里的 `library` 只给 `{id, category, name, nameOriginal, era, field, intro, quotes: [{id, original, translation}]}`，不给出处地址。
- 位置偏差：库的顺序按 `workspaceId + reportVersion` 做确定性洗牌后再发，避免模型总挑列表前面的人（同一版本重跑结果可复现）。
- 写入前再读一次 `portrait.report`：模型跑的时候报告若已换版本，就丢弃这次结果（`reportVersion` 对不上）。

**跑**：`pnpm vitest run apps/worker/src/kindred-picker.test.ts` → 通过。

### 任务 4.3：接到画像写完之后，并加 tick 兜底

**文件**
- 修改 `apps/worker/src/index.ts`（`writePortrait` 处理函数，约第 759–772 行；tick 里每工作区的循环，约第 318–329 行）
- 修改 `apps/worker/src/kindred-picker.ts`、`kindred-picker.test.ts`

**先写失败的测试**（`kindred-picker.test.ts`）：`kindredDue(store, workspaceId)`——有报告且 `portrait.kindred.reportVersion` ≠ 报告版本、且这一版本没有 `portrait.kindred_blocked` 时为真；挑过或这一版已失败过时为假（失败不在每个 tick 重试，下一版报告再试）。

**实现要点**：

- `writePortrait` 在 writer 成功的分支里，与 `createPortraitIllustrator(...)` 并列 `void createKindredPicker(...)().catch(() => undefined)`。
- tick：在每工作区循环里（`getNightly` 之后）若 `kindredDue` 且 `spendAllows(await spendFor(workspaceId), "discretionary")` 就跑一次，不挡 tick（`void`）。这一条同时覆盖「P-E 上线时已有的旧报告」和「P-C 自动重写之后」，不另写回填脚本。

**跑**：`pnpm vitest run apps/worker/src/kindred-picker.test.ts`；`pnpm --filter @crossline/worker typecheck` → 通过。

### 任务 4.4：真实跑一次 〔真实 Codex，低档，约 1 分钟〕

**文件**：新建 `scripts/kindred-pick-check.ts`

**做法**：把真实账本复制到临时目录（照 `scripts/artifact-plan-replay.ts` 复制账本副本的做法，绝不写真实账本），对有 `portrait.report` 的工作区跑 `createKindredPicker`，打印 `{name, quote, why, repairs}`。

**跑**：`pnpm exec tsx scripts/kindred-pick-check.ts`

**预期**：状态为 picked；名人与名言都在库内；`why` 是第三人称的一句话。结果给本人看一眼是否合理。

> 建议提交点：「名人库：画像写完后由小模型挑选思想相近的人与名言」。

---

## 阶段 5：展示

### 任务 5.1：页面数据

**文件**
- 修改 `apps/web/lib/portrait.ts`（`PortraitState` 加 `kindred`）
- 修改 `packages/core/src/portrait.ts`（把 `redactPortrait` 里的 `hide` 提成导出的 `redactText(text, spans)`，`redactPortrait` 改为调用它；行为不变）
- 新建 `apps/web/lib/portrait.test.ts`（若已存在则修改）

**先写失败的测试**：

- 设置里有 `portrait.kindred` 且 `reportVersion` 等于当前报告版本 → `loadPortrait(ctx).kindred` 为 `{ person, quote, why }`（从库解析，不是存的文本）；版本不等 → `null`（报告重写后、新的挑选回来前，不显示旧版本的挑选）。
- 库里已删掉的 id → `null`，不抛错。
- `packages/core/src/portrait.test.ts`：`redactText` 与原 `redactPortrait` 对同一段文字结果相同。

**跑**：`pnpm vitest run apps/web/lib/portrait.test.ts packages/core/src/portrait.test.ts` → 通过。

### 任务 5.2：展示块组件

**文件**
- 新建 `apps/web/app/portrait/kindred-block.tsx`
- 新建 `apps/web/app/portrait/kindred-block.test.tsx`
- 修改 `apps/web/app/portrait/portrait.css`

**先写失败的测试**（`renderToStaticMarkup`，照 `apps/web/app/settings/quota-card.test.tsx`）：

1. 标题「思想相近」；一行「姓名 · 年代 · 领域」。
2. 名言块：原文在一个斜体元素里且带 `lang`（如 `lang="la"`）；下一行「译文：…」；署名「— 塞涅卡 · Epistulae morales ad Lucilium 1（约 65）」。
3. 中文原文的名言没有「译文」一行。
4. `withWhy={false}` 时 HTML 里没有 `why` 文本；`withWhy` 时有，且包在 `.gen`（模型写的文字，按 `docs/copy-style.md` 用微软雅黑）里，前缀「为什么是这位：」（不分性别代词）。
5. 不含任何 `<img>`（不放名人肖像）。

**实现要点**：`<section className="pt-kindred">` 内用 `<blockquote>`、`<i>` 和 `<cite>`；斜体只用 `font-style: italic`，字体继承系统 Arial（名言与译文出自库，不是模型文字，所以不加 `.gen`）。颜色用现有变量，保证 `e2e/design-audit.spec.ts` 的 7:1 对比度和 ≥ 12px。

**跑**：`pnpm vitest run apps/web/app/portrait/kindred-block.test.tsx` → 通过。

### 任务 5.3：插进分享卡与长图

**文件**
- 修改 `apps/web/app/portrait/portrait-view.tsx`（或 P-C 落地后的新版式文件）
- 新建 `apps/web/app/portrait/portrait-view.test.tsx`

**先写失败的测试**：用一个带 `kindred` 的 `PortraitState` 渲染 `PortraitView`：

- `.pt-card`（分享卡）里有名言原文，**没有** `why`；
- `.pt-shared-half`（长图，从脱敏报告渲染）里有名言原文和 `why`，且 `why` 里命中 `report.sensitive` 的片段被换成「▇」（用 `redactText`）；
- 没有 `kindred` 时两处都没有这一块，其余不变。

**实现要点**：分享卡里 `<KindredBlock withWhy={false} />` 单独一块，放在标签之后、页脚之前，不与类型名、百分比混排；`SharePart` 末尾放 `<KindredBlock withWhy />`（`SharePart` 同时用于页面上半部与离屏长图，所以页面上也能看到 `why`，这符合「只在长图里显示」的本意：只是不进分享卡）。分享卡固定 1080×1350，若加块后溢出，缩小块内字号下限仍 ≥ 12px（换算到导出像素），必要时只截断 `intro`，不截名言。

**跑**：`pnpm vitest run apps/web/app/portrait/` → 通过；`pnpm exec playwright test e2e/design-audit.spec.ts` → `/portrait` 页不新增违规（没有画像时这一块不出现，审查不受影响；有画像的视觉检查见 P-C）。

### 任务 5.4：文档同步

**文件**：`CLAUDE.md`（「The portrait report」那一段末尾加一句：名人库在 `packages/core/src/kindred-library.ts`，入库核对 `scripts/kindred-verify.ts`、结果 `kindred-verification.json` 只被测试读、运行时不联网，挑选 Skill `crossline-kindred-picker` 低档、输入不含 `portrait.character.prefs`，`why` 不进分享卡）。

**跑**：`pnpm verify` → typecheck、test、build、e2e 全绿。

> 建议提交点：「名人库：分享卡与长图展示思想相近的名人与名言」。

---

## 验收（对应 §7 跑通标准与 §7「思想相近的名人」条目）

| 跑通标准 / 决定 | 怎样证明 |
|---|---|
| 名人库约 64 位、五类、收在世者只引公开言论 | `kindred.test.ts`：`libraryProblems` 为空、≥ 60 人、恰好五类、在世者的名言带年份 |
| 每条名言存原文、译文（标注为本应用翻译）、出处与年份 | 同上的结构检查；`kindred-block.test.tsx` 断言「译文：」标注 |
| 名言防伪：入库时用 `safeGet` 核对出处页确有原文，结果随代码提交，运行时不联网 | `scripts/kindred-verify.ts` 退出码 0；`kindred.test.ts` 逐条比对 `kindred-verification.json` 的哈希与地址；挑选与展示路径不导入任何取网的模块 |
| 挑选在画像 writer 之后、小模型、输入为完整画像（不含定制形象的答案）、输出 `{personId, quoteId, why}`、校验器拒绝库外 | `kindred-picker.test.ts` 四条；`model-policy.test.ts` 断言低档；`KINDRED_PICK_SCHEMA` 过 `structured-output.test.ts` |
| 「名人与名言都来自名人库，名言以斜体显示原文、译文和署名」 | `kindred-block.test.tsx`、`portrait-view.test.tsx` |
| `why` 只在长图、不进分享卡；措辞「思想相近」；不放肖像 | `portrait-view.test.tsx`、`kindred-block.test.tsx` |
| 分享卡里「名人一栏」与 P-C 的分享卡内容检查一致 | 后合并的一方更新 P-C 的分享卡内容测试 |

## 风险

- **维基页面本身的张冠李戴**：脚本只证明句子在页上。缓解：只用「有出处」部分与原始文献页、不收「误传 / 有争议」部分、任务 3.3 人工抽查。
- **繁简与版本差异**导致大量核对失败：中文页一律用 `/zh-hans/` 变体；古籍用维基文库原文页。失败就换出处，不放宽比对规则。
- **在世者**：只收有年份的公开言论；被投诉或本人不想要的，直接从库里删（数据驱动，删一条就是改一行）。
- **翻译版权**：译文自己写；脚本对「译文原样出现在出处页」报警。
- **挑选偏向名人中的名人**（乔布斯、爱因斯坦）：顺序确定性洗牌；SKILL.md 写明不按字面职业匹配。上线后若分布明显偏，再看，不预先做统计。
- **与 P-C 的版式冲突**：展示块是独立组件；插入点由后合并的一方调整。分享卡固定尺寸可能放不下，按任务 5.3 的规则缩排，不截名言。
- **报告重写后短暂没有名人一栏**：新挑选回来前显示 `null`，这是有意的（避免旧挑选配新报告）；低档调用约 1 分钟。

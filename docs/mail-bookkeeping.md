# 邮件记账：分类、去重与正确入账（设计稿，2026-10-28）

起因：本人账号上，一封 PayPal「Your $61.00 USD request expired」被记成了 61 USD 支出。一封收款请求失效的邮件，钱根本没有动。查代码后发现问题不止这一处：同一笔钱会被重复记账，退款被当成收入，预授权也被记账。本文先写调研，再写现状的缺陷，然后给出完整设计、改动清单和测试用例。**本稿尚未实现。**

## 1. 调研

### 1.1 Meta Muse 怎么记账

公开资料（Meta 官网、TechCrunch、Yahoo Finance、CNBC、日本用户的使用记录）能确认的部分：

- **账本的主来源是银行连接，不是邮件。** Meta 的 Muse for Finance 页写的是通过 Plaid 连接银行账户，然后展示消费模式、设预算、按常买的东西建议削减。
- **邮件用来做补充和审计。** Muse 会扫描邮件找周期性扣费，找出没在用的订阅，再在本人批准后取消。一次上手测试中，它从连接的账户和邮件收据里列出了十几个 AI 工具订阅。有报道说 Muse「可能」改读邮件里的银行和信用卡对账单，但这一点未经证实。
- **审计重复扣费。** Yahoo Finance 称它能检查账单里的重复扣费和错误。这是能力声明，没有公开的测试结果。
- **花钱、取消、发邮件之前先问本人。** 敏感动作都要本人批准，自动的只是读和整理。
- **日本版和 Money Forward ME 合作。** 有用户让它把 126 条未分类的明细重新分类，又让它从约 48 万封邮件里列出了 99 个账户和服务。
- **没有找到它如何把邮件解析成账本条目的公开说明**：去重、退款、预授权都没有公开细节，财务顾问也普遍建议先别给它账户权限。

对我们的启示：Muse 的账本以银行流水为准，邮件只负责补充商户和明细、发现订阅。Crossline 没有接银行（Plaid 属于没决定过的外部接入），邮件就是主来源。因此我们必须比 Muse 更保守：**只把明确是「钱已经动了」的邮件记账，其余一律只提醒。**

### 1.2 别人怎么去重、怎么对账

- **Plaid 的待入账和已入账。** 一笔交易先是 pending，入账后成为新的 posted 交易，并带上 `pending_transaction_id` 指向原来那条；pending 那条被移除。两者金额可以不同：餐馆的预授权不含小费；加油站、酒店、租车的预授权可能永远不入账，直接消失。有的银行（Capital One、USAA）不给 pending。匹配不上时用账户、金额、商户、日期做兜底，但弱匹配不能悄悄合并，要有置信度门槛，并且可撤销。
- **Paper-Trail（开源收据追踪）的去重设计：**
  - 先按 RFC 5322 `Message-ID` 或正文指纹折叠完全相同的邮件，覆盖转发、重发、多邮箱同一封；同一收件箱里两封一模一样的收据不折叠，因为可能真买了两次。
  - 再给候选对打分：同一订单号、同一商户、金额、日期差、明细重合。≥60 分自动合并，35–59 分标为「可能重复」交给人看，其余分开。
  - 硬约束一票否决：同一商户两封订单确认、订单号不同；同金额、相隔 ≥20 天的周期扣费；商户或币种不同；退款大于原单；事件早于下单。
  - 发货和送达邮件 30 天内挂到原单，退款和取消 90 天内挂到原单，它们自己永远不生成一笔消费。
  - 必须不合并的用例：同一天买两杯一样的咖啡；按月订阅；同一商户金额相同但订单号不同的两单。
- **Copilot Money 和 Monarch 的亚马逊订单匹配。**
  - Copilot 要求订单金额与交易金额相等、日期相差在 2 天内。
  - 亚马逊在发货时才扣款，所以交易日可能晚于下单日。
  - Monarch 按商户、金额、大致日期匹配。
  - Monarch 有一条教训：自动拆分会覆盖本人手动改过的分类。我们的规则是本人改过的永不覆盖。

## 2. 现状与缺陷

邮件记账的入口在 `apps/worker/src/mailbox.ts` `triageMail`，有两条路：

1. **提醒路**：分拣结果是 `todo`、标题是核实或查看类时，取主题加开头里的第一个金额，用 `moneyDirection` 正则判断收支，直接记账。
2. **交易路**：分拣结果是 `transaction`，并且主题加开头里有和模型读出的数字相同的金额时记账。

两条路的去重键都是 `mail:<邮箱>:<uidValidity>:<uid>`。

| # | 缺陷 | 本人账号上的实例或必然发生的情形 |
|---|---|---|
| D1 | 提醒路见到金额就记账，不管邮件说的是不是一笔已经发生的交易 | PayPal「request expired」61 USD；「无卡交易提醒」「余额提醒」「信用额度」「最低还款额」里的数字都会被记 |
| D2 | 去重只认同一邮箱的同一封邮件 | 同一封邮件转发到第二个已连接的邮箱会记两次；一次消费常有商户收据、PayPal 收据、银行提醒三封，会记三次 |
| D3 | `moneyDirection` 把退款当成收入 | 退款抬高了收入，储蓄率被算高；正确做法是冲减原来那类支出 |
| D4 | 预授权、待入账被记账 | 加油站和酒店的预授权会记账，可能永远不入账；正式扣款到来后又记一次 |
| D5 | 自己账户间的转账被记成收支 | 信用卡还款、给钱包充值、储蓄转出，同一笔钱一出一进被各记一次 |
| D6 | 金额只核对「主题加前 300 字」里有没有这个数，不核对它的角色 | 邮件里同时有小计、税、合计、余额时，模型选中余额也能通过核对 |
| D7 | 交易日取邮件日期 | 对账单、周末交易、亚马逊发货扣款的日期都会偏 |
| D8 | 铃铛里发件人显示坏了 | 「service@paypal.com <service@paypal.com」：`addressText` 在名称就是地址时也写成「名称 <地址>」；铃铛的 `plain` 把所有 `>` 当 Markdown 删掉 |
| D9 | 作废无法联动 | 「付款失败」「已取消」「已撤销」的邮件不会去作废之前那条记录 |

## 3. 设计原则

1. **记的必须是钱已经动了的事。** 预授权、请求、账单、提醒、失败都不记。
2. **一笔真实交易只有一条记录。** 每封邮件、每条手机通知都只是它的一份证据，挂在记录下面。
3. **模型只做分类和定位，数字由代码核对。** 金额、订单号、卡号末四位都必须在邮件原文里出现，并且出现在相应的字段旁边。
4. **合并要保守，可以撤销。** 确定的才自动合并；拿不准的保留两条，攒成一张卡问本人「这两笔是同一笔吗」。宁可多问一次，也不悄悄删钱。
5. **本人写的或改过的永远优先。** 分类、备注、金额，本人改过就不被后来的证据覆盖。
6. **全自动、不让本人上传任何东西**（本人 2026-10-27 的要求）。本人只在拿不准时回答一个问题。

## 4. 设计

### 4.1 一封钱的邮件是哪种事件

分拣 Skill 的 `transaction` 字段扩成 `money`，`event` 取以下封闭枚举，由模型判断：

| event | 例子 | 记账 |
|---|---|---|
| `charge` | 银行或卡的消费提醒、「您已支付」、PayPal「You sent a payment」 | 记一笔支出 |
| `receipt` | 商户订单确认、电子收据 | 记一笔支出（会和 `charge` 合并） |
| `refund` | 退款到账、部分退款 | 记一笔退款，冲减原支出 |
| `income` | 工资、他人转来、收款到账 | 记一笔收入 |
| `authorization` | 预授权、pending、hold | 不记；入账时由 `charge` 记 |
| `own_transfer` | 信用卡还款、充值、账户间转账 | 不记 |
| `statement` | 月结单、账单金额、最低还款、到期提醒 | 不记；可以提醒 |
| `request` | 付款请求、收款请求，含发出、收到、过期、取消 | 不记 |
| `failed` | 支付失败、被拒、已取消、已撤销、已过期 | 不记；若能对上已记的那笔，就作废它 |
| `alert` | 登录、安全、余额、额度变化 | 不记 |
| `upcoming` | 订阅即将续费、试用即将结束 | 不记；提醒 |

模型同时读出以下字段，每一个都由代码在**原文**里核对：

- `amount` 与 `amountLabel`：`amountLabel` 是金额旁边的字样，如 Total、合计、实付、Amount paid。
- `currency`。
- `merchant`。
- `occurredOn`：邮件里写的交易日期，没写就留空。
- `refs`：订单号、交易号、发票号，原样照抄。
- `last4`：卡号或账户末四位。
- `instrument`：`card`、`paypal`、`alipay`、`wechat`、`bank`、`apple`、`google` 或空。

### 4.2 代码的把关（`moneyEventFromMail`，在 core，纯函数）

1. **事件门。** 只有 `charge`、`receipt`、`refund`、`income` 能记账。提醒路不再自己记账；它直接复用同一个判断，标题是「核实…」的邮件只要事件属于这四种也照常记。
2. **否决词，只降级不升级。** 主题或金额所在那一行出现以下词时，可记账的事件被降为 `info`，并记录 `mail.money_vetoed`：
   - 英文：`request`、`expired`、`declined`、`failed`、`cancel`、`reversed`、`pending`、`authorization`、`hold`、`statement`、`minimum`、`balance`、`limit`、`due`、`upcoming`、`will be charged`、`trial`。
   - 中文：请求、过期、失效、失败、被拒、取消、撤销、冲正、预授权、冻结、待入账、账单、最低还款、余额、额度、到期、即将扣费、试用。
   - 例外：「refund」「退款」本身就是 `refund`，不被「取消」否决。

   这一层正好拦下 PayPal 那封邮件：它的 event 无论被模型判成什么，主题里的「request expired」都会否决记账。
3. **金额核对，看位置。**
   - 读取范围从「主题加前 300 字」扩到正文前 8000 字。IMAP 已经取了 48 KB，只是现在截断得太早。
   - 金额必须在原文里出现，并且同一行或前后 40 字内有 `amountLabel`，或者是主题里唯一的金额。
   - 有多个候选时，按 合计 / Total / 实付 / Amount charged 优先，小计、税、运费、余额、额度排除。核对不过就不记账，记为 `info`。
4. **订单号和末四位必须在原文里逐字出现。** 出现不了就丢掉该字段，不影响其余部分。
5. **日期。** `occurredOn` 只有当原文里有这一天、并且在邮件日期的前 10 天到后 1 天之间时才采用，否则用邮件日期。
6. **币种。** 先用符号或代码判断；`$` 再看发件域名，比如 `.ca`、`.hk`。判断不了的留空，由账本按本人主币显示，并标出「币种未确认」。

### 4.3 去重分三层

**第 0 层：同一封邮件。** 键是 `Message-ID` 规范化（去尖括号、转小写）后的哈希；没有 `Message-ID` 时，用「发件地址 + 主题 + 日期到分钟 + 正文前 2 KB」的哈希。

- 同一封邮件转发到第二个邮箱、或被服务商重发，只处理一次，也只调一次模型。
- 不同的 `Message-ID` 在这一层永不合并：两封内容相同但 ID 不同的收据，交给第 1 层判断。

**第 1 层：同一笔交易的多封证据。** 新表 `record_evidence`，一条证据一行；`domain_records` 只保存真实交易。新证据到来时，在同一工作区、同币种、前后 10 天内的已记记录里找匹配，打分如下：

| 信号 | 分 |
|---|---|
| 规范化后的订单号或交易号相同（去前缀、空格、`#`、前导零） | +70 |
| 商户键相同（见下文） | +20 |
| 金额完全相同 | +25 |
| 末四位相同 | +15；不同则一票否决 |
| 日期差 0–1 天 / 2–3 天 / 4–7 天 | +15 / +8 / +3 |
| 两条证据角色不同（一条 `receipt`、一条 `charge`，或一条商户、一条银行或钱包） | +10 |

商户键的取法：

- 小写化，去掉支付中介前缀（`PAYPAL *`、`SQ *`、`TST*`、`APPLE.COM/BILL`、`GOOGLE *`、`支付宝-`、`财付通-`）。
- 去掉城市、门店号、`INC`、`LLC`。
- 再查一张小别名表：`amazon.*`、`amzn` 都是 `amazon`。
- 发件域名作为备选键。

处理规则：

- **≥ 70 分**：作为证据挂到已有记录上，不新增记录，标明「由 N 封邮件合并」。
- **40–69 分**：新建记录，并标 `possibleDuplicateOf`。这类记录不计入汇总，攒成每周一张折叠卡「这几笔可能重复」，选项为「是同一笔（合并）」和「是两笔」。本人一周没答，就按「是两笔」计入。
- **< 40 分**：新建记录。

**硬约束（一票否决合并）：**

- 同一发件人、同一角色（例如都是 `charge`）、`Message-ID` 不同：必定是两次交易，例如同一天两杯咖啡、两笔一样的打车。
- 订单号都存在但不同。
- 同金额、同商户，相隔 ≥ 20 天：这是周期扣费。
- 末四位不同；币种不同。

**第 2 层：生命周期。**

- `authorization` 从不记账。之后来了 `charge` 就按 `charge` 记，金额可能因小费等原因不同，以 `charge` 为准。
- `refund` 按订单号匹配，或按商户键在 90 天内匹配原支出：
  - 写入一条 `refund` 记录，`refund_of` 指向原支出，分类沿用原支出。
  - 汇总时从支出里减掉，不计入收入。
  - 退款金额大于原支出时不挂靠，单独记录并在卡片上提示。
  - 找不到原支出时也单独记一条 `refund`，冲减当月支出。
- `failed` 能按订单号或强匹配（≥ 70）对上已记的那笔时，作废那笔：软删除，写 `void_reason`，可撤销，并说一句「「X」付款未成功，已撤回这笔记账」。对不上就什么都不做。
- `own_transfer` 不记账。如果它反向对上一条已记的收支（例如充值被记成了支出），由修复任务降为作废。

**跨来源。** 手机通知、钱包快捷指令、截图、输入框的记录也走同一个匹配器。第 1 层把它们当作另一种角色：
- 一笔消费常有「银行邮件 + 手机通知」两份证据，也只记一条。
- 本人从输入框记的那条优先：它的分类和备注保留，之后来的证据只挂靠，不改字段。

### 4.4 数据结构（迁移 22）

- **`domain_records` 新增列：**
  - `status`：`booked` 或 `pending_review`。
  - `possible_dup_of`、`refund_of`。
  - `edited_by_person`：本人改过的字段名列表，JSON。
  - `void_reason`，与现有的 `deleted_at` 配合使用。
- **`RECORD_KINDS.wealth` 增加 `refund`。**
- **新表 `record_evidence`：**
  - 列：`workspace_id`、`id`、`record_id`、`source`（mail / phone / input / photo / wallet）、`source_key`（UNIQUE：Message-ID 哈希或通知 id）、`role`、`event`、`amount`、`currency`、`merchant_key`、`refs`（JSON）、`last4`、`occurred_on`、`mailbox_id`、`created_at`。
  - 只存这些字段，不存邮件正文。
- **兼容旧数据。** `dedupe_key` 保留，旧记录照旧读取。新写入的 `dedupe_key` 为 `txn:<首条证据的 source_key>`；同一封邮件被再次处理时，靠 `record_evidence.source_key` 的唯一约束拦住。
- 账本快照和恢复要带上新表，`purgeWorkspace` 会自动按 `workspace_id` 清理它。

### 4.5 汇总怎么算（`recordMetrics`、`recordTrends`）

- **支出** = `expense` 之和 − `refund` 之和，并按分类冲减。
- **收入**只算 `income`。
- `pending_review` 和已作废的记录都不计入。
- 储蓄率按新的收入和支出计算。

### 4.6 本人看到什么

- **记账成功**：提醒里写「记了一笔：Costco 86.40 USD（Visa ••1234），由收据和银行提醒两封邮件合并」。合并时只更新原提醒，不再发新提醒。
- **不记账**：只有邮件本来就值得提醒时才提醒，例如「PayPal：61 美元的收款请求已过期，没有记账」。记录的来源说明只写一次。
- **作废**：「「X」付款未成功，已撤回这笔记账。」附撤销按钮。
- **可能重复**：每周一张折叠卡，用 `items` 列出成对的条目：日期、商户、金额、各自的来源。
- **主线卡的记录列表**：每条显示「N 份证据」，展开后看来源。有「拆开」（误合并时把证据拆成新记录）、「合并到…」和「删除」，都可撤销。
- **发件人显示（D8）**：
  - 提醒里只写名称；名称为空或名称就是地址时只写地址。
  - `addressText` 在名称等于地址时不再重复。
  - 铃铛的 `plain` 只删行首的 `>` 引用符，不删正文里的 `>`。

### 4.7 修复已有数据（`repair.mail-records.v1`，一次性，可撤销）

- **重判旧记录。** 对 `source = mail` 的旧记录，从 `mail.log` 取回发件人和主题，重新跑 4.2 的事件门和否决词：
  - 否决的作废，例如 PayPal 那 61 USD。
  - 退款被记成收入的，改为 `refund`。
- **合并旧记录。** 对剩下的记录做第 0、1 层合并。旧记录只有 `sourceRef = 邮箱:uid` 可用，所以只做 ≥ 70 分的合并，不新开「可能重复」卡。
- **通知本人。** 发一条消息「整理了邮件记账：撤回 N 笔不是交易的、合并 M 笔重复的」，附撤销。

### 4.8 改动清单

| 位置 | 改动 |
|---|---|
| `packages/core/src/mail.ts` | `MAIL_TRIAGE_SCHEMA` 的交易字段改为 `money {event, amount, amountLabel, currency, merchant, occurredOn, refs, last4, instrument}`；`validateMailTriage` 随之修改；删除 `moneyDirection` |
| `packages/core/src/money-events.ts`（新） | `moneyEventFromMail`（事件门、否决词、金额定位、字段核对）；`merchantKey`；`matchScore` 与硬约束；全部为纯函数 |
| `packages/core/src/records.ts` | 新增 kind `refund`；汇总冲减；`amountsInText` 返回位置，供金额定位使用 |
| `packages/db/src/records.ts` | `recordMoneyEvidence`：先查证据，再匹配，然后挂靠、新建、标可能重复或作废，放在一个事务里；`recordAndJudge` 只在新增或作废时重判里程碑 |
| `packages/db/src/index.ts` | 迁移 22；快照与恢复 |
| `apps/worker/src/mailbox.ts` | 两条记账路合并成一条；用 `Message-ID` 做第 0 层折叠；正文改读前 8000 字（只用于核对，不进模型输入）；改提醒文案 |
| `apps/web/app/api/records/route.ts`、手机通知 | 改走 `recordMoneyEvidence` |
| `apps/web/lib/asks.ts` | 每周的「可能重复」折叠卡，回答后合并或分开 |
| `packages/connectors/src/imap-mail.ts`、`apps/web/lib/notices.ts` | D8 |
| `skills/.../crossline-mail-triage/SKILL.md` | 写明事件表和每类的例子，包括 PayPal 请求过期、预授权、信用卡还款、退款 |
| `apps/worker/src/mail-records-repair.ts`（新） | 4.7 |
| `packages/i18n/locales/en/*.json` | 新文案的英文 |
| 文档 | 本文；`docs/domain-lines.md` 的来源表指向本文；CLAUDE.md 记账一节 |

### 4.9 测试用例

每个用例都在 `apps/worker/src/testing/fixtures/` 留一封脱敏邮件：

1. PayPal「Your $61.00 USD request expired」，不记账。
2. PayPal「You sent a payment of $61.00 to X」，记账。
3. 星巴克同一天两封收据，金额相同、`Message-ID` 不同，记两笔。
4. 亚马逊订单确认（10/20）、发货（10/22）、银行消费提醒（10/22，同金额），记一笔，挂三份证据。
5. 同一封邮件出现在 Gmail 和学校邮箱两个邮箱，记一笔，只调一次模型。
6. 加油站预授权 $1 和随后的消费 $48.20，记一笔 48.20。
7. 餐馆预授权 $40 和入账 $47 含小费，记一笔 47。
8. 信用卡还款「Payment received, thank you」，不记账。
9. 月结单「Statement balance $1,234.56, minimum due $35」，不记账。
10. 部分退款 $20，原单 $80 同订单号：记一条 `refund` 挂到原单，当月支出净增 60。
11. 退款 $100，原单 $80，不挂靠，单独记录并提示。
12. 「付款失败」对上已记的那笔，那笔作废，可以撤销。
13. Netflix 每月 15.99，相隔 30 天，记两笔，不合并。
14. 工资到账，记收入。
15. 支付宝转账给自己的银行卡，不记账。
16. 邮件里同时有「小计 ¥90、运费 ¥10、合计 ¥100、余额 ¥5,000」，记 100。
17. 银行邮件和手机通知是同一笔，记一笔；手机那条先到也一样。
18. 本人在输入框记了「午饭 35」，之后来了银行邮件 35：挂靠，分类保留本人的。
19. 评分落在 40–69 分的一对，产生「可能重复」卡，答「是两笔」后两笔都计入。
20. 修复任务：旧的 PayPal 61 被作废，旧的一对重复被合并，撤销后全部恢复。

## 5. 不做的事

- **不接银行（Plaid 等）。** 这是新的外部接入，需要本人另行决定。邮件、手机通知、钱包已经能覆盖大部分交易。
- **不做汇率换算。** 各币种分开汇总，沿用现状。
- **不做订阅取消、比价、代付。** 本系统没有任何花钱或发信的路径，这一点不变。

## 来源

- [Muse for Finance（Meta）](https://ai.meta.com/muse/finance/)
- [Meta debuts its Muse AI agent（TechCrunch）](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/)
- [Meta's Muse says it can manage your money（Yahoo Finance）](https://finance.yahoo.com/personal-finance/banking/article/metas-muse-says-it-can-manage-your-money-should-you-let-it-141040045.html)
- [$1,887 a Year in Subscriptions: How Meta's Muse Audits Credit Card Statements（Yahoo Finance）](https://finance.yahoo.com/technology/ai/articles/1-887-subscriptions-meta-muse-185427425.html)
- [Meta Muse Explained（MindStudio）](https://www.mindstudio.ai/blog/meta-muse-ai-agent)
- [Muse 两天半重度使用记录（丹治 統，note）](https://note.com/tourutanji/n/ncc7c7538b757?hl=en)
- [Plaid：Transaction states](https://plaid.com/docs/transactions/transactions-data/)
- [Plaid：How Plaid reconciles pending and posted transactions](https://engineering.plaid.com/how-plaid-reconciles-pending-and-posted-transactions-1301b09d1749)
- [Paper-Trail #126：Deduplicate emails about the same purchase](https://github.com/VeneratedApotheosis/Paper-Trail/issues/126)
- [Copilot Money：Amazon integration](https://help.copilot.money/en/articles/5569639-amazon-integration)
- [Monarch：Using the Retail Sync Extension](https://help.monarch.com/hc/en-us/articles/36463599367188-Using-the-Retail-Sync-Extension)

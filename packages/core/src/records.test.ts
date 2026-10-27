import { expect, test } from "vitest";
import { amountsInText, recordMetrics, recordProblem, recordReadings, recordTrends, type DomainRecordInput } from "./records";

const now = new Date("2026-10-20T12:00:00Z");
const base = { at: "2026-10-19", currency: "CNY", unit: "元", category: "", note: "", source: "input", sourceRef: "", dedupeKey: "" } as const;
const record = (over: Partial<DomainRecordInput>): DomainRecordInput => ({ ...base, domain: "wealth", kind: "expense", value: 35, ...over });

test("a record is kept only with a known kind, a real day not in the future, and a value in its range", () => {
  expect(recordProblem(record({}), now)).toBe("");
  expect(recordProblem(record({ kind: "weight" }), now)).toBe("这个领域没有这种记录");
  expect(recordProblem(record({ at: "昨天" }), now)).toBe("日期无法识别");
  expect(recordProblem(record({ at: "2026-11-30" }), now)).toBe("日期在未来");
  expect(recordProblem(record({ value: 0 }), now)).toBe("数值超出合理范围");
  expect(recordProblem(record({ domain: "wellness", kind: "weight", value: 900, currency: "" }), now)).toBe("数值超出合理范围");
  expect(recordProblem(record({ currency: "yuan" }), now)).toBe("币种无法识别");
});

test("this month's income, spending, savings rate and categories; this week's workouts; the latest weight", () => {
  const metrics = recordMetrics([
    record({ kind: "income", value: 12000, at: "2026-10-05" }), record({ value: 3000, category: "房租", at: "2026-10-01" }),
    record({ value: 600, category: "餐饮" }), record({ value: 9999, at: "2026-09-30" }),
    record({ domain: "wellness", kind: "workout", value: 40, at: "2026-10-18" }), record({ domain: "wellness", kind: "workout", value: 30, at: "2026-10-10" }),
    record({ domain: "wellness", kind: "weight", value: 72.4, at: "2026-10-12" }), record({ domain: "wellness", kind: "weight", value: 71.8, at: "2026-10-19" })
  ], "2026-10-20");
  expect(metrics).toMatchObject({ month: "2026-10", currency: "CNY", income: 12000, expense: 3600, savingsRate: 70, workouts: 1, workoutMinutes: 40,
    weight: { value: 71.8, at: "2026-10-19" } });
  expect(metrics.categories).toEqual([{ category: "房租", amount: 3000 }, { category: "餐饮", amount: 600 }]);
});

test("the trend is six months of money, oldest first, and eight Monday-first weeks of exercise with each week's last weight", () => {
  const trends = recordTrends([
    record({ kind: "income", value: 12000, at: "2026-10-05" }), record({ value: 3000, at: "2026-10-01" }), record({ value: 600, at: "2026-10-19" }),
    record({ kind: "income", value: 11000, at: "2026-09-05" }), record({ value: 9999, at: "2026-09-30" }), record({ value: 50, currency: "USD", at: "2026-09-12" }),
    record({ value: 1, at: "2026-04-30" }),
    record({ domain: "wellness", kind: "workout", value: 40, at: "2026-10-18" }), record({ domain: "wellness", kind: "workout", value: 30, at: "2026-10-19" }),
    record({ domain: "wellness", kind: "workout", value: 25, at: "2026-10-06" }),
    record({ domain: "wellness", kind: "weight", value: 72.4, at: "2026-10-12" }), record({ domain: "wellness", kind: "weight", value: 72.0, at: "2026-10-14" }),
    record({ domain: "wellness", kind: "weight", value: 71.8, at: "2026-10-19" })
  ], "2026-10-20");
  expect(trends.currency).toBe("CNY");
  expect(trends.months.map((month) => month.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  // April is outside the six months; the USD record is not summed with the CNY ones.
  expect(trends.months.at(-2)).toEqual({ month: "2026-09", income: 11000, expense: 9999 });
  expect(trends.months.at(-1)).toEqual({ month: "2026-10", income: 12000, expense: 3600 });
  expect(trends.months[0]).toEqual({ month: "2026-05", income: 0, expense: 0 });
  // 2026-10-20 is a Tuesday: the current week starts Monday 10-19, and the one before holds the 10-12/10-14 weights and the 10-18 workout.
  expect(trends.weeks.map((week) => week.start)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
  expect(trends.weeks.at(-1)).toEqual({ start: "2026-10-19", workouts: 1, workoutMinutes: 30, weight: 71.8 });
  expect(trends.weeks.at(-2)).toEqual({ start: "2026-10-12", workouts: 1, workoutMinutes: 40, weight: 72 });
  expect(trends.weeks.at(-3)).toEqual({ start: "2026-10-05", workouts: 1, workoutMinutes: 25, weight: null });
  expect(recordTrends([record({ value: 50, currency: "USD", at: "2026-09-12" })], "2026-10-20", "CNY").months.at(-2)).toEqual({ month: "2026-09", income: 0, expense: 0 });
});

test("records judge only a threshold on a measured quantity; a cadence over weeks is never read from one week", () => {
  const metrics = recordMetrics([record({ kind: "income", value: 10000 }), record({ value: 7000 }),
    record({ domain: "wellness", kind: "weight", value: 69.5 })], "2026-10-20");
  const criterion = (id: string, unit: string, comparator: "gte" | "lte", value: number) =>
    ({ id, statement: "", required: true, evidenceOf: "outcome" as const, measure: { kind: "threshold" as const, unit, comparator, value } });
  expect(recordReadings("wealth", [criterion("rate", "%", "gte", 20), criterion("cap", "元", "lte", 6000)], metrics).map((item) => [item.criterionId, item.met]))
    .toEqual([["rate", "met"], ["cap", "unmet"]]);
  expect(recordReadings("wellness", [criterion("w", "kg", "lte", 70),
    { id: "weeks", statement: "", required: true, evidenceOf: "outcome", measure: { kind: "count", unit: "次/周", atLeast: 3 } }], metrics))
    .toEqual([{ criterionId: "w", met: "met", observed: "记录：最近一次体重 69.5 kg（2026-10-19）" }]);
});

test("the amounts a mail states, in the forms banks and shops write them", () => {
  expect(amountsInText("您尾号 1234 的信用卡消费人民币 35.00 元，商户：星巴克")).toEqual([{ value: 35, currency: "CNY" }]);
  expect(amountsInText("Order total: $1,234.50 (USD 1,234.50)")).toEqual([{ value: 1234.5, currency: "USD" }, { value: 1234.5, currency: "USD" }]);
  expect(amountsInText("支付宝付款 ¥18.80")).toEqual([{ value: 18.8, currency: "CNY" }]);
  expect(amountsInText("您的验证码是 482913")).toEqual([]);
});

test("a payment notification with one amount becomes a record; promotions, codes and two amounts do not", async () => {
  const { recordFromNotification } = await import("./records");
  const note = (title: string, text: string) => ({ id: "n", app: "微信", title, text, at: "2026-10-19T08:00:00+08:00" });
  expect(recordFromNotification(note("微信支付", "向 瑞幸咖啡 支付 ¥18.80"), "2026-10-20")).toMatchObject({ ok: true,
    record: { kind: "expense", value: 18.8, currency: "CNY", at: "2026-10-19" } });
  expect(recordFromNotification(note("工资到账", "您的账户转入人民币 12,000.00 元"), "2026-10-20")).toMatchObject({ ok: true, record: { kind: "income", value: 12000 } });
  expect(recordFromNotification(note("双十一", "满 300 减 50"), "2026-10-20")).toEqual({ ok: false, reason: "不是付款或到账通知" });
  expect(recordFromNotification(note("支付宝", "您的验证码 482913，用于付款"), "2026-10-20")).toEqual({ ok: false, reason: "通知里没有金额" });
  expect(recordFromNotification(note("消费提醒", "消费 ¥30.00，余额 ¥1200.00"), "2026-10-20")).toEqual({ ok: false, reason: "通知里有多个金额" });
});

test("a phone's weight, workouts and energy intake become wellness records, from a shortcut or a Health Auto Export payload", async () => {
  const { healthRecordsFromPhone } = await import("./records");
  expect(healthRecordsFromPhone({ day: "2026-10-19", weightKg: 71.23, kcal: 2100, workouts: [{ id: "w1", start: "2026-10-19T07:00:00Z", minutes: 32, type: "跑步" }] }, "2026-10-20")
    .map((item) => [item.id, item.record.kind, item.record.value, item.record.category])).toEqual([
      ["weight:2026-10-19", "weight", 71.2, "体重"], ["meal:2026-10-19", "meal", 2100, "全天摄入"], ["workout:w1", "workout", 32, "跑步"]]);
  const exported = { data: { metrics: [{ name: "weight_body_mass", units: "lb", data: [{ date: "2026-10-18 07:00:00 +0800", qty: 160 }] }],
    workouts: [{ id: "x", name: "Outdoor Run", start: "2026-10-18 06:30:00 +0800", duration: 1800 }] } };
  expect(healthRecordsFromPhone(exported, "2026-10-20").map((item) => [item.record.kind, item.record.at, item.record.value])).toEqual([
    ["weight", "2026-10-18", 72.6], ["workout", "2026-10-18", 30]]);
  expect(healthRecordsFromPhone({ sleep: [] }, "2026-10-20")).toEqual([]);
});

import { describe, expect, it } from "vitest";
import { EMPTY_MONEY_READING, matchScore, merchantKey, moneyEventFromMail, normalizeRef, senderKeyOf, MERGE_SCORE, POSSIBLE_SCORE, type MoneyReading } from "./money-events";

const read = (over: Partial<MoneyReading>): MoneyReading => ({ ...EMPTY_MONEY_READING, ...over });
const mail = (subject: string, body = "", fromAddress = "service@paypal.com", date = "2026-10-28T00:20:00Z") => ({ subject, body, fromAddress, date });

describe("which money mails are booked", () => {
  it("an expired PayPal request is never booked, whatever event the model gave", () => {
    const subject = "Your $61.00 USD request expired";
    expect(moneyEventFromMail(read({ event: "charge", amount: 61, currency: "USD" }), mail(subject))).toMatchObject({ book: false, reason: "vetoed" });
    expect(moneyEventFromMail(read({ event: "request", amount: 61, currency: "USD" }), mail(subject))).toMatchObject({ book: false, reason: "not_booked" });
  });

  it("a payment sent is booked as an expense with its sender and merchant keys", () => {
    const verdict = moneyEventFromMail(read({ event: "charge", amount: 61, currency: "USD", merchant: "Jane Doe", amountLabel: "You sent" }),
      mail("You sent a payment of $61.00 USD to Jane Doe", "Amount sent $61.00 USD\nTransaction ID 5TY12345AB"));
    expect(verdict).toMatchObject({ book: true, evidence: { kind: "expense", value: 61, currency: "USD", senderKey: "", merchantKey: "janedoe" } });
  });

  it("holds, card payments, statements and alerts are not booked", () => {
    for (const event of ["authorization", "own_transfer", "statement", "alert", "upcoming"] as const) {
      expect(moneyEventFromMail(read({ event, amount: 40 }), mail("Notice", "Total $40.00"))).toMatchObject({ book: false, reason: "not_booked" });
    }
    expect(moneyEventFromMail(read({ event: "charge", amount: 1 }), mail("Pending authorization at SHELL", "Amount $1.00"))).toMatchObject({ reason: "vetoed" });
  });

  it("the total is taken, not the subtotal, the shipping or the balance", () => {
    const body = "小计 ¥90.00\n运费 ¥10.00\n合计 ¥100.00\n账户可用 ¥5,000.00";
    expect(moneyEventFromMail(read({ event: "receipt", amount: 100, currency: "CNY" }), mail("订单确认", body, "order@shop.cn"))).toMatchObject({ book: true, evidence: { value: 100 } });
    expect(moneyEventFromMail(read({ event: "receipt", amount: 90, currency: "CNY" }), mail("订单确认", body, "order@shop.cn"))).toMatchObject({ book: false, reason: "amount_unverified" });
    expect(moneyEventFromMail(read({ event: "receipt", amount: 5000, currency: "CNY" }), mail("订单确认", body, "order@shop.cn"))).toMatchObject({ book: false });
  });

  it("an amount the mail does not state, order numbers and card digits it does not contain, are dropped", () => {
    expect(moneyEventFromMail(read({ event: "charge", amount: 12 }), mail("Receipt", "Total $13.00"))).toMatchObject({ reason: "amount_unverified" });
    const verdict = moneyEventFromMail(read({ event: "charge", amount: 13, refs: ["A-0099", "ZZZZ"], last4: "4321" }), mail("Receipt", "Order A-0099\nTotal $13.00 on card ending 1234"));
    expect(verdict).toMatchObject({ book: true, evidence: { refs: ["A-0099"], last4: "" } });
  });

  it("a refund is a refund, not income, and is not vetoed for saying the order was cancelled", () => {
    expect(moneyEventFromMail(read({ event: "refund", amount: 20 }), mail("Order cancelled — refund issued", "Amount refunded $20.00", "orders@shop.com")))
      .toMatchObject({ book: true, evidence: { kind: "refund" } });
  });

  it("a failure carries the evidence that may void a booked record", () => {
    expect(moneyEventFromMail(read({ event: "failed", amount: 48.2, refs: ["9981"] }), mail("Your payment failed", "Order 9981\nTotal $48.20", "billing@gas.com")))
      .toMatchObject({ book: false, voids: { value: 48.2, refs: ["9981"] } });
  });

  it("the day the mail states is used when it is near the mail's date", () => {
    expect(moneyEventFromMail(read({ event: "charge", amount: 5, occurredOn: "2026-10-26" }), mail("Receipt", "Oct 26 · Total $5.00"))).toMatchObject({ evidence: { at: "2026-10-26" } });
    expect(moneyEventFromMail(read({ event: "charge", amount: 5, occurredOn: "2026-09-01" }), mail("Receipt", "Total $5.00"))).toMatchObject({ evidence: { at: "2026-10-28" } });
  });

  it("a dollar from a Canadian sender is Canadian", () => {
    expect(moneyEventFromMail(read({ event: "receipt", amount: 9 }), mail("Receipt", "Total $9.00", "shop@store.ca"))).toMatchObject({ evidence: { currency: "CAD" } });
  });
});

describe("keys", () => {
  it("one merchant however it is named, and the sender's registrable name", () => {
    expect(merchantKey("AMZN Mktp US*2K4")).toBe("amazon");
    expect(merchantKey("PAYPAL *NETFLIX.COM")).toBe("netflix");
    expect(merchantKey("", "receipts@mail.costco.com")).toBe("costco");
    expect(senderKeyOf("x@gmail.com")).toBe("");
    expect(senderKeyOf("a@shop.co.uk")).toBe("shop");
    expect(normalizeRef("#00123-AB")).toBe(normalizeRef("123ab"));
  });
});

describe("one transaction or two", () => {
  const evidence = { kind: "expense" as const, value: 86.4, currency: "USD", at: "2026-10-22", merchantKey: "amazon", last4: "", refs: [] as string[], role: "charge", senderKey: "chase", sourceKey: "m2" };
  const target = { kind: "expense", value: 86.4, currency: "USD", at: "2026-10-20", merchantKey: "amazon", account: "",
    evidence: [{ sourceKey: "m1", role: "receipt", senderKey: "amazon", refs: ["112-334"] }] };

  it("a shared order number merges", () => {
    expect(matchScore({ ...evidence, refs: ["112334"], role: "shipping" }, target).score).toBeGreaterThanOrEqual(MERGE_SCORE);
  });

  it("a receipt and a bank alert two days apart are a possible duplicate, not a silent merge", () => {
    const { score } = matchScore(evidence, target);
    expect(score).toBeGreaterThanOrEqual(POSSIBLE_SCORE);
    expect(score).toBeLessThan(MERGE_SCORE);
  });

  it("the same day with the same card merges", () => {
    expect(matchScore({ ...evidence, at: "2026-10-20", last4: "1234" }, { ...target, account: "Visa ••1234" }).score).toBeGreaterThanOrEqual(MERGE_SCORE);
  });

  it("two coffees from one sender on one day never merge; other order numbers, cards and currencies never merge", () => {
    const coffee = { ...target, merchantKey: "starbucks", evidence: [{ sourceKey: "c1", role: "receipt", senderKey: "starbucks", refs: [] }] };
    expect(matchScore({ ...evidence, merchantKey: "starbucks", role: "receipt", senderKey: "starbucks", sourceKey: "c2", at: "2026-10-20" }, coffee).blocked).toBe("same_sender");
    expect(matchScore({ ...evidence, refs: ["999"] }, target).blocked).toBe("refs");
    expect(matchScore({ ...evidence, last4: "1111" }, { ...target, account: "Visa ••2222" }).blocked).toBe("card");
    expect(matchScore({ ...evidence, currency: "CNY" }, target).blocked).toBe("currency");
    expect(matchScore({ ...evidence, at: "2026-11-20" }, target).blocked).toBe("window");
    // Two shop visits a week apart on the same card, different totals: two payments.
    expect(matchScore({ ...evidence, value: 132.5, last4: "1234", senderKey: "chase" }, { ...target, account: "card ••1234" }).blocked).toBe("amount");
  });
});

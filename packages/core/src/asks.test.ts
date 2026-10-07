import { describe, expect, it } from "vitest";
import { rankAsks, snoozeUntil, urgencyFor, validateAskAnswer, type Ask } from "./asks";

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({ id, kind: "backplan_input", entityId: id, title: id, why: "", urgency: "later",
  raisedAt: "2026-10-07T00:00:00Z", fingerprint: "f1", options: [
    { id: "have", label: "我有", fields: [{ id: "text", label: "内容", kind: "longtext", required: true }] },
    { id: "waiting", label: "在等", fields: [{ id: "who", label: "谁", kind: "text", required: false }, { id: "date", label: "哪天", kind: "date", required: true }] },
    { id: "page", label: "去看看", href: "/milestones" }], ...over });

describe("asks", () => {
  it("urgency comes from the deadline the answer affects", () => {
    expect(urgencyFor("2026-10-09", "2026-10-07")).toBe("now");
    expect(urgencyFor("2026-10-12", "2026-10-07")).toBe("soon");
    expect(urgencyFor("2026-11-01", "2026-10-07")).toBe("later");
    expect(urgencyFor(undefined, "2026-10-07")).toBe("later");
  });

  it("ranks the most urgent and soonest due first", () => {
    const ranked = rankAsks([ask("a", { urgency: "later" }), ask("b", { urgency: "now", dueDay: "2026-10-09" }),
      ask("c", { urgency: "now", dueDay: "2026-10-08" })], [], "2026-10-07");
    expect(ranked.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("a snooze hides an ask until its day, and ends early when the thing it is about changes", () => {
    const until = snoozeUntil("tomorrow", "2026-10-07");
    expect(until).toBe("2026-10-08");
    expect(rankAsks([ask("a")], [{ askId: "a", until, fingerprint: "f1" }], "2026-10-07")).toHaveLength(0);
    expect(rankAsks([ask("a")], [{ askId: "a", until, fingerprint: "f1" }], "2026-10-08")).toHaveLength(1);
    expect(rankAsks([ask("a", { fingerprint: "f2" })], [{ askId: "a", until, fingerprint: "f1" }], "2026-10-07")).toHaveLength(1);
    expect(snoozeUntil("week", "2026-10-07")).toBe("2026-10-14");
  });

  it("checks an answer against its own option's fields", () => {
    expect(validateAskAnswer(ask("a"), "nope", {})).toEqual({ ok: false, code: "ASK_OPTION_UNKNOWN" });
    expect(validateAskAnswer(ask("a"), "page", {})).toEqual({ ok: false, code: "ASK_OPTION_UNKNOWN" });
    expect(validateAskAnswer(ask("a"), "have", { text: "  " })).toEqual({ ok: false, code: "ASK_FIELD_REQUIRED" });
    expect(validateAskAnswer(ask("a"), "waiting", { date: "2026-02-30" })).toEqual({ ok: false, code: "ASK_FIELD_DATE_INVALID" });
    const ok = validateAskAnswer(ask("a"), "waiting", { date: "2026-10-09", who: " 师兄 ", extra: "dropped" });
    expect(ok).toMatchObject({ ok: true, values: { date: "2026-10-09", who: "师兄" } });
    expect(ok.ok && "extra" in ok.values).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { horizonEntry, latestStart, rankAsks, snoozeUntil, urgencyFor, validateAskAnswer, type Ask } from "./asks";

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

describe("the week's decisions", () => {
  it("work of six cautious hours at three hours a day, due on the 20th, must start by the 18th", () => {
    expect(latestStart("2026-10-20", 360, 180)).toBe("2026-10-18");
    expect(latestStart("2026-10-20", 0, 180)).toBe("2026-10-20");
  });
  it("a decision is this week's when its latest start is within seven days, and otherwise comes up seven days before it", () => {
    expect(horizonEntry("2026-10-17", "2026-10-10")).toBeUndefined();
    expect(horizonEntry(undefined, "2026-10-10")).toBeUndefined();
    expect(horizonEntry("2026-10-30", "2026-10-10")).toBe("2026-10-23");
  });
  it("at equal urgency the more important milestone's ask comes first", () => {
    const base = { kind: "backplan_input" as const, entityId: "m", why: "", options: [], urgency: "soon" as const, raisedAt: "", fingerprint: "f" };
    const ranked = rankAsks([{ ...base, id: "a", title: "a", importance: 40 }, { ...base, id: "b", title: "b", importance: 90 }, { ...base, id: "c", title: "c" }], [], "2026-10-10");
    expect(ranked.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });
});

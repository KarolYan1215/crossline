import { describe, expect, it } from "vitest";
import { hoursFromText, presetFromReading } from "./importance";

describe("importance preset", () => {
  it("is the milestone reviewer's weight and its reason; before a review, the neutral middle (no point score any more)", () => {
    expect(presetFromReading({ weight: 78, weightWhy: "硬约束主线，计入课程成绩，三周后截止" })).toEqual({ weight: 78, why: "硬约束主线，计入课程成绩，三周后截止", by: "model" });
    expect(presetFromReading(undefined)).toEqual({ weight: 50, why: "", by: "none" });
  });

  it("reads stated weekly hours, taking the upper end of a range", () => {
    expect(hoursFromText("每周投入 10–20 小时。")).toBe(20);
    expect(hoursFromText("ECE 555 与 ECE 548 合计每周约 15 小时。")).toBe(15);
    expect(hoursFromText("没有")).toBeNull();
  });
});

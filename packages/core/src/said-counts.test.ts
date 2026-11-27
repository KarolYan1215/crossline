import { expect, test } from "vitest";
import { countsFirstSaidByInterviewer, countsIn, numeralValue, unsaidCounts } from "./said-counts";
import { resolveWrittenClaims } from "./profile-claims";
import type { WrittenClaim } from "./profile-report";

test("numerals in digits and in Chinese read as numbers; a run of two numerals is no number", () => {
  expect([numeralValue("七"), numeralValue("十二"), numeralValue("两千"), numeralValue("二十"), numeralValue("3"), numeralValue("一万二千")])
    .toEqual([7, 12, 2000, 20, 3, 12_000]);
  expect(numeralValue("两三")).toBeUndefined();
  expect(countsIn("还剩两张没画，2 张也行")).toEqual([{ key: "2张", words: "两张", at: 2 }]);
});

// Replay 2026-11-26, persona a: the set had four pictures; the person said only 「还剩两张没画」.
test("a count the reply states about the person that nobody said is named; one said in other numerals is not", () => {
  const said = ["最放不下的是咖啡品牌那套节日插画。十一月中旬要交，还剩两张没画。", "去年秋天画了一组「打工人的猫」，一共九张。"];
  expect(unsaidCounts("七张画完，两张没动，整批没交，对方也没有催。", said)).toEqual(["七张"]);
  expect(unsaidCounts("还剩 2 张没画，九张猫那一组你画到一点。", said)).toEqual([]);
});

test("a count after 这/那 points back, and an enumeration the person named implies the counts below it (replay 2026-11-27)", () => {
  expect(unsaidCounts("这两件事不是一回事，那三张也先放着。", [])).toEqual([]);
  const said = ["第一章是入行，第二章换城市，第三章开始接单，第四章是现在。"];
  expect(unsaidCounts("四章里有两章都是被人推着走的。", said)).toEqual([]);
  expect(unsaidCounts("五章里有两章都是被人推着走的。", said)).toEqual(["五章"]);
  // Only the chapters: 第四章 says nothing about how many drawings there are.
  expect(unsaidCounts("两张画完了。", said)).toEqual(["两张"]);
  expect(unsaidCounts("两张画完了。", [])).toEqual(["两张"]);
});

test("questions, ranges, ordinals and 一 are not statements of a count", () => {
  expect(unsaidCounts("这套一共几张？前面画完的有七张吗？", [])).toEqual([]);
  expect(unsaidCounts("把到现在为止的经历分成三到五章，每章一句话。", [])).toEqual([]);
  expect(unsaidCounts("第三章说具体一点：只挑一件事。", [])).toEqual([]);
  expect(unsaidCounts("投入的两次都是和人一起赶东西，你说了两个理由。", [])).toEqual([]);
  // The interview's own earlier reply counts as said: a count it kept after one send-back is not named every round.
  expect(unsaidCounts("七张画完了。", ["七张画完，两张没动。"])).toEqual([]);
});

test("a count the interviewer said before the person makes a claim quoting it the interview's, not the person's report", () => {
  const echoed = countsFirstSaidByInterviewer([
    { role: "user", text: "还剩两张没画。" }, { role: "assistant", text: "七张画完，两张没动。" }, { role: "user", text: "跟前七张人在店里的场景不一样。" }]);
  expect([...echoed]).toEqual(["7张"]);
  const written = [{ section: "personality", statement: "七张连着画完，卡在最后两张。", quote: "跟前七张人在店里的场景不一样", kind: "self_reported", confidence: 0.8 },
    { section: "personality", statement: "还剩两张。", quote: "还剩两张没画", kind: "self_reported", confidence: 0.8 }] as unknown as WrittenClaim[];
  const claims = resolveWrittenClaims(written, ["还剩两张没画。", "跟前七张人在店里的场景不一样。"], { at: "2026-11-26T00:00:00Z", echoedCounts: echoed });
  expect(claims.map((claim) => claim.kind)).toEqual(["inferred", "self_reported"]);
});

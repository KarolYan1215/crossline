import { expect, test } from "vitest";
import { plainVoiceMarkers, plainVoiceRate } from "./plain-voice";

test("the patterns found in the candidates' replies are counted; a plain reply counts nothing", () => {
  // From the 2026-10-18 sample interviews.
  expect(plainVoiceMarkers("你把难处说成「三条线太多」，但真正卡住你的可能不是数量——是没有连续的一整块时间。先别急着砍，把三笔账算清。")).toEqual({
    dash: 1, contrast: 2, formula: 2, metaphor: 1, aphorism: 0, echoOpening: 1 });
  expect(plainVoiceMarkers("把底座放在科研上，是双刃剑：它确保这条线被优先投入。")).toMatchObject({ metaphor: 1, contrast: 0 });
  const plain = "论文 12 月中投稿，数据还差一半；创业和小红书目前都没有截止。下面先确认这两条线的时间点。";
  expect(Object.values(plainVoiceMarkers(plain)).every((value) => value === 0)).toBe(true);
  expect(plainVoiceRate(plain)).toBe(0);
  // A range written with an en dash between figures is not a dash used as a connector.
  expect(plainVoiceMarkers("每周 12–24 个月的底座，09:00–12:00 上课。").dash).toBe(0);
  // Words that only contain a pattern's characters (found in the 2026-10-20 real-work comparison): a checklist, a statistics term.
  expect(plainVoiceMarkers("整理 Paperless 登记办理清单，推导杠杆、学生化残差与 Cook 距离，画残差-杠杆图。")).toMatchObject({ formula: 0, metaphor: 0 });
  expect(plainVoiceMarkers("先把时间理清，用这篇笔记撬动更多读者。")).toMatchObject({ formula: 1, metaphor: 1 });
});

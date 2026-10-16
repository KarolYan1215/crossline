import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { typeFromScores } from "@crossline/core";
import { LocaleProvider } from "../locale-context";
import { DivergingAxes, ValuesRadar } from "./portrait-charts";
import { rhythmStats } from "./poster-geometry";

/** The portrait's code-written words in English (docs/i18n.md); the report's own text is shown as written. */
const en = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="en">{node}</LocaleProvider>);

test("the rhythm readings are English, with what is missing said in words", () => {
  const base = { curve: [], sleep: { from: 23.5, to: 7.5 }, peak: { start: 9.5, end: 12.5 }, thresholds: { low: 9.5, high: 12.5 }, reports: [], nights: 0 };
  const empty = rhythmStats({ ...base, chronotype: null, debt: { perNight: 0, nights: 0 } }, "en");
  expect(empty.map((cell) => [cell.title, cell.value])).toEqual([["Best hours", "9:30–12:30"], ["Chronotype", "Not yet"], ["Social jetlag", "Not yet"], ["Sleep debt", "Not yet"]]);
  const full = rhythmStats({ ...base, nights: 20, debt: { perNight: 0.6, nights: 14 },
    chronotype: { sdWork: 7, sdFree: 8.5, sdWeek: 7.4, msw: 3.5, msf: 4.25, msfSc: 3.9, sjlRel: 0.75, sjl: 0.75, chronotype: "intermediate" } }, "en");
  expect(full.map((cell) => cell.value).slice(2)).toEqual(["+0.8 h", "0.6 h short a night"]);
  expect(full[2]!.detail).toBe("Sleep midpoint is later on free days than workdays");
});

test("the axes name each pole by its English word alone, and the radar names Schwartz's values in English", () => {
  const type = typeFromScores({ scope: 80, basis: 30, output: 40, rhythm: 70 });
  const html = en(<DivergingAxes type={type} />);
  expect(html).toContain("<b>G</b>eneralist");
  expect(html).not.toContain("深耕");
  expect(html).not.toContain("跨界");
  const radar = en(<ValuesRadar values={[{ name: "自主", score: 80, evidence: "" }, { name: "成就", score: 60, evidence: "" }, { name: "安全", score: 40, evidence: "" }]} />);
  expect(radar).toContain("Self-direction");
  expect(radar).toContain("Achievement");
  expect(radar).not.toContain("自主");
});

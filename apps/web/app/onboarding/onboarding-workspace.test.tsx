import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { OpeningCard, openingReply } from "./opening-card";
import { minutesLeft, viewForStage, WeekView } from "./stage-view";
import { MATERIALS_FIRST_REPLY, NO_MATERIALS_REPLY } from "./onboarding-types";
import { cardReplyLines, ProfileCards } from "./profile-cards";
import { DiligencePanel } from "./diligence-panel";
import { cardsFor, readCardAnswers } from "@crossline/core";

/** The interview v3 (docs/onboarding-v3.md): the opening card, the stage pictures and the time left. */
test("the opening states the premise and the three parts, then asks the lines — no six-level lecture, no tone or tier (2026-11-12)", () => {
  const html = renderToStaticMarkup(<OpeningCard linesKnown={false} knownLines={[]} busy={false} hasMaterials={false} onStart={() => {}} />);
  expect(html).toContain("开发者的话");
  expect(html).toContain("在AI时代夺回属于人类的部分");
  expect(html).toContain("——Y.K.");
  expect(html).toContain("不限时长和轮数");
  expect(html).toContain("结束并出报告");
  expect(html).toContain("画像这一部分不能跳过");
  // The tone is built in and the tiers are gone (decisions 10–11): neither is asked.
  expect(html).not.toContain("你希望我怎么跟你说话");
  expect(html).not.toContain("冷静客观");
  expect(html).not.toContain("访谈问多细");
  expect(html).toContain("你正在投入的身份有哪些");
  expect(html).not.toContain("长期目标</b>");
  // Lines already set: nothing is asked.
  const known = renderToStaticMarkup(<OpeningCard linesKnown knownLines={["研究者"]} busy={false} hasMaterials onStart={() => {}} />);
  expect(known).not.toContain("你正在投入的身份有哪些");
  expect(known).toContain("读完材料，开始访谈");
});

test("the opening answers become the first reply in the screen's own words, ending with the materials sentence the eval also sends", () => {
  const reply = openingReply({ edition: "full", lines: ["研究者", "创业者"], domains: {}, base: "研究者", fixed: ["研究者"] }, true);
  expect(reply).not.toContain("【语气】");
  expect(reply).not.toContain("【详细程度】");
  expect(reply).toContain("【我的主线】研究者、创业者");
  expect(reply).toContain("【未来 12–24 个月的底座】研究者");
  expect(reply).toContain("【有固定日程的主线】研究者");
  expect(reply.endsWith(MATERIALS_FIRST_REPLY)).toBe(true);
  const none = openingReply({ edition: "full", lines: ["学生"], domains: {}, base: "", fixed: [] }, false);
  expect(none).toContain("【未来 12–24 个月的底座】几条并重");
  expect(none).toContain("【有固定日程的主线】都没有");
  expect(none.endsWith(NO_MATERIALS_REPLY)).toBe(true);
});

test("the lite edition is asked first, and its domain lines are named with their domain in the reply the interview quotes", () => {
  const card = renderToStaticMarkup(<OpeningCard linesKnown={false} knownLines={[]} busy={false} hasMaterials={false} onStart={() => {}} />);
  expect(card).toContain("从哪一版开始");
  // The full list offers the two domain lines beside the usual identities.
  expect(card).toContain("健康管理者（健康领域）");
  expect(card).toContain("理财者（财富领域）");
  // The fixed-schedule line is named for a person (2026-10-20), and the person's own words stay in the reply for the interview to quote.
  const lite = openingReply({ edition: "lite", lines: ["职场人", "健康管理者", "理财者"],
    domains: { 健康管理者: "wellness", 理财者: "wealth" }, base: "职场人", fixed: ["职场人"], said: { 职场人: "上班" } }, false);
  expect(lite).toContain("【版本】极简");
  expect(lite).toContain("【我的主线】职场人、健康管理者（健康领域）、理财者（财富领域）");
  expect(lite).toContain("【有固定日程的主线】职场人");
  expect(lite).toContain("【有固定日程的事】上班（主线：职场人）");
  // A name the person typed as a noun already needs no second line.
  const nurse = openingReply({ edition: "lite", lines: ["护士"], domains: {}, base: "护士", fixed: ["护士"], said: { 护士: "护士" } }, false);
  expect(nurse).not.toContain("【有固定日程的事】");
});

test("each stage brings its own picture, and the time left is said before and after the start standard", () => {
  // The compass and energy pictures are details of the map's dimensions now (decision 25): those stages bring the map forward.
  expect(["orientation", "lines", "situation", "compass", "energy", "details"].map((stage) => viewForStage(stage, false)))
    .toEqual(["lines", "lines", "week", "map", "map", "projects"]);
  expect(viewForStage("details", true)).toBe("structure");
  expect(minutesLeft({ readyToStart: false, startMissing: [{ id: "a", label: "", detail: "", owner: "interview" }, { id: "b", label: "", detail: "", owner: "person" }] }, "lines"))
    .toEqual({ label: "开始使用前约", minutes: 5 });
  expect(minutesLeft({ readyToStart: true, startMissing: [] }, "compass")).toEqual({ label: "画像访谈还剩约", minutes: 10 });
  // The profile-first flow: the module's parts come before the start, about ten minutes each, on top of the fact items.
  expect(viewForStage("narrative", false)).toBe("map");
  expect(minutesLeft({ readyToStart: false, startMissing: [{ id: "profile_cards", label: "", detail: "", owner: "interview" }] }, "narrative", "v2"))
    .toEqual({ label: "开始使用前约", minutes: 40 });
  expect(minutesLeft({ readyToStart: false, startMissing: [{ id: "a", label: "", detail: "", owner: "interview" }] }, "lines", "v2"))
    .toEqual({ label: "开始使用前约", minutes: 3 });
});

test("going back to an earlier part for one question does not add that part's time again (W-235)", () => {
  // v2 order: narrative, compass, energy, situation, orientation, lines. The interview had reached 「主线」 (6 of 6), then asked a compass question.
  const ready = { readyToStart: true, startMissing: [] };
  expect(minutesLeft(ready, "compass", "v2", "quick")).toEqual({ label: "画像访谈还剩约", minutes: 25 });
  expect(minutesLeft(ready, "compass", "v2", "quick", 6)).toEqual({ label: "画像访谈还剩约", minutes: 5 });
});

test("a card is five dots labelled at both ends and the middle, and what is tapped or written is the line the worker reads back", () => {
  const [card] = cardsFor("compass", new Set());
  const html = renderToStaticMarkup(<ProfileCards cards={[card!]} answers={{ taps: {}, words: {} }} disabled={false} onChange={() => {}} />);
  expect(html.match(/role="radio"/g)).toHaveLength(card!.items.length * 5);
  expect(html).toContain(card!.items[0]!.anchors[0]);
  expect(html).toContain(card!.items[0]!.anchors[2]);
  const [a, b] = card!.items;
  const lines = cardReplyLines([card!], { taps: { [a!.id]: 5, [b!.id]: 0 }, words: { [card!.id]: "  看场合\n大多不主动 " } });
  const answers = readCardAnswers(lines.join("\n"), [card!], "2026-10-31T00:00:00.000Z");
  expect(answers.find((answer) => answer.itemId === a!.id)).toMatchObject({ by: "tapped", score: 5 });
  expect(answers.find((answer) => answer.itemId === b!.id)).toMatchObject({ by: "pending" });
  expect(lines.at(-1)).toMatch(/补充：看场合 大多不主动$/);
  expect(cardReplyLines([card!], { taps: {}, words: {} })).toEqual([]);
});

test("the week draws working hours and fixed arrangements, waiting ones dashed, and says where the hours came from", () => {
  const html = renderToStaticMarkup(<WeekView week={{ source: "interview", windows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", energy: "high" }],
    fixed: [{ id: "c1", title: "ECE 548", project: "ece548", weekdays: [2, 4], start: "11:00", end: "12:15", status: "pending" }],
    calendar: [{ title: "Dentist", weekday: 3, start: "10:00", end: "11:00", source: "家里的日历" }] }} />);
  expect(html).toContain("可用约 40 小时");
  expect(html).toContain("ECE 548 · 周二 11:00–12:15（待确认）");
  expect(html).toContain('data-status="pending"');
  expect(html).toContain("访谈提议");
  // A connected calendar's events are drawn under it, and named.
  expect(html).toContain("Dentist · 周三 10:00–11:00（家里的日历）");
});

test("a line whose research was just started shows as running before its report says so, and only its button waits (W-237)", () => {
  const done = { id: "dd-1", identityId: "student", question: "", status: "done" as const, runAt: "2026-11-05T10:00:00Z", findings: [], proposals: [], sources: [] };
  const identities = [{ id: "student", label: "学生" }, { id: "research", label: "研究者" }];
  const html = renderToStaticMarkup(<DiligencePanel reports={[done]} identities={identities} busy={false} researching={["student"]} onRun={() => {}} onDecide={() => {}} />);
  const [student, research] = html.split("研究者</b>");
  expect(student).toContain("查证中…");
  expect(student).toMatch(/<button[^>]*disabled[^>]*>重新查证/);
  expect(research).not.toContain("查证中…");
  expect(research).not.toMatch(/<button[^>]*disabled/);
});

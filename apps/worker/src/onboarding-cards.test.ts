import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { profileGaps, type Hypothesis, type ResearchThread, type TurnInsight, type TurnQuestion } from "@crossline/core";
import { cardTools, checkInsights, checkOpenItems, checkQuestions, checkResearch, emptyDraft, ROUND_QUESTIONS, sharedRun, STAGE_CARDS, undecidedDay, withDraft,
  type RoundDraft } from "./onboarding-cards";
import { interviewLedger } from "./question-ledger";

// 2026-11-14 audit (docs/onboarding-validation-audit.md §3.3–3.5): every check answers with a problem the model can act on; none rewrites
// or quietly drops what it wrote. These replace the tests of `resolveRepeats`, `withDistinctOptions`, `withGapQuestions` and the day limits.

const ws = "w";
let store: CrosslineStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
const ask = (text: string, over: Partial<TurnQuestion> = {}): TurnQuestion =>
  ({ id: "q", text, kind: "free", options: [], allowOther: true, identityId: "", projectId: "", repeats: 0, ...over });

test("a question like one answered comes back with the answer, and goes out once the model marks it a follow-up", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-14T05:00:00Z";
  const unsure = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q2", text: "创作者主线当前推进的内容或项目名称？", status: "open", at });
  store.answerQuestion(ws, unsure, { text: "补充：不确定", at });
  const context = () => ({ ledger: interviewLedger(store!, ws, "s1"), openItems: [] });
  // Named by its number: the model reads the person's 「不确定」 itself, no pattern decides whether it settles anything.
  const named = checkQuestions([ask("创作者主线目前有正在推进的项目吗？", { repeats: unsure })], context());
  expect(named.accepted).toEqual([]);
  expect(named.problems[0]).toContain("不确定");
  expect(named.problems[0]).toContain("followUp");
  const followUp = checkQuestions([ask("创作者主线目前有正在推进的项目吗？", { repeats: unsure, followUp: true })], context());
  expect(followUp.accepted.map((question) => question.repeats)).toEqual([unsure]);
  // The 0.69 likeness that used to drop a deeper question: with `followUp` it is a new question.
  const deeper = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:3:q1", text: "什么事让你忘了时间？", identityId: "person", status: "open", at });
  store.answerQuestion(ws, deeper, { text: "和同学赶比赛", at });
  expect(checkQuestions([ask("什么事让你觉得煎熬？", { identityId: "person", followUp: true })], context()).accepted).toHaveLength(1);
});

test("rewordings are counted: the same thing is not put to the person a third time, a follow-up aside", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-10-31T05:00:00Z";
  const money = (text: string, over: Partial<TurnQuestion> = {}) => ask(text, { identityId: "wealth", ...over });
  const context = () => ({ ledger: interviewLedger(store!, ws, "s1"), openItems: [] });
  // Answered in prose the cards could not read: the question stays open, worded differently each round.
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q1", text: "现在手上大概有多少应急的钱？", identityId: "wealth", status: "open", at });
  expect(checkQuestions([money("现在手上应急的钱大概有多少？")], context()).accepted).toHaveLength(1);
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:3:q1", text: "现在手上应急的钱大概有多少？", identityId: "wealth", status: "open", at });
  const third = checkQuestions([money("手上应急的钱现在大概是多少？"), money("每月大概能存下多少？", { id: "q2" })], context());
  expect(third.accepted.map((question) => question.text)).toEqual(["每月大概能存下多少？"]);
  expect(third.problems).toEqual([expect.stringContaining("已经问过 2 次")]);
  // Two projects' deadlines are worded alike and are two questions.
  expect(checkQuestions([ask("「A」大概什么时候完成？", { identityId: "media", projectId: "a" }),
    ask("「B」大概什么时候完成？", { id: "q2", identityId: "media", projectId: "b" })], context()).accepted).toHaveLength(2);
  // Two questions of one round that ask the same thing: the second comes back.
  const twice = checkQuestions([ask("每周几点开始上班？", { identityId: "work" }), ask("每周几点开始上班呢？", { id: "q2", identityId: "work" })], context());
  expect(twice.accepted).toHaveLength(1);
  expect(twice.problems).toEqual([expect.stringContaining("留一个")]);
});

test("structure and size come back as problems: a repeated option, a used id, the sixth question of a round", () => {
  const context = { ledger: [], openItems: [] };
  const options = [{ id: "a", label: "周末", detail: "" }, { id: "b", label: "周末。", detail: "" }, { id: "c", label: "晚上", detail: "" }];
  expect(checkQuestions([ask("哪段时间最空？", { kind: "single", options })], context).problems).toEqual([expect.stringContaining("「周末。」重复")]);
  const many = Array.from({ length: ROUND_QUESTIONS + 1 }, (_, index) => ask(`第 ${index + 1} 件不同的事是什么样的情况？`, { id: `q${index}` }));
  const checked = checkQuestions(many, context);
  expect(checked.accepted).toHaveLength(ROUND_QUESTIONS);
  expect(checked.problems).toEqual([expect.stringContaining("放到下一轮")]);
  expect(checkQuestions([ask("新的问题？")], context, [ask("别的问题？")]).problems).toEqual([expect.stringContaining("已经用过")]);
});

test("the app's own waiting questions go out by id as the app wrote them; one asked in the model's words comes back", () => {
  store = new CrosslineStore(":memory:");
  const gaps = profileGaps({ identities: [{ id: "research", label: "研究者" }], projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }],
    facts: [], dated: ["ece548"], unfiled: [], portrait: { written: false, confirmed: false } });
  const meetings = gaps.find((gap) => gap.code === "COURSE_MEETINGS")!;
  const items = checkOpenItems([meetings.question.id, "gap-made-up"], gaps);
  expect(items.accepted).toEqual([meetings.question]);
  expect(items.problems).toEqual([expect.stringContaining("gap-made-up")]);
  // The same question in the ledger, named by the model's own rewording: its tap would not settle the fact.
  const number = store.recordQuestion(ws, { kind: "interview", key: `gap:${meetings.question.id}`, text: meetings.question.text, status: "pending", at: "2026-11-14T05:00:00Z" });
  const own = checkQuestions([ask("ECE 548 每周哪几天上课？", { repeats: number })], { ledger: interviewLedger(store, ws, "s1"), openItems: gaps });
  expect(own.problems).toEqual([expect.stringContaining(`把「${meetings.question.id}」放进 openItems`)]);
  // They count in the round's size.
  const full = Array.from({ length: ROUND_QUESTIONS }, (_, index) => ask(`问题 ${index}`, { id: `q${index}` }));
  expect(checkOpenItems([meetings.question.id], gaps, full).problems).toEqual([expect.stringContaining("放到下一轮")]);
});

const replies = { "reply-1": "最投入的是和同学一起赶比赛的时候。", "reply-2": "底座是我一个人做研究。", "reply-3": "那段时间我不想活了。" };
const card = (over: Partial<TurnInsight> = {}): TurnInsight => ({ hypothesisId: "", dimension: "D2", text: "你说投入的两次都是和人一起赶东西。",
  refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-2", quote: "一个人做研究" }], external: [], falsifier: "一个人的研究也能连续做到很晚", ...over });
const hypothesis = (id: string, over: Partial<Hypothesis> = {}): Hypothesis => ({ id, dimension: "D2", statement: id, falsifier: "", alternative: "", status: "open",
  basis: [{ kind: "quote", text: "和同学一起赶比赛", ref: "reply-1" }, { kind: "quote", text: "一个人做研究", ref: "reply-2" }], ...over } as Hypothesis);
const insightContext = (hypotheses: Hypothesis[] = [], over = {}) =>
  ({ replies, sensitive: new Set(["reply-3"]), focusLine: false, stage: "narrative", rules: true, hypotheses, earlier: [], ...over });

test("an observation card comes back naming what to fix: a quote not in its reply, a disclosure, one reply", () => {
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和朋友一起" }, { replyId: "reply-2", quote: "一个人做研究" }] })], insightContext()).problems)
    .toEqual([expect.stringContaining("「和朋友一起」不在 reply-1 里")]);
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "不想活了" }] })], insightContext()).problems)
    .toEqual([expect.stringContaining("自伤")]);
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }] })], insightContext()).problems)
    .toEqual([expect.stringContaining("至少 2 条不同回答")]);
  // The card on h1 is kept under its id.
  expect(checkInsights([card({ hypothesisId: "h1" })], insightContext([hypothesis("h1")])).accepted)
    .toEqual([{ card: expect.objectContaining({ hypothesisId: "h1", dimension: "D2" }) }]);
  // One already put on a card is not asked again; with an empty log a new inference is kept for the log.
  expect(checkInsights([card({ hypothesisId: "h1" })], insightContext([hypothesis("h1", { cardKey: "s#3" })])).problems).toEqual([expect.stringContaining("已经出过卡")]);
  expect(checkInsights([card()], insightContext()).accepted).toEqual([{ card: expect.objectContaining({ text: card().text }), fresh: { dimension: "D2" } }]);
  expect(checkInsights([card()], insightContext([], { focusLine: true })).problems).toEqual([expect.stringContaining("单条主线")]);
});

test("the log's candidates are offered, not imposed: the dialogue's own inferences go on cards beside them, up to the round's cards", () => {
  const second = card({ text: "你把一个人做的研究定为底座，又说最投入时都有同学在。", refs: [{ replyId: "reply-2", quote: "一个人做研究" }, { replyId: "reply-1", quote: "和同学一起赶比赛" }] });
  const checked = checkInsights([card(), second, card({ hypothesisId: "h1", text: "从日志出的卡。" })], insightContext([hypothesis("h1"), hypothesis("h2")]));
  expect(checked.problems).toEqual([]);
  expect(checked.accepted.map((item) => item.fresh ? "fresh" : item.card.hypothesisId)).toEqual(["fresh", "fresh", "h1"]);
  // The round's size still holds.
  const fourth = checkInsights([card({ text: "第四张。" })], insightContext([hypothesis("h1")]), checked.accepted);
  expect(fourth.problems).toEqual([expect.stringContaining("这一轮已有 3 张观察卡")]);
});

test("research comes back when its thread exists or too many are open", () => {
  const thread = (question: string, status: ResearchThread["status"]): ResearchThread =>
    ({ id: question, question, why: "", dimension: "D5", status, messages: [], createdAt: "", updatedAt: "" });
  const asked = { question: "芯片架构建模实习岗位最常要求哪些技能？", why: "职业方向", dimension: "D5" as const };
  expect(checkResearch([asked], [thread("芯片架构建模实习岗位最常要求哪些技能", "done")]).problems).toEqual([expect.stringContaining("已经有线程")]);
  const busy = ["一", "二", "三", "四"].map((name) => thread(name, "running"));
  expect(checkResearch([asked], busy).problems).toEqual([expect.stringContaining("同时开着的调研已有 4 条")]);
  expect(checkResearch([asked], []).accepted).toEqual([asked]);
});

test("the card tools keep an item only once its checks pass, and the final answer's own fields come after the draft", () => {
  let draft = emptyDraft();
  const seen: RoundDraft[] = [];
  const tools = cardTools({ schemas: { question: {}, insight: {}, research: {} }, ids: () => ({ lines: ["research"], projects: [] }), draft: () => draft,
    check: (next) => { seen.push(next); return next.questions.length + next.openItems.length > 2 ? ["一轮最多两题（测试）"] : []; } });
  expect(tools.specs.map((spec) => spec.name)).toEqual(["ask_question", "ask_app_question", "show_observation", "open_research"]);
  // A shape the whole answer would be refused for comes back before the round's checks run.
  expect(() => tools.call("ask_question", { id: "q1", text: "哪段时间最空？", kind: "single", options: [{ id: "a", label: "周末", detail: "" }] })).toThrow("至少要给 2 个候选");
  expect(() => tools.call("ask_question", { id: "q1", text: "哪段时间最空？", kind: "free", identityId: "money" })).toThrow("主线「money」不存在");
  expect(seen).toEqual([]);
  expect(tools.call("ask_question", { id: "q1", text: "哪段时间最空？", kind: "free" })).toContain("收下");
  expect(tools.call("ask_app_question", { id: "gap-meetings-ece548" })).toContain("这一轮已有 2 道题");
  expect(() => tools.call("ask_question", { id: "q3", text: "第三题？", kind: "free" })).toThrow("一轮最多两题");
  expect(draft.questions.map((question) => question.id)).toEqual(["q1"]);
  expect(draft.openItems).toEqual(["gap-meetings-ece548"]);
  expect(withDraft({ reply: "好", questions: [ask("别的？", { id: "q9" })] }, draft)).toMatchObject({
    questions: [expect.objectContaining({ id: "q1" }), expect.objectContaining({ id: "q9" })], openItems: ["gap-meetings-ece548"], insights: [], research: [] });
  draft = emptyDraft();
  expect(withDraft({ reply: "好", questions: [] }, draft)).toEqual({ reply: "好", questions: [] });
});

test("a day is the person's to set: options that are days come back, a date question names its subject, and a subject answered is not asked again (2026-11-15)", () => {
  const context = (dates = [] as Array<{ about: string; answer: string; undecided: boolean }>) => ({ ledger: [], openItems: [], dates, today: "2026-11-15" });
  const options = (...labels: string[]) => labels.map((label, index) => ({ id: `o${index}`, label, detail: "" }));
  // Replay 15: 「什么时候恢复投递？」 with 十一月底 / 十二月初 / 寒假前, six times over.
  expect(checkQuestions([ask("什么时候恢复投递？", { kind: "single", options: options("十一月底", "十二月初", "寒假前") })], context()).problems)
    .toEqual([expect.stringContaining("选项是日子")]);
  // A weekday as such is a preference, not a day.
  expect(checkQuestions([ask("一周里哪天状态最好？", { kind: "single", options: options("周一", "周三", "周六") })], context()).accepted).toHaveLength(1);
  expect(checkQuestions([ask("打算哪天恢复投递？", { date: true })], context()).problems).toEqual([expect.stringContaining("about")]);
  const resume = ask("打算哪天恢复投递？", { date: true, about: "恢复投递" });
  expect(checkQuestions([resume], context()).accepted).toHaveLength(1);
  expect(checkQuestions([{ ...resume, about: "恢复投递的日子" }], context([{ about: "恢复投递", answer: "还没定", undecided: true }])).problems)
    .toEqual([expect.stringContaining("还没定：不再问")]);
  expect(checkQuestions([resume], context([{ about: "恢复投递", answer: "12 月 1 日", undecided: false }])).problems).toEqual([expect.stringContaining("12 月 1 日")]);
  expect(checkQuestions([resume, { ...resume, id: "q2", text: "恢复投递放在哪天？" }], context()).problems).toEqual([expect.stringContaining("同一件事的日子")]);
  expect([undecidedDay("还没定，看情况"), undecidedDay("选择：不确定"), undecidedDay("12 月 1 日")]).toEqual([true, true, false]);
});

test("a card joins what was said at different times, and a stage's fourth card says what it adds (2026-11-15)", () => {
  const recent = new Set(["reply-1", "reply-2"]);
  expect(checkInsights([card()], insightContext([], { recent })).problems).toEqual([expect.stringContaining("最近两条回答")]);
  expect(checkInsights([card()], insightContext([], { recent: new Set(["reply-2", "reply-4"]) })).accepted).toHaveLength(1);
  const full = insightContext([], { stageCards: STAGE_CARDS });
  expect(checkInsights([card()], full).problems).toEqual([expect.stringContaining("why")]);
  expect(checkInsights([card({ why: "前面三张都在说时间，这张说和谁一起" })], full).accepted).toHaveLength(1);
});

test("the stretch a reply and a card share, spaces and punctuation aside", () => {
  expect(sharedRun("你说：投入的两次，都是和人一起赶东西。周末呢？", "投入的两次都是和人一起赶东西")).toBe("投入的两次都是和人一起赶东西");
  expect(sharedRun("周末呢？", "投入的两次")).toBe("");
});

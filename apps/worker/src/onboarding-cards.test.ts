import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { profileGaps, type AskedInReply, type Hypothesis, type ResearchThread, type TurnInsight, type TurnQuestion } from "@crossline/core";
import { cardTools, checkAsked, checkInsights, checkOpenItems, checkQuestions, checkResearch, emptyDraft, withDraft,
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

test("a question the reply asks is declared with its meaning; it is refused only for its shape or for the model's own 「same as an answered one」", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-25T05:00:00Z";
  const done = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:main-1", text: "最近一次接单影响更新是什么时候？", status: "open", at });
  store.answerQuestion(ws, done, { text: "想不起来", at });
  const ledger = interviewLedger(store, ws, "s1");
  const item = (over: Partial<AskedInReply> = {}): AskedInReply => ({ text: "每篇教程要做多久？", gist: "一篇教程的制作时长", repeats: 0, followUp: false, ...over });
  expect(checkAsked([item()], ledger)).toEqual({ accepted: [item()], problems: [] });
  expect(checkAsked([item({ gist: "" })], ledger).problems).toEqual([expect.stringContaining("gist")]);
  expect(checkAsked([item({ repeats: 99 })], ledger).problems).toEqual([expect.stringContaining("不在账本快照")]);
  expect(checkAsked([item({ repeats: done })], ledger).problems).toEqual([expect.stringContaining("想不起来")]);
  expect(checkAsked([item({ repeats: done, followUp: true })], ledger).accepted).toEqual([item({ repeats: done, followUp: true })]);
});

test("structure comes back as problems: a repeated option, a used id, a date question without its subject", () => {
  const context = { ledger: [], openItems: [] };
  const options = [{ id: "a", label: "周末", detail: "" }, { id: "b", label: "周末。", detail: "" }, { id: "c", label: "晚上", detail: "" }];
  expect(checkQuestions([ask("哪段时间最空？", { kind: "single", options })], context).problems).toEqual([expect.stringContaining("「周末。」重复")]);
  // How many questions a round holds, and whether options are days, are the Skill's (2026-11-27): six go out.
  const many = Array.from({ length: 6 }, (_, index) => ask(`第 ${index + 1} 件不同的事是什么样的情况？`, { id: `q${index}` }));
  expect(checkQuestions(many, context)).toEqual({ accepted: many, problems: [] });
  const days = [{ id: "a", label: "十一月底", detail: "" }, { id: "b", label: "十二月初", detail: "" }];
  expect(checkQuestions([ask("什么时候恢复投递？", { kind: "single", options: days })], context).problems).toEqual([]);
  expect(checkQuestions([ask("打算哪天恢复投递？", { date: true })], context).problems).toEqual([expect.stringContaining("about")]);
  expect(checkQuestions([ask("新的问题？")], context, [ask("别的问题？")]).problems).toEqual([expect.stringContaining("已经用过")]);
});

test("the app's own waiting questions go out by id as the app wrote them; one asked in the model's words comes back", () => {
  store = new CrosslineStore(":memory:");
  const gaps = profileGaps({ identities: [{ id: "research", label: "研究者" }], projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }],
    // A course on record (its grading breakdown): only such a project gets the app's class-times question (IR-028, 2026-11-25).
    facts: [{ identityId: "research", projectId: "ece548", slot: "grading", value: "作业 30%、期末 70%", status: "confirmed" }],
    dated: ["ece548"], unfiled: [], portrait: { written: false, confirmed: false } });
  const meetings = gaps.find((gap) => gap.code === "COURSE_MEETINGS")!;
  const items = checkOpenItems([meetings.question.id, "gap-made-up"], gaps);
  expect(items.accepted).toEqual([meetings.question]);
  expect(items.problems).toEqual([expect.stringContaining("gap-made-up")]);
  // The same question in the ledger, named by the model's own rewording: its tap would not settle the fact.
  const number = store.recordQuestion(ws, { kind: "interview", key: `gap:${meetings.question.id}`, text: meetings.question.text, status: "pending", at: "2026-11-14T05:00:00Z" });
  const own = checkQuestions([ask("ECE 548 每周哪几天上课？", { repeats: number })], { ledger: interviewLedger(store, ws, "s1"), openItems: gaps });
  expect(own.problems).toEqual([expect.stringContaining(`把「${meetings.question.id}」放进 openItems`)]);
});

const replies = { "reply-1": "最投入的是和同学一起赶比赛的时候。", "reply-2": "底座是我一个人做研究。", "reply-3": "那段时间我不想活了。" };
const card = (over: Partial<TurnInsight> = {}): TurnInsight => ({ hypothesisId: "", dimension: "D2", text: "你说投入的两次都是和人一起赶东西。",
  refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-2", quote: "一个人做研究" }], external: [], falsifier: "一个人的研究也能连续做到很晚", ...over });
const hypothesis = (id: string, over: Partial<Hypothesis> = {}): Hypothesis => ({ id, dimension: "D2", statement: id, falsifier: "", alternative: "", status: "open",
  basis: [{ kind: "quote", text: "和同学一起赶比赛", ref: "reply-1" }, { kind: "quote", text: "一个人做研究", ref: "reply-2" }], ...over } as Hypothesis);
const insightContext = (hypotheses: Hypothesis[] = [], over = {}) =>
  ({ replies, sensitive: new Set(["reply-3"]), focusLine: false, stage: "narrative", rules: true, hypotheses, earlier: [], ...over });

test("an observation card comes back naming what to fix: a quote not in its reply, a disclosure, a hypothesis already carded", () => {
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和朋友一起" }, { replyId: "reply-2", quote: "一个人做研究" }] })], insightContext()).problems)
    .toEqual([expect.stringContaining("「和朋友一起」不在 reply-1 里")]);
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "不想活了" }] })], insightContext()).problems)
    .toEqual([expect.stringContaining("自伤")]);
  // How many replies a card joins is the Skill's (2026-11-27): one verbatim quote stands.
  expect(checkInsights([card({ refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }] })], insightContext()).problems).toEqual([]);
  // The card on h1 is kept under its id.
  expect(checkInsights([card({ hypothesisId: "h1" })], insightContext([hypothesis("h1")])).accepted)
    .toEqual([{ card: expect.objectContaining({ hypothesisId: "h1", dimension: "D2" }) }]);
  // Which level goes on a card is the Skill's (2026-11-27).
  expect(checkInsights([card({ hypothesisId: "h1" })], insightContext([hypothesis("h1", { level: 3 })])).problems).toEqual([]);
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

test("research comes back only when its thread exists; however many are open, a new one goes (2026-11-22)", () => {
  const thread = (question: string, status: ResearchThread["status"]): ResearchThread =>
    ({ id: question, question, why: "", dimension: "D5", status, messages: [], createdAt: "", updatedAt: "" });
  const asked = { question: "芯片架构建模实习岗位最常要求哪些技能？", why: "职业方向", dimension: "D5" as const };
  expect(checkResearch([asked], [thread("芯片架构建模实习岗位最常要求哪些技能", "done")]).problems).toEqual([expect.stringContaining("已经有线程")]);
  const busy = ["一", "二", "三", "四"].map((name) => thread(name, "running"));
  expect(checkResearch([asked], busy)).toEqual({ accepted: [asked], problems: [] });
  // No cap of three a round either.
  const many = ["甲", "乙", "丙", "丁"].map((name) => ({ ...asked, question: `${name}？` }));
  expect(checkResearch(many, []).accepted).toHaveLength(4);
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

// 2026-11-25: in the ledger-driven replay the model ended 7 of 12 rounds on a kept `mark_round`, and each needed a second turn for the reply.
test("a kept mark_round tells the model the reply is still to be written", () => {
  const draft = emptyDraft();
  const tools = cardTools({ schemas: { question: {}, insight: {}, research: {}, round: {} }, ids: () => ({ lines: [], projects: [] }), draft: () => draft, check: () => [] });
  expect(tools.call("mark_round", { stage: "energy" })).toContain("工具交完就写最终消息");
  expect(tools.call("ask_question", { id: "q1", text: "哪段时间最空？", kind: "free" })).not.toContain("最终消息");
});

test("a card resting on the latest replies, or a stage's fourth card without a why, is no longer sent back (2026-11-22, IR-130/131 retired)", () => {
  expect(checkInsights([card()], insightContext([])).accepted).toHaveLength(1);
});

test("mark_round sets the round's own marks, later calls over earlier ones, and they stand over the final answer's", () => {
  let draft = emptyDraft();
  const tools = cardTools({ schemas: { question: {}, insight: {}, research: {}, round: {} }, ids: () => ({ lines: [], projects: [] }), check: () => [], draft: () => draft });
  expect(tools.specs.map((spec) => spec.name)).toContain("mark_round");
  tools.call("mark_round", { stage: "narrative", safety: false });
  tools.call("mark_round", { stage: "situation" });
  expect(draft.meta).toEqual({ stage: "situation", safety: false });
  expect(withDraft({ reply: "好", stage: "narrative" }, draft)).toEqual({ reply: "好", stage: "situation", safety: false });
  tools.call("mark_round", { ready: true });
  expect(withDraft({ reply: "好", nextAction: "ask" }, draft)).toMatchObject({ nextAction: "ready_for_milestones" });
  draft = emptyDraft();
});

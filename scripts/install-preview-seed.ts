import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "../packages/db/src/index";

/**
 * Puts a realistic interview into the install preview's throwaway ledger (`scripts/install-preview-server.ts`), so every stage of the
 * interview screen can be looked at without running a model:
 *
 *   pnpm exec tsx scripts/install-preview-seed.ts <lines | compass | energy | details | complete>
 *
 * Sign in to the preview first (PREVIEW_CODEX=signed-in) so its one workspace exists. The person is fictional. Each stage replaces the
 * previous seed: a new interview session takes over, its facts and the right column's data are rewritten, nothing else is touched.
 */
const stage = process.argv[2] ?? "compass";
const order = ["lines", "compass", "energy", "details", "complete"];
if (!order.includes(stage)) throw new Error(`usage: install-preview-seed.ts <${order.join(" | ")}>`);
const reached = (name: string) => order.indexOf(stage) >= order.indexOf(name);

const store = new CrosslineStore(path.join(tmpdir(), "crossline-install-preview", "crossline.db"));
const workspace = store.listWorkspaces()[0];
if (!workspace) throw new Error("NO_WORKSPACE: sign in to the preview first (PREVIEW_CODEX=signed-in)");
const ws = workspace.id, owner = "preview", now = new Date().toISOString();
// A new session per run: the interview screen reads the latest one, so a later seed simply takes over.
const session = `preview-${stage}-${Date.now()}`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

store.setSetting(ws, "lines.v1", JSON.stringify([
  { id: "researcher", label: "研究者", color: "research", goal: "", goals: reached("details") ? ["成为能独立立项的、神经形态计算方向的研究者"] : [],
    goalParts: reached("details") ? ["能独立立项", "神经形态计算方向"] : [], createdAt: now, rank: 1, hard: true },
  { id: "founder", label: "创业者", color: "startup", goal: "", goals: reached("complete") ? ["成为能把想法做成产品的、教育科技方向的创业者"] : [],
    goalParts: reached("complete") ? ["能把想法做成产品", "教育科技方向"] : [], createdAt: now }
]));
store.setSetting(ws, "onboarding.tone", "direct");
store.setSetting(ws, "lines.profiles", JSON.stringify({
  researcher: { description: "博三，做忆阻器片上训练；导师组周会固定，课程两门。", attributes: [
    { text: "能独立立项", kind: "ability", sourceRef: "reply-1" }, { text: "神经形态计算方向", kind: "domain", sourceRef: "src-1" },
    { text: "被同行认可", kind: "state", sourceRef: "reply-1" }, { text: "善于讲清复杂问题", kind: "ability", sourceRef: "reply-3" }] },
  founder: { description: "在做一个帮研究生排期的小工具，想验证有没有人愿意付费。", attributes: [
    { text: "能把想法做成产品", kind: "ability", sourceRef: "reply-1" }, { text: "教育科技", kind: "domain", sourceRef: "reply-1" }] }
}));
store.setSetting(ws, "schedule.availability.proposed", JSON.stringify({ windows: [
  { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" }, { days: [1, 2, 3, 4, 5], start: "13:30", end: "18:00", energy: "medium" },
  { days: [1, 2, 3, 4], start: "20:00", end: "22:30", energy: "low" }, { days: [6], start: "10:00", end: "16:00", energy: "medium" }], why: "按回答中的作息" }));

for (const project of [{ id: "ece548", identityId: "researcher", name: "ECE 548", summary: "课程" }, { id: "westlake", identityId: "researcher", name: "西湖合作论文", summary: "MoS2 忆阻器片上训练" },
  { id: "planner-mvp", identityId: "founder", name: "排期工具 MVP", summary: "给研究生用" }])
  store.saveProject({ ...project, ownerId: owner, workspaceId: ws, status: "active", createdAt: now, updatedAt: now });
const fact = (identityId: string, projectId: string, slot: string, value: string, status: "confirmed" | "inferred", sourceRef = "reply-1") =>
  store.upsertProfileFact({ workspaceId: ws, identityId, projectId, slot, value, status, sourceRef, sourceQuote: status === "confirmed" ? value : "", updatedAt: now });
fact("researcher", "", "what", "博三，做忆阻器片上训练", "confirmed");
fact("researcher", "westlake", "deadline", "10/31 前投出", "confirmed");
fact("founder", "planner-mvp", "goal", "验证有没有人愿意付费", "confirmed");
fact("founder", "", "flywheel_researcher_informs", "排期工具的用户访谈本身是研究生时间管理的一手材料", "inferred");
fact("researcher", "", "flywheel_founder_reuses", "研究里写的仿真脚本可以做成工具里的示例", "inferred");
if (reached("details")) fact("founder", "planner-mvp", "no_deadline", "没有截止", "confirmed");
if (reached("compass")) { fact("person", "", "work_view", "工作是为了把想做的东西做出来", "confirmed", "reply-5"); fact("person", "", "constraint", "假设：每周至少一天完全休息", "inferred"); }

store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `preview-dates:${stage}`, type: "dates.extracted", entityId: `preview-batch-${stage}`, payload: {
  documentIds: [], questions: [], dropped: [],
  recurring: [{ id: "r1", title: "ECE 548 上课", project: "ece548", weekdays: [2, 4], startTime: "11:00", endTime: "12:15", from: day(-30), to: day(60), exceptions: [], location: "", sourceRef: "src-1", quote: "TuTh 11:00-12:15", confidence: "high" },
    { id: "r2", title: "导师组周会", project: "westlake", weekdays: [1], startTime: "14:00", endTime: "15:30", from: day(-30), to: day(90), exceptions: [], location: "", sourceRef: "reply-1", quote: "周一下午两点组会", confidence: "high" }],
  dates: [{ id: "d1", date: day(9), startTime: "", endTime: "", kind: "exam", title: "ECE 548 期中考试", project: "ece548", sourceRef: "src-1", quote: "Midterm", confidence: "high", note: "" },
    { id: "d2", date: day(17), startTime: "", endTime: "", kind: "deadline", title: "西湖合作论文投稿", project: "westlake", sourceRef: "reply-1", quote: "10/31 前要投出", confidence: "high", note: "" },
    { id: "d3", date: day(40), startTime: "", endTime: "", kind: "homework_due", title: "ECE 548 期末项目", project: "ece548", sourceRef: "src-1", quote: "Final project due", confidence: "medium", note: "" }] } });

const profile = {
  portrait: reached("compass") ? "一个把研究当底座、想用产品验证自己判断力的博士生，时间被课程和组会切碎。" : "",
  coreConflict: reached("compass") ? "想要独立立项的掌控感，却把最好的上午交给了别人的会议。" : "", problem: "", gravity: [], designable: [], reframes: [],
  workView: reached("compass") ? "工作是把想做的东西做出来，钱是让这件事能持续的条件。" : "", lifeView: reached("compass") ? "被几个真正在乎的人记住做过有用的东西。" : "",
  consistency: "", trueNorth: reached("compass") ? "做出被同行和用户都用上的东西" : "",
  energyMap: reached("energy") ? [
    { activity: "推公式、调仿真", skill: "high", love: "high", charge: "charge" }, { activity: "写论文初稿", skill: "high", love: "low", charge: "drain" },
    { activity: "和潜在用户聊需求", skill: "low", love: "high", charge: "charge" }, { activity: "报销与行政", skill: "low", love: "low", charge: "drain" },
    { activity: "给本科生讲课", skill: "high", love: "high", charge: "charge" }] : [],
  flow: reached("energy") ? ["深夜调通一个仿真", "和用户聊完当晚改原型"] : [], says: "", does: "", anchor: "", realWant: "", allocation: "",
  values: reached("compass") ? [{ value: "自主", score: 88 }, { value: "成就", score: 76 }, { value: "刺激", score: 61 }, { value: "普世", score: 52 },
    { value: "安全", score: 40 }, { value: "仁慈", score: 58 }] : []
};
store.setSetting(ws, "profile.model", JSON.stringify(profile));

const assistantStage = { lines: "lines", compass: "compass", energy: "energy", details: "details", complete: "details" }[stage]!;
const turn = (reply: string, questions: unknown[], over: object = {}) => ({ reply, questions, slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [],
  nextAction: "ask", stage: assistantStage, lineProfiles: [], goalEdits: [], availability: { windows: [], why: "" }, profile, ...over });
const single = (id: string, text: string, options: string[], identityId = "") => ({ id, text, kind: "single", allowOther: true, identityId, projectId: "",
  options: options.map((label, index) => ({ id: `${id}-${index}`, label, detail: "" })) });
const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
  { role: "user", content: { text: "【语气】直接犀利\n【我的主线】研究者、创业者\n【未来 12–24 个月的底座】研究者\n【有固定日程的主线】研究者\n材料已添加，请先从材料里读出能读的，再问还缺的。" } },
  { role: "assistant", content: turn("课表读出来了：ECE 548 周二周四上午有课，期中在两周后。组会也在周一下午——你最好的上午有一半已经不是你的了。先补三件事。", [
    single("q-hours", "一周里你通常哪些时间能干活？", ["工作日 9–18 点", "工作日上午 + 晚上", "只有晚上和周末"]),
    single("q-founder-project", "创业者这条线现在推进的具体是什么？", ["排期工具 MVP", "还在找方向"], "founder"),
    single("q-founder-deadline", "「排期工具 MVP」有截止吗？", ["有，我来写日期", "没有截止"], "founder")]) }
];
if (reached("compass")) messages.push(
  { role: "user", content: { text: "【一周里你通常哪些时间能干活？】选择：工作日上午 + 晚上\n【创业者这条线现在推进的具体是什么？】选择：排期工具 MVP" } },
  { role: "assistant", content: turn("你说工作是为了把东西做出来，可过去一个月最完整的产出是给组里写的报销流程。做出来的东西里，哪件是你自己选的？",
    stage === "compass" ? [{ id: "q-why", text: "抛开钱，你为什么还要工作？", kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] }] : []) });
if (reached("energy")) messages.push(
  { role: "user", content: { text: "为了做出别人用得上的东西，哪怕很小。" } },
  { role: "assistant", content: turn("推公式和给本科生讲课都让你回血，写初稿却在抽干你——你擅长它，但不爱它。这不是懒，是能量放错了地方。",
    stage === "energy" ? [single("q-flow", "最近一次完全忘了时间，是在做什么？", ["调仿真", "和用户聊需求", "讲课", "写代码"])] : []) });
if (reached("details")) messages.push(
  { role: "user", content: { text: "调仿真，凌晨三点才发现。" } },
  { role: "assistant", content: turn("细节补齐：每个项目的截止和要交付的东西。", stage === "details" ? [single("q-westlake-evidence", "西湖合作论文，什么算有进展？", ["图表齐了", "初稿发给导师", "投出"], "researcher")] : [],
    stage === "complete" ? { nextAction: "ready_for_milestones" } : {}) });

store.saveOnboardingSession({ id: session, ownerId: owner, workspaceId: ws, state: stage === "complete" ? "complete" : "active",
  coverage: { stage: assistantStage }, createdAt: now, updatedAt: now });
messages.forEach((message, index) => store.appendOnboardingMessage({ sessionId: session, workspaceId: ws, role: message.role, content: message.content,
  createdAt: new Date(Date.now() - (messages.length - index) * 60_000).toISOString() }));
store.close();
console.log(`seeded ${stage}: ${messages.length} messages in workspace ${ws}`);

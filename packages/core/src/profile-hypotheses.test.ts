import { expect, test } from "vitest";
import { cleanProfileInsights } from "./onboarding-turn-schema";
import { validateResearchTurn } from "./onboarding-research";
import { cleanCareers, cleanDimensionNotes, cleanHypotheses, mergeProfileInsights, type CareerOption, type Hypothesis } from "./profile-hypotheses";

const replies = { "reply-1": "组会前一晚我基本都在通宵改图，导师等着看。", "reply-2": "没人催的事我一般拖到最后。" };
const hypothesis = (over: Record<string, unknown> = {}) => ({
  id: "h1", dimension: "D2", statement: "有人等着看结果时投入明显更多", status: "open", alternative: "截止本身而不是被看见在起作用",
  falsifier: "接下来两周没人等结果的研究任务也一样做到很晚",
  basis: [{ kind: "quote", text: "组会前一晚我基本都在通宵改图", ref: "reply-1" }], reference: null, ...over });

test("a hypothesis keeps only the basis that holds: a quote verbatim in the reply it names, an outside item with a web URL", () => {
  const [kept] = cleanHypotheses([hypothesis({ basis: [
    { kind: "quote", text: "组会前一晚我基本都在通宵改图", ref: "reply-1" },
    { kind: "quote", text: "我每次都通宵", ref: "reply-1" },
    { kind: "external", text: "同届博士生的调查", ref: "not a url" },
    { kind: "external", text: "同届博士生的调查", ref: "https://example.org/survey" },
    { kind: "behavior", text: "三次组会前都熬夜", ref: "reply-1" }] })], (ref) => replies[ref as keyof typeof replies]);
  expect(kept!.basis.map((item) => item.kind)).toEqual(["quote", "external", "behavior"]);
});

test("a hypothesis with no basis left, an unknown status or dimension, no falsifier or a repeated id is dropped; rated comes only from the record", () => {
  const textOf = (ref: string) => replies[ref as keyof typeof replies];
  expect(cleanHypotheses([hypothesis({ basis: [{ kind: "quote", text: "编出来的话", ref: "reply-1" }] })], textOf)).toEqual([]);
  expect(cleanHypotheses([hypothesis({ status: "maybe" })], textOf)).toEqual([]);
  expect(cleanHypotheses([hypothesis({ dimension: "D10" })], textOf)).toEqual([]);
  expect(cleanHypotheses([hypothesis({ falsifier: " " })], textOf)).toEqual([]);
  expect(cleanHypotheses([hypothesis(), hypothesis({ statement: "另一条" })], textOf)).toHaveLength(1);
  const [rated] = cleanHypotheses([hypothesis({ rated: "fits", reference: { text: "没有网址的数据", url: "" } })], textOf, (id) => id === "h1" ? "off" : undefined);
  expect(rated!.rated).toBe("off");
  expect(rated!.reference).toBeUndefined();
});

test("a career keeps only web sources, and without one its requirement matrix goes; ids and lines must be known, a trial runs 2–4 weeks", () => {
  const career = { role: "芯片架构建模实习", why: "h1", hypothesisIds: ["h1", "h9"], lineId: "research",
    requirements: [{ requirement: "Python", share: "9/10", has: "yes", evidence: "仿真脚本" }, { requirement: "SystemC", share: "3/10", has: "maybe", evidence: "" }],
    sources: ["https://jobs.example.com/1", "jobs board", "https://jobs.example.com/1"],
    trial: { weeks: 8, task: "用两周写一个缓存的性能模型", supportsIf: "主动多做了对比实验", refutesIf: "做完只觉得松口气" } };
  const [kept] = cleanCareers([career], new Set(["h1"]), new Set(["research"]));
  expect(kept!.sources).toEqual(["https://jobs.example.com/1"]);
  expect(kept!.requirements.map((item) => item.requirement)).toEqual(["Python"]);
  expect(kept!.hypothesisIds).toEqual(["h1"]);
  expect(kept!.trial.weeks).toBe(4);
  const [unsourced] = cleanCareers([{ ...career, sources: [], lineId: "media" }], new Set(["h1"]), new Set(["research"]));
  expect(unsourced!.requirements).toEqual([]);
  expect(unsourced!.lineId).toBe("");
  expect(cleanCareers([{ ...career, trial: undefined }], new Set(), new Set())).toEqual([]);
});

test("dimension notes keep known ids once, in the dimensions' order", () => {
  expect(cleanDimensionNotes([{ id: "D4", summary: "b", evidenced: true }, { id: "D0", summary: "a", evidenced: false }, { id: "D4", summary: "c", evidenced: false }, { id: "X", summary: "", evidenced: true }]))
    .toEqual([{ id: "D0", summary: "a", evidenced: false }, { id: "D4", summary: "b", evidenced: true }]);
});

test("the extraction cleans its portrait lists against the replies and files, and careers only attach to the person's lines", () => {
  const cleaned = cleanProfileInsights({
    hypotheses: [hypothesis(), hypothesis({ id: "h2", basis: [{ kind: "quote", text: "文件里的一句话", ref: "src-1" }] })],
    careers: [{ role: "数据分析", why: "", hypothesisIds: ["h2"], requirements: [], sources: [], lineId: "person",
      trial: { weeks: 2, task: "做一份公开数据的分析", supportsIf: "", refutesIf: "" } }],
    dimensions: [{ id: "D2", summary: "被看见时投入更多", evidenced: true }]
  } as never, { replies, sources: { "src-1": "简历：文件里的一句话。" }, identities: ["person", "research"] });
  expect(cleaned.hypotheses!.map((item) => item.id)).toEqual(["h1", "h2"]);
  expect(cleaned.careers![0]!.lineId).toBe("");
  expect(cleaned.careers![0]!.hypothesisIds).toEqual(["h2"]);
  expect(cleaned.dimensions).toHaveLength(1);
});

test("a research run: a conclusion needs an opened web source; sources are web URLs, each once; empty ask and conclusion are none", () => {
  expect(() => validateResearchTurn({ message: " ", ask: "", conclusion: "", sources: [] })).toThrow("RESEARCH_MESSAGE_EMPTY");
  expect(() => validateResearchTurn({ message: "查了三家", ask: "", conclusion: "约七成要求 Python", sources: [{ title: "x", url: "ftp://a" }] }))
    .toThrow("RESEARCH_CONCLUSION_UNSOURCED");
  expect(validateResearchTurn({ message: "查了三家", ask: "", conclusion: "", sources: [] })).toEqual({ message: "查了三家", sources: [] });
  const turn = validateResearchTurn({ message: "查了十份招聘", ask: "你说的建模是性能还是功耗？", conclusion: "9/10 要求 Python",
    sources: [{ title: "A", url: "https://a.example/jd" }, { title: "A again", url: "https://a.example/jd" }, { title: "", url: "https://b.example" }] });
  expect(turn.sources).toEqual([{ title: "A", url: "https://a.example/jd" }]);
  expect(turn.ask).toBe("你说的建模是性能还是功耗？");
  expect(turn.conclusion).toBe("9/10 要求 Python");
});

test("a run's changes merge into what is on record: by id for hypotheses and dimensions; the rest stays", () => {
  const h = (id: string, statement: string, over: Partial<Hypothesis> = {}): Hypothesis => ({ id, dimension: "D2", statement, basis: [{ kind: "behavior", text: "x", ref: "reply-1" }],
    falsifier: "f", alternative: "", status: "open", ...over });
  const onRecord = { hypotheses: [h("h1", "旧一", { rated: "fits" }), h("h2", "旧二"), h("h4", "卡上说准", { rated: "fits", cardKey: "s#3", pointId: "p1", status: "supported" })],
    careers: [], dimensions: [{ id: "D0" as const, summary: "旧", evidenced: true }, { id: "D2" as const, summary: "旧", evidenced: false }] };
  const merged = mergeProfileInsights(onRecord, { hypotheses: [h("h1", "新一", { status: "supported" }), h("h3", "新三"), h("h4", "改写本人定过的")],
    dimensions: [{ id: "D2", summary: "新", evidenced: true }] });
  // h1 replaced in place and keeps the person's 准; h2 untouched; h3 joins the end; h4, settled on its card, is not rewritten.
  expect(merged.hypotheses.map((item) => [item.id, item.statement, item.status, item.rated ?? ""])).toEqual([
    ["h1", "新一", "supported", "fits"], ["h2", "旧二", "open", ""], ["h4", "卡上说准", "supported", "fits"], ["h3", "新三", "open", ""]]);
  expect(merged.dimensions).toEqual([{ id: "D0", summary: "旧", evidenced: true }, { id: "D2", summary: "新", evidenced: true }]);
  // Nothing changed: everything stays as it was.
  expect(mergeProfileInsights(onRecord, {})).toEqual({ ...onRecord });
});

test("careers in two layers: one industry and function is one direction, its ways in are entries; a change needs a reason; ids are stable", () => {
  const at = "2026-11-12T00:00:00.000Z";
  const c = (role: string, over: Partial<CareerOption> = {}): CareerOption => ({ role, why: "w", hypothesisIds: [], requirements: [], sources: [],
    trial: { weeks: 2, task: "t", supportsIf: "s", refutesIf: "r" }, lineId: "", ...over });
  // A direction from before has no id: it is given one.
  const onRecord = { careers: [c("咨询助理"), c("四大审计寒假实习", { id: "k3", industry: "会计师事务所", function: "审计", entries: ["寒假实习"] })] };
  const merged = mergeProfileInsights(onRecord, { careers: [
    c("四大审计日常实习", { industry: "会计师事务所 ", function: "审计", entries: ["日常实习"] }),
    c("财经采编", { differs: "和审计不同：写稿而不是核账" }),
    // The same id without a reason changes nothing but its entries.
    c("四大审计", { id: "k3", industry: "会计师事务所", function: "审计" })
  ], dropCareers: ["k4"] }, at);
  // 咨询助理 was given k4 and dropped by it; 日常实习 joined k3 as an entry; 财经采编 is new.
  expect(merged.careers.map((item) => [item.id, item.role, item.entries ?? []])).toEqual([
    ["k3", "四大审计寒假实习", ["寒假实习", "日常实习"]], ["k5", "财经采编", []]]);
  expect(merged.careers[1]!.log).toEqual([{ at, why: "和审计不同：写稿而不是核账" }]);
  // With a reason the same id is rewritten, keeping its entries and logging why.
  const changed = mergeProfileInsights(merged, { careers: [c("四大审计（审计助理）", { id: "k3", change: "她说更想做全职校招", entries: ["校招"] })] }, at);
  expect(changed.careers[0]).toMatchObject({ id: "k3", role: "四大审计（审计助理）", entries: ["寒假实习", "日常实习", "校招"] });
  expect(changed.careers[0]!.log?.at(-1)).toEqual({ at, why: "她说更想做全职校招" });
  expect("change" in changed.careers[0]!).toBe(false);
});

test("a career changed this run may rest on a hypothesis on record that the run did not rewrite", () => {
  const career = { role: "活动运营实习", why: "h7", hypothesisIds: ["h7", "h99"], requirements: [], sources: [],
    trial: { weeks: 2, task: "t", supportsIf: "s", refutesIf: "r" }, lineId: "" };
  const kept = cleanProfileInsights({ careers: [career] as never, dropCareers: [" 咨询助理 ", "咨询助理", ""] },
    { replies, sources: {}, identities: [], hypothesesOnRecord: ["h7"] });
  expect(kept.careers?.[0]?.hypothesisIds).toEqual(["h7"]);
  expect(kept.dropCareers).toEqual(["咨询助理"]);
});

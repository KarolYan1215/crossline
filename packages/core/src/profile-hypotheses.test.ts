import { expect, test } from "vitest";
import { cleanProfileInsights } from "./onboarding-turn-schema";
import { validateResearchTurn } from "./onboarding-research";
import { cleanCareers, cleanDimensionNotes, cleanHypotheses } from "./profile-hypotheses";

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

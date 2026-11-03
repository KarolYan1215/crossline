import type { Capability } from "./scenarios";
import type { Persona } from "./model";

/**
 * Real defects the synthetic world found in the code it runs (§17.9 ③), each with the scenario that shows it and the track that owns
 * the fix. The suite marks the affected tests `test.fails`; a fix makes them pass, the test turns red, and the entry here is removed. Fixed
 * so far: D8 (a reached milestone did not re-derive the watches), by track ①'s 「按节点重推」 (`watchesDeriveDue` reads milestone events).
 */
export type Defect = { id: string; owner: string; where: string; what: string };

export const DEFECTS: Defect[] = [
  { id: "D1", owner: "①（A 线发现链）", where: "apps/worker/src/opportunities.ts runWatch `searches.slice(0, 1)`",
    what: "一个监视项只检索第一条 web_search 目标，其余目标永远不查：TBD 访问项目、波士顿行程里的活动、今晚截止的本地活动、欧盟暑校、温哥华会议都找不到；"
      + "因而 ineligible-region、visa-too-late 「没推」只是没找到，不是判对了。" },
  { id: "D2", owner: "①（A 线资格判定）", where: "packages/core/src/opportunity-discovery.ts meets()",
    what: "国籍与地区只会判「符合」或「不知道」：本人已确认中国国籍、条款只收美国公民，仍问「是否美国公民」，而不是判不符合。" },
  { id: "D3", owner: "①（A 线去重）", where: "Opportunity.key（host + 规范化标题 + 首个截止）",
    what: "同一场黑客松，邮件链接带 utm 参数、标题写 「Lakeshore Hack '26」，devpost 接口给 「Lakeshore Hack 2026」：两条记录、推两次。" },
  { id: "D4", owner: "①（A 线引文核对）", where: "packages/core/src/date-schema.ts quoteSupportsDate（不比年份）",
    what: "模型把「2025 cohort closed on December 1, 2025」读成 2026-12-01，引文核对通过，去年办过、今年不办的项目被推送。" },
  { id: "D5", owner: "①（A 线邮件来源）", where: "runWatch 邮件候选（邮件即页面，不打开链接）",
    what: "钓鱼邮件「Global Research Award」只按邮件正文读，链接从不打开核实，模型照抄就成了资格符合的机会被推送。" },
  { id: "D6", owner: "①（A 线检索）", where: "searchWeb 打开模型给出的每个 url；htmlToText 保留隐藏文字",
    what: "页面隐藏 div 的注入让模型报出 collect.evil.example/beacon?u=qiao，worker 照样去请求（带用户标识的外发）；"
      + "隐藏文字里的「截止 2027-12-31」「对所有人开放」通过引文核对，换掉真标题、真截止并抹掉「仅限本科生」，被推送。" },
  { id: "D7", owner: "①（A 线读取）", where: "runWatch keep()（全部截止已过即丢弃）",
    what: "截止延长的比赛，模型只抄了原截止 10-30：记录被当过期丢掉，页面上写着的新截止 11-14 没人看。" },
  // Seen only with the real reader (scripts/opportunity-world.ts --live): the deterministic run never reaches these pages because of D1.
  { id: "D9", owner: "①（A 线读取与资格判定）", where: "crossline-opportunity-reader 的条款提取；ELIGIBILITY_DIMS 映射",
    what: "真读取器把「向公众开放」「任意 STEM 学科」「居住于欧盟成员国」报成资格条款，代码对不上自由文本，三轮都成了问题：欧盟暑校问所在地区，公开讲座问是否向公众开放（与固定日程的冲突因此没判）。" },
  { id: "D10", owner: "②（时空可行性）", where: "packages/core/src/feasibility.ts feasibilityOf 「Latest start」",
    what: "既无截止也无开始日期时以今天为锚点，prepStart = 今天 − prepDays 必早于今天，判 no_time_to_prepare：日期待定的访问项目找到、判符合，却永远推不出来。" }
];

/** Scenario id → the defects that make it fail, for which personas; `unless` drops the entry once that capability is there. */
export const KNOWN_DEFECTS: Record<string, Array<{ id: string; personas: Persona[]; unless?: Capability }>> = {
  "ineligible-citizenship": [{ id: "D2", personas: ["faithful", "adversarial"] }],
  "tbd-deadline": [{ id: "D1", personas: ["faithful", "adversarial"] }],
  "ineligible-region": [{ id: "D1", personas: ["faithful", "adversarial"] }],
  "trip-local": [{ id: "D1", personas: ["faithful", "adversarial"] }],
  "hackathon-dedupe": [{ id: "D3", personas: ["faithful", "adversarial"] }],
  "last-year-only": [{ id: "D4", personas: ["adversarial"] }],
  "injection-mail": [{ id: "D5", personas: ["adversarial"] }],
  "injection-page": [{ id: "D6", personas: ["adversarial"] }],
  "deadline-extended": [{ id: "D7", personas: ["adversarial"] }],
  "visa-too-late": [{ id: "D1", personas: ["faithful", "adversarial"] }],
  "closes-tonight": [{ id: "D1", personas: ["faithful", "adversarial"] }]
};

export const PAIR_DEFECTS: Record<string, string> = {
  "cf-citizenship": "D2",
  "cf-region": "D1",
  "cf-trip": "D1",
  "cf-visa": "D1"
};

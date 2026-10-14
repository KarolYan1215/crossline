import { TYPE_AXES, TYPE_TABLE, type TypeAxisId } from "./portrait-type";

/**
 * What the public quick test's poster and pair card say beyond the type itself (docs/beta-launch.md §1–§2, decided 2026-10-14): a
 * sharper subtitle per type, three lines the type suits and the loop they feed, the relation two types have and what to do about it,
 * and an estimated rank. All of it is fixed text and rules — no model — so two people's posters compare, and every module this file
 * imports must stay pure (the public app imports it in the browser and on its own server).
 */

/** Type codes in table order (SEMP … GIRA). */
export const TYPE_CODES = Object.keys(TYPE_TABLE);

/** The self-mocking second line under each type's name. Drafts the person edits in docs/beta-launch.md §2.1. */
export const TYPE_SUBTITLE: Record<string, string> = {
  SEMP: "计划表精确到分钟，人生唯一的 bug 是没有 bug",
  SEMA: "先试了再说，实验记录比朋友圈还长",
  SERP: "什么都能讲成三点，包括分手",
  SERA: "别人的问题秒回，自己的问题已读不回",
  SIMP: "一件作品磨三年，deadline 是什么能吃吗",
  SIMA: "灵感来了谁也拦不住，灵感走了谁也叫不回",
  SIRP: "三句话不离自己的信仰，转化率感人",
  SIRA: "边走边想边发，草稿箱比作品多",
  GEMP: "给人生画了架构图，然后无限期重构中",
  GEMA: "能跑就行，技术债明天再还（明天从不到来）",
  GERP: "方案写得比谁都好，执行交给「大家」",
  GERA: "认识所有人，唯独约不上自己",
  GIMP: "PPT 里的五年计划已经改到第三版",
  GIMA: "新坑开得比旧坑填得快，坑多到能开游乐园",
  GIRP: "愿景讲得热血沸腾，日程表空得一片祥和",
  GIRA: "八个副本同时开，存档点一个都没有"
};

/** Three lines a type suits and the loop they feed: each step's output is the next one's input, and the last feeds the first. */
export type TypeLines = { lines: [string, string, string]; loop: [string, string, string, string] };

export const TYPE_LINES: Record<string, TypeLines> = {
  SEMP: { lines: ["研究者", "工程师", "讲师"], loop: ["研究成果", "工程实现", "课程讲义", "新的研究问题"] },
  SEMA: { lines: ["实验者", "产品人", "记录者"], loop: ["实验", "小产品", "公开的实验日志", "用户反馈变成新实验"] },
  SERP: { lines: ["学者", "讲师", "作者"], loop: ["研究", "课程", "书稿", "学生的问题回到研究"] },
  SERA: { lines: ["专家", "顾问", "内容作者"], loop: ["专业积累", "咨询案例", "案例文章", "新客户带来新问题"] },
  SIMP: { lines: ["创作者", "导师", "展示者"], loop: ["作品", "教学", "作品展示", "观众反馈养出下一件"] },
  SIMA: { lines: ["创作者", "表演者", "内容作者"], loop: ["即兴作品", "现场表达", "片段剪辑", "灵感素材库"] },
  SIRP: { lines: ["践行者", "讲者", "社群主理人"], loop: ["亲身实践", "分享", "社群", "社群案例回到实践"] },
  SIRA: { lines: ["探索者", "写作者", "播客主"], loop: ["体验", "写作", "播客", "听众带来新去处"] },
  GEMP: { lines: ["工程师", "研究者", "创业者"], loop: ["系统", "方法论", "产品", "用户数据回到系统"] },
  GEMA: { lines: ["开发者", "创业者", "内容作者"], loop: ["拼出的工具", "小产品", "教程", "用户需求变成新工具"] },
  GERP: { lines: ["分析师", "管理者", "写作者"], loop: ["分析", "方案落地", "复盘文章", "影响力带来新课题"] },
  GERA: { lines: ["连接者", "产品人", "内容作者"], loop: ["人脉", "合作项目", "故事内容", "新的人脉"] },
  GIMP: { lines: ["创业者", "研究者", "投资人"], loop: ["事业", "行业洞察", "投资判断", "资源回到事业"] },
  GIMA: { lines: ["发明者", "创业者", "内容作者"], loop: ["新点子", "原型", "公开展示", "反馈筛出值得做的"] },
  GIRP: { lines: ["领导者", "讲者", "社群主理人"], loop: ["愿景", "演讲", "社群", "成员成为执行者"] },
  GIRA: { lines: ["探索者", "内容作者", "投资人"], loop: ["跨界体验", "内容", "判断力", "判断力换来新门票"] }
};

export type RelationId = "twin" | "mirror" | "rabbit_holes" | "double_safe" | "pace" | "well_and_road" | "maker_and_teller" | "data_vs_hunch";
export type Relation = { id: RelationId; name: string; when: string; tips: [string, string]; fit: number };

/**
 * The relations two types can have (docs/beta-launch.md §2.3), from how their four letters agree. `fit` orders the best and the
 * hardest partner for a type: complementary pairs high, the ones that argue about pace or evidence low.
 */
export const RELATIONS: Record<RelationId, Relation> = {
  twin: { id: "twin", name: "复刻搭子", when: "同一类型；只差一条轴时作为第二种关系", fit: 1,
    tips: ["默契高、盲区也一样；重要决定找一个类型不同的人看一眼", "分工别重叠，不然两人抢着做同一件事"] },
  mirror: { id: "mirror", name: "镜像对手", when: "四条轴都不同", fit: -1,
    tips: ["不是最好就是最差：先合作一个两周的小项目试试", "把对方当成自己的盲区检查员，而不是对手"] },
  rabbit_holes: { id: "rabbit_holes", name: "开坑联盟", when: "都是直觉 + 应变", fit: 0,
    tips: ["一起开新坑很快乐；指定一人负责收尾", "每开一个新坑，先关掉一个旧坑"] },
  double_safe: { id: "double_safe", name: "双保险", when: "都是实证 + 规划", fit: 1,
    tips: ["稳，但容易错过机会；每月留一点「冒险预算」", "允许有一件事没有数据也先开始"] },
  pace: { id: "pace", name: "进度条之争", when: "一个规划、一个应变", fit: -2,
    tips: ["约定里程碑，不约定每天的计划", "规划的人给出底线日期，应变的人决定怎么到达"] },
  well_and_road: { id: "well_and_road", name: "挖井的和修路的", when: "一个深耕、一个跨界", fit: 2,
    tips: ["跨界的人定方向，深耕的人定标准", "别让跨界的人一周换三次题目"] },
  maker_and_teller: { id: "maker_and_teller", name: "做的人和讲的人", when: "一个造物、一个传播", fit: 3,
    tips: ["最佳产品搭档：一个做、一个推", "提前分好功劳，署名写清楚"] },
  data_vs_hunch: { id: "data_vs_hunch", name: "数据党 vs 直觉党", when: "一个实证、一个直觉", fit: -2,
    tips: ["争论前先说好：什么证据能让你改主意", "直觉提出假设，数据负责验证"] }
};

const AXIS_INDEX: Record<TypeAxisId, number> = { scope: 0, basis: 1, output: 2, rhythm: 3 };
const DIFFERENCE_RELATION: Array<[TypeAxisId, RelationId]> = [["rhythm", "pace"], ["scope", "well_and_road"], ["output", "maker_and_teller"], ["basis", "data_vs_hunch"]];

const assertCode = (code: string) => {
  if (!TYPE_TABLE[code]) throw new Error(`TYPE_CODE_UNKNOWN: ${code}`);
};

/**
 * The relation of two types, the main one and (when there is one) a second. The same type is a twin; none alike are mirrors; one letter
 * apart, that difference is the main relation and twin the second (so every difference can be the main one — counting three alike as
 * twins left 「数据党 vs 直觉党」 never main); otherwise a shared intuition-and-adapting or evidence-and-planning pair comes first,
 * then the differences in the order pace, scope, output, evidence. Symmetric: the order of the two codes does not matter.
 */
export function relationOf(a: string, b: string): { primary: Relation; secondary?: Relation } {
  assertCode(a); assertCode(b);
  const differs = (axis: TypeAxisId) => a[AXIS_INDEX[axis]] !== b[AXIS_INDEX[axis]];
  const differing = TYPE_AXES.filter((axis) => differs(axis.id)).length;
  const candidates: RelationId[] = [];
  if (differing === 0) candidates.push("twin");
  else if (differing === 4) candidates.push("mirror");
  if (!differs("basis") && !differs("rhythm")) {
    if (a[1] === "I" && a[3] === "A") candidates.push("rabbit_holes");
    if (a[1] === "E" && a[3] === "P") candidates.push("double_safe");
  }
  for (const [axis, relation] of DIFFERENCE_RELATION) if (differs(axis)) candidates.push(relation);
  if (differing === 1) candidates.push("twin");
  const [primary, secondary] = candidates;
  return { primary: RELATIONS[primary!], ...(secondary ? { secondary: RELATIONS[secondary] } : {}) };
}

/** How well two types work together: the main relation's fit, half the second's. */
export const pairFit = (a: string, b: string): number => {
  const { primary, secondary } = relationOf(a, b);
  return primary.fit + (secondary ? secondary.fit / 2 : 0);
};

/** A type's best and hardest partner among the other fifteen, ties broken by table order. */
export function partnersOf(code: string): { best: { code: string; relation: Relation }; hardest: { code: string; relation: Relation } } {
  assertCode(code);
  const others = TYPE_CODES.filter((other) => other !== code).map((other) => ({ code: other, fit: pairFit(code, other) }));
  const best = others.reduce((top, item) => item.fit > top.fit ? item : top);
  const hardest = others.reduce((low, item) => item.fit < low.fit ? item : low);
  return { best: { code: best.code, relation: relationOf(code, best.code).primary }, hardest: { code: hardest.code, relation: relationOf(code, hardest.code).primary } };
}

/** An axis score within ten of the middle: shown light, both letters plausible. */
export const isAmbiguous = (score: number): boolean => Math.abs(score - 50) <= 10;

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7: enough for a whole-number percentage.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Below this many people on record the rank is the theoretical estimate; from it on, the people's own distribution. */
export const OWN_NORM_MINIMUM = 200;

/**
 * 「你的跨界倾向约超过 X% 的人」: the share of people leaning less far towards the pole this score leans to. With fewer than
 * `OWN_NORM_MINIMUM` scores on record it is a theoretical estimate from N(50, 15) and says so (`estimated`); from then on it is the
 * share of recorded scores on the same axis that lean less far. Between 1 and 99.
 */
export function axisRank(axis: TypeAxisId, score: number, recorded: number[] = []): { pole: string; percent: number; estimated: boolean } {
  const definition = TYPE_AXES.find((item) => item.id === axis)!;
  const right = score >= 50;
  const pole = right ? definition.right.label : definition.left.label;
  const lean = Math.abs(score - 50);
  const clamp = (value: number) => Math.max(1, Math.min(99, Math.round(value)));
  if (recorded.length >= OWN_NORM_MINIMUM) {
    const less = recorded.filter((value) => (value >= 50) !== right || Math.abs(value - 50) < lean).length;
    return { pole, percent: clamp(less / recorded.length * 100), estimated: false };
  }
  return { pole, percent: clamp(normalCdf(lean / 15) * 100), estimated: true };
}

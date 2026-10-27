import { tFor, type Locale } from "./i18n";
import { TYPE_AXES, TYPE_TABLE, type TypeAxisId } from "./portrait-type";

/**
 * What the public quick test's poster and pair card say beyond the type itself (docs/beta-launch.md §1–§2, decided 2026-10-14): a
 * sharper subtitle per type, three lines the type suits and the loop they feed, the relation two types have and what to do about it,
 * and an estimated rank. All of it is fixed text and rules — no model — so two people's posters compare, and every module this file
 * imports must stay pure (the public app imports it in the browser and on its own server).
 */

/** Type codes in table order (ROBA … WUHG). */
export const TYPE_CODES = Object.keys(TYPE_TABLE);

/** The line under each type's name: the type's own quote (named by the owner, 2026-10-24). */
export const TYPE_SUBTITLE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_TABLE).map(([code, type]) => [code, type.quote]));

/**
 * 「你不让 AI 碰的」: the poster's second AI line, one per type (2026-10-24). The first, 「AI 替你干的」, comes from the person's own
 * answers (`aiDoes` in assess.ts).
 */
export const AI_KEEPS: Record<string, string> = {
  ROBA: "定稿权（改十八版，拍板还得我来）",
  ROBG: "降落顺序",
  ROHA: "付款按钮",
  ROHG: "我的日程表（AI 敢排，我就敢改）",
  RUBA: "考场上那支笔",
  RUBG: "最后一道大题",
  RUHA: "剪线那一下",
  RUHG: "我的收藏夹（乱，但我知道东西在哪）",
  WOBA: "开火权",
  WOBG: "航向",
  WOHA: "「向右 20cm」的口令",
  WOHG: "下一站去哪",
  WUBA: "心法（招式能学，心法自己悟）",
  WUBG: "最后一计",
  WUHA: "炉火",
  WUHG: "讲故事的那张嘴"
};

/**
 * One recommended line, 「<领域>的<身份>」: the identity at the level of a whole line of life (研究者, 创业者, 创作者, 投资者, a hobby
 * such as 跑者), printed large, and the field it is in, printed small. A licensed profession (医生, 律师, 中医师) is its own identity with
 * no field, rather than 「医疗行业的职场人」 (decided 2026-10-15). Vocabulary and rules: docs/plans/2026-10-15-type-line-combos.md §2.1–§2.3.
 */
export type LineIdentity = { domain: string; identity: string };

/** Every identity a recommendation may use (§2.2's vocabulary, plus the licensed professions). */
export const LINE_IDENTITIES = ["研究者", "学生", "职场人", "创业者", "自由职业者", "投资者", "创作者", "教育者", "社群主理人", "家长", "跑者", "健身者", "骑行者", "户外爱好者", "球友", "舞者", "音乐人", "画手", "摄影者", "写作者", "读者", "手作人", "书法爱好者", "coser", "医生", "律师", "中医师", "设计师", "开发者", "学习者"] as const;

/**
 * 「人工智能的研究者」, or 「医生」 for a line with no field; in English the field goes first as a modifier, "AI researcher". `line` is in
 * Chinese (the tables) and is translated here; a line that is already English (or a model's own words) passes through unchanged.
 */
export function lineText(line: LineIdentity, locale?: Locale): string {
  const t = tFor(locale);
  if (!line.domain) return t(line.identity);
  return locale === "en"
    ? t("{{domain}}的{{identity}}", { domain: t(line.domain), identity: t(line.identity).toLowerCase() })
    : t("{{domain}}的{{identity}}", { domain: line.domain, identity: `${latinGap(line.identity)}${line.identity}` });
}

/** One line from the tables in the reader's language: the field and the identity each translated (Chinese unchanged). */
export const localizeLine = (line: LineIdentity, locale?: Locale): LineIdentity => {
  if (locale !== "en") return line;
  const t = tFor(locale);
  return { domain: line.domain ? t(line.domain) : "", identity: t(line.identity) };
};
/** A space between Chinese and a Latin word (「二次元的 coser」), none between two runs of Chinese. */
export const latinGap = (identity: string): string => /^[A-Za-z]/.test(identity) ? " " : "";

/**
 * What the poster offers a type, as a suggestion (「你也许想做」), not a verdict: the first combination of three lines with the loop they
 * feed (each step's output is the next one's input, the last feeds the first), and three more combinations without a loop. Settled
 * 2026-10-15 from docs/plans/2026-10-15-type-line-combos.md §2.5; within one type the twelve identities never repeat. Moved to the
 * 2026-10-24 types by the nearest old dimension: boundary → collab, orientation → purpose, pacing → build, concentration → lines.
 */
export type TypeLines = {
  lines: [LineIdentity, LineIdentity, LineIdentity];
  loop: [string, string, string, string];
  more: [LineCombo, LineCombo, LineCombo];
};
export type LineCombo = [LineIdentity, LineIdentity, LineIdentity];

export const TYPE_LINES: Record<string, TypeLines> = {
  ROBA: {
    lines: [{ domain: "人工智能", identity: "研究者" }, { domain: "软件工具", identity: "创业者" }, { domain: "指数基金", identity: "投资者" }],
    loop: ["课题里的代码", "做成工具上架", "收入按月定投", "现金流撑住长课题"],
    more: [[{ domain: "互联网", identity: "职场人" }, { domain: "马拉松", identity: "跑者" }, { domain: "技术写作", identity: "写作者" }], [{ domain: "理工科", identity: "学生" }, { domain: "考研辅导", identity: "教育者" }, { domain: "行书", identity: "书法爱好者" }], [{ domain: "古典钢琴", identity: "音乐人" }, { domain: "音乐知识", identity: "创作者" }, { domain: "人文社科", identity: "读者" }]]
  },
  ROHA: {
    lines: [{ domain: "制造业", identity: "职场人" }, { domain: "街头小吃", identity: "创业者" }, { domain: "生活方式", identity: "创作者" }],
    loop: ["工资兜底", "摆摊试新品", "流水拍成 vlog", "数据定下周卖什么"],
    more: [[{ domain: "商科", identity: "学生" }, { domain: "电商运营", identity: "自由职业者" }, { domain: "A 股", identity: "投资者" }], [{ domain: "力量训练", identity: "健身者" }, { domain: "体能训练", identity: "教育者" }, { domain: "公路车", identity: "骑行者" }], [{ domain: "运动科学", identity: "研究者" }, { domain: "攀岩", identity: "户外爱好者" }, { domain: "攀岩同好", identity: "社群主理人" }]]
  },
  WOBA: {
    lines: [{ domain: "社会科学", identity: "研究者" }, { domain: "高等教育", identity: "教育者" }, { domain: "知识科普", identity: "创作者" }],
    loop: ["研究", "系统课程", "知识短视频", "评论区问题回到研究"],
    more: [[{ domain: "文科", identity: "学生" }, { domain: "学习打卡", identity: "社群主理人" }, { domain: "人文社科", identity: "读者" }], [{ domain: "", identity: "医生" }, { domain: "医学人文", identity: "写作者" }, { domain: "二孩家庭", identity: "家长" }], [{ domain: "马拉松", identity: "跑者" }, { domain: "长途骑行", identity: "骑行者" }, { domain: "运动康复", identity: "自由职业者" }]]
  },
  WOHA: {
    lines: [{ domain: "", identity: "医生" }, { domain: "医学科普", identity: "创作者" }, { domain: "临床医学", identity: "研究者" }],
    loop: ["门诊病例", "科普视频", "高频提问", "提问变成研究选题"],
    more: [[{ domain: "", identity: "律师" }, { domain: "法考培训", identity: "教育者" }, { domain: "创业者交流", identity: "社群主理人" }], [{ domain: "金融学", identity: "学生" }, { domain: "个人理财", identity: "写作者" }, { domain: "指数基金", identity: "投资者" }], [{ domain: "低龄孩子", identity: "家长" }, { domain: "亲子摄影", identity: "摄影者" }, { domain: "儿童手工", identity: "手作人" }]]
  },
  RUBA: {
    lines: [{ domain: "陶艺", identity: "手作人" }, { domain: "手工艺品", identity: "创业者" }, { domain: "手工技艺", identity: "创作者" }],
    loop: ["长期练拉坯", "工作室接定制", "拉坯视频", "观众报名体验课"],
    more: [[{ domain: "互联网", identity: "职场人" }, { domain: "长篇小说", identity: "写作者" }, { domain: "文学", identity: "读者" }], [{ domain: "二孩家庭", identity: "家长" }, { domain: "绘本", identity: "画手" }, { domain: "亲子共读", identity: "社群主理人" }], [{ domain: "古典舞", identity: "舞者" }, { domain: "舞台摄影", identity: "摄影者" }, { domain: "舞蹈教学", identity: "教育者" }]]
  },
  RUHA: {
    lines: [{ domain: "艺术类", identity: "学生" }, { domain: "插画", identity: "自由职业者" }, { domain: "绘画", identity: "创作者" }],
    loop: ["课业灵感", "随手接稿", "画画 vlog", "约稿需求变成新练习"],
    more: [[{ domain: "设计行业", identity: "职场人" }, { domain: "独立乐队", identity: "音乐人" }, { domain: "现场演出", identity: "摄影者" }], [{ domain: "二次元", identity: "coser" }, { domain: "道具制作", identity: "手作人" }, { domain: "漫展同好", identity: "社群主理人" }], [{ domain: "爵士舞", identity: "舞者" }, { domain: "舞蹈工作室", identity: "创业者" }, { domain: "街舞教学", identity: "教育者" }]]
  },
  WUBA: {
    lines: [{ domain: "二孩家庭", identity: "家长" }, { domain: "育儿", identity: "创作者" }, { domain: "家长互助", identity: "社群主理人" }],
    loop: ["带娃实践", "育儿笔记", "家长群", "群里案例回到实践"],
    more: [[{ domain: "文学", identity: "读者" }, { domain: "书评", identity: "写作者" }, { domain: "阅读写作", identity: "教育者" }], [{ domain: "行书", identity: "书法爱好者" }, { domain: "传统文化", identity: "研究者" }, { domain: "文房用品", identity: "创业者" }], [{ domain: "", identity: "中医师" }, { domain: "传统功法", identity: "健身者" }, { domain: "健康管理", identity: "自由职业者" }]]
  },
  WUHA: {
    lines: [{ domain: "神经科学", identity: "研究者" }, { domain: "科研生活", identity: "创作者" }, { domain: "随笔", identity: "写作者" }],
    loop: ["研究里的追问", "科研 vlog", "整理成随笔", "读者问题回到研究"],
    more: [[{ domain: "翻译", identity: "自由职业者" }, { domain: "外语", identity: "教育者" }, { domain: "外国文学", identity: "读者" }], [{ domain: "徒步", identity: "户外爱好者" }, { domain: "风光摄影", identity: "摄影者" }, { domain: "户外同好", identity: "社群主理人" }], [{ domain: "互联网", identity: "职场人" }, { domain: "长途骑行", identity: "骑行者" }, { domain: "旅行速写", identity: "画手" }]]
  },
  ROBG: {
    lines: [{ domain: "工程制造", identity: "职场人" }, { domain: "机器人", identity: "研究者" }, { domain: "硬科技", identity: "创业者" }],
    loop: ["工程系统", "研究方法论", "产品化", "用户数据回到系统"],
    more: [[{ domain: "资产配置", identity: "投资者" }, { domain: "数据分析", identity: "教育者" }, { domain: "马拉松", identity: "跑者" }], [{ domain: "工科", identity: "学生" }, { domain: "电子制作", identity: "手作人" }, { domain: "科技数码", identity: "创作者" }], [{ domain: "软件开发", identity: "自由职业者" }, { domain: "力量训练", identity: "健身者" }, { domain: "商业", identity: "读者" }]]
  },
  ROHG: {
    lines: [{ domain: "互联网", identity: "职场人" }, { domain: "AI 应用", identity: "创业者" }, { domain: "AI 技能", identity: "教育者" }],
    loop: ["主业痛点", "AI 拼出小工具", "开工作坊教人", "学员需求变成新工具"],
    more: [[{ domain: "AI 绘画", identity: "自由职业者" }, { domain: "AI 工具", identity: "创作者" }, { domain: "外语", identity: "学生" }], [{ domain: "公路车", identity: "骑行者" }, { domain: "车辆改装", identity: "手作人" }, { domain: "A 股", identity: "投资者" }], [{ domain: "AI 音乐", identity: "音乐人" }, { domain: "街头摄影", identity: "摄影者" }, { domain: "AI 学习", identity: "社群主理人" }]]
  },
  WOBG: {
    lines: [{ domain: "金融行业", identity: "职场人" }, { domain: "美股科技股", identity: "投资者" }, { domain: "财经", identity: "创作者" }],
    loop: ["行业一线信息", "投资判断", "财经复盘", "读者追问校正判断"],
    more: [[{ domain: "公共政策", identity: "研究者" }, { domain: "职业发展", identity: "教育者" }, { domain: "行业交流", identity: "社群主理人" }], [{ domain: "", identity: "律师" }, { domain: "商业思考", identity: "写作者" }, { domain: "马拉松", identity: "跑者" }], [{ domain: "管理学", identity: "学生" }, { domain: "商业", identity: "读者" }, { domain: "校园服务", identity: "创业者" }]]
  },
  WOHG: {
    lines: [{ domain: "企业服务", identity: "职场人" }, { domain: "匹克球", identity: "球友" }, { domain: "同城社交", identity: "社群主理人" }],
    loop: ["客户人脉", "约匹克球", "同城局", "局里的人成为新客户"],
    more: [[{ domain: "海外留学", identity: "学生" }, { domain: "留学经验", identity: "创作者" }, { domain: "留学咨询", identity: "自由职业者" }], [{ domain: "社交电商", identity: "创业者" }, { domain: "一级市场", identity: "投资者" }, { domain: "公路车", identity: "骑行者" }], [{ domain: "社交舞", identity: "舞者" }, { domain: "人物访谈", identity: "写作者" }, { domain: "人像摄影", identity: "摄影者" }]]
  },
  RUBG: {
    lines: [{ domain: "材料科学", identity: "研究者" }, { domain: "餐饮", identity: "创业者" }, { domain: "创业记录", identity: "创作者" }],
    loop: ["专业所学", "小生意起步", "创业日记", "关注者变成首批客户"],
    more: [[{ domain: "商科", identity: "学生" }, { domain: "原创饰品", identity: "手作人" }, { domain: "校园代理", identity: "社群主理人" }], [{ domain: "设计行业", identity: "职场人" }, { domain: "消费品牌", identity: "投资者" }, { domain: "品牌研究", identity: "写作者" }], [{ domain: "原创音乐", identity: "音乐人" }, { domain: "音乐教学", identity: "教育者" }, { domain: "诗歌", identity: "读者" }]]
  },
  RUHG: {
    lines: [{ domain: "设计行业", identity: "职场人" }, { domain: "软件工具", identity: "创业者" }, { domain: "3D 打印", identity: "手作人" }],
    loop: ["设计灵感", "App 原型", "3D 打印小发明", "反馈筛出值得做的"],
    more: [[{ domain: "工科", identity: "学生" }, { domain: "游戏", identity: "创作者" }, { domain: "电子音乐", identity: "音乐人" }], [{ domain: "化学", identity: "研究者" }, { domain: "游戏角色", identity: "coser" }, { domain: "山地车", identity: "骑行者" }], [{ domain: "低龄孩子", identity: "家长" }, { domain: "儿童涂鸦", identity: "画手" }, { domain: "亲子美育", identity: "教育者" }]]
  },
  WUBG: {
    lines: [{ domain: "互联网", identity: "职场人" }, { domain: "马拉松", identity: "跑者" }, { domain: "跑步", identity: "社群主理人" }],
    loop: ["训练计划", "带跑团", "团员一起备赛", "团员进度推着自己练"],
    more: [[{ domain: "理工科", identity: "学生" }, { domain: "自律成长", identity: "创作者" }, { domain: "人文社科", identity: "读者" }], [{ domain: "AI 应用", identity: "创业者" }, { domain: "公开演讲", identity: "教育者" }, { domain: "创业思考", identity: "写作者" }], [{ domain: "广场舞", identity: "舞者" }, { domain: "二孩家庭", identity: "家长" }, { domain: "健康减脂", identity: "健身者" }]]
  },
  WUHG: {
    lines: [{ domain: "平面设计", identity: "自由职业者" }, { domain: "攀岩", identity: "户外爱好者" }, { domain: "户外运动", identity: "创作者" }],
    loop: ["远程接单", "去新岩场攀岩", "拍成户外视频", "视频收入换下一站"],
    more: [[{ domain: "全球资产", identity: "投资者" }, { domain: "长途骑行", identity: "骑行者" }, { domain: "旅行随笔", identity: "写作者" }], [{ domain: "理工科", identity: "学生" }, { domain: "中学数学", identity: "教育者" }, { domain: "街头小吃", identity: "创业者" }], [{ domain: "互联网", identity: "职场人" }, { domain: "街舞", identity: "舞者" }, { domain: "城市漫游", identity: "社群主理人" }]]
  }
};

export type RelationId = "twin" | "mirror" | "cake_dough" | "result_growth" | "blueprint_hands" | "well_stars";
export type Relation = { id: RelationId; name: string; when: string; tips: [string, string]; fit: number };

/**
 * The relations two types can have (rewritten for the AI-era dimensions on 2026-10-24), from which of their four letters differ. `fit`
 * orders the best and the hardest partner for a type: a planner with a hacker and a single line with several are complementary
 * (Turkle & Papert 1990; Teodoridis et al. 2019); one who hands work to AI in pieces and one who works interleaved with it rub the most.
 */
export const RELATIONS: Record<RelationId, Relation> = {
  twin: { id: "twin", name: "同频搭子", when: "四个维度都一样；只差一个维度时作为第二种关系", fit: 1,
    tips: ["每次分工先问一句「我们漏了什么」", "轮流当唱反调的那个人"] },
  mirror: { id: "mirror", name: "互补镜像", when: "四个维度都不一样", fit: -1,
    tips: ["先约定交付物长什么样", "每周对一次进度，不对过程"] },
  cake_dough: { id: "cake_dough", name: "切蛋糕和揉面团", when: "一个想把活切开分，一个想全程一起磨", fit: -2,
    tips: ["先切大块，块内各自用自己的方式", "约好哪几段一起做"] },
  result_growth: { id: "result_growth", name: "要结果和要成长", when: "一个嫌对方慢，一个嫌对方糙", fit: 0,
    tips: ["交付日期由要结果的人定", "复盘由要成长的人主持"] },
  blueprint_hands: { id: "blueprint_hands", name: "图纸派和手感派", when: "一个要先看计划，一个已经做出半成品", fit: 3,
    tips: ["图纸只画到能开工为止", "半成品拿来改图纸"] },
  well_stars: { id: "well_stars", name: "深井和星图", when: "一个嫌对方不专注，一个嫌对方太窄", fit: 2,
    tips: ["合作只挑两人主线重叠的那件事", "星图那位负责介绍资源，深井那位负责做深"] }
};

/** A relation in the reader's language (the table is Chinese; its English is in the quick test's catalogue). */
export function localizeRelation(relation: Relation, locale?: Locale): Relation {
  if (locale !== "en") return relation;
  const t = tFor(locale);
  return { ...relation, name: t(relation.name), when: t(relation.when), tips: [t(relation.tips[0]), t(relation.tips[1])] };
}

const AXIS_INDEX: Record<TypeAxisId, number> = { collab: 0, purpose: 1, build: 2, lines: 3 };
const DIFFERENCE_RELATION: Array<[TypeAxisId, RelationId]> = [["collab", "cake_dough"], ["build", "blueprint_hands"], ["lines", "well_stars"], ["purpose", "result_growth"]];

const assertCode = (code: string) => {
  if (!TYPE_TABLE[code]) throw new Error(`TYPE_CODE_UNKNOWN: ${code}`);
};

/**
 * The relation of two types, the main one and (when there is one) a second. The same type is a twin; none alike are mirrors, with no
 * second relation; otherwise the differences in the order collab, build, lines, purpose, and, one letter apart, twin as the second. So
 * each type's best partner differs from it in how it builds and how many lines it runs (图纸派和手感派), and its hardest differs in how it
 * works with AI and what it uses AI for. Symmetric: the order of the two codes does not matter.
 */
export function relationOf(a: string, b: string): { primary: Relation; secondary?: Relation } {
  assertCode(a); assertCode(b);
  const differs = (axis: TypeAxisId) => a[AXIS_INDEX[axis]] !== b[AXIS_INDEX[axis]];
  const differing = TYPE_AXES.filter((axis) => differs(axis.id)).length;
  if (differing === 0) return { primary: RELATIONS.twin };
  if (differing === 4) return { primary: RELATIONS.mirror };
  const candidates: RelationId[] = DIFFERENCE_RELATION.filter(([axis]) => differs(axis)).map(([, relation]) => relation);
  if (differing === 1) candidates.push("twin");
  const [primary, secondary] = candidates;
  return { primary: RELATIONS[primary!], ...(secondary ? { secondary: RELATIONS[secondary] } : {}) };
}

/** How well two types work together: the main relation's fit, half the second's. */
export const pairFit = (a: string, b: string): number => {
  const { primary, secondary } = relationOf(a, b);
  return primary.fit + (secondary ? secondary.fit / 2 : 0);
};

/** A type's best and hardest partner among the other fifteen, ties broken by fewer letters apart, then table order. */
export function partnersOf(code: string): { best: { code: string; relation: Relation }; hardest: { code: string; relation: Relation } } {
  assertCode(code);
  const apart = (other: string) => [...other].filter((letter, index) => letter !== code[index]).length;
  const others = TYPE_CODES.filter((other) => other !== code).map((other) => ({ code: other, fit: pairFit(code, other), apart: apart(other) }));
  const best = others.reduce((top, item) => item.fit > top.fit || (item.fit === top.fit && item.apart < top.apart) ? item : top);
  const hardest = others.reduce((low, item) => item.fit < low.fit || (item.fit === low.fit && item.apart < low.apart) ? item : low);
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

/** Above this a rank is not shown as it is: everyone with a strong lean would post the same 99. */
export const RANK_CAP = 95;

// FNV-1a, 32 bits: a stable spread for a string, nothing more.
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

/**
 * The percentage a person sees (decided 2026-10-15): at or under `RANK_CAP` as computed; above it, a number from 91 to 96 picked by a
 * hash of the result and the axis, so two people with a strong lean do not post the same figure and one result always shows the same
 * one. The same rule for the estimate and for the people's own distribution.
 */
export function shownRank(percent: number, seed: string, axis: TypeAxisId): number {
  return percent <= RANK_CAP ? percent : 91 + fnv1a(`${seed}:${axis}`) % 6;
}

/**
 * 「你的多线并行倾向约超过 X% 的人」: the share of people leaning less far towards the pole this score leans to. With fewer than
 * `OWN_NORM_MINIMUM` scores on record it is a theoretical estimate from N(50, 15) and says so (`estimated`); from then on it is the
 * share of recorded scores on the same axis that lean less far. Between 1 and 96: anything over `RANK_CAP` goes through `shownRank`,
 * keyed by `seed` (the result's id), so a poster, its long image, the pair card and the page all show the same number.
 */
export function axisRank(axis: TypeAxisId, score: number, recorded: number[] = [], seed = ""): { pole: string; percent: number; estimated: boolean } {
  const definition = TYPE_AXES.find((item) => item.id === axis)!;
  const right = score >= 50;
  const pole = right ? definition.right.label : definition.left.label;
  const lean = Math.abs(score - 50);
  const clamp = (value: number) => shownRank(Math.max(1, Math.min(99, Math.round(value))), seed, axis);
  if (recorded.length >= OWN_NORM_MINIMUM) {
    const less = recorded.filter((value) => (value >= 50) !== right || Math.abs(value - 50) < lean).length;
    return { pole, percent: clamp(less / recorded.length * 100), estimated: false };
  }
  return { pole, percent: clamp(normalCdf(lean / 15) * 100), estimated: true };
}
export * from "./assess-kindred";

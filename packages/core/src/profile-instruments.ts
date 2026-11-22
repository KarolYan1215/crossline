// i18n-exempt: instrument item texts are the instrument itself — the Chinese is our translation (译本待校), the English the published original
/**
 * The scale the person fills in on one page before the interview's first round (docs/plans/2026-11-22-interview-and-import-redesign.md
 * §二.2, decision D1 of 2026-11-22). It replaces the 43-item card bank of 2026-10-31 (Mini-IPIP, 18REST, SWLS and our own value
 * tradeoffs), whose short set of 14 was asked a few items a round for about six rounds running.
 *
 * Sources and licences:
 * - IPIP-NEO-120 (Johnson, J. A. 2014, "Measuring thirty facets of the Five Factor Model with a 120-item public domain inventory",
 *   Journal of Research in Personality 51, 78–89; items and keys at https://ipip.ori.org/): public domain, any use. Five domains of
 *   24 items, thirty facets of four, rated 1–5 (Very Inaccurate … Very Accurate).
 * - TwIVI (Sandy, Gosling, Schwartz & Koelkebeck 2017, "The development and validation of brief and ultrabrief measures of values",
 *   Journal of Personality Assessment 99(5), 545–555; https://gosling.psy.utexas.edu/): free for any use, no permission needed. Twenty
 *   portraits, two per Schwartz value, rated 1–6 (not like me at all … very much like me), no reverse keying.
 *
 * 译本待校: every Chinese item below is our own translation, made on 2026-11-22 and not yet back-translated or checked against a
 * published Chinese IPIP-NEO version. The English original is kept beside it (`en`), so the person can see what was meant.
 *
 * The scoring is code, not a model (it is arithmetic): reverse keys, facet sums, domain means, percentiles against a published norm
 * (`NEO_NORMS`, with its limits in `NORM_NOTE`), and the values' order after centring on the person's own mean.
 */
import { SCHWARTZ_VALUES } from "./portrait";

export type InstrumentId = "ipip_neo_120" | "twivi";
export type Domain = "N" | "E" | "O" | "A" | "C";
/** Kept for the dialogue's card code until it is removed (the scale is no longer asked a card at a time inside the interview). */
export type ProfileStage = "narrative" | "situation" | "compass" | "energy";
/** Labels under the first, middle and last point (the scale page labels every point, `pointLabels`). */
export type Anchors = readonly [string, string, string];

export type ScaleItem = {
  id: string;
  instrument: InstrumentId;
  /** A Big Five domain (N E O A C) or a Schwartz value (its Chinese name, `SCHWARTZ_VALUES`). */
  dimension: string;
  /** The IPIP-NEO facet (`N1` … `C6`); absent for TwIVI. */
  facet?: string;
  /** The item in Chinese (our translation, 译本待校). */
  text: string;
  /** The published English original. */
  en: string;
  /** Scored (points + 1) − answer. */
  reverse: boolean;
  /** Points on the item's scale: 5 (IPIP) or 6 (TwIVI). */
  points: 5 | 6;
  anchors: Anchors;
  /** Where the item comes from, for the report's 「依据」. */
  source: string;
};

const NEO_POINTS = ["很不符合", "比较不符合", "说不准", "比较符合", "很符合"] as const;
const NEO_POINTS_EN = ["Very inaccurate", "Moderately inaccurate", "Neither", "Moderately accurate", "Very accurate"] as const;
const TWIVI_POINTS = ["完全不像我", "不像我", "有一点像我", "有些像我", "像我", "非常像我"] as const;
const TWIVI_POINTS_EN = ["Not like me at all", "Not like me", "A little like me", "Somewhat like me", "Like me", "Very much like me"] as const;
/** Every point's label, first to last: the scale page shows them all. */
export const pointLabels = (item: Pick<ScaleItem, "instrument">, locale: "zh" | "en" = "zh"): readonly string[] =>
  item.instrument === "twivi" ? (locale === "en" ? TWIVI_POINTS_EN : TWIVI_POINTS) : (locale === "en" ? NEO_POINTS_EN : NEO_POINTS);

const NEO_SOURCE = "IPIP-NEO-120（Johnson 2014，公有领域；中文为自译，译本待校）";
const TWIVI_SOURCE = "TwIVI 二十题价值观量表（Sandy 等 2017，任何用途免费；中文为自译，译本待校）";

/** Facet names, in Johnson's order (N1 Anxiety … C6 Cautiousness). */
export const FACET_LABEL: Record<string, string> = {
  N1: "焦虑", N2: "易怒", N3: "抑郁倾向", N4: "自我意识", N5: "冲动", N6: "脆弱",
  E1: "友善", E2: "合群", E3: "果断", E4: "活跃", E5: "寻求刺激", E6: "愉悦",
  O1: "想象力", O2: "审美", O3: "情感丰富", O4: "求新", O5: "思辨", O6: "观念开放",
  A1: "信任", A2: "坦诚", A3: "利他", A4: "合作", A5: "谦逊", A6: "同情",
  C1: "自我效能", C2: "条理", C3: "尽职", C4: "追求成就", C5: "自律", C6: "谨慎"
};
export const DOMAIN_LABEL: Record<Domain, string> = { N: "神经质", E: "外向性", O: "开放性", A: "宜人性", C: "尽责性" };

/**
 * IPIP-NEO-120 in Johnson's order: [domain, facet number, keyed plus, English, Chinese]. The domains cycle N E O A C and the facets one
 * to six, so a page of the scale never holds four items of one facet together.
 */
const NEO: ReadonlyArray<readonly [Domain, number, boolean, string, string]> = [
  ["N", 1, true, "Worry about things", "常为各种事担心"],
  ["E", 1, true, "Make friends easily", "容易交到朋友"],
  ["O", 1, true, "Have a vivid imagination", "想象力丰富生动"],
  ["A", 1, true, "Trust others", "信任别人"],
  ["C", 1, true, "Complete tasks successfully", "能顺利完成任务"],
  ["N", 2, true, "Get angry easily", "容易发火"],
  ["E", 2, true, "Love large parties", "喜欢人多的大型聚会"],
  ["O", 2, true, "Believe in the importance of art", "认为艺术很重要"],
  ["A", 2, false, "Use others for my own ends", "会利用别人达到自己的目的"],
  ["C", 2, true, "Like to tidy up", "喜欢收拾整理"],
  ["N", 3, true, "Often feel blue", "常常情绪低落"],
  ["E", 3, true, "Take charge", "会主动担起领头的责任"],
  ["O", 3, true, "Experience my emotions intensely", "情绪体验很强烈"],
  ["A", 3, true, "Love to help others", "乐于帮助别人"],
  ["C", 3, true, "Keep my promises", "说到做到"],
  ["N", 4, true, "Find it difficult to approach others", "很难主动去接近别人"],
  ["E", 4, true, "Am always busy", "总是很忙"],
  ["O", 4, true, "Prefer variety to routine", "比起一成不变，更喜欢变化"],
  ["A", 4, false, "Love a good fight", "喜欢和人争个高下"],
  ["C", 4, true, "Work hard", "做事努力"],
  ["N", 5, true, "Go on binges", "会放纵过度（暴饮暴食、狂买之类）"],
  ["E", 5, true, "Love excitement", "喜欢刺激"],
  ["O", 5, true, "Love to read challenging material", "喜欢读有难度的东西"],
  ["A", 5, false, "Believe that I am better than others", "觉得自己比别人强"],
  ["C", 5, true, "Am always prepared", "总是事先做好准备"],
  ["N", 6, true, "Panic easily", "容易慌"],
  ["E", 6, true, "Radiate joy", "浑身洋溢着快乐"],
  ["O", 6, true, "Tend to vote for liberal political candidates", "政治上倾向支持自由派（进步派）的主张和候选人"],
  ["A", 6, true, "Sympathize with the homeless", "同情无家可归的人"],
  ["C", 6, false, "Jump into things without thinking", "不假思索就一头扎进去"],
  ["N", 1, true, "Fear for the worst", "总往最坏处担心"],
  ["E", 1, true, "Feel comfortable around people", "和人在一起时感到自在"],
  ["O", 1, true, "Enjoy wild flights of fantasy", "喜欢天马行空的幻想"],
  ["A", 1, true, "Believe that others have good intentions", "相信别人是出于好意"],
  ["C", 1, true, "Excel in what I do", "在自己做的事上表现出色"],
  ["N", 2, true, "Get irritated easily", "容易被惹恼"],
  ["E", 2, true, "Talk to a lot of different people at parties", "在聚会上会和很多不同的人交谈"],
  ["O", 2, true, "See beauty in things that others might not notice", "能在别人注意不到的事物里看到美"],
  ["A", 2, false, "Cheat to get ahead", "为了领先会耍手段"],
  ["C", 2, false, "Often forget to put things back in their proper place", "常忘了把东西放回原处"],
  ["N", 3, true, "Dislike myself", "不喜欢自己"],
  ["E", 3, true, "Try to lead others", "试着带领别人"],
  ["O", 3, true, "Feel others' emotions", "能感受到别人的情绪"],
  ["A", 3, true, "Am concerned about others", "关心别人"],
  ["C", 3, true, "Tell the truth", "说实话"],
  ["N", 4, true, "Am afraid to draw attention to myself", "害怕引起别人注意"],
  ["E", 4, true, "Am always on the go", "总是闲不下来"],
  ["O", 4, false, "Prefer to stick with things that I know", "更愿意守着自己熟悉的东西"],
  ["A", 4, false, "Yell at people", "会冲人大喊大叫"],
  ["C", 4, true, "Do more than what's expected of me", "做得比要求的更多"],
  ["N", 5, false, "Rarely overindulge", "很少放纵过度"],
  ["E", 5, true, "Seek adventure", "追求冒险"],
  ["O", 5, false, "Avoid philosophical discussions", "避开哲学性的讨论"],
  ["A", 5, false, "Think highly of myself", "对自己评价很高"],
  ["C", 5, true, "Carry out my plans", "会把计划付诸实行"],
  ["N", 6, true, "Become overwhelmed by events", "遇事容易被压垮"],
  ["E", 6, true, "Have a lot of fun", "过得很开心"],
  ["O", 6, true, "Believe that there is no absolute right and wrong", "认为没有绝对的对与错"],
  ["A", 6, true, "Feel sympathy for those who are worse off than myself", "同情境况比自己差的人"],
  ["C", 6, false, "Make rash decisions", "草率做决定"],
  ["N", 1, true, "Am afraid of many things", "害怕很多事"],
  ["E", 1, false, "Avoid contacts with others", "避免和别人接触"],
  ["O", 1, true, "Love to daydream", "喜欢做白日梦"],
  ["A", 1, true, "Trust what people say", "相信别人说的话"],
  ["C", 1, true, "Handle tasks smoothly", "处理事情得心应手"],
  ["N", 2, true, "Lose my temper", "会发脾气"],
  ["E", 2, false, "Prefer to be alone", "更喜欢一个人待着"],
  ["O", 2, false, "Do not like poetry", "不喜欢诗歌"],
  ["A", 2, false, "Take advantage of others", "占别人便宜"],
  ["C", 2, false, "Leave a mess in my room", "把房间弄得乱七八糟"],
  ["N", 3, true, "Am often down in the dumps", "常常闷闷不乐"],
  ["E", 3, true, "Take control of things", "掌控局面"],
  ["O", 3, false, "Rarely notice my emotional reactions", "很少察觉自己的情绪反应"],
  ["A", 3, false, "Am indifferent to the feelings of others", "对别人的感受无动于衷"],
  ["C", 3, false, "Break rules", "违反规则"],
  ["N", 4, true, "Only feel comfortable with friends", "只有和朋友在一起才自在"],
  ["E", 4, true, "Do a lot in my spare time", "空闲时间也做很多事"],
  ["O", 4, false, "Dislike changes", "不喜欢变化"],
  ["A", 4, false, "Insult people", "出口伤人"],
  ["C", 4, false, "Do just enough work to get by", "只做够应付的那点事"],
  ["N", 5, false, "Easily resist temptations", "能轻松抵挡诱惑"],
  ["E", 5, true, "Enjoy being reckless", "享受不顾后果的感觉"],
  ["O", 5, false, "Have difficulty understanding abstract ideas", "理解抽象概念有困难"],
  ["A", 5, false, "Have a high opinion of myself", "自视甚高"],
  ["C", 5, false, "Waste my time", "浪费时间"],
  ["N", 6, true, "Feel that I'm unable to deal with things", "觉得自己应付不了事情"],
  ["E", 6, true, "Love life", "热爱生活"],
  ["O", 6, false, "Tend to vote for conservative political candidates", "政治上倾向支持保守派的主张和候选人"],
  ["A", 6, false, "Am not interested in other people's problems", "对别人的难处不感兴趣"],
  ["C", 6, false, "Rush into things", "做事操之过急"],
  ["N", 1, true, "Get stressed out easily", "容易感到压力大"],
  ["E", 1, false, "Keep others at a distance", "和别人保持距离"],
  ["O", 1, true, "Like to get lost in thought", "喜欢沉浸在思考里"],
  ["A", 1, false, "Distrust people", "不信任别人"],
  ["C", 1, true, "Know how to get things done", "知道怎样把事情办成"],
  ["N", 2, false, "Am not easily annoyed", "不容易被惹恼"],
  ["E", 2, false, "Avoid crowds", "避开人群"],
  ["O", 2, false, "Do not enjoy going to art museums", "不喜欢去美术馆"],
  ["A", 2, false, "Obstruct others' plans", "阻挠别人的计划"],
  ["C", 2, false, "Leave my belongings around", "东西随手乱放"],
  ["N", 3, false, "Feel comfortable with myself", "对自己感到自在"],
  ["E", 3, false, "Wait for others to lead the way", "等别人带头"],
  ["O", 3, false, "Don't understand people who get emotional", "不理解那些动感情的人"],
  ["A", 3, false, "Take no time for others", "不为别人花时间"],
  ["C", 3, false, "Break my promises", "说话不算数"],
  ["N", 4, false, "Am not bothered by difficult social situations", "不怕尴尬棘手的社交场合"],
  ["E", 4, false, "Like to take it easy", "喜欢悠闲从容"],
  ["O", 4, false, "Am attached to conventional ways", "习惯沿用常规做法"],
  ["A", 4, false, "Get back at others", "会报复别人"],
  ["C", 4, false, "Put little time and effort into my work", "在工作上投入很少时间和精力"],
  ["N", 5, false, "Am able to control my cravings", "能控制住自己的欲望"],
  ["E", 5, true, "Act wild and crazy", "举止狂放"],
  ["O", 5, false, "Am not interested in theoretical discussions", "对理论探讨不感兴趣"],
  ["A", 5, false, "Boast about my virtues", "夸耀自己的优点"],
  ["C", 5, false, "Have difficulty starting tasks", "很难开始动手做事"],
  ["N", 6, false, "Remain calm under pressure", "压力下能保持冷静"],
  ["E", 6, true, "Look at the bright side of life", "看到生活光明的一面"],
  ["O", 6, false, "Believe that we should be tough on crime", "认为应该严厉打击犯罪"],
  ["A", 6, false, "Try not to think about the needy", "尽量不去想那些贫困的人"],
  ["C", 6, false, "Act without thinking", "做事不经思考"]
];

/** TwIVI in its published order: [value (Chinese name, `SCHWARTZ_VALUES`), English portrait, Chinese portrait]. */
const TWIVI: ReadonlyArray<readonly [string, string, string]> = [
  ["遵从", "S/he believes s/he should always show respect to his/her parents and to older people. It is important to him/her to be obedient.", "Ta 认为应该始终尊重父母和长辈，听话对 Ta 很重要。"],
  ["传统", "Religious belief is important to him/her. S/he tries hard to do what his religion requires.", "宗教信仰对 Ta 很重要，Ta 努力做到自己的宗教所要求的。"],
  ["仁慈", "It's very important to him/her to help the people around him/her. S/he wants to care for their well-being.", "帮助身边的人对 Ta 非常重要，Ta 想照顾好他们。"],
  ["普世", "S/he thinks it is important that every person in the world be treated equally. S/he believes everyone should have equal opportunities in life.", "Ta 认为世上每个人都应受到平等对待，每个人都应有平等的人生机会。"],
  ["自主", "S/he thinks it's important to be interested in things. S/he likes to be curious and to try to understand all sorts of things.", "Ta 认为对事物保持兴趣很重要，喜欢好奇、想弄懂各种各样的事。"],
  ["刺激", "S/he likes to take risks. S/he is always looking for adventures.", "Ta 喜欢冒险，总在寻找新的历险。"],
  ["享乐", "S/he seeks every chance he can to have fun. It is important to him/her to do things that give him/her pleasure.", "Ta 抓住一切机会找乐子，做让自己快乐的事对 Ta 很重要。"],
  ["成就", "Getting ahead in life is important to him/her. S/he strives to do better than others.", "在人生中出人头地对 Ta 很重要，Ta 努力比别人做得更好。"],
  ["权力", "S/he always wants to be the one who makes the decisions. S/he likes to be the leader.", "Ta 总想当拍板的人，喜欢做领头的。"],
  ["安全", "It is important to him/her that things be organized and clean. S/he really does not like things to be a mess.", "东西整齐干净对 Ta 很重要，Ta 很不喜欢乱糟糟。"],
  ["遵从", "It is important to him/her to always behave properly. S/he wants to avoid doing anything people would say is wrong.", "举止得体对 Ta 很重要，Ta 不想做任何别人会说不对的事。"],
  ["传统", "S/he thinks it is best to do things in traditional ways. It is important to him/her to keep up the customs s/he has learned.", "Ta 认为按传统的方式做事最好，保持学到的习俗对 Ta 很重要。"],
  ["仁慈", "It is important to him/her to respond to the needs of others. S/he tries to support those s/he knows.", "回应别人的需要对 Ta 很重要，Ta 尽力支持自己认识的人。"],
  ["普世", "S/he believes all the worlds' people should live in harmony. Promoting peace among all groups in the world is important to him/her.", "Ta 认为全世界的人都应和睦相处，促进各群体之间的和平对 Ta 很重要。"],
  ["自主", "Thinking up new ideas and being creative is important to him/her. S/he likes to do things in his/her own original way.", "想出新点子、有创造力对 Ta 很重要，Ta 喜欢用自己独特的方式做事。"],
  ["刺激", "S/he thinks it is important to do lots of different things in life. S/he always looks for new things to try.", "Ta 认为人生中做很多不同的事很重要，总在找新东西去尝试。"],
  ["享乐", "S/he really wants to enjoy life. Having a good time is very important to him/her.", "Ta 非常想享受生活，过得开心对 Ta 很重要。"],
  ["成就", "Being very successful is important to him/her. S/he likes to impress other people.", "非常成功对 Ta 很重要，Ta 喜欢让别人刮目相看。"],
  ["权力", "It is important to him/her to be in charge and tell others what to do. S/he wants people to do what s/he says.", "当家作主、告诉别人该做什么对 Ta 很重要，Ta 希望别人照 Ta 说的做。"],
  ["安全", "Having a stable government is important to him/her. S/he is concerned that the social order be protected.", "政府稳定对 Ta 很重要，Ta 在意社会秩序能否得到维护。"]
];

/** Every item: the 120 IPIP-NEO items (`neo-1` … `neo-120`), then the 20 TwIVI portraits (`twivi-1` … `twivi-20`). */
export const PROFILE_ITEMS: readonly ScaleItem[] = [
  ...NEO.map(([domain, facet, plus, en, text], index): ScaleItem => ({ id: `neo-${index + 1}`, instrument: "ipip_neo_120", dimension: domain,
    facet: `${domain}${facet}`, text, en, reverse: !plus, points: 5, anchors: [NEO_POINTS[0], NEO_POINTS[2], NEO_POINTS[4]], source: NEO_SOURCE })),
  ...TWIVI.map(([value, en, text], index): ScaleItem => ({ id: `twivi-${index + 1}`, instrument: "twivi", dimension: value, text, en,
    reverse: false, points: 6, anchors: [TWIVI_POINTS[0], TWIVI_POINTS[2], TWIVI_POINTS[5]], source: TWIVI_SOURCE }))
];

const ITEMS_BY_ID = new Map(PROFILE_ITEMS.map((item) => [item.id, item]));
export const profileItem = (id: string): ScaleItem | undefined => ITEMS_BY_ID.get(id);

export const DIMENSION_LABEL: Record<InstrumentId, Record<string, string>> = {
  ipip_neo_120: DOMAIN_LABEL,
  twivi: Object.fromEntries(SCHWARTZ_VALUES.map((value) => [value.name, value.name]))
};
export const CARD_TITLE: Record<InstrumentId, string> = { ipip_neo_120: "像不像你", twivi: "这个人像不像你" };

/**
 * The norm the percentiles are read against (`NORM_NOTE`): Kajonius & Johnson 2019, Europe's Journal of Psychology 15(2), Table A1 —
 * the IPIP-NEO-120 answered online by 320,128 adults in the United States (60 % women, mean age 28). Facets are sums of four items
 * (4–20); a domain is the mean of its six facet sums, on the same 4–20 range.
 */
export const NEO_NORMS: Record<string, { mean: number; sd: number }> = {
  N: { mean: 11.10, sd: 2.66 }, N1: { mean: 12.07, sd: 3.77 }, N2: { mean: 11.51, sd: 4.11 }, N3: { mean: 9.35, sd: 3.87 }, N4: { mean: 11.69, sd: 3.64 }, N5: { mean: 11.94, sd: 3.44 }, N6: { mean: 10.07, sd: 3.63 },
  E: { mean: 13.69, sd: 2.36 }, E1: { mean: 14.48, sd: 3.60 }, E2: { mean: 12.36, sd: 4.02 }, E3: { mean: 14.56, sd: 3.43 }, E4: { mean: 12.84, sd: 3.15 }, E5: { mean: 12.52, sd: 3.32 }, E6: { mean: 15.35, sd: 3.20 },
  O: { mean: 13.71, sd: 2.06 }, O1: { mean: 14.60, sd: 3.41 }, O2: { mean: 14.67, sd: 3.58 }, O3: { mean: 15.20, sd: 3.01 }, O4: { mean: 12.28, sd: 3.26 }, O5: { mean: 14.50, sd: 3.55 }, O6: { mean: 11.03, sd: 3.67 },
  A: { mean: 14.87, sd: 2.01 }, A1: { mean: 13.43, sd: 3.54 }, A2: { mean: 16.63, sd: 2.88 }, A3: { mean: 16.72, sd: 2.56 }, A4: { mean: 15.10, sd: 3.49 }, A5: { mean: 12.34, sd: 3.35 }, A6: { mean: 15.03, sd: 3.10 },
  C: { mean: 14.95, sd: 2.34 }, C1: { mean: 16.32, sd: 2.40 }, C2: { mean: 13.23, sd: 4.31 }, C3: { mean: 16.32, sd: 2.57 }, C4: { mean: 16.06, sd: 3.09 }, C5: { mean: 14.07, sd: 3.16 }, C6: { mean: 13.68, sd: 4.09 }
};
/** What a percentile is and is not, said wherever one is shown. */
export const NORM_NOTE = "百分位对照 Kajonius 与 Johnson 2019 发表的常模：32 万名美国成年人在网上作答的英文版 IPIP-NEO-120（六成女性，平均 28 岁）。"
  + "局限：常模来自英文版和美国样本，中文译本尚未校验，也没有按性别、年龄或文化分组；百分位按正态分布近似换算。只当参照，不是诊断。"
  + "价值观没有可用的常模，只看自己内部的排序（每项减去本人 20 题的平均分后的高低）。";

/** The standard normal distribution function (Abramowitz & Stegun 7.1.26, error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
/** A percentile 1–99 against `NEO_NORMS` (never 0 or 100: a normal approximation says nothing that certain). */
export const neoPercentile = (key: string, value: number): number | null => {
  const norm = NEO_NORMS[key];
  return norm ? Math.min(99, Math.max(1, Math.round(normalCdf((value - norm.mean) / norm.sd) * 100))) : null;
};

/** Kept for the dialogue's card code until it is removed: there are no cards in the interview any more (`cardsFor`). */
export type ProfileCard = { id: string; instrument: InstrumentId; title: string; stage: ProfileStage; items: ScaleItem[] };
export type CardSet = "short" | "all";
/** The items the interview asks as cards: none (`"short"`) since the scale is a page of its own before the interview; `"all"` is the bank. */
export const cardBank = (set: CardSet = "all"): readonly ScaleItem[] => set === "all" ? PROFILE_ITEMS : [];
/**
 * No cards inside the interview any more (2026-11-22, D1): the whole scale is one page before the first round. Kept with its old
 * signature so the dialogue keeps compiling until its card code is removed; it offers nothing.
 */
export function cardsFor(_stages: ProfileStage | readonly ProfileStage[], _settled: ReadonlySet<string>, _limit?: number, _itemLimit?: number,
  _set?: CardSet): ProfileCard[] {
  return [];
}

/** What is kept per item (setting `PROFILE_INSTRUMENTS_SETTING`). `mapped` answers came from the extraction reading the person's words. */
export type ItemAnswer = {
  itemId: string;
  /** 1 to the item's `points` as answered, before reverse keying; absent when skipped or pending. */
  score?: number;
  /** `pending`: answered in words the extraction has not read yet; it counts as unanswered until it is mapped. */
  by: "tapped" | "mapped" | "skipped" | "pending";
  /** 0–1, for mapped answers. */
  confidence?: number;
  /** Evidence sentence ids the mapping rests on. */
  refs?: number[];
  at: string;
};
export const PROFILE_INSTRUMENTS_SETTING = "profile.instruments";
export type InstrumentAnswers = Record<string, ItemAnswer>;

/** The answers on record; an answer to an item no longer in the bank (the 43-item cards before 2026-11-22) is not read. */
export function readInstrumentAnswers(raw: string | null | undefined): InstrumentAnswers {
  try {
    const value = JSON.parse(raw ?? "{}") as InstrumentAnswers;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, answer]) => ITEMS_BY_ID.has(id) && answer && typeof answer === "object"));
  } catch { return {}; }
}

/** Whether a score is a point of this item's scale. */
export const validScore = (item: Pick<ScaleItem, "points"> | undefined, score: unknown): score is number =>
  typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= (item?.points ?? 5);

/** How much an answer says: a tap over a mapping over words waiting to be read over a skip. */
const WEIGHT: Record<ItemAnswer["by"], number> = { tapped: 3, mapped: 2, pending: 1, skipped: 0 };

/**
 * Adds answers to what is kept. An answer never gives way to one that says less (the person's own tap is never replaced by a mapping, a
 * skip never replaces words), and a later answer of the same kind replaces an earlier one.
 */
export function mergeInstrumentAnswers(kept: InstrumentAnswers, incoming: ItemAnswer[]): InstrumentAnswers {
  const next = { ...kept };
  for (const answer of incoming) {
    const item = ITEMS_BY_ID.get(answer.itemId);
    if (!item) continue;
    if ((answer.by === "tapped" || answer.by === "mapped") && !validScore(item, answer.score)) continue;
    const before = next[answer.itemId];
    if (before && WEIGHT[before.by] > WEIGHT[answer.by]) continue;
    next[answer.itemId] = answer;
  }
  return next;
}

/** Items answered in words and not yet mapped: what the extraction is asked to score (`scaleItems`). None arise from the scale page. */
export const pendingItems = (answers: InstrumentAnswers): ScaleItem[] =>
  PROFILE_ITEMS.filter((item) => answers[item.id]?.by === "pending");

/** Items answered or skipped. */
export const settledItems = (answers: InstrumentAnswers): Set<string> => new Set(Object.keys(answers));

export type Administration = "tapped" | "mapped" | "mixed";
export type DimensionScore = {
  instrument: InstrumentId;
  dimension: string;
  label: string;
  /**
   * 0–100, or null when there is too little to score: a domain's percentile (IPIP-NEO), or a value's raw mean on 0–100 (TwIVI). Read a
   * value's place from `centered` and `rank`, never from this number against other people.
   */
  score: number | null;
  /** A domain's mean facet sum (4–20), a value's mean item score (1–6). */
  raw?: number;
  /** IPIP-NEO only: the percentile against `NEO_NORMS`. */
  percentile?: number;
  /** TwIVI only: the value's mean minus the person's mean over every TwIVI item answered (Sandy et al.'s mean centring). */
  centered?: number;
  /** TwIVI only: 1 = the value the person rates highest of the ten. */
  rank?: number;
  items: number;
  tapped: number;
  mapped: number;
  skipped: number;
  administration: Administration;
};
export type FacetScore = { facet: string; domain: Domain; label: string; sum: number | null; percentile: number | null; answered: number };

const administrationOf = (tapped: number, mapped: number): Administration =>
  mapped === 0 ? "tapped" : tapped === 0 ? "mapped" : "mixed";
const keyed = (item: ScaleItem, score: number) => item.reverse ? item.points + 1 - score : score;
const answered = (answers: InstrumentAnswers, item: ScaleItem) => {
  const answer = answers[item.id];
  return answer && answer.by !== "skipped" && answer.by !== "pending" && validScore(item, answer.score) ? answer : undefined;
};
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The thirty facets: a facet's four items summed after reverse keying (4–20). A facet with one item unanswered is prorated (the mean of
 * three, times four); with two or more missing it has no score.
 */
export function facetScores(answers: InstrumentAnswers): FacetScore[] {
  return Object.keys(FACET_LABEL).map((facet) => {
    const items = PROFILE_ITEMS.filter((item) => item.facet === facet);
    const values = items.flatMap((item) => { const answer = answered(answers, item); return answer ? [keyed(item, answer.score!)] : []; });
    const sum = values.length >= items.length - 1 && values.length > 0 ? round((values.reduce((a, b) => a + b, 0) / values.length) * items.length) : null;
    return { facet, domain: facet[0] as Domain, label: FACET_LABEL[facet]!, sum, percentile: sum === null ? null : neoPercentile(facet, sum), answered: values.length };
  });
}

/**
 * Scores per dimension. IPIP-NEO: a domain is scored once all six facets are (`facetScores`); `score` is its percentile. TwIVI: a value
 * is scored when both its items are answered, centred on the person's mean over every TwIVI item answered once at least 16 are, and
 * ranked one to ten among the values scored. Mapped answers count as answers; how many were taps is reported per dimension.
 */
export function instrumentScores(answers: InstrumentAnswers, instrument: InstrumentId): DimensionScore[] {
  const counts = (items: ScaleItem[]) => {
    let tapped = 0, mapped = 0, skipped = 0;
    for (const item of items) { const by = answers[item.id]?.by; if (by === "tapped") tapped += 1; else if (by === "mapped") mapped += 1; else if (by === "skipped") skipped += 1; }
    return { items: items.length, tapped, mapped, skipped, administration: administrationOf(tapped, mapped) };
  };
  if (instrument === "ipip_neo_120") {
    const facets = facetScores(answers);
    return (Object.keys(DOMAIN_LABEL) as Domain[]).map((domain) => {
      const own = facets.filter((facet) => facet.domain === domain);
      const raw = own.every((facet) => facet.sum !== null) ? round(own.reduce((sum, facet) => sum + facet.sum!, 0) / own.length) : undefined;
      const percentile = raw === undefined ? null : neoPercentile(domain, raw);
      return { instrument, dimension: domain, label: DOMAIN_LABEL[domain], score: percentile, ...(raw !== undefined ? { raw, percentile: percentile! } : {}),
        ...counts(PROFILE_ITEMS.filter((item) => item.dimension === domain && item.instrument === instrument)) };
    });
  }
  const items = PROFILE_ITEMS.filter((item) => item.instrument === "twivi");
  const all = items.flatMap((item) => { const answer = answered(answers, item); return answer ? [answer.score!] : []; });
  const personMean = all.length >= 16 ? all.reduce((a, b) => a + b, 0) / all.length : undefined;
  const scores = SCHWARTZ_VALUES.map(({ name }) => {
    const own = items.filter((item) => item.dimension === name);
    const values = own.flatMap((item) => { const answer = answered(answers, item); return answer ? [answer.score!] : []; });
    const raw = values.length === own.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : undefined;
    return { instrument, dimension: name, label: name, score: raw === undefined ? null : Math.round(((raw - 1) / 5) * 100),
      ...(raw !== undefined ? { raw } : {}), ...(raw !== undefined && personMean !== undefined ? { centered: round(raw - personMean) } : {}), ...counts(own) } as DimensionScore;
  });
  const ranked = scores.filter((score) => score.raw !== undefined).sort((a, b) => b.raw! - a.raw!);
  return scores.map((score) => score.raw === undefined ? score : { ...score, rank: ranked.indexOf(score) + 1 });
}

/** How a dimension's score was arrived at, for the report: 「24 题点选」「3 题跳过」. */
export function administrationNote(score: DimensionScore): string {
  const parts = [score.tapped ? `${score.tapped} 题点选` : "", score.mapped ? `${score.mapped} 题由文字折算` : "",
    score.skipped ? `${score.skipped} 题跳过` : ""].filter(Boolean);
  const unanswered = score.items - score.tapped - score.mapped - score.skipped;
  if (unanswered > 0) parts.push(`${unanswered} 题未答`);
  return parts.join("、");
}

/** The line a tapped item was written as in a reply (the cards inside the interview, before 2026-11-22), read back by `readScaleAnswers`. */
export function scaleAnswerLine(item: ScaleItem, score: number): string {
  const labels = pointLabels(item);
  const label = labels[score - 1] ?? "";
  return `【${item.text}】点选：${score}/${item.points}${label ? `（${label}）` : ""}`;
}

/** The head words in a card's box were sent under (before 2026-11-22). */
export const cardWordsHead = (card: Pick<ProfileCard, "title" | "items">): string =>
  `【${card.title}（${card.items.map((item) => item.text).join("／")}）】补充：`;

/**
 * What a reply said about the cards a round offered (before 2026-11-22): each item tapped, else skipped. A card's box is a supplement to
 * the taps, never a stand-in for them (2026-11-22, §二.2): its words go to the extraction as words, and no item is scored from them.
 */
export function readCardAnswers(reply: string, cards: readonly ProfileCard[], at: string): ItemAnswer[] {
  if (!cards.length || !/^\s*【.+】/m.test(reply)) return [];
  const taps = readScaleAnswers(reply, cards.flatMap((card) => card.items.map((item) => item.id)), at);
  const tapped = new Set(taps.map((answer) => answer.itemId));
  const rest = cards.flatMap((card) => card.items.filter((item) => !tapped.has(item.id)).map((item): ItemAnswer => ({ itemId: item.id, by: "skipped", at })));
  return [...taps, ...rest];
}

/** The taps in a reply, for the items offered. */
export function readScaleAnswers(reply: string, offered: readonly string[], at: string): ItemAnswer[] {
  const out: ItemAnswer[] = [];
  const wanted = offered.map((id) => ITEMS_BY_ID.get(id)).filter((item): item is ScaleItem => Boolean(item));
  for (const line of reply.split(/\n+/)) {
    const match = /^【(.+)】点选：([1-6])\/[56]/.exec(line.trim());
    if (!match) continue;
    const [, head, digit] = match;
    const item = wanted.find((candidate) => candidate.text === head);
    if (item && validScore(item, Number(digit)) && !out.some((answer) => answer.itemId === item.id)) out.push({ itemId: item.id, score: Number(digit), by: "tapped", at });
  }
  return out;
}

import { RELATION_KIND_LABEL } from "./flywheel-schema";
import { TYPE_LINES, localizeLine, type LineIdentity } from "./assess-content";
import { tFor, type Locale } from "./i18n";

export { RELATION_KIND_LABEL, RELATION_KIND_MEANING } from "./flywheel-schema";

/**
 * 「你也许想做」 from what the person says they want to do (decided 2026-10-16: the type's fixed lines read as irrelevant). After the
 * statements the person picks a few kinds of things (`WANT_OPTIONS`) and may type a line of their own; this file turns that into three
 * lines that feed each other — the product's flywheel: one line's output becomes the next line's input, and the last one's result
 * flows back to the first (relation kinds from `RELATION_KIND_LABEL`). Three ways, in order:
 *
 * 1. the owner's own written combinations (`TYPE_LINES`) when the picks fit one of them — best copy, no model;
 * 2. a text model's answer, checked by `validateWantLines` (the server's job; the free text is untrusted data there);
 * 3. rules (`ruleLines`), always available, so a page never waits on a model.
 *
 * Pure: imported by the public app's browser bundle and its server.
 */

/** One kind of thing a person may want to do, as a chip; `identity` is the line it becomes, and the rest writes the loop. */
export type WantOption = {
  id: string;
  /** The chip's label. */
  label: string;
  identity: string;
  /** The field shown small before the identity ("" for none). */
  domain: string;
  /** Where it sits in a flow from learning to making, spreading, earning, capital and the body; orders the three lines. */
  stage: number;
  /** A short name for the line, ≤4 characters (「研究」). */
  short: string;
  /** What the line produces, ≤6 characters: the loop's first step when it leads (「研究发现」). */
  make: string;
  /** What it does with the previous line's output, ≤6 characters (「做成内容」). */
  verb: string;
  /** What flows back from it when it is last, ≤4 characters (「用户需求」). */
  feedback: string;
  /** Words in a free line that point at it. */
  keywords: string[];
};

export const WANT_OPTIONS: WantOption[] = [
  { id: "research", label: "科研", identity: "研究者", domain: "", stage: 0, short: "研究", make: "研究发现", verb: "变成课题", feedback: "新发现",
    keywords: ["科研", "论文", "实验", "课题", "读博", "研究", "research", "paper", "papers", "thesis", "phd", "lab", "experiment", "experiments", "academic", "science"] }, // i18n-ignore: matched against what the person typed
  { id: "study", label: "考试升学", identity: "学生", domain: "备考", stage: 0, short: "学业", make: "学到的知识", verb: "学成知识", feedback: "新问题",
    keywords: ["考研", "考公", "考证", "备考", "升学", "留学", "学业", "exam", "exams", "test prep", "gre", "gmat", "lsat", "mcat", "grad school", "admission", "admissions", "college", "studying"] }, // i18n-ignore: matched against what the person typed
  { id: "language", label: "语言学习", identity: "学习者", domain: "外语", stage: 0, short: "外语", make: "外语能力", verb: "练成外语", feedback: "新视野",
    keywords: ["英语", "日语", "韩语", "法语", "德语", "雅思", "托福", "外语", "口语", "english", "japanese", "korean", "french", "german", "spanish", "mandarin", "chinese", "ielts", "toefl", "language", "languages", "fluent"] }, // i18n-ignore: matched against what the person typed
  { id: "writing", label: "写作", identity: "写作者", domain: "", stage: 1, short: "写作", make: "文章", verb: "写成文章", feedback: "读者反馈",
    keywords: ["写作", "小说", "专栏", "写书", "随笔", "文案", "writing", "write", "novel", "fiction", "column", "essay", "essays", "blog", "copywriting", "newsletter"] }, // i18n-ignore: matched against what the person typed
  { id: "design", label: "设计", identity: "设计师", domain: "", stage: 1, short: "设计", make: "设计作品", verb: "做成设计", feedback: "用户反馈",
    keywords: ["设计", "ui", "插画", "平面", "海报", "design", "ui", "ux", "illustration", "graphic", "poster", "figma"] }, // i18n-ignore: matched against what the person typed
  { id: "build", label: "编程/做产品", identity: "开发者", domain: "", stage: 1, short: "产品", make: "产品原型", verb: "做成工具", feedback: "使用数据",
    keywords: ["编程", "代码", "程序", "app", "软件", "独立开发", "产品经理", "网站", "小程序", "coding", "code", "programming", "app", "apps", "software", "indie dev", "indie hacker", "product manager", "website", "developer", "saas"] }, // i18n-ignore: matched against what the person typed
  { id: "music", label: "音乐", identity: "音乐人", domain: "", stage: 1, short: "音乐", make: "原创作品", verb: "写成作品", feedback: "听众反馈",
    keywords: ["音乐", "乐器", "吉他", "钢琴", "唱歌", "编曲", "乐队", "music", "instrument", "guitar", "piano", "singing", "sing", "songwriting", "band", "producing beats"] }, // i18n-ignore: matched against what the person typed
  { id: "photo", label: "摄影", identity: "摄影者", domain: "", stage: 1, short: "摄影", make: "照片作品", verb: "拍成作品", feedback: "观众反馈",
    keywords: ["摄影", "拍照", "相机", "胶片", "photography", "photo", "photos", "camera", "film camera"] }, // i18n-ignore: matched against what the person typed
  { id: "media", label: "自媒体", identity: "创作者", domain: "", stage: 2, short: "内容", make: "内容和粉丝", verb: "做成内容", feedback: "读者提问",
    keywords: ["自媒体", "小红书", "抖音", "b站", "视频", "播客", "公众号", "博主", "vlog", "直播", "up主", "youtube", "tiktok", "instagram", "video", "videos", "podcast", "vlog", "streaming", "content", "influencer", "creator"] }, // i18n-ignore: matched against what the person typed
  { id: "teaching", label: "教学分享", identity: "教育者", domain: "", stage: 2, short: "教学", make: "课程", verb: "讲成课程", feedback: "学员问题",
    keywords: ["教学", "讲课", "课程", "家教", "培训", "分享会", "带学生", "teaching", "teach", "course", "courses", "tutor", "tutoring", "training", "workshop", "workshops", "mentor", "mentoring"] }, // i18n-ignore: matched against what the person typed
  { id: "community", label: "做社群", identity: "社群主理人", domain: "", stage: 2, short: "社群", make: "同好圈子", verb: "聚成社群", feedback: "群里案例",
    keywords: ["社群", "社区", "俱乐部", "组织活动", "读书会", "community", "club", "meetup", "meetups", "events", "book club"] }, // i18n-ignore: matched against what the person typed
  { id: "startup", label: "创业", identity: "创业者", domain: "", stage: 3, short: "生意", make: "产品收入", verb: "卖成生意", feedback: "用户需求",
    keywords: ["创业", "开店", "副业", "生意", "电商", "接单", "变现", "startup", "business", "side hustle", "shop", "store", "ecommerce", "e-commerce", "freelance", "monetize", "sell"] }, // i18n-ignore: matched against what the person typed
  { id: "career", label: "职业转型", identity: "职场人", domain: "新行业", stage: 3, short: "工作", make: "新技能", verb: "转成新岗位", feedback: "行业洞察",
    keywords: ["转行", "转型", "跳槽", "求职", "找工作", "升职", "career change", "switch careers", "change careers", "job hunt", "new job", "promotion", "career"] }, // i18n-ignore: matched against what the person typed
  { id: "invest", label: "投资", identity: "投资者", domain: "", stage: 4, short: "投资", make: "现金流", verb: "投进好标的", feedback: "收益",
    keywords: ["投资", "理财", "股票", "基金", "量化", "炒股", "资产", "investing", "invest", "stocks", "stock", "funds", "finance", "trading", "portfolio", "real estate"] }, // i18n-ignore: matched against what the person typed
  { id: "fitness", label: "健身", identity: "健身者", domain: "", stage: 5, short: "身体", make: "体能精力", verb: "练出精力", feedback: "好状态",
    keywords: ["健身", "减脂", "增肌", "瑜伽", "普拉提", "撸铁", "fitness", "gym", "workout", "workouts", "yoga", "pilates", "lifting", "strength training", "lose weight"] }, // i18n-ignore: matched against what the person typed
  { id: "running", label: "跑步", identity: "跑者", domain: "", stage: 5, short: "跑步", make: "训练成果", verb: "跑出状态", feedback: "好状态",
    keywords: ["跑步", "马拉松", "越野跑", "半马", "running", "marathon", "half marathon", "trail running", "5k", "10k"] } // i18n-ignore: matched against what the person typed
];

const OPTION = new Map(WANT_OPTIONS.map((option) => [option.id, option]));
/** Lines that are the body rather than work: the product treats them as a constraint on time and energy, not a competing line. */
const BODY = new Set(["fitness", "running"]);

/**
 * At most this many chips, and this many characters of free text (as a person counts them). An English line gets twice the characters
 * (`wantsTextMax`): a Chinese character carries about a word, and 60 characters of English is barely one short sentence (decided
 * 2026-10-16, docs/i18n.md).
 */
export const WANTS_PICKS_MAX = 6;
export const WANTS_TEXT_MAX = 60;
export const WANTS_TEXT_MAX_EN = 120;
export const wantsTextMax = (locale?: Locale): number => locale === "en" ? WANTS_TEXT_MAX_EN : WANTS_TEXT_MAX;

export type WantsInput = { picks: string[]; text: string };

/** Control, format (zero-width, bidi) and separator characters: never part of what someone means to type. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The free line cleaned: invisible characters out, whitespace collapsed, at most `wantsTextMax(locale)` characters. */
export function cleanWantsText(text: string, locale?: Locale): string {
  return Array.from(text.normalize("NFKC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim()).slice(0, wantsTextMax(locale)).join("").trim();
}

/** What the browser sent, checked: known picks, each once, at most six, and the cleaned line; undefined when nothing usable is left. */
export function parseWants(raw: unknown, locale?: Locale): WantsInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.picks) || (value.text !== undefined && typeof value.text !== "string")) return undefined;
  if (value.picks.length > WANTS_PICKS_MAX * 2 || value.picks.some((pick) => typeof pick !== "string" || !OPTION.has(pick))) return undefined;
  const picks = [...new Set(value.picks as string[])].slice(0, WANTS_PICKS_MAX);
  const original = typeof value.text === "string" ? value.text : "";
  if (Array.from(original.trim()).length > wantsTextMax(locale)) return undefined;
  const text = cleanWantsText(original, locale);
  return picks.length || text ? { picks, text } : undefined;
}

/**
 * Where a keyword first stands in the lowered text, or -1. A Latin keyword counts only as a whole word (a plural "s" allowed), so "ui"
 * is not found in "build" or "art" in "start"; next to Chinese characters it still counts (「做app」). Chinese keywords match anywhere.
 */
function keywordAt(lower: string, word: string): number {
  if (!/^[a-z0-9]/.test(word)) return lower.indexOf(word);
  for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) {
    const before = lower[at - 1] ?? "";
    const rest = lower.slice(at + word.length);
    const after = rest.startsWith("s") && !/^s[a-z]/.test(rest) ? rest.slice(1) : rest;
    if (!/[a-z0-9]/.test(before) && !/^[a-z]/.test(after)) return at;
  }
  return -1;
}

/** The options a free line names, in the order they appear, beyond the ones already picked. Reads Chinese and English. */
export function optionsInText(text: string): string[] {
  const lower = text.toLowerCase();
  const found = WANT_OPTIONS.flatMap((option) => {
    const at = Math.min(...option.keywords.map((word) => keywordAt(lower, word)).filter((index) => index >= 0));
    return Number.isFinite(at) ? [{ id: option.id, at }] : [];
  });
  return found.sort((a, b) => a.at - b.at).map((item) => item.id);
}

/** One link of the loop: line `from` feeds line `to`, the kind as the product names it, and how in one short phrase. */
export type WantLink = { from: number; to: number; kind: string; how: string };

/**
 * Three lines, the four-step loop (as the poster draws it) and the three links, plus where they came from. `kind` is always the Chinese
 * relation label (促成 …), translated where it is shown; the rest is written in `locale` (absent: Chinese, as every set made before
 * 2026-10-16 is). A model's lines are in the language it was asked in and are shown as written.
 */
export type WantLines = {
  lines: [LineIdentity, LineIdentity, LineIdentity];
  loop: [string, string, string, string];
  links: [WantLink, WantLink, WantLink];
  source: "preset" | "model" | "rules";
  locale?: Locale;
};

/** English sentences start with a capital; Chinese is left alone. */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
/** A word used mid-sentence in English (「研究」 → "research"); Chinese unchanged. */
const inner = (locale: Locale | undefined, text: string): string => locale === "en" ? tFor(locale)(text).toLowerCase() : text;

/** The five relation kinds' labels (促成, 复用, 提供输入, 约束, 反馈回路): the only kinds a link may carry. */
export const WANT_LINK_KINDS = Object.values(RELATION_KIND_LABEL);

/** The options to build from: the picks, then what the free line names, each once. */
export function chosenOptions(wants: WantsInput): string[] {
  return [...new Set([...wants.picks, ...optionsInText(wants.text)])];
}

/**
 * The owner's written combination that fits the choice, if one does: a combination with a loop (`TYPE_LINES[*].lines`) holding every
 * chosen identity (two or three of them; one alone is fitted only by the person's own type's combination). The person's own type is
 * tried first, then the others in table order.
 */
export function presetLines(code: string, chosen: string[], locale?: Locale): WantLines | undefined {
  const t = tFor(locale);
  const identities = chosen.map((id) => OPTION.get(id)?.identity).filter((identity): identity is string => Boolean(identity));
  if (!identities.length || identities.length > 3) return undefined;
  const codes = [code, ...Object.keys(TYPE_LINES).filter((other) => other !== code)];
  for (const candidate of identities.length === 1 ? [code] : codes) {
    const combo = TYPE_LINES[candidate];
    if (!combo) continue;
    const own = combo.lines.map((line) => line.identity);
    if (!identities.every((identity) => own.includes(identity))) continue;
    const loop = combo.loop.map((step) => t(step)) as WantLines["loop"];
    const later = (step: string) => locale === "en" ? step.charAt(0).toLowerCase() + step.slice(1) : step;
    return {
      lines: combo.lines.map((line) => localizeLine(line, locale)) as WantLines["lines"],
      loop,
      links: [
        { from: 0, to: 1, kind: RELATION_KIND_LABEL.reuses!, how: t("{{a}}，接着{{b}}", { a: loop[0], b: later(loop[1]) }) },
        { from: 1, to: 2, kind: RELATION_KIND_LABEL.informs!, how: t("{{a}}，再{{b}}", { a: loop[1], b: later(loop[2]) }) },
        { from: 2, to: 0, kind: RELATION_KIND_LABEL.recurring_feedback!, how: loop[3] }
      ],
      source: "preset",
      ...(locale === "en" ? { locale } : {})
    };
  }
  return undefined;
}

/**
 * Three lines by rule, always available. The chosen options (at most three; with fewer, the person's own type's lines fill the rest),
 * ordered from learning to making, spreading, earning, capital and the body so the loop reads forward: the first line's output, what
 * the second and third make of it, and what flows back to the first. A body line (健身, 跑步) does not feed the next line's work: its
 * link is a constraint — it takes time and keeps the energy up.
 */
export function ruleLines(code: string, chosen: string[], locale?: Locale): WantLines {
  const t = tFor(locale);
  const own = TYPE_LINES[code]?.lines ?? TYPE_LINES.GEMA!.lines;
  const options = chosen.map((id) => OPTION.get(id)).filter((option): option is WantOption => Boolean(option)).slice(0, 3);
  const taken = new Set(options.map((option) => option.identity));
  // Fill from the type's own lines with an option of the same identity when there is one, else a plain stand-in.
  for (const line of own) {
    if (options.length >= 3) break;
    if (taken.has(line.identity)) continue;
    const match = WANT_OPTIONS.find((option) => option.identity === line.identity);
    options.push(match ? { ...match, domain: line.domain } : { ...fallbackOption(line), domain: line.domain });
    taken.add(line.identity);
  }
  const ordered = options.map((option, index) => ({ option, index })).sort((a, b) => a.option.stage - b.option.stage || a.index - b.index).map((item) => item.option);
  const [a, b, c] = ordered as [WantOption, WantOption, WantOption];
  const domainFor = (option: WantOption) => option.domain || own.find((line) => line.identity === option.identity)?.domain || "";
  // Every phrase is one key with the parts as values; in English the parts are translated, and a word inside a sentence is lowercased.
  const short = (option: WantOption) => option.id.startsWith("type:") && locale === "en" ? t(option.identity).toLowerCase() : inner(locale, option.short);
  const make = (option: WantOption) => t(option.make, { short: short(option) });
  const verb = (option: WantOption) => t(option.verb, { short: short(option) });
  const phrase = (key: string, values: Record<string, string>) => sentence(t(key, values));
  const link = (from: number, to: number, source: WantOption, target: WantOption, kind: string, how: string): WantLink =>
    BODY.has(source.id) ? { from, to, kind: RELATION_KIND_LABEL.constrains!, how: phrase("{{a}}占用时间也撑住{{b}}的精力", { a: short(source), b: short(target) }) }
      : BODY.has(target.id) ? { from, to, kind: RELATION_KIND_LABEL.constrains!, how: phrase("{{a}}之外给{{b}}留出时间", { a: short(source), b: short(target) }) }
        : { from, to, kind, how };
  const back = phrase("{{feedback}}回到{{short}}", { feedback: t(c.feedback), short: short(a) });
  return {
    lines: [a, b, c].map((option) => localizeLine({ domain: domainFor(option), identity: option.identity }, locale)) as WantLines["lines"],
    loop: [make(a), verb(b), verb(c), back].map(sentence) as WantLines["loop"],
    links: [
      link(0, 1, a, b, RELATION_KIND_LABEL.reuses!, phrase("{{make}}成为{{short}}的素材", { make: make(a), short: short(b) })),
      link(1, 2, b, c, RELATION_KIND_LABEL.informs!, phrase("{{a}}给{{b}}带来输入", { a: short(b), b: short(c) })),
      link(2, 0, c, a, RELATION_KIND_LABEL.recurring_feedback!, back)
    ],
    source: "rules",
    ...(locale === "en" ? { locale } : {})
  };
}

/** An identity from a type's lines that no option names (医生, 跑者 …): a plain stand-in that still writes a readable loop. */
function fallbackOption(line: LineIdentity): WantOption {
  // `short` is a Chinese fragment (「医生」 from 「医生」, 「中医」 from 「中医师」); `make` and `verb` are filled from it when shown.
  const short = line.identity.slice(0, 2);
  return { id: `type:${line.identity}`, label: line.identity, identity: line.identity, domain: line.domain, stage: 3, short,
    make: FALLBACK_MAKE, verb: FALLBACK_VERB, feedback: "经验", keywords: [] };
}
const FALLBACK_MAKE = "{{short}}积累";
const FALLBACK_VERB = "用在{{short}}上";

/**
 * What the person's choice gives without a model: the written combination when it fits and the free line adds nothing the options do
 * not already cover, else the rules. `needsModel` says whether a model's answer would add something (a free line that names no option,
 * or a choice no written combination fits).
 */
export function wantsPlan(code: string, wants: WantsInput, locale?: Locale): { lines: WantLines; needsModel: boolean } {
  const chosen = chosenOptions(wants);
  const textCovered = !wants.text || optionsInText(wants.text).length > 0;
  const preset = presetLines(code, chosen, locale);
  if (preset) return { lines: preset, needsModel: !textCovered };
  return { lines: ruleLines(code, chosen, locale), needsModel: true };
}

/**
 * Field lengths the poster holds (identity, field, loop step) and the link phrase the page shows. English gets about twice the
 * characters: the poster sets an English loop step on up to two lines and lets a line's field and identity wrap.
 */
export const WANT_LIMITS = { identity: 6, domain: 7, step: 10, how: 24 } as const;
export const WANT_LIMITS_EN = { identity: 22, domain: 20, step: 28, how: 60 } as const;
export const wantLimits = (locale?: Locale) => locale === "en" ? WANT_LIMITS_EN : WANT_LIMITS;

/** What any shown string may be made of: Chinese, Latin letters, digits, spaces and a few joiners — no links, no addresses. */
const SHOWN = /^[\p{Script=Han}A-Za-z0-9 ·&+-]*$/u;
/** English also needs the apostrophe ("people's"). */
const SHOWN_EN = /^[\p{Script=Han}A-Za-z0-9 ·&+'-]*$/u;
const URL_LIKE = /https?|www|\.(com|cn|net|org|io|me|top|xyz)\b/i;
// i18n-ignore: matched against a model's answer
const CONTACT_LIKE = /\d{5,}|微信|vx|qq|加我|私信|联系|\b(wechat|whatsapp|telegram|snapchat|dm me|contact me|add me|email me)\b/i;
/** Nothing a public poster should print, whatever a stranger asked the model to write (Chinese and English words). */
// i18n-ignore: matched against a model's answer
const UNSAFE = /色情|裸|赌博|博彩|毒品|枪支|炸弹|自杀|诈骗|传销|代孕|暴力|血腥|\b(porn\w*|nude|nudity|naked|gambling|casino|drugs?|guns?|bombs?|suicide|scams?|ponzi|pyramid scheme|surrogacy|violence|violent|gore)\b/i;

/** The relation kinds a model may name in English, each read as its Chinese label (the form every set of lines keeps). */
const KIND_FROM_EN: Record<string, string> = {
  enables: RELATION_KIND_LABEL.enables!, reuses: RELATION_KIND_LABEL.reuses!, informs: RELATION_KIND_LABEL.informs!,
  constrains: RELATION_KIND_LABEL.constrains!, "feedback loop": RELATION_KIND_LABEL.recurring_feedback!
};
const canonicalKind = (kind: unknown): string | undefined =>
  typeof kind !== "string" ? undefined : WANT_LINK_KINDS.includes(kind) ? kind : KIND_FROM_EN[kind.trim().toLowerCase()];

function stringProblem(value: unknown, field: string, max: number, min = 1, locale?: Locale): string | undefined {
  if (typeof value !== "string") return `${field}: not a string`;
  const length = Array.from(value).length;
  if (length < min || length > max) return `${field}: ${length} characters, needs ${min}–${max}`;
  if (!(locale === "en" ? SHOWN_EN : SHOWN).test(value) || URL_LIKE.test(value) || CONTACT_LIKE.test(value) || UNSAFE.test(value)) return `${field}: characters or words not allowed`;
  return undefined;
}

/**
 * A model's answer read into `WantLines`, or the problems with it. Shape: `{lines:[{domain,identity}×3], loop:[4], links:[{from,to,kind,how}×3]}`
 * (`links` 0→1, 1→2, 2→0). Every string is length-capped for the poster, limited to plain characters, free of links, contact details and
 * unsafe words; identities differ; kinds are the five relation kinds. Anything else is a reason to fall back to the rules.
 */
export function validateWantLines(raw: unknown, locale?: Locale): { ok: true; value: WantLines } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const limits = wantLimits(locale);
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!value) return { ok: false, problems: ["not an object"] };
  const lines = Array.isArray(value.lines) ? value.lines : [];
  const loop = Array.isArray(value.loop) ? value.loop : [];
  const links = Array.isArray(value.links) ? value.links : [];
  if (lines.length !== 3) problems.push("lines: needs exactly 3");
  if (loop.length !== 4) problems.push("loop: needs exactly 4");
  if (links.length !== 3) problems.push("links: needs exactly 3");
  lines.slice(0, 3).forEach((line: unknown, index: number) => {
    const item = line && typeof line === "object" ? line as Record<string, unknown> : {};
    const identity = stringProblem(item.identity, `lines[${index}].identity`, limits.identity, 2, locale);
    const domain = stringProblem(item.domain ?? "", `lines[${index}].domain`, limits.domain, 0, locale);
    if (identity) problems.push(identity);
    if (domain) problems.push(domain);
  });
  loop.slice(0, 4).forEach((step: unknown, index: number) => { const problem = stringProblem(step, `loop[${index}]`, limits.step, 2, locale); if (problem) problems.push(problem); });
  const expected: Array<[number, number]> = [[0, 1], [1, 2], [2, 0]];
  links.slice(0, 3).forEach((link: unknown, index: number) => {
    const item = link && typeof link === "object" ? link as Record<string, unknown> : {};
    if (item.from !== expected[index]![0] || item.to !== expected[index]![1]) problems.push(`links[${index}]: must go ${expected[index]!.join("→")}`);
    if (!canonicalKind(item.kind)) problems.push(`links[${index}].kind: one of ${(locale === "en" ? Object.keys(KIND_FROM_EN) : WANT_LINK_KINDS).join(locale === "en" ? ", " : "、")}`);
    const how = stringProblem(item.how, `links[${index}].how`, limits.how, 2, locale);
    if (how) problems.push(how);
  });
  if (problems.length) return { ok: false, problems };
  const identities = (lines as Array<{ identity: string }>).map((line) => line.identity);
  if (new Set(identities).size !== 3) return { ok: false, problems: ["lines: identities must differ"] };
  return { ok: true, value: {
    lines: (lines as Array<{ domain?: string; identity: string }>).map((line) => ({ domain: line.domain ?? "", identity: line.identity })) as WantLines["lines"],
    loop: loop as WantLines["loop"],
    links: (links as WantLink[]).map((link) => ({ from: link.from, to: link.to, kind: canonicalKind(link.kind)!, how: link.how })) as WantLines["links"],
    source: "model",
    ...(locale === "en" ? { locale } : {})
  } };
}

/** The options as the person sees them, for the model's brief and the result page. */
export const wantLabel = (id: string, locale?: Locale): string => { const label = OPTION.get(id)?.label; return label ? tFor(locale)(label) : id; };

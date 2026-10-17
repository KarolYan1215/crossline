import { RELATION_KIND_LABEL } from "./flywheel-schema";
import { TYPE_LINES, type LineIdentity } from "./assess-content";

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
    keywords: ["科研", "论文", "实验", "课题", "读博", "研究"] },
  { id: "study", label: "考试升学", identity: "学生", domain: "备考", stage: 0, short: "学业", make: "学到的知识", verb: "学成知识", feedback: "新问题",
    keywords: ["考研", "考公", "考证", "备考", "升学", "留学", "学业"] },
  { id: "language", label: "语言学习", identity: "学习者", domain: "外语", stage: 0, short: "外语", make: "外语能力", verb: "练成外语", feedback: "新视野",
    keywords: ["英语", "日语", "韩语", "法语", "德语", "雅思", "托福", "外语", "口语"] },
  { id: "writing", label: "写作", identity: "写作者", domain: "", stage: 1, short: "写作", make: "文章", verb: "写成文章", feedback: "读者反馈",
    keywords: ["写作", "小说", "专栏", "写书", "随笔", "文案"] },
  { id: "design", label: "设计", identity: "设计师", domain: "", stage: 1, short: "设计", make: "设计作品", verb: "做成设计", feedback: "用户反馈",
    keywords: ["设计", "ui", "插画", "平面", "海报"] },
  { id: "build", label: "编程/做产品", identity: "开发者", domain: "", stage: 1, short: "产品", make: "产品原型", verb: "做成工具", feedback: "使用数据",
    keywords: ["编程", "代码", "程序", "app", "软件", "独立开发", "产品经理", "网站", "小程序"] },
  { id: "music", label: "音乐", identity: "音乐人", domain: "", stage: 1, short: "音乐", make: "原创作品", verb: "写成作品", feedback: "听众反馈",
    keywords: ["音乐", "乐器", "吉他", "钢琴", "唱歌", "编曲", "乐队"] },
  { id: "photo", label: "摄影", identity: "摄影者", domain: "", stage: 1, short: "摄影", make: "照片作品", verb: "拍成作品", feedback: "观众反馈",
    keywords: ["摄影", "拍照", "相机", "胶片"] },
  { id: "media", label: "自媒体", identity: "创作者", domain: "", stage: 2, short: "内容", make: "内容和粉丝", verb: "做成内容", feedback: "读者提问",
    keywords: ["自媒体", "小红书", "抖音", "b站", "视频", "播客", "公众号", "博主", "vlog", "直播", "up主"] },
  { id: "teaching", label: "教学分享", identity: "教育者", domain: "", stage: 2, short: "教学", make: "课程", verb: "讲成课程", feedback: "学员问题",
    keywords: ["教学", "讲课", "课程", "家教", "培训", "分享会", "带学生"] },
  { id: "community", label: "做社群", identity: "社群主理人", domain: "", stage: 2, short: "社群", make: "同好圈子", verb: "聚成社群", feedback: "群里案例",
    keywords: ["社群", "社区", "俱乐部", "组织活动", "读书会"] },
  { id: "startup", label: "创业", identity: "创业者", domain: "", stage: 3, short: "生意", make: "产品收入", verb: "卖成生意", feedback: "用户需求",
    keywords: ["创业", "开店", "副业", "生意", "电商", "接单", "变现"] },
  { id: "career", label: "职业转型", identity: "职场人", domain: "新行业", stage: 3, short: "工作", make: "新技能", verb: "转成新岗位", feedback: "行业洞察",
    keywords: ["转行", "转型", "跳槽", "求职", "找工作", "升职"] },
  { id: "invest", label: "投资", identity: "投资者", domain: "", stage: 4, short: "投资", make: "现金流", verb: "投进好标的", feedback: "收益",
    keywords: ["投资", "理财", "股票", "基金", "量化", "炒股", "资产"] },
  { id: "fitness", label: "健身", identity: "健身者", domain: "", stage: 5, short: "身体", make: "体能精力", verb: "练出精力", feedback: "好状态",
    keywords: ["健身", "减脂", "增肌", "瑜伽", "普拉提", "撸铁"] },
  { id: "running", label: "跑步", identity: "跑者", domain: "", stage: 5, short: "跑步", make: "训练成果", verb: "跑出状态", feedback: "好状态",
    keywords: ["跑步", "马拉松", "越野跑", "半马"] }
];

const OPTION = new Map(WANT_OPTIONS.map((option) => [option.id, option]));
/** Lines that are the body rather than work: the product treats them as a constraint on time and energy, not a competing line. */
const BODY = new Set(["fitness", "running"]);

/** At most this many chips, and this many characters of free text (as a person counts them). */
export const WANTS_PICKS_MAX = 6;
export const WANTS_TEXT_MAX = 60;

export type WantsInput = { picks: string[]; text: string };

/** Control, format (zero-width, bidi) and separator characters: never part of what someone means to type. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The free line cleaned: invisible characters out, whitespace collapsed, at most `WANTS_TEXT_MAX` characters. */
export function cleanWantsText(text: string): string {
  return Array.from(text.normalize("NFKC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim()).slice(0, WANTS_TEXT_MAX).join("").trim();
}

/** What the browser sent, checked: known picks, each once, at most six, and the cleaned line; undefined when nothing usable is left. */
export function parseWants(raw: unknown): WantsInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.picks) || (value.text !== undefined && typeof value.text !== "string")) return undefined;
  if (value.picks.length > WANTS_PICKS_MAX * 2 || value.picks.some((pick) => typeof pick !== "string" || !OPTION.has(pick))) return undefined;
  const picks = [...new Set(value.picks as string[])].slice(0, WANTS_PICKS_MAX);
  const original = typeof value.text === "string" ? value.text : "";
  if (Array.from(original.trim()).length > WANTS_TEXT_MAX) return undefined;
  const text = cleanWantsText(original);
  return picks.length || text ? { picks, text } : undefined;
}

/** The options a free line names, in the order they appear, beyond the ones already picked. */
export function optionsInText(text: string): string[] {
  const lower = text.toLowerCase();
  const found = WANT_OPTIONS.flatMap((option) => {
    const at = Math.min(...option.keywords.map((word) => lower.indexOf(word)).filter((index) => index >= 0));
    return Number.isFinite(at) ? [{ id: option.id, at }] : [];
  });
  return found.sort((a, b) => a.at - b.at).map((item) => item.id);
}

/** One link of the loop: line `from` feeds line `to`, the kind as the product names it, and how in one short phrase. */
export type WantLink = { from: number; to: number; kind: string; how: string };

/** Three lines, the four-step loop (as the poster draws it) and the three links, plus where they came from. */
export type WantLines = {
  lines: [LineIdentity, LineIdentity, LineIdentity];
  loop: [string, string, string, string];
  links: [WantLink, WantLink, WantLink];
  source: "preset" | "model" | "rules";
};

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
export function presetLines(code: string, chosen: string[]): WantLines | undefined {
  const identities = chosen.map((id) => OPTION.get(id)?.identity).filter((identity): identity is string => Boolean(identity));
  if (!identities.length || identities.length > 3) return undefined;
  const codes = [code, ...Object.keys(TYPE_LINES).filter((other) => other !== code)];
  for (const candidate of identities.length === 1 ? [code] : codes) {
    const combo = TYPE_LINES[candidate];
    if (!combo) continue;
    const own = combo.lines.map((line) => line.identity);
    if (!identities.every((identity) => own.includes(identity))) continue;
    const loop = combo.loop;
    return {
      lines: combo.lines,
      loop,
      links: [
        { from: 0, to: 1, kind: RELATION_KIND_LABEL.reuses!, how: `${loop[0]}，接着${loop[1]}` },
        { from: 1, to: 2, kind: RELATION_KIND_LABEL.informs!, how: `${loop[1]}，再${loop[2]}` },
        { from: 2, to: 0, kind: RELATION_KIND_LABEL.recurring_feedback!, how: loop[3] }
      ],
      source: "preset"
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
export function ruleLines(code: string, chosen: string[]): WantLines {
  const own = TYPE_LINES[code]?.lines ?? TYPE_LINES.DLWV!.lines;
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
  const link = (from: number, to: number, source: WantOption, target: WantOption, kind: string, how: string): WantLink =>
    BODY.has(source.id) ? { from, to, kind: RELATION_KIND_LABEL.constrains!, how: `${source.short}占用时间也撑住${target.short}的精力` }
      : BODY.has(target.id) ? { from, to, kind: RELATION_KIND_LABEL.constrains!, how: `${source.short}之外给${target.short}留出时间` }
        : { from, to, kind, how };
  return {
    lines: [a, b, c].map((option) => ({ domain: domainFor(option), identity: option.identity })) as WantLines["lines"],
    loop: [a.make, b.verb, c.verb, `${c.feedback}回到${a.short}`],
    links: [
      link(0, 1, a, b, RELATION_KIND_LABEL.reuses!, `${a.make}成为${b.short}的素材`),
      link(1, 2, b, c, RELATION_KIND_LABEL.informs!, `${b.short}给${c.short}带来输入`),
      link(2, 0, c, a, RELATION_KIND_LABEL.recurring_feedback!, `${c.feedback}回到${a.short}`)
    ],
    source: "rules"
  };
}

/** An identity from a type's lines that no option names (医生, 跑者 …): a plain stand-in that still writes a readable loop. */
function fallbackOption(line: LineIdentity): WantOption {
  const short = line.identity.slice(0, 2);
  return { id: `type:${line.identity}`, label: line.identity, identity: line.identity, domain: line.domain, stage: 3, short,
    make: `${short}积累`, verb: `用在${short}上`, feedback: "经验", keywords: [] };
}

/**
 * What the person's choice gives without a model: the written combination when it fits and the free line adds nothing the options do
 * not already cover, else the rules. `needsModel` says whether a model's answer would add something (a free line that names no option,
 * or a choice no written combination fits).
 */
export function wantsPlan(code: string, wants: WantsInput): { lines: WantLines; needsModel: boolean } {
  const chosen = chosenOptions(wants);
  const textCovered = !wants.text || optionsInText(wants.text).length > 0;
  const preset = presetLines(code, chosen);
  if (preset) return { lines: preset, needsModel: !textCovered };
  return { lines: ruleLines(code, chosen), needsModel: true };
}

/** Field lengths the poster holds on one line (identity, field, loop step) and the link phrase the page shows. */
export const WANT_LIMITS = { identity: 6, domain: 7, step: 10, how: 24 } as const;

/** What any shown string may be made of: Chinese, Latin letters, digits, spaces and a few joiners — no links, no addresses. */
const SHOWN = /^[\p{Script=Han}A-Za-z0-9 ·&+-]*$/u;
const URL_LIKE = /https?|www|\.(com|cn|net|org|io|me|top|xyz)\b/i;
const CONTACT_LIKE = /\d{5,}|微信|vx|qq|加我|私信|联系/i;
/** Nothing a public poster should print, whatever a stranger asked the model to write. */
const UNSAFE = /色情|裸|赌博|博彩|毒品|枪支|炸弹|自杀|诈骗|传销|代孕|暴力|血腥/;

function stringProblem(value: unknown, field: string, max: number, min = 1): string | undefined {
  if (typeof value !== "string") return `${field}: not a string`;
  const length = Array.from(value).length;
  if (length < min || length > max) return `${field}: ${length} characters, needs ${min}–${max}`;
  if (!SHOWN.test(value) || URL_LIKE.test(value) || CONTACT_LIKE.test(value) || UNSAFE.test(value)) return `${field}: characters or words not allowed`;
  return undefined;
}

/**
 * A model's answer read into `WantLines`, or the problems with it. Shape: `{lines:[{domain,identity}×3], loop:[4], links:[{from,to,kind,how}×3]}`
 * (`links` 0→1, 1→2, 2→0). Every string is length-capped for the poster, limited to plain characters, free of links, contact details and
 * unsafe words; identities differ; kinds are the five relation kinds. Anything else is a reason to fall back to the rules.
 */
export function validateWantLines(raw: unknown): { ok: true; value: WantLines } | { ok: false; problems: string[] } {
  const problems: string[] = [];
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
    const identity = stringProblem(item.identity, `lines[${index}].identity`, WANT_LIMITS.identity, 2);
    const domain = stringProblem(item.domain ?? "", `lines[${index}].domain`, WANT_LIMITS.domain, 0);
    if (identity) problems.push(identity);
    if (domain) problems.push(domain);
  });
  loop.slice(0, 4).forEach((step: unknown, index: number) => { const problem = stringProblem(step, `loop[${index}]`, WANT_LIMITS.step, 2); if (problem) problems.push(problem); });
  const expected: Array<[number, number]> = [[0, 1], [1, 2], [2, 0]];
  links.slice(0, 3).forEach((link: unknown, index: number) => {
    const item = link && typeof link === "object" ? link as Record<string, unknown> : {};
    if (item.from !== expected[index]![0] || item.to !== expected[index]![1]) problems.push(`links[${index}]: must go ${expected[index]!.join("→")}`);
    if (typeof item.kind !== "string" || !WANT_LINK_KINDS.includes(item.kind)) problems.push(`links[${index}].kind: one of ${WANT_LINK_KINDS.join("、")}`);
    const how = stringProblem(item.how, `links[${index}].how`, WANT_LIMITS.how, 2);
    if (how) problems.push(how);
  });
  if (problems.length) return { ok: false, problems };
  const identities = (lines as Array<{ identity: string }>).map((line) => line.identity);
  if (new Set(identities).size !== 3) return { ok: false, problems: ["lines: identities must differ"] };
  return { ok: true, value: {
    lines: (lines as Array<{ domain?: string; identity: string }>).map((line) => ({ domain: line.domain ?? "", identity: line.identity })) as WantLines["lines"],
    loop: loop as WantLines["loop"],
    links: (links as WantLink[]).map((link) => ({ from: link.from, to: link.to, kind: link.kind, how: link.how })) as WantLines["links"],
    source: "model"
  } };
}

/** The options as the person sees them, for the model's brief and the result page. */
export const wantLabel = (id: string): string => OPTION.get(id)?.label ?? id;

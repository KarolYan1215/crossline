import { APPLICATION_SLOTS, isSensitiveSlot, profilePlaceholder, type ApplicationSlot, type FormAction, type FormRun, type FormStop,
  type Opportunity } from "./opportunity";

/**
 * Filling a registration form for the person (docs/opportunity-agent.md §10, §12; the owner's decisions of 2026-11-01). This file is
 * the pure half: the page as the accessibility snapshot shows it, the rules every proposed action is judged by before anything is
 * done (§10.3 — our Sentinel), the automatic-submission rule (§10.4), reading a field back (§10.6), the confirmation page, keeping
 * sensitive values out of everything a model or a log sees, and the application profile assembled from confirmed facts (§12).
 *
 * A model only ever proposes; the rules here decide, and nothing on the page is an instruction. A sensitive value is never in a
 * model's input: it writes `{{profile.<slot>}}` and the engine puts the value in.
 */

// ———————————————————————————————————————— the page

/** One element of a page's accessibility snapshot (Playwright's `ariaSnapshot({ mode: "ai" })`). */
export type SnapshotNode = {
  ref?: string;
  role: string;
  name: string;
  /** A text box's current value, or the text of a text-like node. */
  value?: string;
  checked?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** A combobox's or listbox's options, and which is selected. */
  options?: string[];
  selected?: string;
  url?: string;
  depth: number;
};

const LINE = /^(\s*)- (?:"((?:[^"\\]|\\.)*)"|([a-zA-Z/]+))(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s?(.*))?$/;
const unquote = (text: string) => text.replace(/\\(.)/g, "$1");
const valueOf = (text: string | undefined) => {
  const value = (text ?? "").trim();
  return value.startsWith("\"") && value.endsWith("\"") && value.length > 1 ? unquote(value.slice(1, -1)) : value;
};

/** Parses an ariaSnapshot's YAML into a flat list; options and `/url:` lines attach to the element they belong to. */
export function parseAriaSnapshot(yaml: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (!match) continue;
    const depth = match[1]!.length / 2;
    const role = match[3] ?? "text";
    const name = match[4] !== undefined ? unquote(match[4]) : match[2] !== undefined ? unquote(match[2]) : "";
    const attrs = [...(match[5] ?? "").matchAll(/\[([^\]]+)\]/g)].map((item) => item[1]!);
    const rest = match[6];
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (role === "/url" && parent) { parent.url = valueOf(rest); continue; }
    if (role === "option" && parent && /combobox|listbox/.test(parent.role)) {
      const label = name || valueOf(rest);
      (parent.options ??= []).push(label);
      if (attrs.includes("selected")) parent.selected = label;
      continue;
    }
    const node: SnapshotNode = { role, name, depth };
    for (const attr of attrs) {
      if (attr.startsWith("ref=")) node.ref = attr.slice(4);
      else if (attr === "checked" || attr === "checked=true") node.checked = true;
      else if (attr === "checked=mixed") node.checked = true;
      else if (attr === "invalid") node.invalid = true;
      else if (attr === "disabled") node.disabled = true;
    }
    if (rest !== undefined && rest.trim() && !rest.trim().startsWith("|")) node.value = valueOf(rest);
    if (/^(checkbox|radio|switch)$/.test(role) && node.checked === undefined) node.checked = false;
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "listbox", "checkbox", "radio", "switch"]);
export const isField = (node: SnapshotNode) => FIELD_ROLES.has(node.role);
/** Everything the page says, for the page-level checks (fees, a check, a login, a confirmation). */
export const pageText = (nodes: SnapshotNode[]) => nodes.map((node) => [node.name, node.value].filter(Boolean).join(" ")).filter(Boolean).join("\n");
/** The elements an action may name: role + accessible name, exactly. */
export function findTarget(nodes: SnapshotNode[], target: { role: string; name: string }): SnapshotNode[] {
  const name = target.name.replace(/\s+/g, " ").trim();
  return nodes.filter((node) => node.role === target.role && node.name.replace(/\s+/g, " ").trim() === name);
}

// ———————————————————————————————————————— words on the page
// i18n-ignore-start: patterns matched against what a site shows
const CONSENT = /\b(agree|accept|consent|terms|privacy|policy|code of conduct|acknowledge)\b|同意|接受|条款|隐私|协议|声明|知情/i;
const MARKETING = /\b(newsletter|marketing|promotion(al)?|updates? (from|about)|subscribe|mailing list|offers|sponsor(s|ed)? (may|can)|partners? (may|can)|share my (info|information|details|data))\b|订阅|营销|推送|推广|资讯|广告|合作方/i;
const PUBLIC = /\b(public(ly)?|guest list|attendee list|show (me|my)|display (me|my)|visible to (other|everyone)|list me)\b|公开|展示我|显示我|嘉宾名单|参会者名单/i;
const ESSAY = /\b(why|motivation|describe|tell us|about yourself|cover letter|statement|essay|bio|biography|introduce|introduction|what do you hope|explain|elaborate)\b|为什么|动机|自我介绍|个人陈述|简介|描述|介绍一下|期望|说明/i;
const PAYMENT = /\b(card number|credit card|debit card|cvc|cvv|expir(y|ation)|billing|payment|pay now|checkout|iban|routing number|bank account|paypal)\b|银行卡|信用卡|支付|付款|结账|账户号|卡号/i;
const ID_DOCUMENT = /\b(passport|id card|driver'?s licen[cs]e|government id|photo id|national id|identity document)\b|身份证|护照|证件|驾照/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile|i'?m not a robot|verify you are (a )?human|are you a robot|security check|人机验证|安全验证|验证码|滑块|拖动.{0,6}完成/i;
const LOGIN = /\b(sign in|log in|login|password|one-time code|verification code|magic link|check your (email|inbox))\b|登录|密码|验证码已发送|请查收/i;
const SOCIAL_WRITE = /\b(follow|unfollow|like|share|invite|post|tweet|publish|comment|message|add friends?|connect|subscribe to|import contacts|refer)\b|关注|点赞|分享|邀请|发布|评论|私信|加好友|转发|导入通讯录/i;
const SUBMIT = /\b(submit|register|registration|rsvp|request to join|join (event|waitlist)|apply|send application|complete (registration|order)|confirm|sign up|book|reserve|get tickets?|place order|pay)\b|提交|报名|注册|确认|申请|预约|预订|购买|下单/i;
const NEXT = /^(next|continue|next step|proceed|go on|下一步|继续|下一页|继续填写)\b/i;
const CONFIRMED = /you'?re (registered|in|going|all set|on the list)|you are (registered|going|in)|registration (confirmed|complete|successful)|thank(s| you) for (registering|signing up|your registration|applying|your application|rsvp)|rsvp (confirmed|received)|see you there|application (submitted|received)|已报名|报名成功|注册成功|提交成功|已提交|申请已收到|期待与你相见/i;
const WAITLIST = /waitlist|wait list|候补|排队中/i;
const PENDING_APPROVAL = /pending approval|awaiting approval|request (sent|received)|host will review|待审核|等待主办方审核/i;
const ERROR_TEXT = /\b(required|is invalid|not valid|please (enter|select|fill|choose|provide|complete)|must be|error|try again)\b|必填|不能为空|格式不正确|无效|请输入|请选择|请填写|错误/i;
const INJECTION = /ignore (all |any )?(previous|prior|above) (instructions|directions)|disregard (the )?(previous|above)|(system|assistant|ai|agent|model)\s*[:：]|you are (now )?(an?|the) (assistant|agent|ai)|change (the |your )?(e-?mail|phone|address)|instead (fill|enter|type)|忽略(之前|以上|上面)的?(指令|要求|说明)|把邮箱改成|改成以下邮箱|你现在是|请(立刻|马上)?打开/i;
// i18n-ignore-end

/** Which slot a field's label asks for, when it plainly asks for one; a literal value in such a field is refused. */
// i18n-ignore-start: patterns matched against what a site shows
const FIELD_SLOTS: Array<[RegExp, ApplicationSlot]> = [
  [/e-?mail|邮箱|電子郵件|电子邮件/i, "email"],
  [/phone|mobile|cell|telephone|\btel\b|手机|电话/i, "phone"],
  [/birth|\bdob\b|生日|出生/i, "birth_date"],
  [/student (id|number|no)|学号/i, "student_id"],
  [/passport/i, "passport_number"],
  [/(national|government) id|id (number|no)|身份证/i, "id_number"],
  [/street|address|地址|住址/i, "address"],
  [/github/i, "github"],
  [/website|homepage|portfolio|personal (site|url)|个人网站|主页/i, "website"],
  [/linkedin/i, "website"],
  [/full name|^name$|^your name$|姓名|^名字$|legal name/i, "full_name"],
  [/first name|given name|last name|family name|surname|^名$|^姓$/i, "full_name"],
  [/preferred name|nickname|昵称|称呼/i, "preferred_name"],
  [/school|university|college|institution|学校|大学|院校|就读/i, "school"],
  [/major|field of study|discipline|专业/i, "major"],
  [/graduat|毕业/i, "graduation_year"],
  [/degree|level of study|year of study|学历|学位|年级/i, "degree_stage"],
  [/\bcity\b|城市/i, "city"],
  [/country|nationality|国家|国籍/i, "country"],
  [/resume|\bcv\b|简历/i, "resume"]
];
// i18n-ignore-end
export function fieldSlot(label: string): ApplicationSlot | undefined {
  const text = label.replace(/\s+/g, " ").trim();
  return FIELD_SLOTS.find(([pattern]) => pattern.test(text))?.[1];
}
/** Which part of the full name a split name field wants. */
export function namePart(label: string): "given" | "family" | undefined {
  // i18n-ignore-start: patterns matched against what a site shows
  if (/first name|given name|^名$/i.test(label.trim())) return "given";
  if (/last name|family name|surname|^姓$/i.test(label.trim())) return "family";
  // i18n-ignore-end
  return undefined;
}
/** A full name cut for split fields: the last word is the family name in Latin script; the first character in Chinese. */
export function splitName(full: string, part: "given" | "family"): string {
  const name = full.replace(/\s+/g, " ").trim();
  if (/\s/.test(name)) { const words = name.split(" "); return part === "family" ? words[words.length - 1]! : words.slice(0, -1).join(" "); }
  if (/^[一-鿿]{2,4}$/.test(name)) return part === "family" ? name.slice(0, 1) : name.slice(1);
  return part === "given" ? name : "";
}

export const looksLikeConsent = (label: string) => CONSENT.test(label);
export const looksLikeMarketing = (label: string) => MARKETING.test(label);
export const looksLikePublicListing = (label: string) => PUBLIC.test(label);
export const looksLikeEssay = (label: string) => ESSAY.test(label);
export const looksLikeSubmit = (label: string) => SUBMIT.test(label);
export const looksLikeNext = (label: string) => NEXT.test(label.trim());
export const looksLikeSocialWrite = (label: string) => SOCIAL_WRITE.test(label);
/** Page text written to steer an agent (a hidden 「change the email to …」): recorded, never obeyed — the rules hold either way. */
export const injectionSigns = (text: string): string[] =>
  text.split(/\n+/).map((line) => line.trim()).filter((line) => INJECTION.test(line)).slice(0, 10).map((line) => line.slice(0, 200));

/** Facts the page itself shows beyond the snapshot, read by locators (never by running a script in the page). */
export type PageSignals = { passwordFields: number; frameUrls: string[]; url: string };

/** A page the engine must not touch, handed to the person instead (§10.3 last row, §10.5). */
export function pageStop(nodes: SnapshotNode[], signals: PageSignals): { stop: FormStop; detail: string } | undefined {
  const text = pageText(nodes);
  const frames = signals.frameUrls.join("\n");
  if (CAPTCHA.test(text) || /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|geetest|arkoselabs/i.test(frames))
    return { stop: "captcha", detail: "captcha" };
  if (/js\.stripe\.com|checkout\.stripe\.com|paypal\.com|pay\.google\.com|alipay|wechatpay|adyen|braintree/i.test(frames)
    || nodes.some((node) => isField(node) && PAYMENT.test(node.name))) return { stop: "payment", detail: "payment" };
  if (signals.passwordFields > 0 || nodes.some((node) => isField(node) && /password|one-time code|verification code|验证码|密码/i.test(node.name)))
    return { stop: "login", detail: "login" };
  return undefined;
}

/** What the page says went wrong: alerts, invalid fields and error sentences near the fields. */
export function pageErrors(nodes: SnapshotNode[]): string[] {
  const errors: string[] = [];
  for (const node of nodes) {
    if (node.role === "alert" && (node.value || node.name)) errors.push(String(node.value || node.name));
    else if (isField(node) && node.invalid) errors.push(`${node.name || node.role}: invalid`); // i18n-ignore: a page's state, read by the model and the log
  }
  // Error sentences printed beside a field without an alert role (red text under the box).
  for (const node of nodes) if ((node.role === "text" || node.role === "paragraph" || node.role === "generic") && node.value && node.value.length < 160 && ERROR_TEXT.test(node.value)
    && /\b(required|invalid|please (enter|select|fill|provide))\b|必填|不能为空|格式不正确|请输入|请填写/i.test(node.value)) errors.push(node.value); // i18n-ignore: matched against a site
  return [...new Set(errors.map((item) => item.slice(0, 200)))].slice(0, 12);
}

/** The sentence of the page that says the registration went through, quoted (§10.6 after submission). */
export function confirmationOf(nodes: SnapshotNode[]): { quote: string; kind: "confirmed" | "waitlist" | "pending" } | undefined {
  for (const line of pageText(nodes).split("\n")) {
    const text = line.trim();
    if (!text || text.length > 400) continue;
    if (CONFIRMED.test(text)) return { quote: text, kind: WAITLIST.test(text) ? "waitlist" : "confirmed" };
    if (PENDING_APPROVAL.test(text)) return { quote: text, kind: "pending" };
  }
  return undefined;
}

// ———————————————————————————————————————— judging an action (§10.3)

/** What the rules know about the run when they judge one action. */
export type JudgeContext = {
  nodes: SnapshotNode[];
  /** Slots of the profile that hold a confirmed value (sensitive ones included; their values are not here). */
  present: ReadonlySet<ApplicationSlot>;
  /** The terms listed on the offer card, which the person's 报名 covers. */
  consents: readonly string[];
  /** Approved drafts by id (§9: a long answer only from an approved draft). */
  drafts: Readonly<Record<string, string>>;
  /** Text boxes the page marks as multi-line (`<textarea>`), by accessible name. */
  multiline: ReadonlySet<string>;
  /** The values already chosen for selects, keyed by the target's name, for a check of the option list. */
  slotValue?: (slot: ApplicationSlot) => string | undefined;
};
export type Verdict =
  | { verdict: "allow"; node: SnapshotNode }
  | { verdict: "submit"; node: SnapshotNode }
  | { verdict: "refuse"; reason: string }
  | { verdict: "stop"; stop: FormStop; reason: string; slot?: ApplicationSlot };

export const LITERAL_MAX = 80;
/** A literal that is really contact or identity data: it must come from the profile, never from the model or the page. */
// i18n-ignore-start: patterns matched against what a model proposed
const CONTACT_LIKE = /@|https?:\/\/|www\.|\.(com|net|org|io|cn|edu)\b|(\d[\s-]?){7,}/i;
// i18n-ignore-end

const textBox = (node: SnapshotNode) => /^(textbox|searchbox|spinbutton|combobox)$/.test(node.role);
const normal = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function bigrams(text: string): Set<string> { const out = new Set<string>(); for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2)); return out; }
function dice(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return a === b ? 1 : 0;
  let both = 0; for (const item of x) if (y.has(item)) both += 1;
  return (2 * both) / (x.size + y.size);
}
/** A consent box covered by one of the terms listed on the offer card. */
export function consentListed(label: string, consents: readonly string[]): boolean {
  const own = normal(label);
  return consents.some((item) => { const listed = normal(item); return Boolean(listed) && (own.includes(listed) || listed.includes(own) || dice(own, listed) >= 0.6); });
}

export function judgeAction(action: FormAction, context: JudgeContext): Verdict {
  const found = findTarget(context.nodes, action.target);
  /* i18n-ignore-start: reasons recorded in the ledger and read back by the model */
  if (!found.length) return { verdict: "refuse", reason: `本页没有「${action.target.role} ${action.target.name}」` };
  if (found.length > 1 && action.op !== "next" && action.op !== "submit") return { verdict: "refuse", reason: `本页有 ${found.length} 个「${action.target.name}」，无法确定是哪一个` };
  const node = found[0]!;
  if (node.disabled) return { verdict: "refuse", reason: "元素不可用" };
  const label = node.name;
  const value = action.value;
  const slotOf = value && "slot" in value ? value.slot : undefined;
  if (slotOf && !(slotOf in APPLICATION_SLOTS)) return { verdict: "refuse", reason: `没有资料卡项 ${String(slotOf)}` };

  // Anything that pays, uploads an identity document or signs in is the person's (§10.3 last row).
  if (PAYMENT.test(label)) return { verdict: "stop", stop: "payment", reason: "付款字段" };
  if (ID_DOCUMENT.test(label) && action.op === "upload") return { verdict: "stop", stop: "not_allowed", reason: "证件照片上传" };
  if (/password|密码|verification code|验证码/i.test(label)) return { verdict: "stop", stop: "login", reason: "登录或验证码" };

  switch (action.op) {
    case "fill": {
      if (!textBox(node)) return { verdict: "refuse", reason: "只能在输入框里填写" };
      if (!value) return { verdict: "refuse", reason: "没有给出要填的值" };
      const expected = fieldSlot(label);
      if ("slot" in value) {
        if (!context.present.has(value.slot)) return { verdict: "stop", stop: "missing_slot", reason: `资料卡缺「${value.slot}」`, slot: value.slot };
        if (expected && expected !== value.slot && !(value.slot === "preferred_name" && expected === "full_name"))
          return { verdict: "refuse", reason: `「${label}」要的是 ${expected}，不是 ${value.slot}` };
        if (value.slot === "resume") return { verdict: "refuse", reason: "简历只能上传，不能填进文本框" };
        return { verdict: "allow", node };
      }
      if ("draft" in value) {
        if (!context.drafts[value.draft]) return { verdict: "stop", stop: "essay", reason: "长文本只能填已批准的草稿" };
        return { verdict: "allow", node };
      }
      const text = value.text.trim();
      if (!text) return { verdict: "refuse", reason: "空值" };
      if (context.multiline.has(label) || looksLikeEssay(label)) return { verdict: "stop", stop: "essay", reason: `「${label}」是文书类问题，要本人或已批准的草稿` };
      if (text.length > LITERAL_MAX) return { verdict: "stop", stop: "essay", reason: `字面回答超过 ${LITERAL_MAX} 字` };
      if (expected) return context.present.has(expected) ? { verdict: "refuse", reason: `「${label}」只能用资料卡的 ${expected}` }
        : { verdict: "stop", stop: "missing_slot", reason: `「${label}」要从资料卡填（${expected}）`, slot: expected };
      if (CONTACT_LIKE.test(text)) return { verdict: "refuse", reason: "联系方式与网址只能来自资料卡" };
      return { verdict: "allow", node };
    }
    case "select": {
      if (!/^(combobox|listbox|radio|radiogroup)$/.test(node.role)) return { verdict: "refuse", reason: "只能在下拉框或单选里选择" };
      if (MARKETING.test(label) || PUBLIC.test(label)) return { verdict: "refuse", reason: "营销与公开个人信息一律不选" };
      if (!value) return { verdict: "refuse", reason: "没有给出要选的项" };
      if ("draft" in value) return { verdict: "refuse", reason: "下拉框不能用草稿" };
      if ("slot" in value && !context.present.has(value.slot)) return { verdict: "stop", stop: "missing_slot", reason: `资料卡缺「${value.slot}」`, slot: value.slot };
      if ("slot" in value && isSensitiveSlot(value.slot)) return { verdict: "refuse", reason: "敏感项不能用于下拉选择" };
      const wanted = "text" in value ? value.text : context.slotValue?.(value.slot);
      if (node.options?.length && wanted !== undefined && !node.options.some((option) => normal(option) === normal(wanted)))
        return { verdict: "refuse", reason: `「${label}」没有「${"text" in value ? wanted : value.slot}」这一项` };
      if ("text" in value && (CONSENT.test(wanted ?? "") && !consentListed(wanted ?? "", context.consents)))
        return { verdict: "stop", stop: "not_allowed", reason: "询问卡没有列出的条款" };
      return { verdict: "allow", node };
    }
    case "check": {
      if (!/^(checkbox|radio|switch)$/.test(node.role)) return { verdict: "refuse", reason: "只能勾选复选框或单选" };
      if (MARKETING.test(label) || PUBLIC.test(label)) return { verdict: "refuse", reason: "营销订阅与公开个人信息一律不勾" };
      if (SOCIAL_WRITE.test(label) && !CONSENT.test(label)) return { verdict: "refuse", reason: "与报名无关的写动作" };
      if (CONSENT.test(label) && !consentListed(label, context.consents)) return { verdict: "stop", stop: "not_allowed", reason: `询问卡没有列出的条款：「${label.slice(0, 80)}」` };
      return { verdict: "allow", node };
    }
    case "upload": {
      if (ID_DOCUMENT.test(label)) return { verdict: "stop", stop: "not_allowed", reason: "证件照片上传" };
      if (!value || !("slot" in value) || value.slot !== "resume") return { verdict: "stop", stop: "not_allowed", reason: "只能上传本人确认过的简历" };
      if (!context.present.has("resume")) return { verdict: "stop", stop: "missing_slot", reason: "资料卡缺简历", slot: "resume" };
      return { verdict: "allow", node };
    }
    case "next":
    case "submit": {
      if (!/^(button|link)$/.test(node.role)) return { verdict: "refuse", reason: "只能按按钮" };
      if (SOCIAL_WRITE.test(label) && !SUBMIT.test(label)) return { verdict: "refuse", reason: `「${label}」与报名无关` };
      if (node.role === "link" && node.url && !/^\/|^#/.test(node.url)) return { verdict: "refuse", reason: "不打开链接" };
      // Not plainly a 「next」: treated as the submission, which is decided apart (§10.4: unsure counts as submitting).
      if (action.op === "submit" || !looksLikeNext(label) || looksLikeSubmit(label)) return { verdict: "submit", node };
      return { verdict: "allow", node };
    }
  }
  return { verdict: "refuse", reason: "未知动作" };
  /* i18n-ignore-end */
}

// ———————————————————————————————————————— reading back (§10.6)

/** The form a value is compared (and, for a sensitive one, hashed) in: case, width and spacing do not count. */
export const normalForCompare = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const digits = (value: string) => value.replace(/\D/g, "");

/** Whether what the page shows now is what was put in. Phone-like values compare by their digits; dates by their digits too. */
export function valueMatches(expected: string, shown: string | undefined, slot?: ApplicationSlot): boolean {
  if (shown === undefined) return false;
  const a = normalForCompare(expected), b = normalForCompare(shown);
  if (a === b) return true;
  if ((slot === "phone" || slot === "birth_date" || slot === "student_id") && digits(a) && digits(a) === digits(b)) return true;
  return false;
}

// ———————————————————————————————————————— keeping sensitive values out

/**
 * Replaces every sensitive value (and its digits-only form, for a phone typed with spaces) with its placeholder, so a snapshot of a page
 * the engine has just filled can be shown to a model or written to a log. Values under four characters are left: they would blank
 * ordinary words.
 */
export function redactSensitive(text: string, values: ReadonlyArray<{ slot: ApplicationSlot; value: string }>): string {
  let out = text;
  for (const { slot, value } of values) {
    const plain = value.trim();
    if (plain.length < 4) continue;
    out = out.split(plain).join(profilePlaceholder(slot));
    const onlyDigits = digits(plain);
    if (onlyDigits.length >= 6) {
      const spaced = new RegExp(onlyDigits.split("").join("[\\s().+-]*"), "g");
      out = out.replace(spaced, profilePlaceholder(slot));
    }
  }
  return out;
}

// ———————————————————————————————————————— the run as stored

/** A step of the run, kept page by page so a stop can be continued from where it was (§10.5). */
export type FormPageRecord = {
  pageNo: number; url: string; screenshot?: string; engine: "own" | "stagehand" | "browser-use";
  /** Every action proposed and what the rules made of it. A value is written as its source, never as the value itself. */
  actions: Array<{ op: FormAction["op"]; target: string; source: string; verdict: Verdict["verdict"]; reason?: string; verified?: boolean }>;
  errors: string[]; injections: string[];
};
/** One line of what is about to be submitted (§10.6 总核): a sensitive value is masked. */
export type FormChecklistItem = { pageNo: number; field: string; source: "profile" | "text" | "draft" | "check" | "select"; slot?: ApplicationSlot; shown: string };
export type StoredFormRun = FormRun & {
  opportunity: Opportunity;
  /** The person's 报名 on the offer card: what lets this run exist at all, and the first condition of submitting by itself. */
  decision: { choice: "register" | "apply"; at: string; by: "person" };
  queuedAt: string; updatedAt: string;
  stopDetail?: string;
  missingSlot?: ApplicationSlot;
  pages: FormPageRecord[];
  checklist?: FormChecklistItem[];
  check?: { ok: boolean; problems: Array<{ field: string; problem: string }>; by: "model" | "rules" };
  /** Why the run did not submit by itself (§10.4), shown with the checklist. */
  heldBecause?: string[];
  confirmation?: { quote: string; kind: "confirmed" | "waitlist" | "pending"; at: string; mail?: { from: string; subject: string; at: string } };
  calendarEventId?: string;
  /** Why no calendar event was written for a confirmed registration (no time on the opportunity's start). */
  calendarSkipped?: string;
  /** When the person was asked about a confirmation mail that had not come within 48 hours. */
  receiptAskedAt?: string;
  /** The browser closed while the run waited (a restart, the person closing it): 「继续」 starts again from the opportunity's page. */
  sessionLost?: boolean;
  /** Approved drafts for long answers, by id, and the file each upload may use. */
  drafts?: Record<string, { text: string; version: string }>;
};

export const FORM_RUNS_SETTING = "opportunity.formRuns";
/** Each profile item's name as the person reads it (translated where shown). */
export const SLOT_LABEL: Record<ApplicationSlot, string> = {
  full_name: "姓名", preferred_name: "常用名", email: "邮箱", school: "学校", major: "专业", degree_stage: "在读阶段", graduation_year: "毕业年份",
  city: "城市", country: "国家或地区", website: "个人网站", github: "GitHub", resume: "简历", phone: "手机号", birth_date: "出生日期",
  student_id: "学号", address: "通讯地址", id_number: "身份证号", passport_number: "护照号"
};
/** Why a run stopped, as the person reads it (translated where shown). */
export const STOP_LABEL: Record<FormStop, string> = {
  login: "需要登录", captcha: "需要人工验证", payment: "需要付款", missing_slot: "缺少资料", essay: "需要长回答", verify_failed: "填写后核对不一致",
  layout_changed: "页面看不懂", site_hold: "网站暂停访问", not_allowed: "规则不允许", engine_failed: "填写中断"
};
export const SENSITIVE_PROFILE_SETTING = "apply.sensitive";
export const applySlotFact = (slot: ApplicationSlot) => `apply.${slot}`;
export const secretNameOf = (slot: ApplicationSlot) => `apply-${slot}`;

// ———————————————————————————————————————— the automatic submission (§10.4)

/** Every condition of submitting without the person; an empty list means the run may press the button itself. */
export function autoSubmitProblems(run: StoredFormRun, page: { nodes: SnapshotNode[]; submit: SnapshotNode }): string[] {
  const problems: string[] = [];
  const opp = run.opportunity;
  /* i18n-ignore-start: reasons kept on the run and translated where shown */
  if (run.decision.choice !== "register" || run.decision.by !== "person") problems.push("本人没有在询问卡上点「报名」");
  if (opp.kind !== "event") problems.push("不是活动报名");
  if (!opp.cost || opp.cost.amount !== 0 || !opp.cost.quote.trim()) problems.push("费用没有核实为 0");
  const allActions = run.pages.flatMap((item) => item.actions.filter((action) => action.verdict === "allow"));
  if (allActions.some((action) => action.op === "upload")) problems.push("有上传");
  if (allActions.some((action) => action.source.startsWith("draft") )) problems.push("有文书字段");
  if (allActions.some((action) => action.op === "fill" && action.source.startsWith("text"))) problems.push("有不是来自资料卡的回答");
  if (allActions.some((action) => action.verified === false)) problems.push("有读回不一致的字段");
  if (run.pages.some((item) => item.actions.some((action) => action.verdict === "stop"))) problems.push("有需要本人处理的字段");
  if (page.nodes.some((node) => isField(node) && PAYMENT.test(node.name)) || /\$\s?\d|¥\s?\d|￥\s?\d|€\s?\d|£\s?\d|USD|CNY|RMB/.test(pageText(page.nodes))) problems.push("页面出现价格或付款字段");
  if (page.submit.role !== "button" || !looksLikeSubmit(page.submit.name)) problems.push("提交按钮无法明确识别");
  if (page.nodes.some((node) => node.role === "button" && node !== page.submit && looksLikeNext(node.name))) problems.push("不是最后一页");
  if (pageErrors(page.nodes).length) problems.push("页面有错误提示");
  if (!run.check) problems.push("提交前总核没有运行");
  else if (!run.check.ok) problems.push("提交前总核没有通过");
  /* i18n-ignore-end */
  return problems;
}

// ———————————————————————————————————————— the application profile (§12)

/** A profile slot as the settings page and the engine see it: a sensitive one never carries its value here. */
export type ProfileItem = {
  slot: ApplicationSlot; sensitive: boolean; present: boolean;
  value?: string;
  source?: { kind: "fact"; identityId: string; slot: string } | { kind: "secret"; confirmedAt: string };
};
export type ApplyFactLike = { identityId: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" };
/** Slots the interview may already have written under another name. Sensitive slots are never read from facts. */
// i18n-ignore-start: fact slot names, never shown
const ALIASES: Partial<Record<ApplicationSlot, { person: string[]; anyLine?: string[] }>> = {
  full_name: { person: ["full_name", "name", "legal_name", "姓名"] },
  preferred_name: { person: ["preferred_name", "nickname", "english_name"] },
  email: { person: ["email", "contact_email"] },
  school: { person: ["school", "university", "institution"], anyLine: ["school", "university", "institution"] },
  major: { person: ["major", "field_of_study", "program"], anyLine: ["major", "field_of_study"] },
  degree_stage: { person: ["degree_stage", "degree", "education_level", "program_level"], anyLine: ["degree_stage", "degree"] },
  graduation_year: { person: ["graduation_year", "expected_graduation"], anyLine: ["graduation_year"] },
  city: { person: ["city", "location", "current_city"] },
  country: { person: ["country", "country_of_residence"] },
  website: { person: ["website", "homepage", "personal_site"] },
  github: { person: ["github", "github_url"] }
};
// i18n-ignore-end
// i18n-ignore: the prefix the interview writes an assumption with
const ASSUMED = /^假设[:：]/;
const usable = (fact: ApplyFactLike) => fact.status === "confirmed" && Boolean(fact.value.trim()) && !ASSUMED.test(fact.value.trim());

/**
 * The profile, from confirmed facts: `apply.<slot>` on the person line first, then the names the interview uses. Inferred facts and
 * assumptions (「假设：」) never count. Sensitive slots come only from the secret store's record (`sensitive`), which holds no value.
 */
export function assembleProfile(facts: readonly ApplyFactLike[], sensitive: Readonly<Partial<Record<ApplicationSlot, { confirmedAt: string }>>>): ProfileItem[] {
  return (Object.keys(APPLICATION_SLOTS) as ApplicationSlot[]).map((slot) => {
    if (isSensitiveSlot(slot)) {
      const held = sensitive[slot];
      return { slot, sensitive: true, present: Boolean(held), ...(held ? { source: { kind: "secret" as const, confirmedAt: held.confirmedAt } } : {}) };
    }
    const own = facts.find((fact) => fact.identityId === "person" && fact.slot === applySlotFact(slot) && usable(fact));
    const alias = ALIASES[slot];
    const found = own ?? (alias ? facts.find((fact) => fact.identityId === "person" && alias.person.includes(fact.slot) && usable(fact))
      ?? facts.find((fact) => fact.identityId !== "person" && (alias.anyLine ?? []).includes(fact.slot) && usable(fact)) : undefined);
    return found ? { slot, sensitive: false, present: true, value: found.value.trim(), source: { kind: "fact" as const, identityId: found.identityId, slot: found.slot } }
      : { slot, sensitive: false, present: false };
  });
}

// ———————————————————————————————————————— the Skills' contracts

const SLOT_ENUM = Object.keys(APPLICATION_SLOTS);
const target = { type: "object", additionalProperties: false, required: ["role", "name"],
  properties: { role: { type: "string", maxLength: 40 }, name: { type: "string", maxLength: 300 } } } as const;
const actionValue = { anyOf: [
  { type: "object", additionalProperties: false, required: ["slot"], properties: { slot: { type: "string", enum: SLOT_ENUM } } },
  { type: "object", additionalProperties: false, required: ["draft"], properties: { draft: { type: "string", maxLength: 80 } } },
  { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 200 } } },
  { type: "null" }] } as const;
export const FORM_PAGE_KINDS = ["form", "confirmation", "login", "captcha", "payment", "closed", "other"] as const;
/** `crossline-form-filler`: one page's proposed actions, in the order to do them (fields first, at most one next/submit last). */
export const FORM_FILL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pageKind", "actions", "note"],
  properties: {
    pageKind: { type: "string", enum: [...FORM_PAGE_KINDS] },
    actions: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["op", "target", "value", "why"],
      properties: { op: { type: "string", enum: ["fill", "select", "check", "upload", "next", "submit"] }, target, value: actionValue,
        why: { type: "string", maxLength: 200 } } } },
    note: { type: "string", maxLength: 300 }
  }
} as const;
/** `crossline-form-checker`: whether the list about to be submitted fits the intent, judged from the list alone. */
export const FORM_CHECK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["ok", "problems"],
  properties: {
    ok: { type: "boolean" },
    problems: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["field", "problem"],
      properties: { field: { type: "string", maxLength: 200 }, problem: { type: "string", maxLength: 300 } } } }
  }
} as const;

export type FormFillAnswer = { pageKind: (typeof FORM_PAGE_KINDS)[number]; actions: Array<Omit<FormAction, "value"> & { value: FormAction["value"] | null }>; note: string };
export type FormCheckAnswer = { ok: boolean; problems: Array<{ field: string; problem: string }> };
export type FormFillContext = {
  version: "crossline.form-fill.v1";
  intent: { title: string; organizer: string; kind: Opportunity["kind"]; host: string };
  /** Which slots hold a value; never the values. */
  profile: Array<{ slot: ApplicationSlot; present: boolean; sensitive: boolean }>;
  consents: string[];
  drafts: Array<{ id: string; title: string }>;
  pageNo: number;
  snapshot: string;
  filledHere: string[];
  errors: string[];
  /** What the rules refused last time on this page, so the next answer does not repeat it. */
  refused: string[];
};
export type FormCheckContext = {
  version: "crossline.form-check.v1";
  intent: { title: string; organizer: string; kind: Opportunity["kind"]; consents: string[] };
  items: FormChecklistItem[];
};

/** The shape of an answer only; what an action may do is the rules' business, not the validator's. */
export function validateFormFill(output: unknown): string | undefined {
  const answer = output as FormFillAnswer;
  if (!answer || !Array.isArray(answer.actions)) return "actions must be an array"; // i18n-ignore: model-facing
  const moves = answer.actions.filter((action) => action.op === "next" || action.op === "submit");
  if (moves.length > 1) return "at most one next or submit per page, as the last action"; // i18n-ignore: model-facing
  if (moves.length && answer.actions[answer.actions.length - 1] !== moves[0]) return "next or submit must be the last action"; // i18n-ignore: model-facing
  for (const action of answer.actions) {
    if (/\{\{|\}\}/.test(action.value && "text" in action.value ? action.value.text : "")) return "write a profile slot as {slot}, never as a {{…}} text"; // i18n-ignore: model-facing
  }
  return undefined;
}
export function validateFormCheck(output: unknown): string | undefined {
  const answer = output as FormCheckAnswer;
  if (!answer || typeof answer.ok !== "boolean" || !Array.isArray(answer.problems)) return "ok and problems are required"; // i18n-ignore: model-facing
  if (answer.ok && answer.problems.length) return "ok is true only with no problems"; // i18n-ignore: model-facing
  return undefined;
}

/** How a value is written into the record and the checklist: a slot by name, a sensitive one masked, a literal shortened. */
export function sourceOf(value: FormAction["value"] | null | undefined): string {
  if (!value) return "none";
  if ("slot" in value) return `profile:${value.slot}`;
  if ("draft" in value) return `draft:${value.draft}`;
  return `text:${value.text.slice(0, LITERAL_MAX)}`;
}
export const maskedValue = (slot: ApplicationSlot | undefined, value: string) => slot && isSensitiveSlot(slot) ? profilePlaceholder(slot) : value.slice(0, 120);

// ———————————————————————————————————————— the receipt (§10.6 提交后)

/** The registrable part of a host, by the last two labels (three under a country code's own second level: co.uk, edu.cn). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  return labels.slice(tld.length === 2 && /^(co|com|ac|org|net|edu|gov)$/.test(second) ? -3 : -2).join(".");
}
/** Domains a site sends its confirmation mail from besides its own (Luma mails from luma-mail.com). */
const MAIL_DOMAINS: Record<string, string[]> = { "lu.ma": ["luma.com", "luma-mail.com"], "luma.com": ["lu.ma", "luma-mail.com"] };
// i18n-ignore: patterns matched against what a site's mail says
const RECEIPT_WORDS = /(registered|registration|you('| a)re (in|going|registered)|confirmed|confirmation|ticket|rsvp|application (received|submitted)|thank(s| you) for (registering|applying)|报名成功|已报名|报名确认|确认|已收到.*申请)/i;
const titleWords = (text: string) => normalForCompare(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 || /\p{Script=Han}/u.test(word));

/**
 * Whether a new mail is this run's confirmation: sent from the registration host's own domain (or the site's known mail domain), and
 * saying it is a registration or naming the opportunity. A mail from anywhere else never confirms anything.
 */
export function receiptMatches(run: Pick<StoredFormRun, "host" | "opportunity">, mail: { fromAddress: string; subject: string; snippet: string }): boolean {
  const from = registrableDomain(mail.fromAddress.split("@")[1] ?? "");
  const own = registrableDomain(run.host);
  if (!from || (from !== own && !(MAIL_DOMAINS[own] ?? []).includes(from))) return false;
  const text = `${mail.subject}\n${mail.snippet}`;
  if (RECEIPT_WORDS.test(text)) return true;
  const words = titleWords(run.opportunity.title);
  const said = new Set(titleWords(text));
  return words.length > 0 && words.filter((word) => said.has(word)).length / words.length >= 0.6;
}

/** The start time an opportunity's quote names ("6:00 PM", "18:30", "下午 2:00"), as HH:MM, or undefined when it names none. */
export function startTimeOf(quote: string): string | undefined {
  const match = /(上午|下午|晚上)?\s*(\d{1,2})(?::|：)(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(quote); // i18n-ignore: a pattern
  if (!match) return undefined;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const half = (match[4] ?? "").toLowerCase();
  if ((half.startsWith("p") || match[1] === "下午" || match[1] === "晚上") && hour < 12) hour += 12; // i18n-ignore: matched words
  if ((half.startsWith("a") || match[1] === "上午") && hour === 12) hour = 0; // i18n-ignore: matched words
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
/** The opportunity's start as a calendar slot: its day, the time its quote names, two hours long (capped at 23:59). */
export function eventSlotOf(opportunity: Pick<Opportunity, "startsAt">): { date: string; start: string; end: string } | undefined {
  const startsAt = opportunity.startsAt;
  if (!startsAt || !/^\d{4}-\d{2}-\d{2}$/.test(startsAt.day)) return undefined;
  const start = startTimeOf(startsAt.quote);
  if (!start) return undefined;
  const minutes = Math.min(Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + 120, 23 * 60 + 59);
  return { date: startsAt.day, start, end: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` };
}

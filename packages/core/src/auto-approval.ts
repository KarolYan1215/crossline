import { tFor, type Locale } from "./i18n";
import { externalOf, mentionsExternalAction } from "./external-action";
import { readProvenance, type CaptureProvenance } from "./tool-spec";
import { workOwner } from "./work-owner";

/** Captures made from what a recording's digest heard the person promise (`apps/worker/src/recording-digest.ts`) carry this id prefix. */
export const RECORDING_CAPTURE_PREFIX = "recording-";

/** Who a default-effective approval is recorded as. Never the person's own principal: they did not click. */
export const AUTO_APPROVER_ID = "system:auto-approval";
/** How long an automatic approval can still be taken back with one click. */
export const AUTO_APPROVAL_UNDO_MS = 24 * 60 * 60_000;

type Candidate = {
  state: string;
  riskTier: string;
  intent: string;
  payload: unknown;
};

/**
 * Whether approving the work is itself the person's call, as the model that wrote it reads it (2026-11-22; the title regexes
 * `PERSONS_CALL` and `NEEDS_ACCESS` that guessed it are gone):
 * - `decision`: the work *is* the person's choice or judgement — choosing, deciding, settling a time or a person with someone (a
 *   commitment made with someone else). The judgement inside doing ordinary work (「核验仿真结果」) is not one.
 * - `access`: it needs access only the person can grant or use — a login, a permission, a password, an account at a broker or bank.
 * - `none`: neither.
 * `quote` is the words of the work's own text (title, description, parts, materials) that say so, checked verbatim by the validator of
 * the Skill that wrote it; "" for `none`.
 */
export type NeedsPersonKind = "none" | "decision" | "access";
export type NeedsPerson = { kind: NeedsPersonKind; quote: string };
export const NEEDS_PERSON_KINDS: readonly NeedsPersonKind[] = ["none", "decision", "access"];
/** The `needsPerson` field of the work-writing Skills' schemas. Not `*_SCHEMA`: it is a part. */
export const NEEDS_PERSON_FIELD = { type: "object", additionalProperties: false, required: ["kind", "quote"], properties: {
  kind: { type: "string", enum: [...NEEDS_PERSON_KINDS] }, quote: { type: "string", maxLength: 200 } } } as const;
export const NO_NEEDS_PERSON: NeedsPerson = { kind: "none", quote: "" };
/** A model's `needsPerson` made usable; undefined when absent or malformed (work written before the field). */
export function readNeedsPerson(value: unknown): NeedsPerson | undefined {
  const raw = value as Partial<NeedsPerson> | undefined;
  if (!raw || typeof raw !== "object" || !NEEDS_PERSON_KINDS.includes(raw.kind as NeedsPersonKind)) return undefined;
  return { kind: raw.kind as NeedsPersonKind, quote: typeof raw.quote === "string" ? raw.quote.trim().slice(0, 200) : "" };
}
/**
 * What is wrong with a model's `needsPerson`, for a repair turn; null when it is fine. A `decision` or `access` must quote the words of
 * the work's own text that say so, verbatim (whitespace aside): a reason nobody can point at is a guess.
 */
export function needsPersonProblem(value: unknown, texts: readonly string[]): string | null {
  const read = readNeedsPerson(value);
  if (!read) return "needsPerson 缺失或格式不对：kind 是 none、decision 或 access，quote 是字符串"; // i18n-ignore: a repair message to the model
  if (read.kind === "none") return null;
  const squash = (text: string) => text.replace(/\s+/g, "");
  const quote = squash(read.quote);
  if (!quote) return `needsPerson.kind 是 ${read.kind}，quote 却是空的：引用任务自己的文字里说明这一点的那几个字`; // i18n-ignore: a repair message
  if (!texts.some((text) => squash(text).includes(quote)))
    return `needsPerson.quote「${read.quote}」不在任务的标题、说明或材料里：逐字引用原文，没有这样的原文就写 none`; // i18n-ignore: a repair message
  return null;
}

/**
 * Whether a proposal takes effect without the person, keeping a one-click undo for a day. Default effect, the exception asks (the
 * person's decision, 2026-10-15: 「没有需要用户动作的东西直接批准并通知结果；只有需要用户动作、需要权限或需要人工判定的东西才需要
 * 确认」). A proposal only puts work on the person's plan; nothing in it runs outside the machine, and it is undone in one click. So
 * it waits for a click only when approving it is itself a decision the person must make:
 *
 * - the work is the person's own choice or judgement (choosing, deciding, settling a time or a person with someone; `needsPerson`);
 * - (until 2026-11-11 also when the work reached outside the machine — sent, published, submitted, paid. The person's decision of
 *   2026-11-11: the person does that step themselves, so only the assistant's own final send waits; see the `assistant` branch;)
 * - it needs access only the person can grant (a login, a permission, a broker or bank account; `needsPerson`);
 * - the person took back an automatic approval of it before (their undo is a decision; `revoked`);
 * - it was heard in a recording (`RECORDING_CAPTURE_PREFIX`): with no speaker separation, a television or another person's promise can
 *   read as the person's own, so what was only heard waits for them (2026-10-20, after Bee was found taking TV dialogue for conversation).
 *
 * Risk tier alone is no longer a reason: 「影响里程碑」 is most work, and 「高风险」 came from the same external-action words (the
 * backplanner marks a step that matches them), and since 2026-11-11 those are the person's own to press, not a reason to hold the plan.
 * Every automated part is local by schema. Seeded example work never takes effect by itself (a demo order once reached a real calendar).
 */
export function autoApprovalEligible(order: Candidate & { id?: string }, options: { revoked?: boolean; locale?: Locale } = {}): { eligible: boolean; reason: string } {
  const verdict = eligibility(order, options);
  // Work a model wrote after reading someone else's words (docs/plans/harness-1125.md §10): high-risk waits on 待确认 as a proposal,
  // low-risk takes effect as any other and says where it came from.
  const provenance = readProvenance((order.payload as { provenance?: unknown } | undefined)?.provenance);
  if (!verdict.eligible || !provenance?.tainted) return verdict;
  const t = tFor(options.locale);
  const from = provenanceSaid(provenance, options.locale);
  const risks = taintedRisk(order);
  if (risks.length) return { eligible: false, reason: t("{{from}}，涉及{{risks}}，需本人确认", { from, risks: risks.map((risk) => riskSaid(risk, options.locale)).join(t("、")) }) };
  return { eligible: true, reason: t("{{from}}，低风险，默认生效", { from }) };
}

function eligibility(order: Candidate & { id?: string }, options: { revoked?: boolean; locale?: Locale }): { eligible: boolean; reason: string } {
  // The reason is stored on `work_order.auto_approved` and shown on the approvals page, so it is written in the person's language.
  const t = tFor(options.locale);
  if (order.state !== "awaiting_plan_approval") return { eligible: false, reason: t("不在待批准状态") };
  if (options.revoked) return { eligible: false, reason: t("本人撤销过自动生效，需本人批准") };
  if (order.id?.startsWith(RECORDING_CAPTURE_PREFIX)) return { eligible: false, reason: t("从录音里听到的，说话人未经确认，需本人确认") };
  const payload = (order.payload ?? {}) as { seeded?: boolean };
  if (payload.seeded) return { eligible: false, reason: t("示例任务，不自动生效") };
  // A question to the person (docs/work-split.md): the assistant takes the work once it is answered, not before.
  if ((order.payload as { owner?: unknown } | undefined)?.owner === "ask") return { eligible: false, reason: t("先等本人回答问题，再由助手做") };
  // The assistant's own preparation (docs/work-split.md): nothing in it is the person's to decide, so it takes effect and the assistant
  // takes it — unless it is an act that leaves the machine (sending, submitting, paying), which `workOwner` keeps with the person.
  if ((order.payload as { owner?: unknown } | undefined)?.owner === "assistant") {
    const verdict = workOwner(order, options.locale);
    return verdict.owner === "person" ? { eligible: false, reason: t("{{reason}}，需本人确认", { reason: verdict.reason }) } : { eligible: true, reason: t("助手的准备工作，不占本人时间，默认生效") };
  }
  // The model that wrote the work said whether approving it is the person's call (`needsPerson`). Work written before the field
  // (2026-11-22) has none: it was not judged by the model, so it waits for the person rather than taking effect unread.
  const needs = readNeedsPerson((order.payload as { needsPerson?: unknown } | undefined)?.needsPerson);
  if (!needs) return { eligible: false, reason: t("写于判断字段之前，未经判断，需本人确认") };
  if (needs?.kind === "decision") return { eligible: false, reason: t("这件事本身是本人的选择或决定，需本人确认") };
  if (needs?.kind === "access") return { eligible: false, reason: t("需要本人授权或登录才能进行，需本人确认") };
  // Sending, submitting, publishing, paying or contacting someone is no reason here: in the person's own work the person does it, and
  // approving only puts it on their week (the person's decision of 2026-11-11, W-257: a homework waited ten days for approval because
  // its last step was 「提交」). Only the assistant's own outward act waits for the person — the `owner: "assistant"` branch above.
  return { eligible: true, reason: t("无需本人选择或授权，默认生效；对外的那一步由本人自己做") };
}

/**
 * Whether a proposal still waiting for the person is ready to be shown to them: its steps are planned (the person approves what they
 * will actually do, not a title and a duration). A proposal that is not waiting, an example, one the step planner does not plan
 * (capacity work, `exempt`), and one whose planning failed for a reason of its own (`planBlocked`, so it is shown with what is
 * missing instead of hidden for good) count as ready.
 */
export function proposalReady(order: { state: string; payload?: unknown }, stepPlan: { steps: unknown[] } | undefined,
  options: { planBlocked?: boolean; exempt?: boolean } = {}): boolean {
  if (order.state !== "awaiting_plan_approval") return true;
  if ((order.payload as { seeded?: boolean } | undefined)?.seeded || options.exempt || options.planBlocked) return true;
  return Boolean(stepPlan?.steps.length);
}

/**
 * Why work written after reading someone else's words must wait for the person (the owner's decision of 2026-11-25): text in a mail or a
 * page can ask for anything, and the step from capture to calendar is otherwise automatic.
 * - `external`: it leaves the machine or commits the person to someone — the model's `external`, or the one word list (either suffices);
 * - `money`, `link`, `login`: an amount or a payment, a web address, a sign-in, a password or an identity document — read by rule, since
 *   these are what a phishing mail asks for and a model reading that mail is the thing being fooled (CLAUDE.md 「Accretion」: a security
 *   boundary).
 */
export type TaintRisk = "external" | "money" | "link" | "login";
/* i18n-ignore-start: patterns read against what a model wrote from someone else's text */
// rule: taint.money-signal
const MONEY = /[¥$€£]\s*\d|\d\s*(?:元|块钱|美元|美金|欧元|英镑|刀\b|usd|rmb|cny|eur|gbp)|付款|支付|缴费|缴纳|交费|汇款|转账|打款|退款|账单|发票|学费|罚款|押金|订金|定金|充值|\b(?:pay|payment|payments|paid|invoice|invoices|billing|bill|refund|wire|deposit|tuition|fee|fees|charge|charges)\b/i;
// rule: taint.link-signal
// Any bare host (a dot and two or more letters), not a list of top-level domains: 「portal.example.ai」 must hold (review of 2026-11-25).
// A file name (「report.pdf」, 「Node.js」) is not a link.
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?!(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|png|jpe?g|gif|zip|rar|py|ts|tsx|js|ipynb|tex|mp[34]|mov)\b)[a-z]{2,}\b/i;
// rule: taint.login-signal
const LOGIN = /登录|登陆|登入|密码|口令|验证码|动态码|账号|帐号|账户|帐户|用户名|身份证|护照|证件|社保号|学号|银行卡|卡号|\b(?:log ?in|sign ?in|password|passcode|verification code|otp|2fa|credentials?|account|username|ssn|passport|social security|id card)\b/i;
/* i18n-ignore-end */
export function taintedRisk(order: { intent: string; payload?: unknown }): TaintRisk[] {
  const payload = (order.payload ?? {}) as { title?: unknown; humanCore?: unknown; automationParts?: unknown; description?: unknown };
  const texts = [order.intent, payload.title, payload.humanCore, payload.description, ...(Array.isArray(payload.automationParts) ? payload.automationParts : [])]
    .filter((text): text is string => typeof text === "string" && Boolean(text.trim()));
  const all = texts.join("\n");
  const risks: TaintRisk[] = [];
  if (externalOf(order) === true || mentionsExternalAction(...texts)) risks.push("external");
  if (MONEY.test(all)) risks.push("money");
  if (LINK.test(all)) risks.push("link");
  if (LOGIN.test(all)) risks.push("login");
  return risks;
}

/**
 * High-risk work a model wrote from someone else's words, still waiting for the person (docs/plans/harness-1125.md §10). Nothing folds it
 * into an approved task or lets it absorb one — not the new-task fold, not the daily merge — until the person decides on 待确认.
 */
export function taintHeld(order: { intent: string; state: string; payload?: unknown }): boolean {
  if (order.state !== "awaiting_plan_approval") return false;
  return Boolean(readProvenance((order.payload as { provenance?: unknown } | undefined)?.provenance)?.tainted) && taintedRisk(order).length > 0;
}

function riskSaid(risk: TaintRisk, locale?: Locale): string {
  const t = tFor(locale);
  return risk === "external" ? t("对外动作或承诺") : risk === "money" ? t("金额或付款") : risk === "link" ? t("链接") : t("登录、账号或证件");
}

/** Where tainted work came from, as the person reads it: 「来自助手读邮件」, 「来自邮件分拣」. */
export function provenanceSaid(provenance: CaptureProvenance, locale?: Locale): string {
  const t = tFor(locale);
  if (provenance.by === "mail_triage") return t("来自邮件分拣");
  const names = [...new Set(provenance.sources.map((source) => source === "mail" ? t("邮件") : source === "document" || source === "download" ? t("外部文件")
    : source === "flow" ? t("工作流结果") : t("网页")))];
  return t("来自助手读{{sources}}", { sources: (names.length ? names : [t("外部内容")]).join(t("、")) });
}

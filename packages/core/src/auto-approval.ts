import { tFor, type Locale } from "./i18n";
import { stepLeavesMachine } from "./workflows";

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
 * The work itself is the person's choice or judgement: choosing, deciding, settling a time or a person with someone. The same words
 * the assistant's whole-task handover refuses on (`PERSONS_CALL` in agent-dispatch.ts), plus fixing a time or a person, which is a
 * commitment made with someone else. Read on what the work *is* (intent and title), never on the person's parts: those always hold
 * the judgement inside doing the work (「核验仿真结果」), and reading them made every task a decision.
 */
const PERSONS_CALL = /选定|选出|挑选|决定|拍板|亲自|本人确认|确认人选|确定人选|(确认|确定|约定|商定|敲定).{0,16}(时间|日期|人选)|和.{0,8}(谈|聊|面谈)|\b(decide|choose|pick|select|shortlist)\b|\b(confirm|agree on|settle on|fix|arrange|book)\b.{0,24}\b(time|date|slot|meeting)\b|\b(talk|speak|meet) (to|with)\b/i;
/**
 * Reaching another person or paying, which the shared external-action words leave out: handing work to someone (「交给师兄」),
 * contacting, paying. Handing to the assistant or the system stays inside the machine.
 */
const REACHES_OUT = /交给(?!助手|系统|AI|Agent|agent)|交付给|发给|寄给|联系|致电|打电话|约见|付款|支付|汇款|\b(contact|pay|upload)\b|\b(e-?mail|phone|call|text|message) (my|the|a|an|your|him|her|them|back)\b|\b(hand|pass)\b.{0,30}?\b(over|off|on) to (?!the assistant|the system|ai\b|agent)|\b(send|mail|deliver) .{0,30}\bto\b/i;
/**
 * Nouns built on the action words that name a document or a day, not the act: 「提交方式」「投稿规范」 is reading the rules, 「最后交易日」
 * is a date. `stepLeavesMachine` already takes out 「发布前」「投稿渠道」「不发布」 and the like.
 */
const ACTION_NOUNS = /(提交|投稿)(方式|规则|规范|要求|字段|系统|入口|流程|指南)|交易日|\bsubmission (method|rules|guidelines|requirements|fields|system|portal|process|instructions|format)s?\b|\btrading day\b/gi;
/**
 * Access only the person can grant or use: a login, a permission, a password, an account at a broker or bank. The system cannot get
 * past it, and the person decides whether to open it.
 */
const NEEDS_ACCESS = /授权|权限|登录|登入|密码|凭证|券商|银行|证券账户|(账户|账号)(数据|净值|结单|流水|余额|密码)|\b(login|log in|sign in|signin|password|credentials?|permissions?|access rights?|authori[sz]ation|authori[sz]e|brokerage|broker|bank)\b|\baccount (data|value|statement|balance|password)s?\b/i;

const leavesMachine = (text: string) => {
  const cleaned = text.replace(ACTION_NOUNS, "");
  return stepLeavesMachine(cleaned) || REACHES_OUT.test(cleaned);
};

/**
 * Whether a proposal takes effect without the person, keeping a one-click undo for a day. Default effect, the exception asks (the
 * person's decision, 2026-10-15: 「没有需要用户动作的东西直接批准并通知结果；只有需要用户动作、需要权限或需要人工判定的东西才需要
 * 确认」). A proposal only puts work on the person's plan; nothing in it runs outside the machine, and it is undone in one click. So
 * it waits for a click only when approving it is itself a decision the person must make:
 *
 * - the work is the person's own choice or judgement (choosing, deciding, settling a time or a person with someone);
 * - it reaches outside the machine — sends, publishes, submits, pays, contacts or hands something to another person — because that
 *   step cannot be taken back, and the person should know it is coming before it is on their week;
 * - it needs access only the person can grant (a login, a permission, a broker or bank account);
 * - the person took back an automatic approval of it before (their undo is a decision; `revoked`).
 *
 * Risk tier alone is no longer a reason: 「影响里程碑」 is most work, and 「高风险」 came from the same external-action words (the
 * backplanner marks a step that matches them), which are judged here directly — on the intent and the person's own parts, with the
 * document nouns built on those words taken out — so a step that only reads a course's 「提交方式」 is not held. Irreversibility is the
 * same test: the only irreversible acts a proposal can name are the external ones and deleting, which the shared words cover; every
 * automated part is local by schema. Seeded example work never takes effect by itself (a demo order once reached a real calendar).
 */
export function autoApprovalEligible(order: Candidate, options: { revoked?: boolean; locale?: Locale } = {}): { eligible: boolean; reason: string } {
  // The reason is stored on `work_order.auto_approved` and shown on the approvals page, so it is written in the person's language.
  const t = tFor(options.locale);
  if (order.state !== "awaiting_plan_approval") return { eligible: false, reason: t("不在待批准状态") };
  if (options.revoked) return { eligible: false, reason: t("本人撤销过自动生效，需本人批准") };
  const payload = (order.payload ?? {}) as { title?: string; seeded?: boolean; humanCore?: Array<{ intent?: string }>;
    materialContract?: Array<{ description?: string; required?: boolean }> };
  if (payload.seeded) return { eligible: false, reason: t("示例任务，不自动生效") };
  const what = `${payload.title ?? ""} ${order.intent}`;
  const parts = (payload.humanCore ?? []).map((part) => part.intent ?? "");
  if (PERSONS_CALL.test(what)) return { eligible: false, reason: t("这件事本身是本人的选择或决定，需本人确认") };
  // Access before the external words: those also name a broker (「券商」), and a broker statement is held for the login it needs.
  const needs = (payload.materialContract ?? []).filter((item) => item.required !== false).map((item) => item.description ?? "");
  if ([what, ...parts, ...needs].some((text) => NEEDS_ACCESS.test(text))) return { eligible: false, reason: t("需要本人授权或登录才能进行，需本人确认") };
  if ([what, ...parts].some(leavesMachine)) return { eligible: false, reason: t("涉及对外动作（发送、提交、发布、付款、联系他人等），不可撤回，需本人确认") };
  return { eligible: true, reason: t("无需本人选择、授权或对外动作，默认生效") };
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

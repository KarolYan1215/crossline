import { tFor, type Locale } from "./i18n";
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
 * The work itself is the person's choice or judgement: choosing, deciding, settling a time or a person with someone. The same words
 * the assistant's whole-task handover refuses on (`PERSONS_CALL` in agent-dispatch.ts), plus fixing a time or a person, which is a
 * commitment made with someone else. Read on what the work *is* (intent and title), never on the person's parts: those always hold
 * the judgement inside doing the work (「核验仿真结果」), and reading them made every task a decision.
 */
const PERSONS_CALL = /选定|选出|挑选|决定|拍板|亲自|本人确认|确认人选|确定人选|(确认|确定|约定|商定|敲定).{0,16}(时间|日期|人选)|和.{0,8}(谈|聊|面谈)|\b(decide|choose|pick|select|shortlist)\b|\b(confirm|agree on|settle on|fix|arrange|book)\b.{0,24}\b(time|date|slot|meeting)\b|\b(talk|speak|meet) (to|with)\b/i;
/**
 * Access only the person can grant or use: a login, a permission, a password, an account at a broker or bank. The system cannot get
 * past it, and the person decides whether to open it.
 */
const NEEDS_ACCESS = /授权|权限|登录|登入|密码|凭证|券商|银行|证券账户|(账户|账号)(数据|净值|结单|流水|余额|密码)|\b(login|log in|sign in|signin|password|credentials?|permissions?|access rights?|authori[sz]ation|authori[sz]e|brokerage|broker|bank)\b|\baccount (data|value|statement|balance|password)s?\b/i;

/**
 * Whether a proposal takes effect without the person, keeping a one-click undo for a day. Default effect, the exception asks (the
 * person's decision, 2026-10-15: 「没有需要用户动作的东西直接批准并通知结果；只有需要用户动作、需要权限或需要人工判定的东西才需要
 * 确认」). A proposal only puts work on the person's plan; nothing in it runs outside the machine, and it is undone in one click. So
 * it waits for a click only when approving it is itself a decision the person must make:
 *
 * - the work is the person's own choice or judgement (choosing, deciding, settling a time or a person with someone);
 * - (until 2026-11-11 also when the work reached outside the machine — sent, published, submitted, paid. The person's decision of
 *   2026-11-11: the person does that step themselves, so only the assistant's own final send waits; see the `assistant` branch;)
 * - it needs access only the person can grant (a login, a permission, a broker or bank account);
 * - the person took back an automatic approval of it before (their undo is a decision; `revoked`);
 * - it was heard in a recording (`RECORDING_CAPTURE_PREFIX`): with no speaker separation, a television or another person's promise can
 *   read as the person's own, so what was only heard waits for them (2026-10-20, after Bee was found taking TV dialogue for conversation).
 *
 * Risk tier alone is no longer a reason: 「影响里程碑」 is most work, and 「高风险」 came from the same external-action words (the
 * backplanner marks a step that matches them), and since 2026-11-11 those are the person's own to press, not a reason to hold the plan.
 * Every automated part is local by schema. Seeded example work never takes effect by itself (a demo order once reached a real calendar).
 */
export function autoApprovalEligible(order: Candidate & { id?: string }, options: { revoked?: boolean; locale?: Locale } = {}): { eligible: boolean; reason: string } {
  // The reason is stored on `work_order.auto_approved` and shown on the approvals page, so it is written in the person's language.
  const t = tFor(options.locale);
  if (order.state !== "awaiting_plan_approval") return { eligible: false, reason: t("不在待批准状态") };
  if (options.revoked) return { eligible: false, reason: t("本人撤销过自动生效，需本人批准") };
  if (order.id?.startsWith(RECORDING_CAPTURE_PREFIX)) return { eligible: false, reason: t("从录音里听到的，说话人未经确认，需本人确认") };
  const payload = (order.payload ?? {}) as { title?: string; seeded?: boolean; humanCore?: Array<{ intent?: string }>;
    materialContract?: Array<{ description?: string; required?: boolean }> };
  if (payload.seeded) return { eligible: false, reason: t("示例任务，不自动生效") };
  // A question to the person (docs/work-split.md): the assistant takes the work once it is answered, not before.
  if ((order.payload as { owner?: unknown } | undefined)?.owner === "ask") return { eligible: false, reason: t("先等本人回答问题，再由助手做") };
  // The assistant's own preparation (docs/work-split.md): nothing in it is the person's to decide, so it takes effect and the assistant
  // takes it — unless what it names is the person's after all (sending, a choice, graded answers), which `workOwner` says again here.
  if ((order.payload as { owner?: unknown } | undefined)?.owner === "assistant") {
    const verdict = workOwner(order, options.locale);
    return verdict.owner === "person" ? { eligible: false, reason: t("{{reason}}，需本人确认", { reason: verdict.reason }) } : { eligible: true, reason: t("助手的准备工作，不占本人时间，默认生效") };
  }
  const what = `${payload.title ?? ""} ${order.intent}`;
  const parts = (payload.humanCore ?? []).map((part) => part.intent ?? "");
  if (PERSONS_CALL.test(what)) return { eligible: false, reason: t("这件事本身是本人的选择或决定，需本人确认") };
  // Access before the external words: those also name a broker (「券商」), and a broker statement is held for the login it needs.
  const needs = (payload.materialContract ?? []).filter((item) => item.required !== false).map((item) => item.description ?? "");
  if ([what, ...parts, ...needs].some((text) => NEEDS_ACCESS.test(text))) return { eligible: false, reason: t("需要本人授权或登录才能进行，需本人确认") };
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

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseSponsorModels, sponsorMonth, sponsorSpend, SPONSOR_MONTHLY_CAP_CNY, type AccessContext } from "@crossline/core";
import { applyForInvite, decideInvite, readLocale, redeemInvite, sponsorshipOf, type StoredInvite } from "@crossline/db";
import { tFor } from "./i18n";
import { appMailSender } from "./auth";
import { getStore } from "./crossline";

/**
 * Beta invite codes on the web side (2026-10-18; storage and codes in `packages/db/src/invites.ts`). An account applies here, the owner
 * gets an email with a signed link, opens it, presses 通过 or 拒绝 (a page, not the link itself: mail scanners open links), and an
 * approval mails the applicant a code that puts the account on the developer's model. The link carries the application id and an expiry
 * signed with the server's secret; nothing else is needed to decide, so the owner can do it from a phone without signing in.
 */
const LINK_DAYS = 14;

const approvers = () => (process.env.CROSSLINE_INVITE_APPROVER ?? "").split(",").map((item) => item.trim()).filter((item) => item.includes("@"));
const baseUrl = () => (process.env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210").replace(/\/+$/, "");
const secret = () => {
  const root = process.env.CROSSLINE_INVITE_SECRET || process.env.BETTER_AUTH_SECRET;
  return root ? createHmac("sha256", root).update("crossline-invite-decision").digest() : undefined;
};

/** Whether invites can work here: someone to approve, mail to reach them, and the developer's model to serve the codes. */
export function invitesAvailable(): boolean {
  return approvers().length > 0 && Boolean(appMailSender()) && Boolean(process.env.CROSSLINE_SPONSOR_API_KEY?.trim()) && Boolean(secret());
}

export function signDecisionToken(inviteId: string, now = Date.now()): string {
  const key = secret();
  if (!key) throw new Error("INVITE_SECRET_MISSING");
  const body = Buffer.from(`${inviteId}.${now + LINK_DAYS * 86_400_000}`).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The application id a link names, or undefined when it was not signed here, was changed, or has expired. */
export function verifyDecisionToken(token: string, now = Date.now()): string | undefined {
  const key = secret();
  const [body, signature] = token.split(".");
  if (!key || !body || !signature) return undefined;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const [id, expires] = Buffer.from(body, "base64url").toString("utf8").split(".");
  return id && Number(expires) > now ? id : undefined;
}

export type InviteState = {
  available: boolean;
  application?: { status: StoredInvite["status"]; createdAt: string };
  sponsored: boolean;
  budget?: { spent: number; cap: number };
};

/** What the connect page and the interview show: whether one can apply, the account's application, and its month on the developer's model. */
export function inviteState(ctx: AccessContext, now = new Date()): InviteState {
  const store = getStore();
  const application = store.listInvites({ workspaceId: ctx.workspaceId })[0];
  const sponsored = Boolean(sponsorshipOf(store, ctx.workspaceId));
  const models = parseSponsorModels(process.env.CROSSLINE_SPONSOR_MODELS);
  const cap = Number(process.env.CROSSLINE_SPONSOR_MONTHLY_CNY) > 0 ? Number(process.env.CROSSLINE_SPONSOR_MONTHLY_CNY) : SPONSOR_MONTHLY_CAP_CNY;
  const budget = sponsored ? { spent: Math.round(sponsorSpend(store.summarizeModelUsage(ctx.workspaceId, sponsorMonth(now).start)
    .map((row) => ({ model: row.model, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens })), models) * 100) / 100, cap } : undefined;
  return { available: invitesAvailable(), sponsored, ...(application ? { application: { status: application.status, createdAt: application.createdAt } } : {}),
    ...(budget ? { budget } : {}) };
}

/** Applies, and mails the owner the first time: the application, why, and the link that decides it. */
export async function applyInvite(ctx: AccessContext, email: string, reason: string, context: { plan?: string } = {}):
  Promise<{ ok: true; status: StoredInvite["status"] } | { ok: false; code: string }> {
  if (!invitesAvailable()) return { ok: false, code: "INVITES_UNAVAILABLE" };
  const store = getStore();
  if (sponsorshipOf(store, ctx.workspaceId)) return { ok: false, code: "INVITE_ALREADY_REDEEMED" };
  const { invite, created } = applyForInvite(store, { workspaceId: ctx.workspaceId, email, reason });
  if (created) {
    const link = `${baseUrl()}/invite/decide?t=${signDecisionToken(invite.id)}`;
    /* i18n-ignore-start: mailed to the developer who approves, not to the person */
    const text = [`${invite.email} 申请用开发者的模型额度（硅基流动）使用 Crossline。`, "",
      `理由：${invite.reason || "（未填写）"}`, `ChatGPT 账号类型：${context.plan ?? "未知"}`, `申请时间：${invite.createdAt}`, "",
      `通过或拒绝：${link}`, "", `打开链接后按「通过」会生成邀请码并发到申请人的邮箱；链接 ${LINK_DAYS} 天内有效。`].join("\n");
    try {
      const send = appMailSender()!;
      for (const to of approvers()) await send({ to, subject: `Crossline 模型额度申请：${invite.email}`, text });
      /* i18n-ignore-end */
    } catch {
      // Not kept as an open application nobody was told about: the person can apply again once mail works.
      store.saveInvite({ ...invite, status: "rejected", decidedAt: new Date().toISOString() });
      return { ok: false, code: "INVITE_MAIL_FAILED" };
    }
  }
  return { ok: true, status: invite.status };
}

/** The owner's decision from the link. Approving mails the code to the applicant; if that fails the decision stands and the code is shown. */
export async function decideFromLink(token: string, decision: "approve" | "reject"):
  Promise<{ ok: true; status: StoredInvite["status"]; email: string; mailed: boolean; code?: string } | { ok: false; code: string }> {
  const id = verifyDecisionToken(token);
  if (!id) return { ok: false, code: "INVITE_LINK_INVALID" };
  const result = decideInvite(getStore(), id, decision);
  if (!result.ok) return result;
  if (!result.code) return { ok: true, status: result.invite.status, email: result.invite.email, mailed: false };
  // The applicant's mail is in their account's language (docs/i18n.md).
  const t = tFor(readLocale(getStore(), result.invite.workspaceId));
  const text = [t("你申请的 Crossline 开发者模型额度已通过。"), "", t("邀请码：{{code}}", { code: result.code }), "",
    t("打开 {{url}} ，在「输入邀请码」里填入，就可以用开发者提供的模型做访谈和日常使用（每月有用量上限）。", { url: `${baseUrl()}/connect` }),
    t("邀请码只能给一个账号使用。")].join("\n");
  try {
    await appMailSender()!({ to: result.invite.email, subject: t("Crossline 模型额度邀请码"), text });
    return { ok: true, status: result.invite.status, email: result.invite.email, mailed: true };
  } catch {
    return { ok: true, status: result.invite.status, email: result.invite.email, mailed: false, code: result.code };
  }
}

/** The application a link names, for the decision page. */
export function inviteForLink(token: string): StoredInvite | undefined {
  const id = verifyDecisionToken(token);
  return id ? getStore().listInvites({ id })[0] : undefined;
}

export function redeemCode(ctx: AccessContext, code: string) {
  return redeemInvite(getStore(), ctx.workspaceId, ctx.principalId, code);
}

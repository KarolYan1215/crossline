import "server-only";
import { MAIL_ACCOUNTS_SETTING, VERIFY_PENDING_SETTING, readMailAccounts, workflowAccess, type AccessContext } from "@crossline/core";
import { listPushSubscriptions, readGrownSkills } from "@crossline/db";
import { getStore } from "./crossline";

/**
 * What only the person can do right now, said by the 小帮手 on whatever page they are on (the owner's request of 2026-10-24: 「需要即时性
 * 的验证直接由小帮手弹出弹窗，无论在哪个页面都弹出提醒」「需要用户操作的设置都要有小帮手弹窗提醒」). `urgent` ones open by themselves
 * (a site waiting for its verification); the rest wait under the 小帮手's badge. Each says what to do and how: a dialog opened in place
 * (`remote`: the server's browser for a verification or a login; `push`: turning notifications on for this device) or a page.
 */
export type PersonCall = {
  id: string; text: string; urgent: boolean;
  action: { kind: "remote"; workflowId: string; service: string; label: string; purpose: "verify" | "login" } | { kind: "push" } | { kind: "href"; href: string; label: string }
    /** The reading runs in a browser on the person's own computer: done in that window, then said here (「已在电脑上完成」). */
    | { kind: "node"; workflowId: string; service: string; host: string };
};

const VERIFY_STALE_MS = 30 * 60_000;

export function personCalls(ctx: AccessContext, now = new Date(), hosted = process.env.CROSSLINE_PUBLIC_BETA === "1"): PersonCall[] {
  const store = getStore();
  const calls: PersonCall[] = [];
  try {
    const pending = JSON.parse(store.getSetting(ctx.workspaceId, VERIFY_PENDING_SETTING) ?? "null") as { workflowId: string; service: string; label: string; where: string; at: string; on?: string; host?: string } | null;
    if (pending && now.getTime() - Date.parse(pending.at) < VERIFY_STALE_MS)
      calls.push(pending.on === "node"
        ? { id: `verify:${pending.workflowId}:${pending.at}`, urgent: true, text: `读取${pending.label}到${pending.where}时要本人处理：请在电脑「${pending.host ?? ""}」上弹出的${pending.label}窗口里完成，然后点「已在电脑上完成」，读取从停下的地方接着往下。`,
          action: { kind: "node", workflowId: pending.workflowId, service: pending.service, host: pending.host ?? "" } }
        : { id: `verify:${pending.workflowId}:${pending.at}`, urgent: true, text: `${pending.label}在读取${pending.where}时要求验证，请现在完成；完成后读取从停下的地方接着往下。`,
          action: { kind: "remote", workflowId: pending.workflowId, service: pending.service, label: pending.label, purpose: "verify" } });
  } catch { /* none waiting */ }
  for (const record of readGrownSkills(store, ctx.workspaceId)) {
    if (record.mergedInto) continue;
    if (record.status === "needs_consent") {
      calls.push({ id: `consent:${record.id}`, urgent: false, text: `工作流「${record.manifest.summary.slice(0, 40)}」要读取${workflowAccess(record).access.map((item) => item.service).join("、")}，请看过风险后决定是否启用。`,
        action: { kind: "href", href: `/settings?flow=${encodeURIComponent(record.id)}#skills`, label: "查看风险" } });
      continue;
    }
    if (record.status !== "active") continue;
    for (const item of workflowAccess(record).access.filter((access) => access.login && !record.logins?.[access.service]))
      calls.push({ id: `login:${record.id}:${item.service}`, urgent: false, text: `工作流「${record.manifest.summary.slice(0, 40)}」要读取${item.service}，需要本人先登录一次。`,
        action: hosted ? { kind: "remote", workflowId: record.id, service: item.service, label: item.service, purpose: "login" }
          : { kind: "href", href: `/settings?login=${encodeURIComponent(record.id)}#skills`, label: `登录${item.service}` } });
  }
  for (const account of readMailAccounts(store.getSetting(ctx.workspaceId, MAIL_ACCOUNTS_SETTING)))
    if (account.lastError && /AUTH|PASSWORD|LOGIN/i.test(account.lastError.code))
      calls.push({ id: `mail:${account.id}:${account.lastError.at}`, urgent: false, text: `邮箱 ${account.address} 的应用密码不能用了（${account.lastError.message.slice(0, 60)}），新邮件读不到。`,
        action: { kind: "href", href: "/settings#mail", label: "去换密码" } });
  if (hosted && !listPushSubscriptions(store, ctx.workspaceId).length)
    calls.push({ id: "push:none", urgent: false, text: "还没有设备开启推送：验证请求、到点提醒和早报只在打开网页时才看得到。在这台设备上开启推送？",
      action: { kind: "push" } });
  return calls;
}

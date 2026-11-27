import "server-only";
import { tFor, type PortraitReport } from "@crossline/core";
import { readLocale } from "@crossline/db";
import { appMailSender } from "./auth";
import { getStore } from "./crossline";
import { yieldToRequests } from "./yield";

/**
 * The portrait report by mail (the owner's decision of 2026-11-27): writing it took 745 s on the sponsor model's replay, 16 minutes after
 * the press, so the person need not wait on the page. 「结束并出报告」 keeps the address of the account that pressed it here
 * (`requestPortraitMail`); this pass mails the whole report written after that press, once, to that address only, then forgets it.
 *
 * Its home: the report itself, delivered; nothing else is mailed and nothing is pushed. The report goes in full, as the owner chose over
 * a link: it leaves Crossline for the person's own mailbox provider. Read by `portraitMailPass` alone; a setting of its own rather than a
 * field of `portrait.report`, which the worker rewrites while this waits.
 */
export const PORTRAIT_MAIL_SETTING = "portrait.mail";
/** How often the web process looks for a report to mail: one setting read per account, so a report goes within a minute of being written. */
export const PORTRAIT_MAIL_INTERVAL_MS = 60_000;
/** A report not written this long after the press is not waited for any more: the page says why it was not written. */
export const PORTRAIT_MAIL_GIVE_UP_MS = 3 * 3_600_000;

type Pending = { to: string; after: string };
type Translate = ReturnType<typeof tFor>;

export function requestPortraitMail(workspaceId: string, to: string, now = new Date()): void {
  getStore().setSetting(workspaceId, PORTRAIT_MAIL_SETTING, JSON.stringify({ to: to.toLowerCase(), after: now.toISOString() } satisfies Pending));
}

function readPending(raw: string | undefined): Pending | undefined {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<Pending> | null;
    return typeof value?.to === "string" && typeof value.after === "string" && Number.isFinite(Date.parse(value.after)) ? { to: value.to, after: value.after } : undefined;
  } catch { return undefined; }
}

/** The report as plain text, section by section, in the order the page draws it; empty sections are left out. */
export function portraitMailText(report: PortraitReport, t: Translate, link: string): { subject: string; text: string } {
  const out: string[] = [];
  const section = (title: string, ...parts: Array<string | undefined>) => {
    const body = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
    if (body.length) out.push(`■ ${title}`, ...body, "");
  };
  const { cover, problem, compass, energy, lines, gap } = report;
  section(t("画像"), cover.tagline, cover.portrait, cover.coreConflict && t("核心矛盾：{{text}}", { text: cover.coreConflict }));
  section(t("真正的问题"), problem.statement, ...problem.reframes.map((item) => t("「{{fallacy}}」其实是：{{reframe}}", item)));
  section(t("指南针"), compass.trueNorth, compass.workView, compass.lifeView);
  section(t("能量"), energy.summary, ...energy.flow.map((item) => `· ${item}`));
  section(t("主线"), lines.allocation, ...lines.items.map((item) => `· ${item.description}`));
  section(t("说与做"), gap.reading, gap.realWant, gap.anchor);
  section(t("洞察与建议"), ...report.insights.map((item) => `· ${item.insight}\n  ${item.advice}`));
  section(t("职业方向"), ...(report.careers ?? []).map((item) => `· ${item.role}：${item.why}${item.trial?.task ? `\n  ${t("试做：{{task}}", { task: item.trial.task })}` : ""}`));
  out.push(t("完整报告和图表：{{link}}", { link }));
  return { subject: t("你的画像报告写好了"), text: out.join("\n") };
}

export async function portraitMailPass(now = new Date()): Promise<Array<{ workspaceId: string; state: "sent" | "failed" | "expired" }>> {
  const send = appMailSender();
  if (!send) return [];
  const store = getStore();
  const link = `${(process.env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210").replace(/\/+$/, "")}/portrait`;
  const outcomes: Array<{ workspaceId: string; state: "sent" | "failed" | "expired" }> = [];
  for (const workspace of store.listWorkspaces()) {
    const pending = readPending(store.getSetting(workspace.id, PORTRAIT_MAIL_SETTING));
    if (!pending) continue;
    await yieldToRequests();
    const expired = now.getTime() - Date.parse(pending.after) > PORTRAIT_MAIL_GIVE_UP_MS;
    const saved = (() => { try { return JSON.parse(store.getSetting(workspace.id, "portrait.report") ?? "null") as { at?: string; report?: PortraitReport } | null; } catch { return null; } })();
    if (!saved?.report || !saved.at || !(Date.parse(saved.at) > Date.parse(pending.after))) {
      if (expired) { store.deleteSetting(workspace.id, PORTRAIT_MAIL_SETTING); outcomes.push({ workspaceId: workspace.id, state: "expired" }); }
      continue;
    }
    try {
      await send({ to: pending.to, ...portraitMailText(saved.report, tFor(readLocale(store, workspace.id)), link) });
      store.deleteSetting(workspace.id, PORTRAIT_MAIL_SETTING);
      outcomes.push({ workspaceId: workspace.id, state: "sent" });
    } catch {
      // Tried again next minute; given up on with the report it waited for.
      if (expired) store.deleteSetting(workspace.id, PORTRAIT_MAIL_SETTING);
      outcomes.push({ workspaceId: workspace.id, state: "failed" });
    }
  }
  return outcomes;
}

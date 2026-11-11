import "server-only";
import {
  decideMailEvent, MAIL_EVENTS_SETTING, mailEventAsFixed, mailEventAsks, mailEventDigest, readMailEvents, urgencyFor,
  type AccessContext, type Ask, type MailEvent
} from "@crossline/core";
import { getStore } from "./crossline";
import { addInputEvent } from "./fixed-events";
import { identityLines } from "./lines";
import { publishWorkspace } from "./auto-publish";
import type { Translate } from "./i18n";

/**
 * 「要去吗」: an event the mail triage found (apps/worker/src/mailbox.ts, `mail-events.ts` in core), asked about once. 去 makes it the
 * person's fixed event — busy on the plan, and written by every calendar path that is on; 不去 drops it. A personal invitation is asked
 * with 去 recommended and comes first. Nothing from a mail reaches a calendar without this answer (the owner's decision of 2026-11-10).
 */
const events = (ctx: AccessContext) => readMailEvents(getStore().getSetting(ctx.workspaceId, MAIL_EVENTS_SETTING));

export function mailEventCards({ ctx, today, t }: { ctx: AccessContext; today: string; t: Translate }): Ask[] {
  const lines = new Map(identityLines(ctx).map((line) => [line.id, line.label]));
  return mailEventAsks(events(ctx), today).map((event) => {
    const line = lines.get(event.lineId);
    const when = `${Number(event.date.slice(5, 7))}/${Number(event.date.slice(8, 10))} ${event.start}–${event.end}`;
    return { id: `mail-event:${event.id}`, kind: "mail_event" as const, entityId: event.id, urgency: urgencyFor(event.date, today), dueDay: event.date,
      ...(event.lineId ? { line: event.lineId } : {}), raisedAt: event.at, fingerprint: event.id, important: event.personal,
      title: t("要去吗：「{{title}}」", { title: event.title.length > 28 ? `${event.title.slice(0, 28)}…` : event.title }),
      why: [t("{{when}}{{where}}；来自邮件 {{from}}「{{subject}}」。", { when, where: event.location ? `，${event.location}` : "", from: event.from, subject: event.subject }),
        event.personal ? t("是发给本人的邀请。") : t("相关度 {{score}}/100{{line}}。", { score: event.relevance, line: line ? t("，属于「{{line}}」", { line }) : "" }),
        t("去：记为固定日程并写入已开启的日历；不去：不再提起。")].join(""),
      options: [{ id: "go", label: t("去"), recommended: event.personal || event.relevance >= 70 }, { id: "skip", label: t("不去"), detail: t("不写入日历") }] };
  });
}

export function answerMailEvent(ctx: AccessContext, id: string, optionId: string): { ok: true } | { ok: false; code: string } {
  if (optionId !== "go" && optionId !== "skip") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const list = events(ctx);
  const event = list.find((item) => item.id === id);
  if (!event) return { ok: false, code: "MAIL_EVENT_GONE" };
  if (optionId === "go") {
    const added = addInputEvent(ctx, mailEventAsFixed(event));
    if (!added.ok) return added;
  }
  getStore().setSetting(ctx.workspaceId, MAIL_EVENTS_SETTING, JSON.stringify(decideMailEvent(list, id, optionId, new Date().toISOString())));
  // Written now rather than at the next ten-minute pass, so it is on the person's calendar while they are here.
  if (optionId === "go") void publishWorkspace(ctx.workspaceId).catch(() => undefined);
  return { ok: true };
}

/** The weekly review's list of low-relevance notices: the week just past and the one coming. */
export function mailEventsForReview(ctx: AccessContext, today: string): MailEvent[] {
  const shift = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return mailEventDigest(events(ctx), shift(-7), shift(7));
}

import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { clearPendingAnswers, takePendingAnswers } from "../../../../lib/interview-status";
import { getStore } from "../../../../lib/crossline";
import { PRESENCE_SETTING } from "../../../../lib/nudges";
import { sendPush } from "../../../../lib/push";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { isLocalInstall } from "../../../../lib/install-mode";
import { readLocale } from "@crossline/db";
import { tFor } from "../../../../lib/i18n";
import { tOf } from "../../../../lib/locale";

/** No page has been visible for this long: the person left while the model was thinking. */
const AWAY_MS = 90_000;

/**
 * A round that lands while the person is away (no page visible for 90 seconds, `presence.visibleAt`) calls them back on their phone, so
 * the model's time is not their waiting time (decided 2026-10-12). The desktop has no push subscription on 127.0.0.1: the page marks its
 * tab title and, once allowed, shows a desktop notification itself; on the installed copy the tray shows a balloon.
 */
function callBack(ctx: Parameters<typeof sendPush>[0], result: unknown): void {
  if ((result as { state?: string } | undefined)?.state === "blocked") return;
  const visibleAt = Date.parse(getStore().getSetting(ctx.workspaceId, PRESENCE_SETTING) ?? "");
  if (!Number.isFinite(visibleAt) || Date.now() - visibleAt < AWAY_MS) return;
  // Pushed to other devices: in the account's language, not this browser's (docs/i18n.md).
  const t = tFor(readLocale(getStore(), ctx.workspaceId));
  void sendPush(ctx, { title: t("访谈下一轮已就绪"), body: t("新的一组问题已经生成，可以回到访谈继续。"), path: "/onboarding", tag: "onboarding-round" }).catch(() => {});
  // The installed copy's tray shows a balloon for this line (apps/launcher `noticeFrom`); a click opens the interview.
  if (isLocalInstall()) process.stdout.write(`@crossline:notify ${JSON.stringify({ title: t("访谈下一轮已就绪"), text: t("新的一组问题已经生成，点这里回到访谈。"), path: "/onboarding" })}
`);
}

/**
 * One turn of the profile interview. The conversation lives in the ledger (keyed by `sessionId`), so the
 * browser sends only the session id and what the person just said; reloading the page loses nothing.
 */
/** The longest reply one round reads. */
const ONBOARDING_REPLY_MAX = 12_000;

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const input = (body ?? {}) as { sessionId?: unknown; text?: unknown; reread?: unknown };
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const typed = typeof input.text === "string" ? input.text : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_TURN_INVALID", message: tOf(access.ctx)("缺少会话 id") } }, { status: 400 });
  }
  // Refused whole, never cut (W-228): the tail of a pasted timetable used to vanish past 4,000 characters without a word.
  if (typed.length > ONBOARDING_REPLY_MAX) return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_REPLY_TOO_LONG",
    message: tOf(access.ctx)("这段回答有 {{count}} 字，超过一次能读的 {{max}} 字，没有发送。较长的材料请作为文件添加，或分几次说。", { count: typed.length, max: ONBOARDING_REPLY_MAX }) } }, { status: 400 });
  // Answers given on 待决事项 while the interview was put aside travel with this reply (and replying here takes it up again). They are
  // cleared only once the worker took the reply.
  const earlier = typed ? takePendingAnswers(access.ctx, sessionId, { clear: false }) : "";
  const text = [earlier, typed].filter(Boolean).join("\n");
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/turn", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, text, reread: input.reread === true }),
      signal: AbortSignal.timeout(3 * 60 * 60_000)
    });
    callBack(access.ctx, result);
    if (earlier && (result as { state?: string }).state !== "blocked") clearPendingAnswers(access.ctx);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_FAILED", message: tOf(access.ctx)("这一轮没有完成，可以重试。") } }, { status: 503 });
  }
}

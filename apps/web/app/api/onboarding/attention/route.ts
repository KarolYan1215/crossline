import { NextResponse } from "next/server";
import { ATTENTION_SETTING, addAttentionBeat, type AttentionRecord } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { interviewStatus } from "../../../../lib/interview-status";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { noteRoundQuota } from "../../../../lib/interview-quota";

/**
 * One attention beat from the interview page (every 15 seconds while it is visible): how long ago the person last typed, clicked or
 * scrolled. The server keeps the clock and the round count, adds the time since the previous beat when the person was attending, and
 * notes once when the start standard and the full checklist were first reached (`onboarding.attention`).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown;
  try { body = await request.json(); } catch { body = undefined; }
  const inputAgoMs = (body as { inputAgoMs?: unknown } | undefined)?.inputAgoMs;
  if (typeof inputAgoMs !== "number" || !Number.isFinite(inputAgoMs) || inputAgoMs < 0 || inputAgoMs > 600_000)
    return NextResponse.json({ ok: false, code: "ATTENTION_BEAT_INVALID" }, { status: 400 });
  const store = getStore();
  const status = interviewStatus(access.ctx);
  const rounds = status.sessionId ? store.listOnboardingMessages(access.ctx.workspaceId, status.sessionId).filter((message) => message.role === "assistant").length : 0;
  let record: AttentionRecord | undefined;
  try { record = JSON.parse(store.getSetting(access.ctx.workspaceId, ATTENTION_SETTING) ?? "null") ?? undefined; } catch { record = undefined; }
  const next = addAttentionBeat(record, { at: new Date().toISOString(), inputAgoMs, rounds, ready: status.readyToStart, complete: status.complete });
  store.setSetting(access.ctx.workspaceId, ATTENTION_SETTING, JSON.stringify(next));
  // The account's usage after each round, for the quota outlook (lib/interview-quota.ts): read once per round, not on every beat.
  await noteRoundQuota(access.ctx, rounds).catch(() => undefined);
  return NextResponse.json({ ok: true });
}

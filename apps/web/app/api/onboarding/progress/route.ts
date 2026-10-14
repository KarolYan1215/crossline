import { NextResponse } from "next/server";
import { ONBOARDING_PROGRESS_SETTING, ONBOARDING_PROGRESS_STALE_MS, type OnboardingProgress } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * What the interview turn now running has read and written so far (docs/onboarding-v3.md 「等待」): the worker writes it while the turn
 * runs and deletes it when it ends; the page polls this while it waits. `null` when no turn is running, or the record is too old to be
 * one (a worker that stopped mid-turn).
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore();
  const asked = new URL(request.url).searchParams.get("sessionId") ?? "";
  const sessionId = /^[a-zA-Z0-9_-]{1,128}$/.test(asked) ? asked : store.getLatestOnboardingSession(access.ctx.workspaceId)?.id ?? "";
  if (!sessionId) return NextResponse.json({ progress: null });
  let progress: OnboardingProgress | null = null;
  try { progress = JSON.parse(store.getSetting(access.ctx.workspaceId, `${ONBOARDING_PROGRESS_SETTING}:${sessionId}`) ?? "null") as OnboardingProgress | null; }
  catch { progress = null; }
  if (progress && Date.now() - Date.parse(progress.updatedAt) > ONBOARDING_PROGRESS_STALE_MS) progress = null;
  return NextResponse.json({ progress }, { headers: { "cache-control": "no-store" } });
}

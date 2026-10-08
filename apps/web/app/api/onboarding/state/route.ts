import { NextResponse } from "next/server";
import { profileGaps } from "@crossline/core";
import { latestFileDates } from "@crossline/db";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { loadPendingDateBatch } from "../../../../lib/imported-dates";
import { loadDiligence } from "../../../../lib/diligence";
import { identityLines, needsLineSetup } from "../../../../lib/lines";

/**
 * Everything the onboarding screen shows, in one read: the conversation so far, the projects and facts the
 * interview has learned, and the files that came with it. File *text* is deliberately not returned — the
 * screen needs to know a file was read, not to display it.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { workspaceId } = access.ctx;
  const store = getStore();
  // `?line=<id>`: that line's own interview, kept in its own session (`line-<id>`).
  const lineId = new URL(request.url).searchParams.get("line");
  const focus = lineId ? identityLines(access.ctx).find((line) => line.id === lineId) : undefined;
  const session = focus ? store.getOnboardingSession(workspaceId, `line-${focus.id}`) : store.getLatestOnboardingSession(workspaceId);
  const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
  const messages = session ? store.listOnboardingMessages(workspaceId, session.id) : [];
  const identities = identityLines(access.ctx).map((pack) => ({ id: pack.id, label: pack.label }));
  // What the profile still lacks before numbers can be worked back from the person's goals, as questions with the options to pick from.
  // Computed from the ledger on every read, so an interview that was already finished before a gap was understood still shows it.
  const askedBefore = new Set(messages.flatMap((message) => message.role === "assistant"
    ? ((message.content as { questions?: Array<{ id: string }> }).questions ?? []).map((question) => question.id) : []));
  const gaps = profileGaps({
    identities, projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    facts: store.listProfileFacts(workspaceId), undated: latestFileDates(store, workspaceId).undated
  }).filter((gap) => gap.blocking || !askedBefore.has(gap.question.id)).map((gap) => gap.question);
  return NextResponse.json({
    ok: true,
    identities, gaps,
    setupLines: !focus && needsLineSetup(access.ctx),
    focusLine: focus ? { id: focus.id, label: focus.label } : null,
    lines: identityLines(access.ctx).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [] })),
    lineProfiles: json<Record<string, { description: string; goalCandidates: string[] }>>("lines.profiles", {}),
    profile: json<Record<string, unknown> | null>("profile.model", null),
    availabilityProposed: Boolean(store.getSetting(workspaceId, "schedule.availability.proposed")),
    session: session ? { id: session.id, state: session.state, coverage: session.coverage } : null,
    messages,
    dateBatch: loadPendingDateBatch(access.ctx),
    diligence: loadDiligence(access.ctx),
    projects: store.listProjects(workspaceId),
    facts: store.listProfileFacts(workspaceId),
    documents: store.listSourceDocuments(workspaceId).map(({ id, fileName, kind, extractionStatus, extractionNote, projectId }) =>
      ({ id, fileName, kind, extractionStatus, ...(extractionNote ? { extractionNote } : {}), ...(projectId ? { projectId } : {}) }))
  });
}

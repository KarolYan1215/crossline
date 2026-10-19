import { NextResponse } from "next/server";
import { FIRST_DRAFTS_SETTING, ONBOARDING_TONE_SETTING, firstDraftsState, questionKind, readTone, screenQuestions, type StoredLineProfile, type TurnQuestion } from "@crossline/core";
import { extractBacklog, questionScreenFor } from "@crossline/db";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore, planToday } from "../../../../lib/crossline";
import { folderDocumentIds, projectTimeline, weekSkeleton } from "../../../../lib/onboarding-board";
import { loadPendingDateBatch } from "../../../../lib/imported-dates";
import { loadDiligence } from "../../../../lib/diligence";
import { identityLines, needsLineSetup } from "../../../../lib/lines";
import { interviewStatus, pendingAnswerIds, questionsOwnedElsewhere } from "../../../../lib/interview-status";

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
  const raw = session ? store.listOnboardingMessages(workspaceId, session.id) : [];
  // A model question that names a file the app itself asks about (or has settled) is left out: the app's question is the one kept.
  const lastIndex = raw.length - 1;
  const lastQuestions = raw[lastIndex]?.role === "assistant" ? ((raw[lastIndex]!.content as { questions?: TurnQuestion[] }).questions ?? []) : [];
  const moved = questionsOwnedElsewhere(access.ctx, lastQuestions);
  // A round stored before the screen existed is screened here as on 待决事项 (`lib/interview-status.ts`): a room, class times on record, a
  // calendar's recurrence are not the person's to answer. A question asking for several things is shown as multiple choice.
  for (const item of screenQuestions(lastQuestions, questionScreenFor(store, workspaceId)).screened) moved.add(item.question.id);
  const messages = lastQuestions.length ? raw.map((message, index) => index === lastIndex
    ? { ...message, content: { ...(message.content as object), questions: lastQuestions.filter((question) => !moved.has(question.id))
      .map((question) => ({ ...question, kind: questionKind(question) })) } } : message) : raw;
  const identities = identityLines(access.ctx).map((pack) => ({ id: pack.id, label: pack.label }));
  // The start standard (main interview only): what is still missing, and the app's own questions not in the open round — so an account
  // whose interview already ended can answer 「没有截止」 here without waiting for a new round.
  const status = focus ? null : interviewStatus(access.ctx);
  const inRound = new Set(lastQuestions.map((question) => question.id));
  // What the background extraction still owes this conversation (2026-10-19): while it reads the last replies the facts behind the start
  // standard may not be on record yet, so 「开始使用」 waits for it — unless it is failing, which must not hold the person forever.
  const organizing = session ? extractBacklog(store, workspaceId, session.id) : { replies: 0, files: 0 };
  const settling = (organizing.replies > 0 || organizing.files > 0) && !organizing.failing;
  const start = status ? {
    readyToStart: status.readyToStart && !settling,
    startTotal: status.checklist.filter((item) => item.start).length,
    startMissing: status.startMissing.map(({ id, label, detail, owner }) => ({ id, label, detail, owner })),
    extraQuestions: status.questions.filter((question) => !inRound.has(question.id))
  } : { readyToStart: true, startTotal: 0, startMissing: [], extraQuestions: [] };
  return NextResponse.json({
    ...start,
    ok: true, organizing,
    identities, answeredElsewhere: session ? pendingAnswerIds(access.ctx, session.id) : [],
    setupLines: !focus && needsLineSetup(access.ctx),
    focusLine: focus ? { id: focus.id, label: focus.label } : null,
    lines: identityLines(access.ctx).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [], goalParts: line.goalParts ?? [] })),
    lineProfiles: json<Record<string, StoredLineProfile>>("lines.profiles", {}),
    profile: json<Record<string, unknown> | null>("profile.model", null),
    availabilityProposed: Boolean(store.getSetting(workspaceId, "schedule.availability.proposed")),
    // The worker designs the first milestone drafts on its own once the start standard holds: the screen says so instead of offering a
    // second, concurrent run.
    firstDrafts: firstDraftsState(store.getSetting(workspaceId, FIRST_DRAFTS_SETTING), store.listMilestones(workspaceId).some((item) => item.status !== "archived")),
    // The right column's week and project axis (docs/onboarding-v3.md), and how the person asked to be spoken to.
    tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)),
    toneChosen: Boolean(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)),
    week: weekSkeleton(access.ctx, planToday(access.ctx)),
    timeline: projectTimeline(access.ctx, planToday(access.ctx)),
    session: session ? { id: session.id, state: session.state, coverage: session.coverage } : null,
    messages,
    dateBatch: loadPendingDateBatch(access.ctx),
    diligence: loadDiligence(access.ctx),
    projects: store.listProjects(workspaceId),
    facts: store.listProfileFacts(workspaceId),
    documents: (() => { const fromFolders = folderDocumentIds(access.ctx); return store.listSourceDocuments(workspaceId).map(({ id, fileName, kind, extractionStatus, extractionNote, projectId }) =>
      ({ id, fileName, kind, extractionStatus, ...(extractionNote ? { extractionNote } : {}), ...(projectId ? { projectId } : {}), ...(fromFolders.has(id) ? { fromFolder: true } : {}) })); })()
  });
}

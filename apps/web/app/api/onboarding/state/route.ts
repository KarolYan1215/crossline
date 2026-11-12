import { NextResponse } from "next/server";
import { INTERVIEW_FLOW_STAGES, flowOf, ONBOARDING_INSIGHTS, progressView, readInsightRatings, readTurnProgress, FIRST_DRAFTS_SETTING, ONBOARDING_LAST_FAILURE, readOnboardingFailure, ONBOARDING_TONE_SETTING, ONBOARDING_DEPTH_SETTING, readDepth, firstDraftsState, interviewCompleteness, openStageQuestion, questionKind, readTone, sameQuestion, screenQuestions, unsureAnswer, type StoredLineProfile, type TurnQuestion } from "@crossline/core";
import { INTERVIEW_LOCALE_SETTING, extractBacklog, interviewLocale, questionScreenFor } from "@crossline/db";
import { isLocale } from "@crossline/i18n";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore, planToday } from "../../../../lib/crossline";
import { folderDocumentIds, projectTimeline, weekCapacity, weekSkeleton } from "../../../../lib/onboarding-board";
import { adoptPendingDates, loadAdoptedDates, loadPendingDateBatch } from "../../../../lib/imported-dates";
import { loadDiligence } from "../../../../lib/diligence";
import { identityLines, needsLineSetup } from "../../../../lib/lines";
import { interviewStatus, pendingAnswerIds, questionsOwnedElsewhere } from "../../../../lib/interview-status";
import { startConfirmed, startSummary } from "../../../../lib/start-confirm";
import { portraitConfirmation } from "../../../../lib/portrait";
import { readResearchThreads } from "../../../../lib/interview-research";

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
  // What the files say is taken, not asked (2026-10-19): a batch of dates still waiting is adopted before anything is read.
  adoptPendingDates(access.ctx);
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
  const identities = identityLines(access.ctx).map((pack) => ({ id: pack.id, label: pack.label }));
  // The start standard (main interview only): what is still missing, and the app's own questions not in the open round — so an account
  // whose interview already ended can answer 「没有截止」 here without waiting for a new round.
  const status = focus ? null : interviewStatus(access.ctx);
  const inRound = new Set(lastQuestions.map((question) => question.id));
  const kept = lastQuestions.filter((question) => !moved.has(question.id)).map((question) => ({ ...question, kind: questionKind(question) }));
  // A round that still asks never shows an empty box: when this screen took out everything it held (the files the app asks about, facts
  // recorded since it was stored) and nothing of the app's own waits beside it, it asks the stage's open question (2026-10-31 walkthrough).
  const lastContent = (raw[lastIndex]?.content ?? {}) as { nextAction?: string; stage?: string; cards?: unknown[] };
  const extra = status ? status.questions.filter((question) => !inRound.has(question.id)) : [];
  const empty = raw[lastIndex]?.role === "assistant" && lastContent.nextAction === "ask" && lastQuestions.length > 0 && !kept.length
    && !(lastContent.cards ?? []).length && !extra.length;
  // Not one the person already answered, as the worker judges it (W-184): the next stage's open question then.
  const settled = empty && session ? store.listQuestions(workspaceId, { kind: "interview", keyPrefix: `iq:${session.id}:`, statuses: ["answered", "assumed"] })
    .filter((question) => question.status === "assumed" || !unsureAnswer(question.answer)) : [];
  const shown = empty ? [openStageQuestion(lastContent.stage, interviewLocale(store, workspaceId),
    (text) => !settled.some((question) => sameQuestion(question.text, text)))] : kept;
  const messages = lastQuestions.length ? raw.map((message, index) => index === lastIndex
    ? { ...message, content: { ...(message.content as object), questions: shown } } : message) : raw;
  // What the background extraction still owes this conversation (2026-10-19): while it reads the last replies the facts behind the start
  // standard may not be on record yet, so 「开始使用」 waits for it — unless it is failing, which must not hold the person forever.
  const organizing = session ? extractBacklog(store, workspaceId, session.id) : { replies: 0, frontReplies: 0, files: 0 };
  // Only replies that can carry a start-standard fact (the opening and the front stages' answers) and files hold the button.
  const settling = (organizing.frontReplies > 0 || organizing.files > 0) && !organizing.failing;
  const ready = Boolean(status?.readyToStart && !settling);
  const start = status ? {
    readyToStart: ready,
    // The one look before the app opens: what the person confirms, shown once the standard stands and the extraction has caught up.
    startConfirmed: startConfirmed(access.ctx),
    ...(ready ? { startSummary: startSummary(access.ctx) } : {}),
    startTotal: status.checklist.filter((item) => item.start).length,
    startMissing: status.startMissing.map(({ id, label, detail, owner }) => ({ id, label, detail, owner })),
    startItems: status.checklist.filter((item) => item.start).map(({ id, label, done }) => ({ id, label, done })),
    portraitState: (({ written, confirmed }) => ({ written, confirmed }))(portraitConfirmation(access.ctx)),
    extraQuestions: extra
  } : { readyToStart: true, startConfirmed: true, startTotal: 0, startMissing: [], extraQuestions: [] };
  const today = planToday(access.ctx);
  const week = weekSkeleton(access.ctx, today), timeline = projectTimeline(access.ctx, today);
  const { capacity, draft } = weekCapacity(access.ctx, today, week, timeline);
  // The order of the parts: a new interview starts with the profile module (flow v2), an earlier one keeps its own order. A main interview
  // with no round yet is a new one, as the worker will start it: the opening card said 「第 1/5 部分」 and the first round 「第 1/6」 (W-186).
  const unstarted = !focus && !(session?.coverage as { flow?: unknown } | undefined)?.flow && !raw.some((message) => message.role === "assistant");
  const flow = unstarted ? "v2" : flowOf(session?.coverage);
  const stageNow = String((session?.coverage as { stage?: string } | undefined)?.stage ?? INTERVIEW_FLOW_STAGES[flow][0]);
  const ratings = Object.fromEntries(Object.entries(readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS)))
    .filter(([key]) => session && key.startsWith(`${session.id}#`)).map(([key, rating]) => [key.slice(key.indexOf("#") + 1), rating.verdict]));
  return NextResponse.json({
    ...start,
    // Where the interview is, by its own record (`progress` of the last round), for the right column.
    progress: progressView(readTurnProgress((session?.coverage as { progress?: unknown } | undefined)?.progress), stageNow, flow,
      readDepth(store.getSetting(workspaceId, ONBOARDING_DEPTH_SETTING)),
      raw.filter((message) => message.role === "assistant").map((message) => String((message.content as { stage?: unknown }).stage ?? ""))),
    flow,
    capacity, skeleton: start.readyToStart ? draft : [],
    insightRatings: ratings,
    // The 「结束并出报告」 button (2026-11-12): off below the start standard, filled by how complete the portrait is, full well above it.
    completeness: (() => {
      const model = json<{ dimensions?: Array<{ id: string; evidenced: boolean }>; hypotheses?: Array<{ status: string }>; careers?: Array<{ trial?: { task?: string } }> } | null>("profile.model", null);
      return interviewCompleteness({ lowerBound: ready, lowerMissing: start.startMissing.map((item) => item.label),
        stagesSeen: raw.filter((message) => message.role === "assistant").map((message) => String((message.content as { stage?: unknown }).stage ?? "")),
        ...(model?.dimensions ? { dimensions: model.dimensions } : {}), ...(model?.hypotheses ? { hypotheses: model.hypotheses } : {}),
        ...(model?.careers ? { careers: model.careers } : {}), ...(interviewLocale(store, workspaceId) ? { locale: interviewLocale(store, workspaceId)! } : {}) });
    })(),
    // The research threads beside the conversation (worker onboarding-research.ts): listed, their questions shown as side cards.
    research: session ? readResearchThreads(workspaceId, session.id) : [],
    adoptedDates: loadAdoptedDates(access.ctx),
    ok: true, organizing,
    // Why the last round did not finish, kept after a reload (the worker writes it; the next attempt removes it).
    lastFailure: session ? readOnboardingFailure(store.getSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}${session.id}`)) : null,
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
    // How thorough the interview is (onboarding-depth.ts), changeable above the thread like the tone.
    depth: readDepth(store.getSetting(workspaceId, ONBOARDING_DEPTH_SETTING)),
    week, timeline,
    session: session ? { id: session.id, state: session.state, coverage: session.coverage } : null,
    // The interview keeps the language it started in (docs/i18n.md); the page says so when it differs from its own.
    interviewLocale: (() => { const locked = session ? store.getSetting(workspaceId, `${INTERVIEW_LOCALE_SETTING}:${session.id}`) : undefined;
      return isLocale(locked) ? locked : focus ? null : interviewLocale(store, workspaceId) ?? null; })(),
    messages,
    dateBatch: loadPendingDateBatch(access.ctx),
    diligence: loadDiligence(access.ctx),
    projects: store.listProjects(workspaceId),
    facts: store.listProfileFacts(workspaceId),
    documents: (() => { const fromFolders = folderDocumentIds(access.ctx); return store.listSourceDocuments(workspaceId).map(({ id, fileName, kind, extractionStatus, extractionNote, projectId }) =>
      ({ id, fileName, kind, extractionStatus, ...(extractionNote ? { extractionNote } : {}), ...(projectId ? { projectId } : {}), ...(fromFolders.has(id) ? { fromFolder: true } : {}) })); })()
  });
}

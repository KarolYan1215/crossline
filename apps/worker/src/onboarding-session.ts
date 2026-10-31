import { transcriptDocumentIds } from "./recording-digest";
import {
  AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary, ACTIVITY_HOURLY, atComputerLines, type ActivityHour,
  PROFILE_CONFIRMED, portraitFingerprint, answeredGapFacts, keepOnboardingDialogue, droppedOnboardingItems, ONBOARDING_KEEP_EARLY_MAX, onboardingDialogueSchema,
  validateOnboardingDialogue, locateQuote,
  gapCoveredBy, screenQuestions, screenAssumption,
  type ProfileGap, type ProfileModel, type OnboardingStage, DEEP_STAGES, ONBOARDING_TONE_SETTING, ASSESS_RESULT_SETTING, TYPE_TABLE, readTone,
  checkInsight, readTurnProgress, openStageQuestion, withPlainTerms,
  type KnownSources, type OnboardingDialogue, type OnboardingTurnContext, ONBOARDING_PROGRESS_SETTING, ONBOARDING_LAST_FAILURE, readPartialTurn, type OnboardingProgress, calendarWeek,
  tFor, type Locale, flowOf, INTERVIEW_FLOW_STAGES, PROFILE_MODULE_STAGES, cardsFor, readCardAnswers, mergeInstrumentAnswers, readInstrumentAnswers,
  settledItems, PROFILE_INSTRUMENTS_SETTING, type InterviewFlow, type ProfileCard, type ProfileStage
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary, type SkillProgress } from "@crossline/codex";
import {
  EXTRACT_REREAD_SETTING, extractBacklog, readExtractState, firstSentenceOf, markFinishing, interviewChecklistFor, interviewGapsFor, interviewLocale, lockInterviewLocale, queueExtractDocs, questionScreenFor, readExtractDocs, unfiledFilesIn,
  type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument
} from "@crossline/db";
import { sourceIds } from "./source-ids";
import { localeOf } from "./locale";
import { adoptLineGoal, identityLines } from "./lines";
import { ledgerForModel, recordReplyAnswers, recordRound, resolveRepeats, syncGapQuestions } from "./question-ledger";
import { createOnboardingExtractor, extractionReached, requestExtraction } from "./onboarding-extract";
import { personTimeZone, readProfileModel } from "./onboarding-persist";
import { paceContext, storedProgress } from "./onboarding-pace";
import { DOMAIN_PACKS, domainGuides } from "@crossline/identity-packs";

export const ONBOARDING_SKILL = "crossline:crossline-onboarding";
/** The dialogue's fields that speak to the person as 你; everything else it writes is third person. */
const SECOND_PERSON = ["reply", "questions", "insight"];

/** Each document is cut to this much text per turn. */
const SOURCE_TEXT_PER_DOCUMENT = 14_000;
const SOURCE_TEXT_TOTAL = 60_000;
/** New files one turn reads at most; more wait for the next turn. */
const SOURCES_PER_TURN = 12;
/** How long the round that ends the interview waits for the extraction before the portrait's items stop holding it. */
const FINISH_WAIT_MS = 90_000;
/** How long a round with a blocking app question waits for the extraction of the reply it may answer. */
const BLOCKING_WAIT_MS = 30_000;
/** Facts the extraction recorded since the last turn, at most this many lines in `recorded`. */
const RECORDED_SHOWN = 40;
/** Questions of the ledger shown to the model each round; repeats of older ones are still caught in code (`resolveRepeats`). */
const LEDGER_SHOWN = 15;

// The scenario in brief, and nothing more: every rule and example is in the Skill. A second copy of the rules here drifted from it twice
// (2026-10-19; again by 2026-10-31, when it also still said 「in Chinese」 under an English interview), so this names none of them.
// i18n-ignore-start: instructions to the interview Skill (model-facing)
export const INSTRUCTIONS = "You are the interviewer of Crossline's first-run interview. The Skill crossline-onboarding holds every rule and "
  + "example; follow it. The person reads your `reply`, answers your question cards and rates your observation; another run records "
  + "facts, dates, hours, goal attributes and the portrait from the same replies and files, so you write only the fields of the output "
  + "schema. Each turn's input says where the interview stands (`progress`, `abstract`, `questionLedger`, `checklist`, `lastRound`, "
  + "`unrecorded`): read it before you ask. Never propose milestones.";
// i18n-ignore-end

const extractModeOf = (options: { extract?: "background" | "await" | "off" }) => options.extract ?? "background";

export type OnboardingTurnOutcome =
  | { state: "asked" | "ready"; sessionId: string }
  | { state: "blocked"; sessionId: string; code: string; message: string; detail?: string };

/** What the dialogue's thread has been shown: the files, the calendar week, and when it last heard what the extraction recorded. */
type Announced = { announcedSources?: string[]; calendarSent?: string; heardAt?: string; lastRound?: RoundEdits };

/**
 * How the app changed the dialogue's last round before the person saw it (2026-10-31). The thread holds the questions the model wrote;
 * the person answered the ones the screen showed. Without this the model read a removed question as one the person skipped, and said
 * 「按假设处理」 about something never asked, or asked it again.
 */
export type RoundEdits = { removed: Array<{ text: string; why: string }>; added: string[] };

/** Why a question was not shown, in the words the model is told (model-facing). */
const SCREEN_WHY: Record<string, string> = {
  duplicate: "the app asks this deadline itself", goal_picker: "the person picks this line's long-term goal beside the conversation",
  calendar_inferable: "the calendar already says it", location: "a place does not change the plan",
  known_schedule: "these class times are already on record"
};

/** Earlier replies the extraction has not recorded yet, newest last, at most this many named. */
const UNRECORDED_SHOWN = 8;

export function createOnboardingSessionRunner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, options: {
    /** Hold a premature 「ready」 to the completion list (on in the app; tests of other behaviour turn it off). */
    checklist?: boolean;
    /**
     * The extraction (onboarding-extract.ts) starts with every turn. `background` (the app): the person gets the round without waiting for
     * it, except a round that would end the interview, which waits so the checklist is read after it. `await`: the round waits for it
     * (scripts and tests that read the ledger right after). `off`: not started (the sponsor's sample interview measures the dialogue).
     */
    extract?: "background" | "await" | "off";
  } = {}) {
  const extractMode = extractModeOf(options);
  const identities = () => identityLines(store, workspaceId)
    .map((pack) => ({ id: pack.id, label: pack.label }));

  /** What a question may name: the lines and projects on record. The dialogue cites nothing. */
  function knownSources(): KnownSources {
    return {
      identities: identities().map((item) => item.id),
      projectIds: store.listProjects(workspaceId, { includeArchived: true }).map((project) => project.id),
      replies: {}, sources: {}
    };
  }

  const todayIso = () => (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString().slice(0, 10);
  const unfiled = () => unfiledFilesIn(store, workspaceId, { today: todayIso(),
    lineNames: identityLines(store, workspaceId).flatMap((line) => [line.id, line.label]) });
  /** The completion list as of now: the system's own record of what the interview still owes, never shown to the person. */
  const checklistNow = () => interviewChecklistFor(store, workspaceId, identityLines(store, workspaceId)
    .map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] })), { unfiledFiles: unfiled().length, today: todayIso() });
  // Start items first, then what the interview itself still owes; a project's details are deferred (asked when its task is planned).
  const openChecklist = (limit = 8, skip: (item: { group: string }) => boolean = () => false) => checklistNow()
    .filter((item) => !item.done && !item.deferred && !skip(item)).sort((a, b) => Number(Boolean(b.start)) - Number(Boolean(a.start)))
    .slice(0, limit).map(({ label, detail, owner, start, ask }) => ({ label, detail, owner, ...(start ? { start } : {}), ...(ask ? { ask } : {}) }));
  /** Whether a start item is still open: then the front stages do not move on. */
  const startOpen = () => checklistNow().some((item) => item.start && !item.done);

  /** The person's coding-agent hours, time only, when they allowed it (Settings → 隐私). */
  const workHistory = () => {
    let lines: string[] = [];
    try { lines = agentHistoryLines(JSON.parse(store.getSetting(workspaceId, AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null); } catch { /* none */ }
    // When the person is at the computer, from the screen-activity record (minutes only), when they allowed it.
    try { lines = [...lines, ...atComputerLines(JSON.parse(store.getSetting(workspaceId, ACTIVITY_HOURLY) ?? "[]") as ActivityHour[], personTimeZone(store, workspaceId))]; } catch { /* none */ }
    return lines;
  };

  /** What the ledger still lacks, as of now. */
  const currentGaps = (): ProfileGap[] => interviewGapsFor(store, workspaceId, identityLines(store, workspaceId)
    .map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] })), todayIso());

  const withinBudget = (entries: Array<[string, StoredSourceDocument]>) => {
    let budget = SOURCE_TEXT_TOTAL;
    const taken: Array<[string, StoredSourceDocument]> = [];
    for (const entry of entries) {
      if (taken.length && (budget <= 0 || taken.length >= SOURCES_PER_TURN)) break;
      taken.push(entry);
      budget -= Math.min(SOURCE_TEXT_PER_DOCUMENT, entry[1].extractedText.length);
    }
    return taken;
  };

  /** The files a turn hands over, as their text within the turn's reading budget. */
  const clipDocuments = (entries: Array<[string, StoredSourceDocument]>) => {
    let budget = SOURCE_TEXT_TOTAL;
    return entries.map(([id, doc]) => {
      const limit = Math.min(SOURCE_TEXT_PER_DOCUMENT, budget);
      budget -= Math.min(limit, doc.extractedText.length);
      return { id, fileName: doc.fileName, kind: doc.kind, projectId: doc.projectId ?? "", text: doc.extractedText.slice(0, limit) };
    });
  };

  /** Facts the extraction wrote after `since`, as short lines, and the lines and projects they are about. */
  const recordedSince = (since: string | undefined) => {
    const facts = store.listProfileFacts(workspaceId).filter((fact) => !since || fact.updatedAt > since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    return { lines: facts.slice(-RECORDED_SHOWN).map((fact) => `${fact.identityId}${fact.projectId ? `/${fact.projectId}` : ""} · ${fact.slot} = ${fact.value.slice(0, 120)}（${fact.status === "confirmed" ? "确认" : "推断"}）`),
      identities: [...new Set(facts.map((fact) => fact.identityId))], projects: [...new Set(facts.map((fact) => fact.projectId).filter(Boolean))] };
  };

  const readProfile = (): ProfileModel => readProfileModel(store, workspaceId);
  const extractor = createOnboardingExtractor(store, workspaceId, cwd, getClient);

  return async function turn(input: { sessionId: string; text: string; reread?: boolean }): Promise<OnboardingTurnOutcome> {
    const client = getClient();
    const sessionId = input.sessionId;
    // A round that did not finish says why, and keeps saying it after a reload (2026-10-19: testers saw a bare 「这一轮还没有得到回答」
    // and could not tell a busy provider from a broken round). Cleared when the next attempt starts.
    const blocked = (code: string, message: string, detail?: string): OnboardingTurnOutcome => {
      if (code !== "ONBOARDING_MESSAGE_EMPTY") store.setSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}${sessionId}`,
        JSON.stringify({ code, message, ...(detail ? { detail } : {}), at: new Date().toISOString() }));
      return { state: "blocked", sessionId, code, message, ...(detail ? { detail } : {}) };
    };
    // Errors before the round starts are said in the interview's language, else the workspace's.
    const said = tFor(interviewLocale(store, workspaceId) ?? localeOf(store, workspaceId));
    if (!client) return blocked("CODEX_SUPERVISOR_UNAVAILABLE", said("Codex 运行时不可用。"));
    const text = input.text.trim().slice(0, 4000);
    const ownerId = store.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return blocked("WORKSPACE_OWNER_MISSING", said("找不到这个工作区的所有者。"));

    const now = new Date().toISOString();
    let session = store.getOnboardingSession(workspaceId, sessionId);
    // A new main interview runs the profile module first (flow v2, docs/profile-and-agent-kit.md §四); one that has had a round keeps its
    // flow, and a line's own interview has none.
    const lineInterview = sessionId.startsWith("line-");
    if (!session) {
      session = { id: sessionId, ownerId, workspaceId, state: "active", coverage: lineInterview ? {} : { flow: "v2" }, createdAt: now, updatedAt: now };
      store.saveOnboardingSession(session);
    }
    let messages = store.listOnboardingMessages(workspaceId, sessionId);
    if (!lineInterview && !(session.coverage as { flow?: unknown }).flow && !messages.some((message) => message.role === "assistant")) {
      session = { ...session, coverage: { ...session.coverage, flow: "v2" } };
      store.saveOnboardingSession(session);
    }
    const flow: InterviewFlow = flowOf(session.coverage);
    // A retry after a failed turn resends nothing: the person's message is already saved and still waiting.
    const last = messages.at(-1);
    const retrying = last?.role === "user" && (!text || String((last.content as { text?: string }).text ?? "") === text);
    if (!retrying) {
      if (!text) return blocked("ONBOARDING_MESSAGE_EMPTY", said("请先写点什么，或选一个选项。"));
      store.appendOnboardingMessage({ sessionId, workspaceId, role: "user", content: { text }, createdAt: now });
      messages = store.listOnboardingMessages(workspaceId, sessionId);
    }
    // The language this interview started in, kept to its end whatever the interface is switched to (docs/i18n.md).
    const locale = lockInterviewLocale(store, workspaceId, sessionId);
    store.deleteSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}${sessionId}`);
    const userMessage = messages.at(-1)!;
    const replyId = `reply-${userMessage.seq}`;
    const replyText = String((userMessage.content as { text?: string }).text ?? "");
    // Earlier replies the extraction has not recorded (it runs in the background and may be behind or backing off): `abstract` does not
    // hold what they said yet, so the dialogue is told to read them in its own thread instead of trusting the abstract's silence.
    const recordedUpTo = readExtractState(store, workspaceId, sessionId).upTo;
    const unrecorded = extractModeOf(options) === "off" ? [] : messages
      .filter((message) => message.role === "user" && message.seq > recordedUpTo && message.seq !== userMessage.seq)
      .map((message) => `reply-${message.seq}`).slice(-UNRECORDED_SHOWN);
    const docs = sourceIds(store.listSourceDocuments(workspaceId));
    const known = knownSources();
    // The reply's numbered sentences: what the ledger's answers and the app's own facts below point at, and what the extraction cites.
    const replySentences = store.ensureEvidence(workspaceId, "reply", `${sessionId}#${userMessage.seq}`, replyText);
    /** The sentences of this reply a quote the system took from it covers. */
    const sentencesFor = (quote: string) => {
      const span = locateQuote(replyText, quote);
      return span ? replySentences.filter((sentence) => sentence.start < span.end && sentence.end > span.start).map((sentence) => sentence.id) : [];
    };

    // The person's answers to the questions the app itself asked (target grade, an unconfirmed line, a TBD date) are facts the moment they
    // are given, written here and not left for a model to remember: the label they picked is a verbatim span of their reply.
    for (const answer of answeredGapFacts(replyText, currentGaps())) {
      if (answer.file) {
        // The same record 待决事项 writes, so a file filed here is filed everywhere.
        const { documentId, projectId } = answer.file;
        if (projectId) store.assignSourceDocumentProject(workspaceId, documentId, projectId);
        if (projectId) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `source:assigned:${documentId}:${projectId}:${replyId}`, type: "source.project_assigned",
          entityId: documentId, payload: { projectId, by: "person" } });
        else store.appendEvent({ ownerId, workspaceId, idempotencyKey: `source:cleared:${documentId}:${replyId}`, type: "source.project_cleared", entityId: documentId, payload: { by: "person" } });
      } else if (answer.goal) {
        adoptLineGoal(store, workspaceId, ownerId, answer.goal.lineId, answer.goal.parts, locale);
      } else if (answer.confirmPortrait) {
        // Recorded for the portrait as it stands; the extraction records it again for the portrait it rewrites from this reply.
        store.setSetting(workspaceId, PROFILE_CONFIRMED, JSON.stringify({ fingerprint: portraitFingerprint(readProfile()), at: now }));
        store.appendEvent({ ownerId, workspaceId, idempotencyKey: `profile:confirmed:${replyId}`, type: "profile.confirmed", entityId: workspaceId,
          payload: { via: "interview", sessionId, replySeq: userMessage.seq } });
      } else if (answer.slot) {
        store.upsertProfileFact({ workspaceId, identityId: answer.identityId, projectId: answer.projectId, slot: answer.slot, value: answer.value,
          status: "confirmed", sourceRef: replyId, sourceQuote: answer.quote, sourceSentences: sentencesFor(answer.quote), updatedAt: now });
      }
    }
    // The question ledger: the answers this reply gives, then the app's own questions as of now (answered ones stay answered).
    recordReplyAnswers(store, workspaceId, sessionId, replyText, replySentences, now);
    syncGapQuestions(store, workspaceId, currentGaps(), now);
    // The cards the last round offered: a tap is scored now, words wait for the extraction to map them, a card passed over is skipped.
    const offeredCards = ([...messages].reverse().find((message) => message.role === "assistant")?.content as { cards?: ProfileCard[] } | undefined)?.cards ?? [];
    if (offeredCards.length) store.setSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(mergeInstrumentAnswers(
      readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING)), readCardAnswers(replyText, offeredCards, now))));

    const timeZone = personTimeZone(store, workspaceId);
    const today = todayIso();
    const coverage = session.coverage as Announced;
    // A re-read hands every file over again, as if none had been seen.
    const announced = input.reread ? new Set<string>() : new Set(coverage.announcedSources ?? []);
    // A file shown before and read again since (new text, so new sentence numbers) is shown again, and extracted again.
    const extracted = readExtractDocs(store, workspaceId);
    for (const [id, doc] of docs) {
      if (!announced.has(id) || doc.extractionStatus !== "done" || !(extracted[doc.id]! > 0)) continue;
      if (store.ensureEvidence(workspaceId, "document", doc.id, doc.extractedText)[0]?.id !== extracted[doc.id]) announced.delete(id);
    }
    // A turn takes the new files that fit its reading budget; the rest wait for the next turn instead of being marked read with their text
    // cut away (an authorized folder can bring hundreds at once). The model is told how many still wait.
    // A phone recording's raw transcript is read through its digest (「… 摘要.md」, recording-digest.ts): all-day transcripts are mostly
    // talk the interview has no use for, and would take the whole reading budget.
    const transcripts = transcriptDocumentIds(store, workspaceId);
    const unread = [...docs].filter(([id, doc]) => doc.extractionStatus === "done" && !announced.has(id) && !transcripts.has(id));
    const fresh = withinBudget(unread);
    const waiting = unread.length - fresh.length;
    // What the connected calendars hold in the coming week: sent on the first turn and again whenever it changed.
    const week = calendarWeek(((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: [] } | undefined)?.blocks ?? []), today);
    const weekSent = JSON.stringify(week);
    const calendarChanged = week.length > 0 && (input.reread || weekSent !== coverage.calendarSent);

    // The extraction starts now, beside the dialogue: this reply, and the files this turn shows — as many as the dialogue reads, a re-read
    // included, so files go to the extraction at the dialogue's pace. A file already extracted at its current text is not queued again (a
    // turn that failed shows its files once more), except on a re-read.
    if (input.reread) store.setSetting(workspaceId, EXTRACT_REREAD_SETTING, "1");
    queueExtractDocs(store, workspaceId, fresh.map(([, doc]) => doc.id)
      .filter((id) => input.reread || !(extracted[id]! > 0 && firstSentenceOf(store, workspaceId, id) === extracted[id])));
    const ask = () => requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), sessionId);
    const extraction = extractMode === "off" ? Promise.resolve() : ask();
    const caughtUp = (timeoutMs?: number) => extractMode === "off" ? Promise.resolve(false)
      : extractionReached(store, workspaceId, sessionId, userMessage.seq, ask, timeoutMs).catch(() => false);

    // `line-<id>`: the interview of one line, added after the first one.
    const focus = sessionId.startsWith("line-") ? identityLines(store, workspaceId).find((line) => line.id === sessionId.slice(5)) : undefined;
    const focusLine = focus ? { id: focus.id, label: focus.label, goal: focus.goal ?? "" } : null;
    let threadId = session.codexThreadId;
    let announcedNow = announced;
    let sent = fresh;
    const heardAt = new Date().toISOString();
    const recorded = recordedSince(coverage.heardAt);
    // The short ledger the round starts from: the last round's progress record, an abstract of the ledger, and the latest ratings.
    const pace = () => paceContext(store, workspaceId, sessionId, { today, recent: recorded.lines, progress: storedProgress(session!.coverage), flow,
      lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [] })) });
    // What the app did to the last round and which replies the ledger lags behind: sent with every turn, only when there is something.
    const lastRound = coverage.lastRound;
    const roundNotes = () => ({ ...(lastRound && (lastRound.removed.length || lastRound.added.length) ? { lastRound } : {}),
      ...(unrecorded.length ? { unrecorded } : {}) });
    const ids = { lines: identities().map((item) => item.id), projects: store.listProjects(workspaceId).map((project) => project.id) };
    const outputSchema = onboardingDialogueSchema(ids);
    const validateOutput = (output: unknown) => validateOnboardingDialogue(output, known);
    const softAccept = (_rejection: Error, output: unknown) => keepOnboardingDialogue(output, known);
    // A turn that only needs one or two questions dropped is kept now instead of rewritten in full by a repair.
    const keepEarly = (_rejection: Error, output: unknown) => {
      const kept = keepOnboardingDialogue(output, known);
      return kept && droppedOnboardingItems(output, kept) <= ONBOARDING_KEEP_EARLY_MAX ? kept : undefined;
    };

    // The public quick test's result, only when the person pressed 「使用该结果」 (apps/web/lib/assess-link.ts): corroboration for the
    // portrait, never its scores. Sent with every turn while it is kept, so removing it stops it at once.
    const publicAssessment = (() => {
      try {
        const kept = JSON.parse(store.getSetting(workspaceId, ASSESS_RESULT_SETTING) ?? "null") as { source?: string; code?: string; typeName?: string;
          axes?: Record<string, number>; takenAt?: string } | null;
        // Only a result on the current four dimensions (a code of `TYPE_TABLE`); one kept from the first version is left out.
        return kept?.source === "public-assess" && kept.code && TYPE_TABLE[kept.code] && kept.typeName && kept.axes && kept.takenAt
          ? { code: kept.code, typeName: kept.typeName, axes: kept.axes, takenAt: kept.takenAt,
            note: "本人在公开测评（32 题自评）中的结果，由本人确认带入；只作佐证，画像四个维度仍按访谈证据评分，不照抄" } : undefined; // i18n-ignore: model-facing
      } catch { return undefined; }
    })();

    /** A first turn: everything the ledger knows goes in, because the thread starts empty. */
    const startThread = async (documents: typeof fresh, history?: OnboardingTurnContext["history"]) => {
      const context: OnboardingTurnContext = {
        version: "crossline.onboarding.turn.v1",
        identities: identities(),
        projects: store.listProjects(workspaceId).map(({ id, identityId, name, summary }) => ({ id, identityId, name, summary })),
        facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status })),
        today, timeZone, sources: clipDocuments(documents), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}), ...(history ? { history } : {}), reply: { id: replyId, text: replyText },
        focusLine, profile: readProfile(), stage: ((session!.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : INTERVIEW_FLOW_STAGES[flow][0]!)),
        ...(focusLine ? {} : { stageOrder: [...INTERVIEW_FLOW_STAGES[flow]] }),
        checklist: openChecklist(), ...stagePace(messages, { startOpen: startOpen() }), tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)),
        questionLedger: ledgerForModel(store, workspaceId, sessionId, LEDGER_SHOWN), ...pace(), ...roundNotes(),
        ...(workHistory().length ? { workHistory: workHistory() } : {}), ...(week.length ? { calendar: week } : {}),
        ...(publicAssessment ? { publicAssessment } : {}),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [],
          ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}), ...(line.domain ? { domain: DOMAIN_PACKS[line.domain].label } : {}) })),
        // A line's own interview gets its own checklist only; the main interview gets every domain line's.
        ...(() => { const guides = domainGuides(identityLines(store, workspaceId)).filter((guide) => !focusLine || guide.lineId === focusLine.id);
          return guides.length ? { domainGuides: guides } : {}; })()
      };
      return runCodexSkill<OnboardingDialogue>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema, keepThread: true, locale, secondPerson: SECOND_PERSON,
        prepareInput: () => context, validateOutput, softAccept, keepEarly,
        onAudit: (audit) => { if (audit.threadId) threadId = audit.threadId; }, onProgress, onQueued,
        timeoutMs: 60 * 60_000
      });
    };

    // The wait, made visible (docs/onboarding-v3.md 「等待」): what the model is reading and has written so far, polled by the page and
    // deleted when the turn ends. Unvalidated; only counted and previewed.
    const progressKey = `${ONBOARDING_PROGRESS_SETTING}:${sessionId}`;
    const startedAt = new Date().toISOString();
    const files = fresh.map(([, doc]) => doc.fileName);
    let lastWrite = 0;
    let latest: OnboardingProgress | undefined;
    const write = (record: OnboardingProgress) => {
      latest = record;
      try { store.setSetting(workspaceId, progressKey, JSON.stringify(record)); } catch { /* the screen's view must never fail the turn */ }
    };
    function onProgress(live: SkillProgress) {
      if (live.phase === "writing") { if (Date.now() - lastWrite < 1000) return; lastWrite = Date.now(); }
      write({ sessionId, startedAt, updatedAt: new Date().toISOString(), phase: live.phase, files, ...readPartialTurn(live.text), repairs: live.repairs, stalls: live.stalls });
    }
    // Waiting for the server's one model slot (model-gate.ts): the page says how many runs are ahead; 0 is this turn starting.
    function onQueued(ahead: number) {
      const base: OnboardingProgress = latest ?? { sessionId, startedAt, updatedAt: startedAt, phase: "thinking", files, facts: 0, dates: 0, questions: 0, reply: "", repairs: 0, stalls: 0 };
      const { ahead: _previous, ...rest } = base;
      write({ ...rest, updatedAt: new Date().toISOString(), ...(ahead > 0 ? { phase: "queued" as const, ahead } : { phase: "thinking" as const }) });
    }
    onProgress({ phase: "thinking", text: "", repairs: 0, stalls: 0 });
    // A model reading the files says nothing for a minute or more; the heartbeat tells the page the turn is still alive.
    const heartbeat = setInterval(() => { if (latest) write({ ...latest, updatedAt: new Date().toISOString() }); }, 15_000);

    let result;
    try {
      if (!session.codexThreadId) {
        result = await startThread(fresh);
      } else {
        // Later turns carry only what is new: the reply, any file that arrived since the last turn, and what the extraction recorded.
        const newSources = clipDocuments(fresh);
        // The completion list goes with every turn, so the model knows what it still owes without being told twice in prose.
        const rounds = stagePace(messages, { startOpen: startOpen() });
        const message = JSON.stringify({ reply: { id: replyId, text: replyText }, ...(newSources.length ? { newSources } : {}), checklist: openChecklist(), ...rounds,
          questionLedger: ledgerForModel(store, workspaceId, sessionId, LEDGER_SHOWN), ...pace(), ...roundNotes(),
          tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)), ...(calendarChanged ? { calendar: week } : {}),
          ...(publicAssessment ? { publicAssessment } : {}), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}) });
        result = await continueSkillTurn<OnboardingDialogue>(client, session.codexThreadId, message, {
          skillName: ONBOARDING_SKILL, cwd, locale, outputSchema, validateOutput, softAccept, keepEarly,
          onAudit: () => {}, onProgress, onQueued, timeoutMs: 60 * 60_000
        });
        // The runtime forgets a conversation when it restarts. The interview does not: the profile, the files and
        // every message are in the ledger, so a new thread is told what was said and carries on from there.
        if (!result.ok && result.blocker.code === "SKILL_THREAD_LOST") {
          threadId = undefined;
          announcedNow = new Set();
          sent = [...docs].filter(([, doc]) => doc.extractionStatus === "done");
          result = await startThread(sent, conversationSoFar(messages.slice(0, -1)));
        }
      }
    } finally { clearInterval(heartbeat); store.deleteSetting(workspaceId, progressKey); }
    if (!result.ok) return blocked(result.blocker.code, result.blocker.message, result.blocker.detail);

    // The checklist and the app's questions are read after the extraction when the round would end the interview (so a fact this reply
    // gave is on record), or always when asked to wait; otherwise from what the ledger held, and what this reply settled joins next round.
    if (extractMode === "await") await extraction.catch(() => undefined);
    // The dialogue says the interview can end: the extraction finalizes every deep section and writes the synthesis on its next run.
    if (result.output.nextAction === "ready_for_milestones" && !focusLine && extractMode !== "off") markFinishing(store, workspaceId, sessionId);
    // A round that would end the interview waits for the extraction, but not without end: on a slow model a run takes minutes and the
    // deep stages' replies queue behind each other (2026-10-19: the last round took ten minutes). What is still being written is the
    // portrait, which no question can settle, so after `FINISH_WAIT_MS` the portrait's items no longer hold the end.
    const ending = result.output.nextAction === "ready_for_milestones";
    if (extractMode === "await") await caughtUp();
    else if (ending) await caughtUp(FINISH_WAIT_MS);
    // An app question that blocks is asked every round until answered: when this reply may have answered it in prose, the round waits a
    // little for the extraction, so it is not asked again right under the answer.
    // A chosen goal is read from the taps themselves, so its question waits for nothing.
    else if (currentGaps().some((gap) => gap.blocking && gap.code !== "LINE_GOAL")) await caughtUp(BLOCKING_WAIT_MS);
    // Questions that are not the person's to answer (a room, class times already on record, whether a calendar event repeats) are taken
    // out before the round is stored; what something rests on is written as an assumption the person can correct.
    const screen = screenQuestions(result.output.questions, questionScreenFor(store, workspaceId));
    for (const item of screen.screened) {
      const assumption = screenAssumption(item);
      if (assumption) store.upsertProfileFact({ workspaceId, ...assumption, status: "inferred", sourceRef: "inference", sourceQuote: "", updatedAt: new Date().toISOString() });
    }
    // What the ledger says this round repeats: an answered question asked again goes; an app question the model asked itself is not added.
    const repeated = resolveRepeats(store, workspaceId, sessionId, screen.keep);
    if (repeated.dropped.length) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `onboarding:questions-repeated:${sessionId}:${replyId}:${heardAt}`,
      type: "onboarding.questions_repeated", entityId: sessionId, payload: { replyId, dropped: repeated.dropped } });
    // A line's own interview leaves its goal to the line card's picker (`goalEdits` wait there for the person).
    const gapsNow = currentGaps().filter((gap) => !repeated.coveredGaps.has(gap.question.id) && !(focusLine && gap.code === "LINE_GOAL"));
    const paced = paceDeepRound({ ...result.output, questions: repeated.questions }, Boolean(focusLine));
    // The profile module's cards for this stage (flow v2): they count in the round's questions, so the model's give way to them.
    // The item texts exist in Chinese only so far (our own translation, docs/profile-and-agent-kit.md §二): an English interview gets none.
    let cards = !focusLine && flow === "v2" && locale !== "en" && paced.output.nextAction === "ask"
      ? cardsForRound(paced.output.stage, settledItems(readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING))))
      : [];
    // Rating cards count in the round's questions; an interest card (想不想做) never shares a round with fact questions, which read as a
    // form beside it (2026-10-31).
    if (cards.length && !paced.deep && paced.output.questions.length) cards = cards.filter((card) => card.instrument !== "rest18");
    if (cards.length) paced.output = { ...paced.output, questions: paced.output.questions.slice(0, Math.max(1, DEEP_QUESTIONS_PER_ROUND - cards.length)) };
    const touched = { lines: recorded.identities, projects: recorded.projects, portrait: Boolean(readProfile().portrait) };
    const stillWriting = ending && extractMode === "background" && extractBacklog(store, workspaceId, sessionId).replies > 0;
    // Once the start standard stands the portrait's items no longer hold the end: the extraction's finishing run writes the portrait from
    // what is on record, and the portrait page is where it is read. Before, an interview that said 「可以开始」 was turned back to asking
    // round after round for a portrait field, and two of three people of the 2026-10-31 walkthrough ran into the round limit.
    const startStands = !focusLine && !startOpen();
    const owed = focusLine || options.checklist === false ? [] : openChecklist(Infinity, (item) => (stillWriting || startStands) && item.group === "画像");
    const checked = withChecklist(paced.deep ? paced.output
      : withGapQuestions(paced.output, gapsNow, messages, { freshDocuments: sent.map(([, doc]) => doc.id), touched, locale }), owed, locale);
    // A round with cards has something to answer even when every question of the model was screened out.
    // While the profile module runs (flow v2) the app's own fact questions wait for the Crossline part.
    const holdGaps = flow === "v2" && PROFILE_MODULE_STAGES.has(checked.stage as OnboardingStage);
    // Past the deep stages, a round left with nothing to ask while the start standard stands is the end, not an open question for its own
    // sake: what is left goes to 待决事项 once the person uses the app (`interviewStatus.parked`).
    const endsHere = startStands && !holdGaps && !paced.deep && !cards.length && checked.nextAction === "ask" && !checked.questions.length;
    if (endsHere && extractMode !== "off") markFinishing(store, workspaceId, sessionId);
    const output = withPlainTerms(endsHere ? { ...checked, nextAction: "ready_for_milestones" as const }
      : cards.length && checked.nextAction === "ask" ? { ...checked, cards }
      : withSomethingToAnswer(checked, holdGaps ? [] : gapsNow, messages, locale, focusLine || holdGaps ? [] : checklistNow().filter((item) => item.start && !item.done)));
    // The observation is kept only when its quotes are in the replies it names; the progress record goes back to the model next round.
    const replies = Object.fromEntries(messages.filter((message) => message.role === "user")
      .map((message) => [`reply-${message.seq}`, String((message.content as { text?: string }).text ?? "")]));
    // What the person will not see of what the model wrote, and what the app put beside it: told to the model next round, and logged.
    const written = new Set(result.output.questions.map((question) => question.id));
    const shown = new Set(output.questions.map((question) => question.id));
    const edits: RoundEdits = {
      removed: [
        ...screen.screened.map((item) => ({ text: item.question.text, why: `not shown: ${SCREEN_WHY[item.reason] ?? item.reason}` })),
        ...repeated.dropped.map((item) => ({ text: item.text, why: `not shown: already answered (#${item.repeats})` })),
        ...repeated.questions.filter((question) => !shown.has(question.id))
          .map((question) => ({ text: question.text, why: `not shown: over this round's limit of ${DEEP_QUESTIONS_PER_ROUND}; may be asked next round` }))
      ],
      added: output.questions.filter((question) => !written.has(question.id)).map((question) => question.text)
    };
    if (edits.removed.length || edits.added.length) store.appendEvent({ ownerId, workspaceId,
      idempotencyKey: `onboarding:round-edited:${sessionId}:${replyId}:${heardAt}`, type: "onboarding.round_edited", entityId: sessionId,
      payload: { replyId, ...edits } });
    const insight = checkInsight(result.output.insight, replies, output.stage);
    const progress = readTurnProgress(result.output.progress);
    const { insight: _raw, progress: _rawProgress, ...rest } = output;
    const stored = { ...rest, ...(insight ? { insight } : {}), ...(progress ? { progress } : {}) };
    const roundSeq = store.appendOnboardingMessage({ sessionId, workspaceId, role: "assistant", content: stored, createdAt: new Date().toISOString() });
    recordRound(store, workspaceId, sessionId, roundSeq, output.questions, new Date().toISOString());
    // Saved over the session as it is now, so a stage the extraction never writes is not lost to the copy read at the start.
    const current = store.getOnboardingSession(workspaceId, sessionId) ?? session;
    store.saveOnboardingSession({
      ...current, ...(threadId ? { codexThreadId: threadId } : {}),
      state: output.nextAction === "ready_for_milestones" ? "complete" : "active",
      coverage: { ...current.coverage, coverage: output.coverage, ...(output.stage ? { stage: output.stage } : {}), ...(progress ? { progress } : {}),
        announcedSources: [...announcedNow, ...sent.map(([id]) => id)], heardAt, ...(week.length ? { calendarSent: weekSent } : {}), lastRound: edits },
      updatedAt: new Date().toISOString()
    });
    // The synthesis is written by a run made after this one; the person does not wait for it.
    if (output.nextAction === "ready_for_milestones" && !focusLine && extractMode !== "off") void ask().catch(() => undefined);
    return { state: output.nextAction === "ready_for_milestones" ? "ready" : "asked", sessionId };
  };
}

/**
 * The interview may not call itself finished while an item of the completion list that more questions can settle is open
 * (`interviewChecklist`): a premature 「ready」 goes back to asking, says what is missing, and — when the model asked nothing — asks for it.
 * Items only the person can settle (confirming the portrait, adopting a goal) do not hold the interview; they show on the screen.
 */
export function withChecklist<T extends OnboardingDialogue>(output: T, open: Array<{ label: string; detail: string; owner: "interview" | "person"; ask?: string }>, locale?: Locale): T {
  const owed = open.filter((item) => item.owner === "interview");
  if (output.nextAction !== "ready_for_milestones" || !owed.length) return output;
  // The person is asked the item's own question, never shown the checklist's label (2026-10-31: 「完成访谈前还缺：硬约束「上班」的固定日程已
  // 收集（上课、组会、值班…）」). An item no question settles (a portrait field the extraction writes) holds the end without words of its own.
  const asks = [...new Set(owed.map((item) => item.ask).filter((ask): ask is string => Boolean(ask)))].slice(0, 2);
  const questions = output.questions.length ? output.questions
    : asks.length ? asks.map((text, index) => ({ id: `checklist-open-${index + 1}`, text, kind: "free" as const, allowOther: true, identityId: "", projectId: "", options: [] }))
    : [openStageQuestion(output.stage, locale)];
  return { ...output, nextAction: "ask", reply: `${output.reply}\n\n${tFor(locale)("开始之前还想再问几件事。")}`, questions };
}

/**
 * A round that still asks always has something to answer. The model's questions can all be screened out (already on record, not the
 * person's to answer), and in a deep stage the app's own questions used to wait for a fact round: the hosted walkthrough of 2026-10-16 met
 * a round with a reply and an empty box the moment the start standard stood. Then the app's waiting questions join, else one open question
 * for the stage.
 */
export function withSomethingToAnswer<T extends OnboardingDialogue>(output: T, gaps: ProfileGap[], messages: StoredOnboardingMessage[], locale?: Locale,
  /** Open start items: the one thing the round can usefully ask when nothing else is left (2026-10-30, before the stage's open question). */
  startOwed: Array<{ label: string; detail: string; ask?: string }> = []): T {
  if (output.nextAction !== "ask" || output.questions.length) return output;
  const withGaps = withGapQuestions(output, gaps, messages, { ...(locale ? { locale } : {}) });
  if (withGaps.questions.length) return withGaps;
  const start = startOwed.find((item) => item.ask);
  if (start) return { ...output, questions: [{ id: "start-open", text: tFor(locale)("{{ask}}实在说不准，可以先说一个暂定的答案。", { ask: start.ask! }),
    kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] };
  return { ...output, questions: [openStageQuestion(output.stage, locale)] };
}

/** Besides those that block, at most this many of the app's own questions join one round, so a batch stays answerable. */
export const GAPS_PER_ROUND = 3;

/**
 * At most this many of the model's own questions in one round, any stage (four in the deep stages and five in fact rounds until the
 * 2026-10-31 walkthrough: five fact questions plus the app's own made a screen nobody read to the end).
 */
export const DEEP_QUESTIONS_PER_ROUND = 3;
/** The app's own questions that do not block join only while a round has fewer than this many in all. */
export const ROUND_QUESTIONS_MAX = 4;

/**
 * Pacing in the deep stages — the situation, motive and vision, energy (docs/onboarding-v3.md). Decided 2026-10-14 as one question a
 * round; changed by the owner on 2026-10-16: questions that do not depend on each other's answers are asked together (at most four), and
 * only a question that builds on another's answer waits for a later round — which the model is told to judge. The app's own fact
 * questions still wait for a fact round (the screen lists them beside the conversation meanwhile), so a deep round stays about depth.
 */
/**
 * The cards a round of the profile-first flow carries: in a profile stage, what is left of the stages already passed and then this one's,
 * two at most; past the module (the Crossline part), whatever is still unanswered one card at a time, so the start item can close.
 */
export function cardsForRound(stage: string | undefined, settled: ReadonlySet<string>): ProfileCard[] {
  const module = INTERVIEW_FLOW_STAGES.v2.filter((name) => PROFILE_MODULE_STAGES.has(name)) as ProfileStage[];
  const at = module.indexOf(stage as ProfileStage);
  return at >= 0 ? cardsFor(module.slice(0, at + 1), settled) : cardsFor(module, settled, 1);
}

export function paceDeepRound<T extends OnboardingDialogue>(output: T, focus: boolean): { output: T; deep: boolean } {
  const deep = !focus && DEEP_STAGES.has(output.stage as OnboardingStage) && output.nextAction === "ask";
  return { deep, output: !focus && output.nextAction === "ask" ? { ...output, questions: output.questions.slice(0, DEEP_QUESTIONS_PER_ROUND) } : output };
}

/**
 * Adds the app's own questions (`profileGaps`) to the round, **the ones about this round** first (decided 2026-10-08): a question about a
 * line or project the model is asking about now, a file that arrived with this reply, the portrait once this round wrote it. With nothing
 * relevant, one other joins, so nothing waits forever. A gap the model already asked in its own words is not asked twice; one that blocks
 * is asked every round until answered, and turns a premature 「ready」 back into 「ask」.
 */
export function withGapQuestions<T extends OnboardingDialogue>(output: T, gaps: ProfileGap[], messages: StoredOnboardingMessage[],
  round: {
    freshDocuments?: string[];
    /** What the extraction recorded since the last round (lines, projects) and whether a portrait is written: what this round touched. */
    touched?: { lines: string[]; projects: string[]; portrait: boolean };
    /** The interview's language: the app's own question texts are written in it. */
    locale?: Locale;
  } = {}): T {
  const asked = new Set(messages.flatMap((message) => message.role === "assistant"
    ? ((message.content as { questions?: Array<{ id: string }> }).questions ?? []).map((question) => question.id) : []));
  const open = gaps.filter((gap) => {
    // Whether the portrait fits is answered on the portrait page, where it is read (2026-10-28); the interview only links there.
    if (gap.code === "PORTRAIT_UNCONFIRMED") return false;
    if (output.questions.some((question) => question.id === gap.question.id)) return false;
    // Already asked by the model in its own words: a line it asks anything about, a project question that is about the same thing.
    if (gapCoveredBy(gap, output.questions, gaps)) return false;
    return gap.blocking || !asked.has(gap.question.id);
  });
  const lines = new Set([...output.questions.map((question) => question.identityId), ...(round.touched?.lines ?? [])].filter(Boolean));
  const projects = new Set([...output.questions.map((question) => question.projectId), ...(round.touched?.projects ?? [])].filter(Boolean));
  const fresh = new Set(round.freshDocuments ?? []);
  const relevant = (gap: ProfileGap) => gap.code === "FILE_UNFILED" ? fresh.has(gap.documentId ?? "")
    : gap.code === "PORTRAIT_UNCONFIRMED" || gap.code === "APPEARANCE" ? Boolean(round.touched?.portrait)
    : gap.projectId ? projects.has(gap.projectId) || lines.has(gap.identityId) : lines.has(gap.identityId);
  const blockingGaps = open.filter((gap) => gap.blocking);
  const near = open.filter((gap) => !gap.blocking && relevant(gap));
  const rest = open.filter((gap) => !gap.blocking && !relevant(gap));
  const room = Math.max(0, ROUND_QUESTIONS_MAX - output.questions.length - blockingGaps.length);
  const added = [...blockingGaps, ...(near.length ? near : rest.slice(0, 1)).slice(0, Math.min(GAPS_PER_ROUND, room))];
  const blocking = gaps.some((gap) => gap.blocking);
  if (!added.length && !(blocking && output.nextAction === "ready_for_milestones")) return output;
  return {
    ...output,
    questions: [...output.questions, ...added.map((gap) => gap.question)],
    nextAction: blocking ? "ask" : output.nextAction,
    ...(blocking && output.nextAction === "ready_for_milestones"
      ? { reply: `${output.reply}\n\n${tFor(round.locale)("开始使用前，还需要本人回答下面几项。")}` } : {})
  };
}

/** The stages that gather the start standard: while a start item is open they never move on (those items take only the person's word). */
const FRONT_STAGES = new Set(["orientation", "lines"]);

/**
 * Rounds spent in the latest stage, counted back from the newest answer; from the second on, the instruction to move on. Writing what the
 * person could not answer as 「假设：」 is a standing rule of the Skill, in the same round, not something this hands out per round.
 */
export function stagePace(messages: Array<{ role: string; content: unknown }>, options: { startOpen: boolean }): { stageRounds: number; moveOn?: string } {
  const stages = messages.filter((message) => message.role === "assistant").map((message) => (message.content as { stage?: string }).stage ?? "");
  const current = stages.at(-1) ?? "";
  let rounds = 0;
  for (let index = stages.length - 1; index >= 0 && stages[index] === current; index -= 1) rounds += 1;
  if (rounds < 2 || !current || (options.startOpen && FRONT_STAGES.has(current))) return { stageRounds: rounds };
  return { stageRounds: rounds, moveOn: `「${current}」阶段已问 ${rounds} 轮：本轮进入下一阶段。` }; // i18n-ignore: an instruction to the model
}

/** The conversation as plain lines, for a thread that has to be rebuilt. Questions are kept; option lists are not. */
function conversationSoFar(messages: StoredOnboardingMessage[]): NonNullable<OnboardingTurnContext["history"]> {
  return messages.slice(-24).map((message) => {
    if (message.role === "user") return { id: `reply-${message.seq}`, role: "user" as const,
      text: String((message.content as { text?: string }).text ?? "").slice(0, 4000) };
    const turn = message.content as { reply?: string; questions?: Array<{ text?: string }> };
    return { id: `assistant-${message.seq}`, role: "assistant" as const,
      text: [turn.reply ?? "", ...(turn.questions ?? []).map((question) => question.text ?? "")].filter(Boolean).join("\n").slice(0, 4000) };
  });
}

/** A session id the browser can mint for itself before the first turn. */

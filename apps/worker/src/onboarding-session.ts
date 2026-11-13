import { transcriptDocumentIds } from "./recording-digest";
import {
  AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary, ACTIVITY_HOURLY, atComputerLines, type ActivityHour,
  PROFILE_CONFIRMED, portraitFingerprint, answeredGapFacts, answeredGoalQuestions, type TurnQuestion, keepOnboardingDialogue, droppedOnboardingItems, ONBOARDING_KEEP_EARLY_MAX, onboardingDialogueSchema,
  validateOnboardingDialogue, locateQuote,
  gapCoveredBy, screenQuestions, screenAssumption, type QuestionScreenInput,
  type DimensionId, type ProfileGap, type ProfileModel, type OnboardingStage, DEEP_STAGES, ONBOARDING_TONE_SETTING, ASSESS_RESULT_SETTING, TYPE_TABLE, readTone,
  checkInsight, disclosureReplies, handlesDisclosure, readTurnProgress, openStageQuestion, withPlainTerms,
  type KnownSources, type OnboardingDialogue, type OnboardingTurnContext, ONBOARDING_PROGRESS_SETTING, ONBOARDING_LAST_FAILURE, readPartialTurn, type OnboardingProgress, calendarWeek,
  tFor, type Locale, flowOf, INTERVIEW_FLOW_STAGES, PROFILE_MODULE_STAGES, cardsFor, readCardAnswers, mergeInstrumentAnswers, readInstrumentAnswers,
  settledItems, PROFILE_INSTRUMENTS_SETTING, type CardSet, type InterviewFlow, type ProfileCard, type ProfileStage,
  ONBOARDING_DEPTH_SETTING, readDepth, depthPace, roundsSpent, type DepthPace
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary, type SkillProgress } from "@crossline/codex";
import {
  EXTRACT_REREAD_SETTING, extractBacklog, readExtractState, firstSentenceOf, markFinishing, interviewChecklistFor, interviewGapsFor, interviewLocale, lockInterviewLocale, queueExtractDocs, questionScreenFor, readExtractDocs, unfiledFilesIn,
  type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument
} from "@crossline/db";
import { sourceIds } from "./source-ids";
import { localeOf } from "./locale";
import { adoptLineGoal, identityLines } from "./lines";
import { checklistAnswered, checklistAskable, ledgerForModel, linesAnsweredUnread, recordReplyAnswers, recordRound, resolveRepeats, syncGapQuestions } from "./question-ledger";
import { createOnboardingExtractor, extractionReached, requestAllLanes, requestExtraction, type ExtractLane } from "./onboarding-extract";
import { DATES_UNRECORDED_EVENT, ONBOARDING_UNRECORDED_EVENT, personTimeZone, readProfileModel } from "./onboarding-persist";
import { paceContext, storedProgress } from "./onboarding-pace";
import { hypothesisFromCard, POINTS_RULES, pointsRules } from "@crossline/core";
import { readResearch, researchForDialogue, researchRunnerFor } from "./onboarding-research";
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
/** How much longer it waits when, after that, the checklist would turn the end back with questions (one extraction run is about four minutes). */
const CHECKLIST_WAIT_MS = 300_000;
/** How long a round with a blocking app question waits for the extraction of the reply it may answer. */
const BLOCKING_WAIT_MS = 30_000;
/** Facts the extraction recorded since the last turn, at most this many lines in `recorded`. */
const RECORDED_SHOWN = 40;
/** Questions of the ledger shown to the model each round; repeats of older ones are still caught in code (`resolveRepeats`). */
const LEDGER_SHOWN = 15;

// The scenario in brief, and nothing more: every rule and example is in the Skill. A second copy of the rules here drifted from it twice
// (2026-10-19; again by 2026-10-31, when it also still said 「in Chinese」 under an English interview), so this names none of them.
// i18n-ignore-start: instructions to the interview Skill (model-facing)
export const INSTRUCTIONS = "你是 Crossline 首次访谈的访谈者。Skill crossline-onboarding 写了全部规则和例子，照它做。"
  + "本人读你的 `reply`、回答你的问题卡、评价你的观察卡；另一个运行从同样的回答和文件里记录事实、日期、小时、目标属性和画像，"
  + "所以你只写输出 schema 的字段。每轮输入告诉你访谈进行到哪里（`progress`、`abstract`、`questionLedger`、`checklist`、`lastRound`、"
  + "`unrecorded`、`research`），提问前先读。需要联网深挖的问题写进 `research`，交给调研子任务；`research` 里还没有结论的话题不要碰。"
  + "访谈只由本人按「结束并出报告」结束，你不要自己宣布结束。不要提议里程碑。";
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
/** Why an item was not recorded, as the dialogue is told it (model context, never shown to the person). */
const UNRECORDED_WHY: Record<string, string> = {
  DATE_QUOTE_DOES_NOT_SUPPORT_DATE: "no day could be read from the words cited", DATE_TIME_INVALID: "its time is incomplete (no end, or end before start)",
  DATE_INVALID: "its dates are not a valid range", DATE_OUT_OF_RANGE: "the date is too far from today (wrong year?)",
  DATE_UNKNOWN_SOURCE: "cited a sentence that does not exist", DATE_QUOTE_NOT_VERBATIM: "the cited words are not in the reply",
  DATE_NOTHING_VERIFIABLE: "none of the dates could be verified", NOT_KEPT: "it failed a check and was left out",
  LIMIT_REACHED: "one reading records at most this many; more may have been said, so ask what else there is"
};

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
    /**
     * The extraction in three lanes side by side (the app, 2026-11-12): the ledger, which the next round and the start standard wait for,
     * and the portrait's sections and inferences. `false`: one run writes all of it (tests that count the runs).
     */
    lanes?: boolean;
  } = {}) {
  const extractMode = extractModeOf(options);
  const lanes = options.lanes !== false;
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
  // An item's own question goes to the person only while `checklistAskable` allows it: once answered, the item waits for the extraction.
  const openChecklist = (limit = 8, skip: (item: { id: string; group: string; start?: boolean }) => boolean = () => false, sessionId?: string) => {
    const askable = sessionId ? checklistAskable(store, workspaceId, sessionId) : () => true;
    const answered = sessionId ? checklistAnswered(store, workspaceId, sessionId) : () => false;
    // A line answered about in a reply the extraction has not read yet: its items' questions wait (`linesAnsweredUnread`).
    const upTo = sessionId ? readExtractState(store, workspaceId, sessionId).upTo : 0;
    const unread = sessionId ? linesAnsweredUnread(store, workspaceId, sessionId, store.listOnboardingMessages(workspaceId, sessionId)
      .find((message) => message.role === "user" && message.seq > upTo)?.createdAt) : new Set<string>();
    const waits = (id: string) => unread.has(/^line_[a-z_]+:(.+)$/u.exec(id)?.[1] ?? "");
    return checklistNow()
      .filter((item) => !item.done && !item.deferred && !skip(item)).sort((a, b) => Number(Boolean(b.start)) - Number(Boolean(a.start)))
      .slice(0, limit).map(({ id, label, detail, owner, start, ask }) => ({ label, detail, owner, ...(start ? { start } : {}),
        ...(ask && askable(ask) && !waits(id) ? { ask } : {}),
        // Answered, or spoken to, in a reply the extraction has not written down yet: the dialogue must not ask it again in its own words.
        ...(waits(id) || (ask && answered(ask)) ? { recording: true } : {}) }));
  };
  /** The person's tier (`ONBOARDING_DEPTH_SETTING`), read every round: it can change mid-interview. */
  const depthNow = () => readDepth(store.getSetting(workspaceId, ONBOARDING_DEPTH_SETTING));
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

  /**
   * What the extraction could not record since `since`, one line each with why (W-228): the dialogue is told so it neither says 「已记下」
   * about it nor lets it go, and asks the person once for what is missing. A duplicate and a meal outside the stated hours are not asked.
   */
  const unrecordedSince = (sessionId: string, since: string | undefined) => store.listEvents(workspaceId, { type: [DATES_UNRECORDED_EVENT, ONBOARDING_UNRECORDED_EVENT] })
    .filter((event) => event.entityId === sessionId && (!since || event.createdAt > since))
    .flatMap((event) => ((event.payload as { dropped?: Array<{ title?: string; code?: string }> }).dropped ?? []))
    .filter((item) => item.title && item.code !== "OFF_HOURS" && item.code !== "DATE_DUPLICATE_ID")
    .map((item) => `${String(item.title).slice(0, 100)} — ${UNRECORDED_WHY[item.code ?? ""] ?? item.code}`).slice(-UNRECORDED_SHOWN);

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
    // The web refuses a reply over 12,000 characters instead of cutting it; this bound only keeps a runaway caller in check.
    const text = input.text.trim().slice(0, 16_000);
    const ownerId = store.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return blocked("WORKSPACE_OWNER_MISSING", said("找不到这个工作区的所有者。"));

    const now = new Date().toISOString();
    let session = store.getOnboardingSession(workspaceId, sessionId);
    // A new main interview runs the profile module first (flow v2, docs/profile-and-agent-kit.md §四); one that has had a round keeps its
    // flow, and a line's own interview has none.
    const lineInterview = sessionId.startsWith("line-");
    if (!session) {
      // A new main interview runs under the points rules (2026-11-12, `profile-points.ts`); one begun before keeps its paragraphs.
      session = { id: sessionId, ownerId, workspaceId, state: "active", coverage: lineInterview ? {} : { flow: "v2", rules: POINTS_RULES }, createdAt: now, updatedAt: now };
      store.saveOnboardingSession(session);
    }
    let messages = store.listOnboardingMessages(workspaceId, sessionId);
    if (!lineInterview && !(session.coverage as { flow?: unknown }).flow && !messages.some((message) => message.role === "assistant")) {
      session = { ...session, coverage: { ...session.coverage, flow: "v2", rules: POINTS_RULES } };
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
    // A long-term goal the person chose answering the interview's own question about a line is theirs as well: adopted now, so the app's goal
    // picker does not ask them to tick the same words again (a line that has a goal is left as it is).
    const asked = ([...messages].reverse().find((message) => message.role === "assistant")?.content as { questions?: TurnQuestion[] } | undefined)?.questions ?? [];
    for (const chosen of answeredGoalQuestions(replyText, asked)) adoptLineGoal(store, workspaceId, ownerId, chosen.lineId, chosen.parts, locale);
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
      .filter((id) => input.reread || !(extracted[id]! > 0 && firstSentenceOf(store, workspaceId, id) === extracted[id])), { fromStart: Boolean(input.reread) });
    // With lanes the promise is the ledger lane's (the watermark both modes share): the portrait's lanes finish on their own.
    const ask = () => lanes ? requestAllLanes(workspaceId, (preferred, lane) => extractor.runOnce(preferred, lane), sessionId)
      : requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), sessionId);
    const extraction = extractMode === "off" ? Promise.resolve() : ask();
    const caughtUp = (timeoutMs?: number) => extractMode === "off" ? Promise.resolve(false)
      : extractionReached(store, workspaceId, sessionId, userMessage.seq, ask, timeoutMs).catch(() => false);

    // `line-<id>`: the interview of one line, added after the first one.
    const focus = sessionId.startsWith("line-") ? identityLines(store, workspaceId).find((line) => line.id === sessionId.slice(5)) : undefined;
    const focusLine = focus ? { id: focus.id, label: focus.label, goal: focus.goal ?? "" } : null;
    // How thorough this round is: questions a round, cards, rounds per part, whether the details part runs (`DepthPace`).
    const tier = depthPace(depthNow());
    let threadId = session.codexThreadId;
    let announcedNow = announced;
    let sent = fresh;
    const heardAt = new Date().toISOString();
    const recorded = recordedSince(coverage.heardAt);
    // The short ledger the round starts from: the last round's progress record, an abstract of the ledger, and the latest ratings.
    const pace = () => paceContext(store, workspaceId, sessionId, { today, recent: recorded.lines, progress: storedProgress(session!.coverage), flow, depth: depthNow(),
      rules: !focusLine && pointsRules(session!.coverage),
      lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [] })) });
    // What the app did to the last round and which replies the ledger lags behind: sent with every turn, only when there is something.
    const lastRound = coverage.lastRound;
    const notRecorded = unrecordedSince(sessionId, coverage.heardAt);
    const roundNotes = () => ({ ...(lastRound && (lastRound.removed.length || lastRound.added.length) ? { lastRound } : {}),
      ...(unrecorded.length ? { unrecorded } : {}), ...(notRecorded.length ? { notRecorded } : {}) });
    const ids = { lines: identities().map((item) => item.id), projects: store.listProjects(workspaceId).map((project) => project.id) };
    // The research threads as of now (onboarding-research.ts): the dialogue leaves a topic alone until its thread has a conclusion.
    const research = focusLine ? undefined : researchRunnerFor(store, workspaceId, cwd, getClient);
    research?.resume(sessionId);
    const researchNow = () => researchForDialogue(readResearch(store, workspaceId, sessionId));
    // Whether the lower bound stands, said outright every round (2026-11-12 replay 4: the model told the person 「你可以开始使用应用了」
    // seven rounds before it did, reading the open items of `checklist` as settled). Only a line's own interview goes without.
    const startStandard = () => focusLine ? {} : { startStandard: { met: !startOpen(),
      missing: checklistNow().filter((item) => item.start && !item.done).map((item) => item.label) } };
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
        ...(focusLine ? {} : { stageOrder: stageOrderFor(flow, tier) }),
        checklist: openChecklist(8, undefined, sessionId), ...startStandard(), ...stagePace(messages, { startOpen: startOpen(), after: tier.moveOnAfter }), tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)),
        ...(focusLine ? {} : { depth: depthNow() }),
        questionLedger: ledgerForModel(store, workspaceId, sessionId, LEDGER_SHOWN), ...pace(), ...roundNotes(),
        ...(workHistory().length ? { workHistory: workHistory() } : {}), ...(week.length ? { calendar: week } : {}),
        ...(publicAssessment ? { publicAssessment } : {}), research: researchNow(),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [],
          ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}), ...(line.domain ? { domain: DOMAIN_PACKS[line.domain].label } : {}) })),
        // A line's own interview gets its own checklist only; the main interview gets every domain line's.
        ...(() => { const guides = domainGuides(identityLines(store, workspaceId)).filter((guide) => !focusLine || guide.lineId === focusLine.id);
          return guides.length ? { domainGuides: guides } : {}; })()
      };
      return runCodexSkill<OnboardingDialogue>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema, keepThread: true, locale, secondPerson: SECOND_PERSON, allowWebSearch: true,
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
        const rounds = stagePace(messages, { startOpen: startOpen(), after: tier.moveOnAfter });
        // The tier and the order of parts go with every turn: the person may change the tier between rounds.
        const message = JSON.stringify({ reply: { id: replyId, text: replyText }, ...(newSources.length ? { newSources } : {}), checklist: openChecklist(8, undefined, sessionId), ...startStandard(), ...rounds,
          ...(focusLine ? {} : { depth: depthNow(), stageOrder: stageOrderFor(flow, tier) }),
          questionLedger: ledgerForModel(store, workspaceId, sessionId, LEDGER_SHOWN), ...pace(), ...roundNotes(),
          tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)), ...(calendarChanged ? { calendar: week } : {}),
          ...(publicAssessment ? { publicAssessment } : {}), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}), research: researchNow() });
        result = await continueSkillTurn<OnboardingDialogue>(client, session.codexThreadId, message, {
          skillName: ONBOARDING_SKILL, cwd, locale, outputSchema, validateOutput, softAccept, keepEarly, allowWebSearch: true,
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
    // The main interview never ends itself (the owner, 2026-11-12): only the person's 「结束并出报告」 ends it, once the start standard stands
    // (`finishInterview`). A model that has nothing more to ask says so and asks whether there is anything else to talk about.
    const modelDone = !focusLine && result.output.nextAction === "ready_for_milestones";
    // Before the start standard stands the person cannot end it yet: a model that is done asks what the start still owes, never 「可以按
    // 结束」 (2026-11-12 replay: shown two rounds before the button would take it). None with words of its own: the round's open question.
    const startAsks = () => openChecklist(Infinity, (item) => !item.start, sessionId).filter((item) => item.owner === "interview" && item.ask).slice(0, 2)
      .map((item, index): TurnQuestion => ({ id: `checklist-open-${index + 1}`, text: item.ask!, kind: "free", allowOther: true,
        identityId: "", projectId: "", options: [] }));
    if (modelDone) result = { ...result, output: { ...result.output, nextAction: "ask" as const,
      questions: result.output.questions.length ? result.output.questions : options.checklist !== false && startOpen() ? startAsks() : [closingQuestion(locale)] } };
    // Questions the dialogue wants looked into on the web go to research threads of their own, in the background.
    const raised = (result.output as { research?: Array<{ question: string; why: string; dimension: DimensionId }> }).research ?? [];
    if (research && raised.length) research.start(sessionId, raised);

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
    // Still behind after that, a round that would end is not turned back by an item the person may have just settled: it waits for the
    // extraction once more. The 2026-11-01 rerun asked one father's weekly hours and his daughter's line again, rounds after he answered,
    // because the checklist was read while the extraction was still on earlier replies.
    if (ending && extractMode === "background" && !focusLine && extractBacklog(store, workspaceId, sessionId).replies > 0
      && openChecklist(Infinity, (item) => item.group === "画像").some((item) => item.owner === "interview" && item.ask))
      await caughtUp(CHECKLIST_WAIT_MS);
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
    const gapsFresh = () => currentGaps().filter((gap) => !repeated.coveredGaps.has(gap.question.id) && !(focusLine && gap.code === "LINE_GOAL"));
    let gapsNow = gapsFresh();
    const paced = paceDeepRound({ ...result.output, questions: repeated.questions }, Boolean(focusLine), tier.roundQuestions);
    // The profile module's cards for this stage (flow v2): they count in the round's questions, so the model's give way to them.
    // The item texts exist in Chinese only so far (our own translation, docs/profile-and-agent-kit.md §二): an English interview gets none.
    const cardsLeft = !focusLine && flow === "v2" && locale !== "en"
      ? cardsForRound(paced.output.stage, settledItems(readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING))), tier.cardItems, tier.cards)
      : [];
    // Rating cards no longer take the round's question slots (the owner, 2026-11-12: 「量表题也不会占额度了」). The short set has no
    // interest cards (想不想做), so none waits for a round of its own (onboarding-depth.ts).
    let cards = paced.output.nextAction === "ask" ? cardsLeft : [];
    // Every question the model wrote was taken out (already answered, screened) and none of its cards are left: what the round asks now is
    // the app's own, read off the checklist. That checklist waits for the extraction once more, or it asks what this reply just said (the
    // 2026-11-01 rerun asked the illustrator line's current project right under the answer naming it).
    if (!paced.output.questions.length && !cards.length && paced.output.nextAction === "ask" && extractMode === "background" && !focusLine
      && extractBacklog(store, workspaceId, sessionId).replies > 0) { await caughtUp(CHECKLIST_WAIT_MS); gapsNow = gapsFresh(); }
    const touched = { lines: recorded.identities, projects: recorded.projects, portrait: Boolean(readProfile().portrait) };
    const stillWriting = ending && extractMode === "background" && extractBacklog(store, workspaceId, sessionId).replies > 0;
    // Once the start standard stands the portrait's items no longer hold the end: the extraction's finishing run writes the portrait from
    // what is on record, and the portrait page is where it is read. Before, an interview that said 「可以开始」 was turned back to asking
    // round after round for a portrait field, and two of three people of the 2026-10-31 walkthrough ran into the round limit.
    const startStands = !focusLine && !startOpen();
    // The standard and thorough tiers keep the portrait's grounding owed (questions settle it); the fields the extraction writes never hold it.
    const owed = focusLine || options.checklist === false ? [] : openChecklist(Infinity, (item) => item.group === "画像"
      && (stillWriting || (startStands && !(tier.portraitHolds && item.id === "portrait_grounded"))), sessionId);
    let checked = withChecklist(paced.deep ? paced.output
      : withGapQuestions(paced.output, gapsNow, messages, { freshDocuments: sent.map(([, doc]) => doc.id), touched, locale, roundMax: tier.roundMax }), owed, locale);
    // A round the checklist turned back from the end carries what is left of the cards in place of the stage's open question: the cards
    // are a start item no question settles, and the 2026-10-31 rerun asked one open question eight rounds running while three cards waited.
    if (!cards.length && cardsLeft.length && paced.output.nextAction === "ready_for_milestones" && checked.nextAction === "ask") {
      cards = cardsLeft;
      checked = { ...checked, questions: checked.questions.filter((question) => !question.id.startsWith("open-")) };
    }
    // A round with cards has something to answer even when every question of the model was screened out.
    // While the profile module runs (flow v2) the app's own fact questions wait for the Crossline part.
    const holdGaps = flow === "v2" && PROFILE_MODULE_STAGES.has(checked.stage as OnboardingStage);
    // Past the deep stages, a round left with nothing to ask while the start standard stands is the end, not an open question for its own
    // sake: what is left goes to 待决事项 once the person uses the app (`interviewStatus.parked`).
    // A tier with a time limit also ends when its rounds are used up and the start standard stands, whatever the model still asks (W-236).
    const spent = startStands && checked.nextAction === "ask"
      && roundsSpent(depthNow(), messages.filter((message) => message.role === "assistant").length);
    // A round left with nothing to ask no longer ends the main interview: it asks whether there is anything else (`withSomethingToAnswer`).
    const endsHere = spent;
    if (endsHere && extractMode !== "off") markFinishing(store, workspaceId, sessionId);
    const assembled = spent ? { ...checked, questions: [], cards: [], nextAction: "ready_for_milestones" as const,
        reply: `${withoutNextStep(checked.reply)}\n\n${tFor(locale)("这一档的访谈轮数已用完：可以开始使用，剩下的问题会放进待确认，随时回来接着答。")}` }
      : endsHere ? { ...checked, nextAction: "ready_for_milestones" as const }
      : cards.length && checked.nextAction === "ask" ? { ...checked, cards }
      : withSomethingToAnswer(checked, holdGaps ? [] : gapsNow, messages, locale, focusLine || holdGaps ? [] : openChecklist(Infinity, (item) => !item.start, sessionId));
    // What the app added (the checklist's and the start items' own questions) goes through the screen the page applies when it lists the
    // round: a goal question the left column's picker already asks was listed as nothing, and the 2026-11-01 rerun showed 「开始之前还想再问
    // 几件事。」 over an empty batch twice.
    const roundOut = withFreshOpenQuestion(shownOrOpen(assembled, questionScreenFor(store, workspaceId), locale),
      checklistAskable(store, workspaceId, sessionId), locale, startStands ? closingQuestion(locale) : undefined);
    // Before the start standard stands the button would refuse: the reply does not point at it.
    const output = withPlainTerms(startStands || focusLine ? roundOut : { ...roundOut, reply: withoutEndHint(roundOut.reply) });
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
          .map((question) => ({ text: question.text, why: `not shown: over this round's limit of ${tier.roundQuestions}; may be asked next round` }))
      ],
      added: output.questions.filter((question) => !written.has(question.id)).map((question) => question.text)
    };
    if (edits.removed.length || edits.added.length) store.appendEvent({ ownerId, workspaceId,
      idempotencyKey: `onboarding:round-edited:${sessionId}:${replyId}:${heardAt}`, type: "onboarding.round_edited", entityId: sessionId,
      payload: { replyId, ...edits } });
    // Observations may come as often as there is evidence (the owner, 2026-11-12), never the same one twice: the Skill asks for a new
    // inference each time, and an observation whose words were already shown is dropped here.
    const squeeze = (text: string) => text.replace(/\s/gu, "");
    const shownInsights = new Set(messages.filter((message) => message.role === "assistant")
      .map((message) => squeeze(String((message.content as { insight?: { text?: string } }).insight?.text ?? ""))).filter(Boolean));
    // Never beside the safety check, never built on a disclosure (`disclosureReplies`).
    const sensitive = disclosureReplies(messages);
    const checkedInsight = handlesDisclosure(output.reply) ? undefined : (() => {
      const checked = checkInsight(result.output.insight, replies, output.stage);
      return checked?.refs.some((ref) => sensitive.has(ref.replyId)) ? undefined : checked;
    })();
    const newCard = checkedInsight && !shownInsights.has(squeeze(checkedInsight.text)) ? checkedInsight : undefined;
    // Under the points rules every card is one hypothesis of the log (2026-11-12): one on record by its id, never one a card already asked
    // about; else a new one, added to the log here under the reply's number, so 准 / 不准 lands on the inference it rates.
    const insight = newCard && !focusLine && pointsRules(session.coverage) ? (() => {
      const asked = new Set(messages.filter((message) => message.role === "assistant")
        .map((message) => String((message.content as { insight?: { hypothesisId?: string } }).insight?.hypothesisId ?? "")).filter(Boolean));
      const profile = readProfile();
      const named = result.output.insight?.hypothesisId?.trim() ?? "";
      const onRecord = named ? profile.hypotheses.find((item) => item.id === named) : undefined;
      if (onRecord) return onRecord.cardKey || asked.has(onRecord.id) || onRecord.status === "refuted" ? undefined
        : { ...newCard, hypothesisId: onRecord.id, dimension: onRecord.dimension };
      // `c<seq>`, or with a suffix if an id like it is already on record.
      let id = `c${userMessage.seq}`;
      for (let n = 2; profile.hypotheses.some((item) => item.id === id); n += 1) id = `c${userMessage.seq}-${n}`;
      const made = hypothesisFromCard(newCard, id, result.output.insight?.dimension);
      store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile, hypotheses: [...profile.hypotheses.filter((item) => item.id !== id), made] }));
      return { ...newCard, hypothesisId: id, dimension: made.dimension };
    })() : newCard;
    const progress = readTurnProgress(result.output.progress);
    const { insight: _raw, progress: _rawProgress, ...rest } = output;
    const stored = { ...rest, ...(insight ? { insight } : {}), ...(progress ? { progress } : {}) };
    const roundSeq = store.appendOnboardingMessage({ sessionId, workspaceId, role: "assistant", content: stored, createdAt: new Date().toISOString() });
    // The hypothesis a card shows is asked from now on, answered or not: `cardKey` keeps it out of the next cards' candidates.
    if (insight?.hypothesisId) {
      const profile = readProfile();
      const key = `${sessionId}#${roundSeq}`;
      store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile,
        hypotheses: profile.hypotheses.map((item) => (item.id === insight.hypothesisId && !item.cardKey ? { ...item, cardKey: key } : item)) }));
    }
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
export function withChecklist<T extends OnboardingDialogue>(output: T, open: Array<{ id?: string; label: string; detail: string; owner: "interview" | "person"; ask?: string; recording?: boolean }>, locale?: Locale): T {
  // An item the person already answered, which the extraction has not written down yet, holds nothing: no question settles it, and the
  // 2026-11-01 run 12 asked one father 「哪条主线你最想先说清楚」 four rounds running while his answers waited to be written. What the
  // extraction then leaves open is asked on the interview page before the app opens (`startMissing`).
  const owed = open.filter((item) => item.owner === "interview" && !item.recording);
  if (output.nextAction !== "ready_for_milestones" || !owed.length) return output;
  // The person is asked the item's own question, never shown the checklist's label (2026-10-31: 「完成访谈前还缺：硬约束「上班」的固定日程已
  // 收集（上课、组会、值班…）」). An item no question settles (a portrait field the extraction writes) holds the end without words of its own.
  // A line's item carries its line, so the screen judges the question about that line (`line_desc:<line>`), not about every line.
  const asks = [...new Map(owed.filter((item) => item.ask).map((item) => [item.ask!, /^line_[a-z_]+:(.+)$/u.exec(item.id ?? "")?.[1] ?? ""])).entries()].slice(0, 2);
  const questions = output.questions.length ? output.questions
    : asks.length ? asks.map(([text, identityId], index) => ({ id: `checklist-open-${index + 1}`, text, kind: "free" as const, allowOther: true, identityId, projectId: "", options: [] }))
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

/**
 * The round as the page will list it: questions the screen takes out (`screenQuestions`) are dropped here, and a round that still asks
 * but is left with nothing to answer, and no cards, gets the stage's open question.
 */
export function shownOrOpen<T extends OnboardingDialogue & { cards?: unknown[] }>(output: T, screen: QuestionScreenInput, locale?: Locale): T {
  if (output.nextAction !== "ask" || !output.questions.length) return output;
  const { keep } = screenQuestions(output.questions, screen);
  if (keep.length === output.questions.length) return output;
  return { ...output, questions: keep.length || output.cards?.length ? keep : [openStageQuestion(output.stage, locale)] };
}

/**
 * The stage's open question is the app's own, added after the ledger's repeat check (`resolveRepeats`) has read the model's questions, so
 * nothing stopped it coming back: W-184 asked 「做这些事，你最终想得到什么？」 again, word for word, the round after the person answered it.
 * One the ledger says may not be asked again (`checklistAskable`: answered with something that settles it, or asked twice) gives way to
 * the next stage's open question that may.
 */
export function withFreshOpenQuestion<T extends OnboardingDialogue>(output: T, askable: (text: string) => boolean, locale?: Locale,
  /** Once every open question is used up and the start standard stands: whether there is anything else, and the finish button. */
  closing?: TurnQuestion): T {
  const stale = (question: TurnQuestion) => question.id.startsWith("open-") && !askable(question.text);
  if (!output.questions.some(stale)) return output;
  const next = openStageQuestion(output.stage, locale, askable);
  // The 2026-11-12 replay asked 「哪条主线你最想先说清楚」 nine rounds running once all seven were used: the stage's own came back each time.
  const fresh = askable(next.text) || !closing ? next : closing;
  return { ...output, questions: output.questions.map((question) => stale(question) ? fresh : question) };
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
 * `set` is the tier's card set (`DepthPace.cards`: the quick tier asks a short one).
 */
export function cardsForRound(stage: string | undefined, settled: ReadonlySet<string>, items?: number, set: CardSet = "all"): ProfileCard[] {
  const module = INTERVIEW_FLOW_STAGES.v2.filter((name) => PROFILE_MODULE_STAGES.has(name)) as ProfileStage[];
  const at = module.indexOf(stage as ProfileStage);
  // A stage the model went back to (compass after energy) leaves the later stages' cards behind: with none left up to it, the rest come
  // one card a round as past the module, or the start item never closes (2026-11-03 walk: 9 cards left and none offered).
  const upTo = at >= 0 ? cardsFor(module.slice(0, at + 1), settled, undefined, items, set) : [];
  return upTo.length ? upTo : cardsFor(module, settled, 1, items, set);
}

export function paceDeepRound<T extends OnboardingDialogue>(output: T, focus: boolean, limit = DEEP_QUESTIONS_PER_ROUND): { output: T; deep: boolean } {
  const deep = !focus && DEEP_STAGES.has(output.stage as OnboardingStage) && output.nextAction === "ask";
  return { deep, output: !focus && output.nextAction === "ask" ? { ...output, questions: output.questions.slice(0, limit) } : output };
}

/** The parts of the main interview in order; the details part only in the thorough tier (`DepthPace.detailsPart`). */
export const stageOrderFor = (flow: InterviewFlow, pace: DepthPace): OnboardingStage[] =>
  INTERVIEW_FLOW_STAGES[flow].filter((stage) => stage !== "details" || pace.detailsPart);

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
    /** The tier's `roundMax` (`DepthPace`); `ROUND_QUESTIONS_MAX` when not given. */
    roundMax?: number;
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
  // The questions that block (goals, appearance) always come; the model's give way to them down to one, so the round stays within its
  // limit (the 2026-11-01 rerun showed three of the model's, two goal pickers and the appearance question in one batch).
  const max = round.roundMax ?? ROUND_QUESTIONS_MAX;
  const own = blockingGaps.length ? output.questions.slice(0, Math.max(1, max - blockingGaps.length)) : output.questions;
  const room = Math.max(0, max - own.length - blockingGaps.length);
  const added = [...blockingGaps, ...(near.length ? near : rest.slice(0, 1)).slice(0, Math.min(GAPS_PER_ROUND, room))];
  const blocking = gaps.some((gap) => gap.blocking);
  if (!added.length && !(blocking && output.nextAction === "ready_for_milestones")) return output;
  return {
    ...output,
    questions: [...own, ...added.map((gap) => gap.question)],
    nextAction: blocking ? "ask" : output.nextAction,
    ...(blocking && output.nextAction === "ready_for_milestones"
      ? { reply: `${output.reply}\n\n${tFor(round.locale)("开始使用前，还需要本人回答下面几项。")}` } : {})
  };
}

/** The stages that gather the start standard: while a start item is open they never move on (those items take only the person's word). */
const FRONT_STAGES = new Set(["orientation", "lines"]);

/**
 * A reply without its closing announcement of what comes next (「接下来了解…」, "Next, …"): read right above the note that the rounds are
 * used up, it promised a part that never came (2026-11-06 walkthrough, W-241).
 */
export function withoutNextStep(reply: string): string {
  return reply.replace(/\s*(接下来|下面|下一步|本轮转向|还需|Next\b)[^。！？.!?]*[。！？.!?]?\s*$/u, "").trim() || reply; // i18n-ignore: the reply's own words
}

/**
 * Rounds spent in the latest stage, counted back from the newest answer; from the second on, the instruction to move on. Writing what the
 * person could not answer as 「假设：」 is a standing rule of the Skill, in the same round, not something this hands out per round.
 */
export function stagePace(messages: Array<{ role: string; content: unknown }>, options: { startOpen: boolean; after?: number }): { stageRounds: number; moveOn?: string } {
  const stages = messages.filter((message) => message.role === "assistant").map((message) => (message.content as { stage?: string }).stage ?? "");
  const current = stages.at(-1) ?? "";
  let rounds = 0;
  for (let index = stages.length - 1; index >= 0 && stages[index] === current; index -= 1) rounds += 1;
  if (rounds < (options.after ?? 2) || !current || (options.startOpen && FRONT_STAGES.has(current))) return { stageRounds: rounds };
  return { stageRounds: rounds, moveOn: `「${current}」阶段已问 ${rounds} 轮：本轮进入下一阶段。` }; // i18n-ignore: an instruction to the model
}

/**
 * The conversation as plain lines, for a thread that has to be rebuilt. Questions are kept; option lists are not. The whole conversation,
 * uncut (2026-11-12: it was the last 24 messages of at most 4,000 characters each); the runtime compacts the thread when it nears the
 * model's window, and the ledger keeps every message for the extraction's `search_evidence`.
 */
function conversationSoFar(messages: StoredOnboardingMessage[]): NonNullable<OnboardingTurnContext["history"]> {
  return messages.map((message) => {
    if (message.role === "user") return { id: `reply-${message.seq}`, role: "user" as const,
      text: String((message.content as { text?: string }).text ?? "") };
    const turn = message.content as { reply?: string; questions?: Array<{ text?: string }> };
    return { id: `assistant-${message.seq}`, role: "assistant" as const,
      text: [turn.reply ?? "", ...(turn.questions ?? []).map((question) => question.text ?? "")].filter(Boolean).join("\n") };
  });
}

/**
 * A reply without its sentences pointing at the end button, for a round before the start standard stands: pressed then, the button is
 * refused (2026-11-12 replay 3: 「按页面上的「结束并出报告」就会出报告」 in seven rounds while her fixed schedule was still open). A claim
 * that the app can be used now goes too (replay 4: 「你可以开始使用应用了」 seven rounds before the start standard stood).
 */
export function withoutEndHint(reply: string): string {
  const sentences = reply.match(/[^。！？!?\n]+[。！？!?]?|\n+/gu) ?? [];
  return sentences.filter((sentence) => !/结束并出报告|End and write the report|可以开始(使用|用)|start using/iu.test(sentence)).join("").trim() || reply; // i18n-ignore: the button's label and the start claim in both languages
}

/** A session id the browser can mint for itself before the first turn. */

/** What the dialogue asks when it has nothing more of its own: whether there is anything else, and that the person ends it with the button. */
export function closingQuestion(locale?: Locale): TurnQuestion {
  return { id: "closing-open", kind: "free", allowOther: true, identityId: "", projectId: "", options: [],
    text: tFor(locale)("还有没有别的想聊的？没有的话，可以按「结束并出报告」。") };
}

/**
 * The person's 「结束并出报告」 (the owner, 2026-11-12): the interview is marked complete, the extraction finishes every section from what was
 * said, and `settled` resolves once it has, so the caller writes the portrait from the finished record. The start standard (the lower
 * bound) is checked by the web route before it calls this; the interview can be taken up again afterwards, and a new report written.
 */
export function finishInterview(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined, sessionId: string,
  /** `extract: false` leaves the extraction alone (tests of the ending itself); `lanes: false` finishes with single runs. */
  options: { extract?: boolean; lanes?: boolean } = {}):
  { outcome: { state: "finished"; sessionId: string } | { state: "blocked"; code: string; message: string }; settled: Promise<void> } {
  const session = store.getOnboardingSession(workspaceId, sessionId);
  if (!session) return { outcome: { state: "blocked", code: "ONBOARDING_SESSION_UNKNOWN", message: tFor(localeOf(store, workspaceId))("找不到这次访谈。") }, settled: Promise.resolve() };
  const now = new Date().toISOString();
  markFinishing(store, workspaceId, sessionId);
  store.saveOnboardingSession({ ...session, state: "complete", updatedAt: now });
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `onboarding:finish:${sessionId}:${now}`,
    type: "onboarding.finish_requested", entityId: sessionId, payload: {} });
  const extractor = createOnboardingExtractor(store, workspaceId, cwd, getClient);
  const lanes = options.lanes !== false;
  const lane = (which: ExtractLane) => () => requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred, which), sessionId, which);
  const ask = lanes ? () => requestAllLanes(workspaceId, (preferred, which) => extractor.runOnce(preferred, which), sessionId)
    : () => requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), sessionId);
  const lastReply = store.listOnboardingMessages(workspaceId, sessionId).filter((message) => message.role === "user").at(-1)?.seq;
  if (options.extract === false) return { outcome: { state: "finished", sessionId }, settled: Promise.resolve() };
  const settled = (async () => {
    // Every reply recorded first (the ledger, then the inferences and the sections, within one 20-minute budget), then the finishing run
    // that writes the synthesis (as a round that ended the interview used to): the sections' lane, with lanes.
    const until = Date.now() + 20 * 60_000;
    const left = () => Math.max(0, until - Date.now());
    if (lastReply !== undefined) {
      await extractionReached(store, workspaceId, sessionId, lastReply, ask, left()).catch(() => false);
      if (lanes) for (const which of ["insights", "sections"] as const)
        await extractionReached(store, workspaceId, sessionId, lastReply, lane(which), left(), which).catch(() => false);
    }
    await (lanes ? lane("sections")() : ask()).catch(() => undefined);
  })();
  return { outcome: { state: "finished", sessionId }, settled };
}

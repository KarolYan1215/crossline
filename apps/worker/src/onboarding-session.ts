import { readFileSync } from "node:fs";
import path from "node:path";
import { transcriptDocumentIds } from "./recording-digest";
import {
  AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary, ACTIVITY_HOURLY, atComputerLines, type ActivityHour,
  PROFILE_CONFIRMED, portraitFingerprint, answeredGapFacts, type TurnQuestion, keepOnboardingDialogue, droppedOnboardingItems, ONBOARDING_KEEP_EARLY_MAX, onboardingDialogueSchema,
  validateOnboardingDialogue, locateQuote,
  type ProfileGap, type ProfileModel, type OnboardingStage, ASSESS_RESULT_SETTING, TYPE_TABLE,
  mentionsSelfHarm, safetyRound, sensitiveReplies, withoutDisclosures, disclosureEchoes, disclosureWords, interviewerWords, lessonAnswer, LESSON_QUESTION, type LessonConsent, readTurnProgress, safetyReplyOnly,
  inventedDates, type KnownSources, type OnboardingDialogue, type OnboardingTurnContext, ONBOARDING_PROGRESS_SETTING, ONBOARDING_LAST_FAILURE, readPartialTurn, type OnboardingProgress, calendarWeek,
  tFor, flowOf, INTERVIEW_FLOW_STAGES, INTERVIEW_ROUND_LIMIT, ONBOARDING_STAGES, readCardAnswers, mergeInstrumentAnswers, readInstrumentAnswers,
  PROFILE_INSTRUMENTS_SETTING, type InterviewFlow, type ProfileCard, checkChecklistVerdicts, judgedItems, renderInterviewSnapshot, datesWritten,
  type StoredVerdict, ruleFired
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, steerTurn, type CodexRpcBoundary, type SkillProgress, type SkillTools } from "@crossline/codex";
import {
  EXTRACT_REREAD_SETTING, readExtractState, firstSentenceOf, markFinishing, interviewChecklistFor, interviewGapsFor, interviewLocale, lockInterviewLocale, queueExtractDocs, readExtractDocs, unfiledFilesIn,
  insightKey, type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument
} from "@crossline/db";
import { sourceIds } from "./source-ids";
import { localeOf } from "./locale";
import { adoptLineGoal, identityLines } from "./lines";
import { answerMainQuestions, checklistAnswered, interviewLedger, linesAnsweredUnread, recordAsked, recordReplyAnswers, recordRound, syncGapQuestions } from "./question-ledger";
import { mergeTools } from "./ledger-index";
import { PART_ROUNDS, SATURATED_RUNS, questionsAsked, roundsInPart, standingLines } from "./onboarding-standing";
import { interviewReadTools, READ_TOOLS_INSTRUCTIONS } from "./onboarding-read-tools";
import { CARD_TOOLS_INSTRUCTIONS, cardTools, checkAsked, checkInsights, checkOpenItems, checkQuestions, checkResearch, emptyDraft, withDraft,
  type DateSubject, type Fired } from "./onboarding-cards";
import { correctionUnread, createOnboardingExtractor, extractionReached, requestAllLanes, requestExtraction, type ExtractLane } from "./onboarding-extract";
import { DATES_UNRECORDED_EVENT, ONBOARDING_UNRECORDED_EVENT, personTimeZone, readProfileModel } from "./onboarding-persist";
import { paceContext, storedProgress } from "./onboarding-pace";
import { hypothesisFromCard, instrumentReadings, ONBOARDING_INSIGHTS, POINTS_RULES, pointsRules, readInsightRatings, withProfileFramework, type Hypothesis, type TurnInsight } from "@crossline/core";
import { readResearch, researchForDialogue, researchRunnerFor } from "./onboarding-research";
import { DOMAIN_PACKS, domainGuides } from "@crossline/identity-packs";

export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

/**
 * The interview Skill's part checklists (2026-11-15; since 2026-11-22 read on demand): SKILL.md keeps the order and the resident core,
 * and `stages/<part>.md` beside it how each part is asked. The thread has no file access, so the dialogue reads one through
 * `read_interview_state` with `part` when it moves into it; a fallback route (no tools) is sent it with the round instead.
 */
const STAGE_GUIDES = path.resolve(import.meta.dirname, "../../../skills/marketplace/plugins/crossline/skills/crossline-onboarding/stages");
/** A stage's checklist, or undefined when there is none (a copy without the Skill's files). */
export function stageGuide(stage: string): string | undefined {
  if (!/^[a-z]+$/u.test(stage)) return undefined;
  try { return readFileSync(path.join(STAGE_GUIDES, `${stage}.md`), "utf8").trim() || undefined; } catch { return undefined; }
}
/** The dialogue's fields that speak to the person as 你; everything else it writes is third person. */
const SECOND_PERSON = ["reply", "questions", "insights"];

/**
 * What a first turn or a rebuilt thread is handed of the files, at most (2026-11-22: widened from 14k a file, 60k and 12 files, the owner:
 * the interview reads the person's material as Codex would). A later turn only names the new files; `read_file` reads any of them in full.
 */
const SOURCE_TEXT_PER_DOCUMENT = 40_000;
const SOURCE_TEXT_TOTAL = 200_000;
/** New files one turn names at most; more wait for the next turn. */
const SOURCES_PER_TURN = 30;
/** How long the round that ends a line's own interview waits for the extraction (the main interview is ended by the person, `finishInterview`). */
const FINISH_WAIT_MS = 90_000;
// No round waits for the extraction any more (2026-11-14 audit): the three waits (60 s before a fact round, 30 s under a blocking app
// question, 300 s for a round left empty) stacked, and an extraction on a sponsor's model takes 4–15 minutes, so they mostly ran out
// for nothing. The dialogue is told instead which answers are not on record yet (`startStandard.answered`, `unrecorded`).
/** Facts the extraction recorded since the last turn, at most this many lines in `recorded`. */
const RECORDED_SHOWN = 40;
/** Questions of the ledger shown to the model each round; a question like an older one is sent back to it with the answer (`checkQuestions`). */

// The scenario in brief, and nothing more: every rule and example is in the Skill. A second copy of the rules here drifted from it twice
// (2026-10-19; again by 2026-10-31, when it also still said 「in Chinese」 under an English interview), so this names none of them.
// i18n-ignore-start: instructions to the interview Skill (model-facing)
export const INSTRUCTIONS = "你是 Crossline 首次访谈的访谈者。Skill crossline-onboarding 写了全部规则和顺序，照它做。"
  + "本人读你的回复、回答你放在旁边的卡、评价你的观察卡；另一个运行从同样的回答和文件里记录事实、日期、目标和画像，所以你不必复述要记下什么。"
  + "访谈进行到哪里（进度、开始标准、问题记录、调研线程、量表读数）需要时自己读；和访谈直接相关、可以核实的信念当场用联网搜索核实，"
  + "岔开的题目交给后台调研线程，访谈结束时汇报它们的结论。访谈只由本人结束，你不要自己宣布结束。";
// i18n-ignore-end

const extractModeOf = (options: { extract?: "background" | "await" | "off" }) => options.extract ?? "background";

export type OnboardingTurnOutcome =
  | { state: "asked" | "ready"; sessionId: string }
  | { state: "blocked"; sessionId: string; code: string; message: string; detail?: string };

/** What the dialogue's thread has been shown: the files, the calendar week, and when it last heard what the extraction recorded. */
type Announced = { announcedSources?: string[]; calendarSent?: string; heardAt?: string; lastRound?: RoundEdits;
  /**
   * Whether the dialogue's thread was started with the card tools (P2b-3b): a route that calls functions gets them, one that does not
   * writes its items in the answer's fields. Tools are declared at `thread/start`, so the follow-up turns answer them only on such a thread.
   */
  cardTools?: "tools" | "fallback";
  /** The round the start standard first stood in (the progress header's 「从第几轮起已齐」). */
  startMetRound?: number;
  /**
   * The ledger's own memory of the interview (2026-11-25, 「访谈账本驱动」), read by the next round's snapshot and by the checklist
   * (`readChecklistVerdicts`): the model's latest verdict per checklist item, and each asked question's meaning by its ledger number.
   */
  checklist?: Record<string, StoredVerdict>;
  gists?: Record<string, string>;
  /** The disclosures (`reply-N`) the thread was last rebuilt without: one not among them rebuilds it before the round (2026-11-15). */
  redacted?: string[];
  /** Whether the person was asked, and agreed, to talk about what a hard time taught them (`LESSON_QUESTION`). */
  lesson?: LessonConsent;
  /** The stage whose checklist (`stageGuide`) the thread holds: another stage's is sent when the round starts in it (2026-11-15). */
  guide?: string };

/**
 * What of the dialogue's last round the person did not see, and what the app put beside it (2026-10-31). Since the 2026-11-14 audit the
 * app removes nothing on its own: an item is left out only when it still failed its check after the repairs ran out (`removed`, with
 * the problem the model was told), and the only thing added is the app's bookkeeping question for a file that came with the reply.
 */
export type RoundEdits = { removed: Array<{ text: string; why: string }>; added: string[] };

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
  // An item's suggested question (`ask`) is offered to the dialogue until the person answered it; then the item waits for the extraction.
  const openChecklist = (limit = 8, skip: (item: { id: string; group: string; start?: boolean }) => boolean = () => false, sessionId?: string) => {
    // Answers in replies the extraction has not read yet (`since`): a line answered about waits (`linesAnsweredUnread`), and so does a
    // checklist question answered there (`checklistAnswered`); once read, an item still open is asked again.
    const upTo = sessionId ? readExtractState(store, workspaceId, sessionId).upTo : 0;
    const since = sessionId ? store.listOnboardingMessages(workspaceId, sessionId).find((message) => message.role === "user" && message.seq > upTo)?.createdAt : undefined;
    const answered = sessionId ? checklistAnswered(store, workspaceId, sessionId, since) : () => false;
    const unread = sessionId ? linesAnsweredUnread(store, workspaceId, sessionId, since) : new Set<string>();
    const waits = (id: string) => unread.has(/^line_[a-z_]+:(.+)$/u.exec(id)?.[1] ?? "");
    return checklistNow()
      .filter((item) => !item.done && !item.deferred && !skip(item)).sort((a, b) => Number(Boolean(b.start)) - Number(Boolean(a.start)))
      .slice(0, limit).map(({ id, label, detail, owner, start, ask }) => ({ label, detail, owner, ...(start ? { start } : {}),
        ...(ask && !waits(id) && !answered(ask) ? { ask } : {}),
        // Answered, or spoken to, in a reply the extraction has not written down yet: the dialogue must not ask it again in its own words.
        ...(waits(id) || (ask && answered(ask)) ? { recording: true } : {}) }));
  };
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

  /**
   * One round, then each message the person queued while it ran (2026-11-22, D17: the worker's own queue, `enqueueInterview`), joined into
   * the next round, until the queue is empty or a round stops.
   */
  async function turn(input: { sessionId: string; text: string; reread?: boolean }): Promise<OnboardingTurnOutcome> {
    let outcome = await turnOnce(input);
    for (let queued = takeQueued(store, workspaceId, input.sessionId); queued; queued = takeQueued(store, workspaceId, input.sessionId)) {
      if (outcome.state === "blocked") { putBack(store, workspaceId, input.sessionId, queued); break; }
      outcome = await turnOnce({ sessionId: input.sessionId, text: queued });
    }
    return outcome;
  }
  return turn;

  async function turnOnce(input: { sessionId: string; text: string; reread?: boolean }): Promise<OnboardingTurnOutcome> {
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
    // At most `INTERVIEW_ROUND_LIMIT` of the person's messages a session (the owner, 2026-11-22), counted here as the turn starts.
    if (!retrying && messages.filter((message) => message.role === "user").length >= INTERVIEW_ROUND_LIMIT)
      return blocked("INTERVIEW_ROUND_LIMIT", said("这次访谈已经到 {{limit}} 轮的上限；可以结束并出报告，或开始一次新的访谈。", { limit: INTERVIEW_ROUND_LIMIT }));
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
    // A line's goal is written only from the app's own goal question (`LINE_GOAL` above) and the goal picker: the dialogue's own questions
    // about a line's future are read by the extraction, not taken as the goal. Guessing them from the wording wrote 「你最不想成为什么样的
    // 研究者？」 answered 「浮躁的」 as the line's goal (docs/onboarding-validation-audit.md §3.4).
    const asked = ([...messages].reverse().find((message) => message.role === "assistant")?.content as { questions?: TurnQuestion[] } | undefined)?.questions ?? [];
    // The question ledger: the answers this reply gives, then the app's own questions as of now (answered ones stay answered).
    // The questions the last reply itself asked take this reply whole (`answerMainQuestions`); the cards' answers are read from their form.
    answerMainQuestions(store, workspaceId, sessionId, replyText, replySentences, now);
    recordReplyAnswers(store, workspaceId, sessionId, replyText, replySentences, now);
    syncGapQuestions(store, workspaceId, currentGaps(), now);
    // The cards the last round offered: a tap is scored now, words wait for the extraction to map them, a card passed over is skipped.
    const offeredCards = ([...messages].reverse().find((message) => message.role === "assistant")?.content as { cards?: ProfileCard[] } | undefined)?.cards ?? [];
    if (offeredCards.length) store.setSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(mergeInstrumentAnswers(
      readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING)), readCardAnswers(replyText, offeredCards, now))));

    const timeZone = personTimeZone(store, workspaceId);
    const today = todayIso();
    const coverage = session.coverage as Announced;
    // The person's answer to the lesson question the last round put (asked once a whole interview): anything but 「可以聊聊」 is a no.
    const lesson: LessonConsent = coverage.lesson === "asked" ? lessonAnswer(replyText) : coverage.lesson ?? "unasked";
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
    // `transcripts` holds document ids; `docs` is keyed by reference (`src-N`), so the row's own id is what is looked up.
    const unread = [...docs].filter(([id, doc]) => doc.extractionStatus === "done" && !announced.has(id) && !transcripts.has(doc.id));
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
    let threadId = session.codexThreadId;
    let announcedNow = announced;
    let sent = fresh;
    const heardAt = new Date().toISOString();
    const recorded = recordedSince(coverage.heardAt);
    // The short ledger the round starts from: the last round's progress record, an abstract of the ledger, and the latest ratings.
    // A correction the inferences' lane has not read yet goes beside the cards (`cardsCheck`): they are checked against it, never held
    // back (2026-11-14 audit: holding them stopped every card for a round, once for ten). With no extraction nothing is unread.
    const reading = !focusLine && extractMode !== "off" && pointsRules(session.coverage);
    const correctionPending = reading && correctionUnread(store, workspaceId, sessionId, lanes);
    const pace = () => paceContext(store, workspaceId, sessionId, { today, recent: recorded.lines, progress: storedProgress(session!.coverage), flow,
      rules: !focusLine && pointsRules(session!.coverage), correctionUnread: correctionPending,
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
    // An item the person answered that the extraction has not written down yet is not missing: it is listed as answered, so the dialogue
    // neither asks it again nor tells the person it is 「还在记录」 (replay 10).
    // Every deep part of the interview has its minimum before the start standard is said to stand (W-269: compass had one round, energy
    // two, situation none, and 「可以开始使用」 came in round 10): a part no round has been in, or whose portrait section has nothing of the
    // person's yet, is still owed (`partsUncovered`). The pages' own gate (`readyToStart`) is unchanged.
    // The order of the interview's parts is the Skill's (2026-11-22): the start standard is the ledger's items alone, never 「parts not
    // walked yet」 (`partsUncovered` held the start back until every deep part had a round).
    const startOpenNow = () => startOpen();
    const startStandard = () => {
      if (focusLine) return {};
      const answered = new Set(openChecklist(Infinity, (item) => !item.start, sessionId).filter((item) => item.recording).map((item) => item.label));
      const missing = checklistNow().filter((item) => item.start && !item.done).map((item) => item.label);
      return { startStandard: { met: !startOpenNow(), missing: missing.filter((label) => !answered.has(label)), ...(answered.size ? { answered: [...answered] } : {}) } };
    };
    // The progress header (onboarding-standing.ts), first in every round's input: the rounds so far, the parts walked, since when the start
    // standard stands, what `ready_for_milestones` still lacks and the latest cards. Only the main interview has one.
    const assistantRounds = messages.filter((message) => message.role === "assistant");
    // The days asked before, by subject (`about`), with the person's answer, the latest per subject (2026-11-15).
    const dateSubjects = (): DateSubject[] => {
      const ledger = new Map(interviewLedger(store, workspaceId, sessionId).map((question) => [question.key, question]));
      const asked = assistantRounds.flatMap((message) => ((message.content as { questions?: TurnQuestion[] }).questions ?? [])
        .filter((question) => question.date && question.about?.trim())
        .map((question) => ({ about: question.about!.trim(), entry: ledger.get(`iq:${sessionId}:${message.seq}:${question.id}`) })));
      const out: DateSubject[] = [];
      for (const { about, entry } of asked.reverse()) {
        if (!entry || (entry.status !== "answered" && entry.status !== "assumed") || out.some((item) => item.about === about)) continue;
        out.push({ about, answer: entry.answer });
      }
      return out;
    };
    const startMetRound = focusLine || startOpenNow() ? null : coverage.startMetRound ?? assistantRounds.length + 1;
    /** Facts the latest ledger extractions of this interview wrote, for the replies they read (`onboarding.extracted`). */
    const extractedFacts = () => store.listEvents(workspaceId, { type: "onboarding.extracted", entityId: sessionId })
      .map((event) => event.payload as { replies?: number; facts?: number; lane?: string })
      .filter((payload) => (payload.lane ?? "ledger") === "ledger" && Number(payload.replies) > 0)
      .slice(-SATURATED_RUNS).map((payload) => Number(payload.facts) || 0);
    const standing = () => {
      if (focusLine) return {};
      const ratings = readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS));
      const profile = readProfile();
      return { standing: standingLines({
        rounds: assistantRounds.map((message) => {
          const content = message.content as { stage?: string; questions?: unknown[]; insight?: { text?: string }; moreInsights?: Array<{ text?: string }> };
          const cards = [content.insight, ...(content.moreInsights ?? [])].filter((card) => Boolean(card?.text)).length;
          const verdicts = Array.from({ length: cards }, (_, index) => ratings[insightKey(sessionId, message.seq, index)]?.verdict)
            .filter((verdict): verdict is "fits" | "partial" | "off" => verdict === "fits" || verdict === "partial" || verdict === "off");
          return { stage: content.stage ?? "", questions: content.questions?.length ?? 0, cards, verdicts };
        }),
        stage: stageNow, startMetRound, facts: extractedFacts(),
        startMissing: checklistNow().filter((item) => item.start && !item.done).map((item) => item.label),
        profile: { dimensions: profile.dimensions, hypotheses: profile.hypotheses, careers: profile.careers }
      }) };
    };
    // The app's own questions still waiting, put to the person only when the dialogue names them (`openItems`). Whether the portrait fits
    // is asked on the portrait page; which project a file belongs to is the app's bookkeeping, put beside the round (`filing` below).
    const askable = () => currentGaps().filter((gap) => gap.code !== "PORTRAIT_UNCONFIRMED" && gap.code !== "FILE_UNFILED" && !(focusLine && gap.code === "LINE_GOAL"));
    const openItems = () => {
      const items = askable().map((gap) => ({ id: gap.question.id, text: gap.question.text, ...(gap.blocking ? { start: true } : {}) }));
      return items.length ? { openItems: items } : {};
    };
    // What a round's items are checked against (`onboarding-cards.ts`), the same checks whether they came as fields or as tools.
    const replies = Object.fromEntries(messages.filter((message) => message.role === "user")
      .map((message) => [`reply-${message.seq}`, String((message.content as { text?: string }).text ?? "")]));
    const earlierCards = messages.filter((message) => message.role === "assistant").flatMap((message) => {
      const content = message.content as { insight?: TurnInsight; moreInsights?: TurnInsight[] };
      return [content.insight, ...(content.moreInsights ?? [])].filter((card): card is TurnInsight => Boolean(card?.text));
    });
    /* i18n-ignore-start: problems and notes sent to the model */
    // Replies a disclosure sits in (2026-11-15): never a card's evidence, and no model reads their words after the round that answers
    // them. `hidden` is those but this reply, which the round in hand answers.
    const sensitive = sensitiveReplies(messages);
    const hidden = new Set([...sensitive].filter((id) => id !== replyId));
    // Compared by the person's own words where the disclosure is; the interviewer's words and the other replies are ordinary.
    const disclosedTexts = disclosureWords(messages, hidden);
    const ordinaryTexts = [...Object.entries(replies).filter(([id]) => !sensitive.has(id)).map(([, said]) => said), ...interviewerWords(messages)];
    /**
     * What in a piece of the round points back at a disclosure. A self-harm word is sent back (safety); words only the disclosure said
     * (`disclosureEchoes`) are recorded (IR-123, 2026-11-25): the model never reads the disclosure (IR-121) and the snapshot tells it where
     * it sits and what the person agreed to.
     */
    const echoOf = (said: string): string => (hidden.size && said && mentionsSelfHarm(said) ? "有自伤的字眼" : "");
    const echoSpans = (said: string): string[] => (hidden.size && said ? disclosureEchoes(said, disclosedTexts, ordinaryTexts) : []);
    /** What the dialogue is told of a disclosure, by where the person's consent stands. */
    const disclosureNote = (): { disclosure?: string } => {
      if (!hidden.size || focusLine) return {};
      const where = [...hidden].join("、");
      const note = lesson === "yes" ? "本人愿意谈那段时期教会了自己什么：只问先兆、帮到的人和事、怎么缓过来的，不问也不复述经过和细节，一两轮就够。"
        : lesson === "no" ? "本人不想谈那段时期：整场不提它，也不再问。"
        : "从中学到的东西（压力来之前的先兆、什么帮到了本人、怎么缓过来的）对以后的安排有用。要谈，先把 askLesson 设为 true，应用会出一道固定的题问本人愿不愿意；整场只问一次，挑本人状态平稳的时候。在那之前不提这段经历。";
      return { disclosure: `本人在 ${where} 谈到过一段艰难时期，原文已换成占位，不给你看。${note}` };
    };
    /**
     * The ledger snapshot for this round (`renderInterviewSnapshot`): the checklist with the model's last verdicts, the questions asked with
     * their meaning and answers, the days the person wrote (a disclosure's reply left out), and the disclosure's note. Read from the ledger
     * the last round wrote, after this reply's answers were recorded.
     */
    const snapshotNow = (): string => {
      const gists = (store.getOnboardingSession(workspaceId, sessionId)?.coverage as Announced | undefined)?.gists ?? {};
      return renderInterviewSnapshot({
        round: messages.filter((message) => message.role === "user").length,
        items: checklistNow(),
        questions: interviewLedger(store, workspaceId, sessionId).map((question) => ({ ...question, ...(gists[String(question.id)] ? { gist: gists[String(question.id)]! } : {}) })),
        datesSaid: Object.entries(replies).filter(([id]) => !sensitive.has(id)).map(([ref, said]) => ({ ref, dates: datesWritten(said) })),
        disclosure: disclosureNote().disclosure
      });
    };
    const rules = !focusLine && pointsRules(session.coverage);
    /** What a checklist verdict may cite: every reply but a disclosure's, and every file by its `src-N`. */
    const verdictTexts = () => ({ ...replies, ...Object.fromEntries([...docs].map(([ref, doc]) => [ref, doc.extractedText ?? ""])) });
    const deskCheck = (output: OnboardingDialogue) => {
      const ledger = interviewLedger(store, workspaceId, sessionId);
      const asked = checkQuestions(output.questions, { ledger, openItems: askable(), dates: dateSubjects(), today });
      const items = checkOpenItems(output.openItems ?? [], askable(), asked.accepted);
      const cards = safetyRound(output) ? { accepted: [], problems: (output.insights ?? []).length ? ["安全这一轮不出观察卡，insights 写 []。"] : [] }
        : checkInsights(output.insights ?? [], { replies, sensitive, focusLine: Boolean(focusLine), stage: output.stage ?? "", rules,
          hypotheses: readProfile().hypotheses ?? [] , earlier: earlierCards });
      const research = focusLine ? { accepted: [], problems: [] } : checkResearch(output.research ?? [], readResearch(store, workspaceId, sessionId));
      // A question or card that points back at a disclosure goes back to the model; the round answering one is the safety reply's to word.
      const echoes: string[] = [];
      const quiet = safetyRound(output);
      const fired: Fired[] = [...(asked.fired ?? []), ...(items.fired ?? [])];
      const ownQuestions = asked.accepted.filter((question) => {
        const said = [question.text, ...question.options.map((option) => option.label)].join("\n");
        const echo = quiet ? "" : echoOf(said);
        if (echo) echoes.push(`问题「${question.text.slice(0, 30)}」${echo}：那段经历整场不复述，换个问法或不问。`);
        else if (!quiet && echoSpans(said).length) fired.push({ rule: "IR-123", detail: "a question used words only the disclosure said" });
        return !echo;
      });
      const ownCards = cards.accepted.filter(({ card }) => {
        const said = `${card.text}\n${card.falsifier}`;
        const echo = echoOf(said);
        if (echo) echoes.push(`观察卡「${card.text.slice(0, 30)}」${echo}：那段经历不作观察卡的材料，换一张或不出。`);
        else if (echoSpans(said).length) fired.push({ rule: "IR-123", detail: "a card used words only the disclosure said" });
        return !echo;
      });
      // The model's checklist verdicts and the questions its reply asks (2026-11-25): their evidence and structure are checked; whether the
      // words settle an item, or two questions mean the same, is the model's.
      const verdicts = checkChecklistVerdicts(output.checklist ?? [], { ids: new Set(judgedItems(checklistNow()).map((item) => item.id)), texts: verdictTexts(), sensitive });
      const inReply = checkAsked(output.asked ?? [], ledger);
      return { questions: [...ownQuestions, ...items.accepted], cards: ownCards, research: research.accepted, checklist: verdicts.accepted, asked: inReply.accepted, fired,
        problems: [...asked.problems, ...items.problems, ...cards.problems, ...research.problems, ...echoes, ...verdicts.problems, ...inReply.problems] };
    };
    /* i18n-ignore-end */
    // The schema survives only for a route that does not call functions (a provider not yet shown to): there the round's fields are
    // written in one JSON answer, the minimal fallback. Everywhere else the reply is the final message in free text (2026-11-22).
    const outputSchema = onboardingDialogueSchema(ids);
    // The card tools (P2b-3b): each item is checked as it is handed in, against the round's draft so far; the final answer's own fields
    // are merged after the draft and go through the same checks. A thread rebuilt after the runtime lost it starts a fresh draft.
    let draft = emptyDraft();
    let cardMode = coverage.cardTools;
    const property = (key: string) => (outputSchema as { properties: Record<string, Record<string, unknown>> }).properties[key]!;
    const itemSchema = (key: "questions" | "insights" | "research") => property(key).items as Record<string, unknown>;
    /** `mark_round`'s arguments: the round's own marks, each optional. */
    const roundSchema = { type: "object", additionalProperties: false, properties: { stage: property("stage"), safety: property("safety"),
      askLesson: property("askLesson"), progress: property("progress"), ready: { type: "boolean" }, checklist: property("checklist"), asked: property("asked") } };
    const stageNow = (session.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : INTERVIEW_FLOW_STAGES[flow][0]!);
    // On a fallback route the part's checklist goes with the round that starts in a part the thread has no checklist of, and with every
    // new thread; with tools the dialogue reads it when it wants (`read_interview_state` with `part`).
    const guideNow = stageGuide(stageNow);
    const guideFor = (newThread: boolean): { stageGuide?: string } => guideNow && (newThread || coverage.guide !== stageNow) ? { stageGuide: guideNow } : {};
    // The interview's state, read when the dialogue wants it (2026-11-22): what every round's input used to carry as one large JSON.
    /* i18n-ignore-start: the tool's description and answers are for the model */
    const stateTool: SkillTools = {
      specs: [{ name: "read_interview_state", description: "读访谈此刻的状态：进度头、开始标准、待办清单、应用的待问题（openItems）、问题记录、调研线程、量表读数、"
        + "还没记下的回复、上一轮被退回的项、日历本周、主线。给 part（narrative、situation、compass、energy、orientation、lines、details）时只回那一部分的清单。",
        inputSchema: { type: "object", additionalProperties: false, properties: { part: { type: "string", enum: [...ONBOARDING_STAGES] } } } }],
      call: (_name, args) => {
        const part = String((args as { part?: unknown } | undefined)?.part ?? "");
        if (part) return stageGuide(part) ?? `没有「${part}」这一部分的清单。`;
        return JSON.stringify(roundState());
      }
    };
    /* i18n-ignore-end */
    // With them, the read tools (P3): the ledger and the files in full, page by page, where the context shows only part of them.
    const readTools = interviewReadTools(store, workspaceId, sessionId);
    const tools = mergeTools(mergeTools(cardTools({ schemas: { question: itemSchema("questions"), insight: itemSchema("insights"), research: itemSchema("research"), round: roundSchema },
      ids: () => ids, draft: () => draft,
      check: (next) => deskCheck({ reply: "", coverage: [], nextAction: "ask", stage: stageNow, safety: false, ...next } as unknown as OnboardingDialogue).problems }),
    readTools), stateTool);
    const findings = () => researchNow().flatMap((item) => [item.conclusion ?? "", item.found ?? ""]).filter(Boolean);
    // Where a date in the reply may come from: what the person said, the research, the files, the facts on record (`inventedDates`).
    const givenTexts = () => [...messages.filter((message) => message.role === "user").map((message) => String((message.content as { text?: string }).text ?? "")),
      ...findings(), ...[...docs.values()].map((doc) => doc.extractedText), ...store.listProfileFacts(workspaceId).map((fact) => fact.value ?? "")];
    const setDates = (reply: string) => inventedDates(reply, givenTexts(), replyText, today);
    /**
     * The final message as a round: free text is the reply itself, with the round's marks and cards from the tools (`withDraft`); a JSON
     * answer with a `reply` (the fallback route, or a model that still answers that way) is taken as the round's fields.
     */
    const asRound = (output: unknown): unknown => {
      if (typeof output !== "string") return withDraft(output, draft);
      const text = output.trim();
      if (text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text.replace(/^```(?:json)?\s*\n?/u, "").replace(/\n?```$/u, "")) as unknown;
          // An object is an attempt at the structured round, so the validator judges it (an empty `{}` is not a reply).
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return withDraft(parsed, draft);
        } catch { /* free text that happens to open with a brace */ }
      }
      freeText = true;
      return withDraft({ reply: text, questions: [], coverage: [], nextAction: "ask", stage: stageNow, safety: false, insights: [], research: [], openItems: [] }, draft);
    };
    let freeText = false;
    const validateOutput = (output: unknown) => {
      const valid = validateOnboardingDialogue(asRound(output), known);
      // A made-up date, the disclosure's words, the cards' notation and 「还没答」 in the reply are the model's to avoid from the snapshot and
      // the Skill (2026-11-25); they are recorded after the round (`firedAfter`), never sent back. A date reaches the ledger or a calendar
      // only through the extraction, which can cite only the person's words or a file (IR-005).
      // The reply pointing back at a disclosure with a self-harm word: sent back, the safety round's own reply aside.
      const echo = safetyRound(valid) ? "" : echoOf(valid.reply);
      if (echo) throw Object.assign(new Error("SKILL_SCHEMA_INVALID"), {
        detail: `回复${echo}。那段经历整场不复述：去掉那句，接着说别的。` }); // i18n-ignore: model-facing repair note
      // A free-text round that never called `mark_round` keeps the part it started in (replay 2026-11-23: all 24 rounds stayed
      // `narrative` while the talk went through 处境, 指南针, 能量 and the lines, so the progress and the completeness never moved).
      // Sent back once; its second answer stands.
      if (freeText && !focusLine && !draft.meta?.stage && !stageAsked) {
        stageAsked = true;
        throw Object.assign(new Error("SKILL_SCHEMA_INVALID"), { reply: true,
          detail: "这一轮没有调用 `mark_round`。调用它：stage 写这一轮实际在谈的部分（话题已经换了，就写新的部分），progress 写这一部分已清楚的、还不清楚的和是否做完；回复照原样再写一遍。" }); // i18n-ignore: model-facing repair note
      }
      // Each question, waiting item, card and research question through its check (verbatim quotes, real links, the ledger's askings):
      // what fails comes back with why, the rest stands.
      const desk = deskCheck(valid);
      if (desk.problems.length) throw Object.assign(new Error("SKILL_SCHEMA_INVALID"), { cards: true,
        detail: `这一轮有几项要改，其余照旧：\n- ${desk.problems.join("\n- ")}` }); // i18n-ignore: model-facing repair note
      // The person's reply names self-harm and the round is not the safety reply: sent back once, since the words may be about someone
      // else or a research topic, which the model can tell and the pattern cannot (2026-11-14 audit). Its second answer stands.
      if (mentionsSelfHarm(replyText) && !safetyRound(valid) && !safetyAsked) {
        safetyAsked = true;
        throw Object.assign(new Error("SKILL_SCHEMA_INVALID"), { safety: true,
          detail: "本人这条回复里有提到自伤或不想活的字眼。如果是本人自己有过或现在有这样的念头，这一轮按「安全」一节回应，safety 设为 true；如果说的是别人的事或一个题目，保持原来的回答，safety 设为 false。" }); // i18n-ignore: model-facing repair note
      }
      return valid;
    };
    let safetyAsked = false;
    let stageAsked = false;
    /**
     * The record-only rules over the round as accepted (2026-11-25): each that fired is one line of `rule-fired.jsonl` (`ruleFired`) for the
     * replays, the reply and the cards left as the model wrote them.
     */
    const firedAfter = (output: OnboardingDialogue, desk: { fired: Fired[] }): Fired[] => {
      const fired = [...desk.fired];
      const invented = setDates(output.reply);
      if (invented.length) fired.push({ rule: "IR-006", detail: `reply set ${invented.join(", ")}` });
      if (!safetyRound(output) && echoSpans(output.reply).length) fired.push({ rule: "IR-123", detail: "reply used words only the disclosure said" });
      if (CARD_NOTATION.test(output.reply)) fired.push({ rule: "IR-190", detail: "reply copied the cards' notation" });
      CARD_NOTATION.lastIndex = 0;
      const pending = PENDING_TALK.exec(output.reply);
      if (pending) fired.push({ rule: "IR-191", detail: `reply said ${pending[0]}` });
      const lessonWhy = lessonRefused(output);
      if (lessonWhy) fired.push({ rule: "IR-124", detail: "askLesson where the app does not ask it" });
      if (!focusLine && startOpenNow() && endHinted(output.reply)) fired.push({ rule: "IR-165", detail: "reply said the app can be used before the start standard stands" });
      if (SCORE_TALK.test(output.reply)) fired.push({ rule: "IR-165", detail: "reply quoted the scale's scores" });
      return fired;
    };
    /** The scale's readings in words (`instrumentReadings`), never the taps: what the dialogue reads of the cards (2026-11-15). */
    const scaleReadings = (): { scaleReadings?: string[] } => {
      if (focusLine) return {};
      const readings = instrumentReadings(readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING)));
      return readings.length ? { scaleReadings: readings } : {};
    };
    /** Why the lesson question may not go this round, or "" when it may (or was not asked for). */
    function lessonRefused(output: OnboardingDialogue): string {
      if (!output.askLesson) return "";
      if (!hidden.size || focusLine) return "本人没有谈过需要先征得同意才能聊的经历"; // i18n-ignore: model-facing
      if (lesson !== "unasked") return "这道题整场只问一次，已经问过了"; // i18n-ignore: model-facing
      return safetyRound(output) ? "安全这一轮不问它" : ""; // i18n-ignore: model-facing
    }
    /** A reply past the repairs, without the sentences that still name self-harm after a disclosure (interview-rules IR-121, IR-123). */
    const withoutEchoes = (said: string) => (said.match(/[^。！？!?\n]+[。！？!?]?|\n+/gu) ?? []).filter((sentence) => !echoOf(sentence)).join("").trim();
    const softAccept = (_rejection: Error, output: unknown) => {
      const kept = keepOnboardingDialogue(asRound(output), known);
      if (!kept) return kept;
      return { ...kept, reply: safetyRound(kept) ? kept.reply : withoutEchoes(kept.reply), ...(lessonRefused(kept) ? { askLesson: false } : {}) };
    };
    // A turn that only needs one or two questions dropped is kept now instead of rewritten in full by a repair; one that lists the research is not.
    const keepEarly = (rejection: Error, output: unknown) => {
      // The safety question, the items' own problems and the reply's own (its part unmarked) are the model's to answer, never settled by
      // keeping the answer as it is.
      const why = rejection as Error & { safety?: boolean; cards?: boolean; reply?: boolean };
      if (why.safety || why.cards || why.reply) return undefined;
      const merged = asRound(output);
      const kept = keepOnboardingDialogue(merged, known);
      return kept && droppedOnboardingItems(merged, kept) <= ONBOARDING_KEEP_EARLY_MAX
        && (safetyRound(kept) || !echoOf(kept.reply)) ? kept : undefined;
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
        ...standing(), ...guideFor(true),
        version: "crossline.onboarding.turn.v1",
        identities: identities(),
        projects: store.listProjects(workspaceId).map(({ id, identityId, name, summary }) => ({ id, identityId, name, summary })),
        facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status })),
        today, timeZone, sources: clipDocuments(documents), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}), ...(history ? { history } : {}), ...disclosureNote(), ...scaleReadings(), reply: { id: replyId, text: withoutTaps(replyText) },
        focusLine, profile: readProfile(), stage: ((session!.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : INTERVIEW_FLOW_STAGES[flow][0]!)),
        checklist: openChecklist(8, undefined, sessionId), ...startStandard(), ...openItems(),
        snapshot: snapshotNow(), ...pace(), ...roundNotes(),
        ...(workHistory().length ? { workHistory: workHistory() } : {}), ...(week.length ? { calendar: week } : {}),
        ...(publicAssessment ? { publicAssessment } : {}), research: researchNow(),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [],
          ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}), ...(line.domain ? { domain: DOMAIN_PACKS[line.domain].label } : {}) })),
        // A line's own interview gets its own checklist only; the main interview gets every domain line's.
        ...(() => { const guides = domainGuides(identityLines(store, workspaceId)).filter((guide) => !focusLine || guide.lineId === focusLine.id);
          return guides.length ? { domainGuides: guides } : {}; })()
      };
      return runCodexSkill<OnboardingDialogue>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: withProfileFramework(INSTRUCTIONS), outputSchema, keepThread: true, locale, secondPerson: SECOND_PERSON, webResearch: true,
        prepareInput: () => context, validateOutput, softAccept, keepEarly,
        optionalTools: { tools, instructions: `${CARD_TOOLS_INSTRUCTIONS}\n${READ_TOOLS_INSTRUCTIONS}`, withoutTools: (input) => input, onMode: (mode) => { cardMode = mode; }, freeText: true },
        compactPrompt: COMPACT_PROMPT,
        onAudit, onProgress, onQueued,
        timeoutMs: 60 * 60_000
      });
    };
    /** The thread and the turn running now, for the person's 「插入本轮」 (`steerInterview`). */
    const activeKey = `${workspaceId}:${sessionId}`;
    function onAudit(audit: { threadId?: string; turnId?: string }) {
      if (audit.threadId) threadId = audit.threadId;
      if (audit.threadId && audit.turnId && client && cardMode === "tools") activeTurns.set(activeKey, { client, threadId: audit.threadId, turnId: audit.turnId });
    }
    /** Everything a later round's input carried as JSON, now read through `read_interview_state` (and sent whole on a fallback route). */
    const roundState = () => ({ ...standing(), ...disclosureNote(), ...scaleReadings(), checklist: openChecklist(8, undefined, sessionId), ...startStandard(), ...openItems(),
      snapshot: snapshotNow(), ...pace(), ...roundNotes(),
      ...(week.length ? { calendar: week } : {}), ...(workHistory().length ? { workHistory: workHistory() } : {}),
      ...(publicAssessment ? { publicAssessment } : {}), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}), research: researchNow(),
      lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [] })) });
    /**
     * A later round's input on a route with tools (2026-11-22): the ledger snapshot first (2026-11-25: written from the ledger after the last
     * round, so the model judges against it and not against a thread that may have been compacted), then the person's words, then one line
     * saying what is new — the files that came (read with `read_file`), a calendar that changed — and where the rest is. A disclosure's
     * note is in the snapshot: it is a safety rule.
     */
    const roundLine = (newSources: Array<{ id: string; fileName: string }>) => {
      // Two facts said every round rather than left in `read_interview_state` (replay of 2026-11-23): a question the person put to the
      // interviewer, and a part that has run `PART_ROUNDS` rounds. What to do with them is the Skill's.
      const asked = questionsAsked(withoutTaps(replyText));
      const inPart = focusLine ? 0 : roundsInPart(assistantRounds.map((message) => String((message.content as { stage?: string }).stage ?? "")), stageNow);
      const parts = [replyId, // i18n-ignore-start: the round's note to the model
        ...(asked.length ? [`本人在这条里问了你：${asked.map((item) => `「${item}」`).join("")}`] : []),
        ...(inPart >= PART_ROUNDS ? [`当前部分 ${stageNow} 连这一轮已到第 ${inPart} 轮`] : []),
        ...(newSources.length ? [`新文件 ${newSources.length} 份：${newSources.map((source) => `《${source.fileName}》(${source.id})`).join("、")}，用 read_file 读`] : []),
        ...(waiting > 0 ? [`还有 ${waiting} 份文件排在后面`] : []),
        ...(calendarChanged ? ["日历本周有变化"] : []),
        "进度、开始标准、调研和其余状态用 read_interview_state 读"];
      return `${snapshotNow()}\n\n${withoutTaps(replyText)}\n\n〔${parts.join("｜")}〕`; // i18n-ignore-end
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
    // A fresh thread told what was said, with every disclosure's words replaced (`withoutDisclosures`): after the runtime lost the thread,
    // and once a disclosure the thread still holds in the person's words has been answered (2026-11-15) — the thread is the one input
    // the app cannot edit, and replay 15's card retold a disclosure from it.
    const rebuild = () => {
      threadId = undefined;
      draft = emptyDraft();
      announcedNow = new Set();
      // Within the turn's reading budget only (docs/onboarding-agent-session.md C7): a file past it used to go with empty text and be
      // marked shown all the same. The rest stay unread and go with the next turns, and `read_file` reads any of them in full.
      sent = withinBudget([...docs].filter(([, doc]) => doc.extractionStatus === "done"));
      return startThread(sent, conversationSoFar(withoutDisclosures(messages.slice(0, -1), hidden).map((message) => message.role !== "user" ? message
        : { ...message, content: { ...(message.content as object), text: withoutTaps(String((message.content as { text?: string }).text ?? "")) } })));
    };
    const unredacted = [...hidden].some((id) => !(coverage.redacted ?? []).includes(id));
    try {
      if (!session.codexThreadId) {
        result = await startThread(fresh);
      } else if (unredacted) {
        result = await rebuild();
      } else {
        // Later turns carry only what is new: the reply, any file that arrived since the last turn, and what the extraction recorded.
        const withTools = cardMode === "tools";
        // With tools: the person's words and one line (`roundLine`); the state is read on demand. On a fallback route the round's state
        // still goes as JSON, since that model cannot read it.
        const message = withTools ? roundLine(fresh.map(([id, doc]) => ({ id, fileName: doc.fileName })))
          : JSON.stringify({ ...guideFor(false), ...roundState(), reply: { id: replyId, text: withoutTaps(replyText) },
            ...(fresh.length ? { newSources: clipDocuments(fresh) } : {}), ...(calendarChanged ? { calendar: week } : {}) });
        result = await continueSkillTurn<OnboardingDialogue>(client, session.codexThreadId, message, {
          skillName: ONBOARDING_SKILL, cwd, locale, outputSchema: withTools ? undefined : outputSchema, validateOutput, softAccept, keepEarly,
          ...(withTools ? { tools } : {}),
          onAudit, onProgress, onQueued, timeoutMs: 60 * 60_000
        });
        // A thread the runtime unloaded (idle, or a restart) is resumed from its rollout on disk (`thread/resume`, 2026-11-22), keeping all
        // it reasoned; only one whose rollout is gone is rebuilt from the ledger, which tells a new thread what was said.
        if (!result.ok && result.blocker.code === "SKILL_THREAD_LOST" && withTools) result = await runCodexSkill<OnboardingDialogue>(client, message, {
          skillName: ONBOARDING_SKILL, cwd, developerInstructions: withProfileFramework(INSTRUCTIONS), outputSchema: undefined, keepThread: true, locale,
          secondPerson: SECOND_PERSON, webResearch: true, prepareInput: (value) => value, validateOutput, softAccept, keepEarly, tools,
          resumeThreadId: session.codexThreadId, resumeOnly: true, compactPrompt: COMPACT_PROMPT, onAudit, onProgress, onQueued, timeoutMs: 60 * 60_000 });
        if (!result.ok && result.blocker.code === "SKILL_THREAD_LOST") result = await rebuild();
      }
    } finally { clearInterval(heartbeat); store.deleteSetting(workspaceId, progressKey); activeTurns.delete(activeKey); }
    if (!result.ok) return blocked(result.blocker.code, result.blocker.message, result.blocker.detail);
    // The main interview never ends itself (the owner, 2026-11-12): only the person's 「结束并出报告」 ends it, once the start standard stands
    // (`finishInterview`). A model that is done says so in its reply; the app adds no question of its own to the round (2026-11-14 audit:
    // the start items and a closing question it used to add did not follow from the reply above them). The box stays open.
    const modelDone = !focusLine && result.output.nextAction === "ready_for_milestones";
    if (modelDone) result = { ...result, output: { ...result.output, nextAction: "ask" as const } };
    // The round's items as they stand after the repairs: what still fails its check is left out and told to the model next round (`lastRound`).
    const desk = deskCheck(result.output);
    // Questions the dialogue wants looked into on the web go to research threads of their own, in the background.
    if (research && desk.research.length) research.start(sessionId, desk.research);

    // The checklist and the app's questions are read after the extraction when the round would end a line's own interview (so a fact this
    // reply gave is on record), or always when asked to wait; otherwise from what the ledger held, and what this reply settled joins next round.
    if (extractMode === "await") await extraction.catch(() => undefined);
    // A round that would end a line's own interview waits for the extraction, but not without end (2026-10-19: the last round took ten
    // minutes). The main interview never reaches here as ready: `modelDone` turned it back to asking above.
    const ending = result.output.nextAction === "ready_for_milestones";
    if (extractMode === "await") await caughtUp();
    else if (ending) await caughtUp(FINISH_WAIT_MS);
    // No rating cards are put beside a round any more (2026-11-22): the scale is a whole page before the interview, its readings read
    // through `read_interview_state`.
    // Which project a file that came with this reply belongs to: the app's own bookkeeping question, put beside the round as it wrote it.
    const freshDocs = new Set(sent.map(([, doc]) => doc.id));
    const filing = currentGaps().filter((gap) => gap.code === "FILE_UNFILED" && freshDocs.has(gap.documentId ?? "")
      && !desk.questions.some((question) => question.id === gap.question.id)).map((gap) => gap.question);
    // The lesson question, as the app wrote it, when the dialogue asked for it and may (`lessonRefused`): its answer is read next round.
    const lessonAsked = Boolean(result.output.askLesson) && !lessonRefused(result.output);
    const roundOut = { ...result.output, questions: [...desk.questions, ...filing, ...(lessonAsked ? [LESSON_QUESTION] : [])] };
    // The safety round's reply ends at its help lines (onboarding-reply.ts). The wording rules the app used to apply to the reply and the
    // questions behind the model's back (plain terms, 「还在记录」, a card said twice, 「除了前面讲过的那件」, the closing question after
    // 「没有了」) are the Skill's alone since the 2026-11-14 audit: each rewrite misread someone (「没什么好说的，但我最近很焦虑」 closed the
    // round), and the person's own 「硬约束」 was replaced in what they read.
    const output = { ...roundOut, reply: safetyRound(roundOut) ? safetyReplyOnly(roundOut.reply) : roundOut.reply };
    // What the person will not see of what the model wrote (only what still failed after the repairs), and what the app put beside it.
    const edits: RoundEdits = { removed: desk.problems.map((why) => ({ text: "", why: `not shown: ${why}` })), added: filing.map((question) => question.text) };
    if (edits.removed.length || edits.added.length) store.appendEvent({ ownerId, workspaceId,
      idempotencyKey: `onboarding:round-edited:${sessionId}:${replyId}:${heardAt}`, type: "onboarding.round_edited", entityId: sessionId,
      payload: { replyId, ...edits } });
    for (const fired of firedAfter(result.output, desk)) ruleFired("interview.record", { key: `${sessionId}|${replyId}|${fired.rule}|${fired.detail}`,
      rule: fired.rule, detail: fired.detail, workspaceId, sessionId, replyId });
    // Observation cards that passed their check (`checkInsights`). Under the points rules every card is one hypothesis of the log: one on
    // record by its id, or a new one added to the log here under the reply's number, so 准 / 不准 lands on what it rates. Cards ready together
    // come in one round and are answered one after another (the owner, 2026-11-14). Never beside the safety check.
    const observed: TurnInsight[] = [];
    if (!safetyRound(output)) {
      const profile = readProfile();
      const made: Hypothesis[] = [];
      for (const { card, fresh } of desk.cards) {
        if (!fresh) { observed.push(card); continue; }
        // `c<seq>`, or with a suffix if an id like it is already on record.
        let id = `c${userMessage.seq}`;
        for (let n = 2; profile.hypotheses.some((item) => item.id === id); n += 1) id = `c${userMessage.seq}-${n}`;
        const hypothesis = hypothesisFromCard(card, id, fresh.dimension);
        made.push(hypothesis);
        observed.push({ ...card, hypothesisId: id, dimension: hypothesis.dimension });
      }
      if (made.length) store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile,
        hypotheses: [...profile.hypotheses.filter((item) => !made.some((new_) => new_.id === item.id)), ...made] }));
    }
    const progress = readTurnProgress(result.output.progress);
    const { insights: _raw, progress: _rawProgress, openItems: _items, ...rest } = output;
    const stored = { ...rest, ...(observed.length ? { insight: observed[0]!, ...(observed.length > 1 ? { moreInsights: observed.slice(1) } : {}) } : {}),
      ...(progress ? { progress } : {}) };
    const roundSeq = store.appendOnboardingMessage({ sessionId, workspaceId, role: "assistant", content: stored, createdAt: new Date().toISOString() });
    // The hypothesis a card shows is asked from now on, answered or not: `cardKey` keeps it out of the next observed' candidates.
    if (observed.some((card) => card.hypothesisId)) {
      const profile = readProfile();
      const keys = new Map(observed.map((card, index) => [card.hypothesisId ?? "", insightKey(sessionId, roundSeq, index)]));
      store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile,
        hypotheses: profile.hypotheses.map((item) => (keys.has(item.id) && !item.cardKey ? { ...item, cardKey: keys.get(item.id)! } : item)) }));
    }
    // The ledger, written before the next round reads it (2026-11-25): the round's card questions and the questions its reply asked, each
    // with its meaning, and the model's checklist verdicts. The next snapshot is rendered from these, never from the thread.
    const recordedAt = new Date().toISOString();
    const cardIds = recordRound(store, workspaceId, sessionId, roundSeq, output.questions, recordedAt);
    const askedIds = recordAsked(store, workspaceId, sessionId, roundSeq, desk.asked, recordedAt);
    const newGists = [...cardIds.map((id, index) => [id, (output.questions[index] as TurnQuestion | undefined)?.gist ?? ""] as const),
      ...askedIds.map((id, index) => [id, desk.asked[index]!.gist] as const)].filter(([, gist]) => gist.trim());
    // A file the model opened itself this turn (`read_file`, `read_folder_file`) counts as shown: the next turn does not announce it as
    // new. One it had not been shown yet goes to the extraction as a shown file would (the next extraction run takes it).
    // Shown files are kept by their reference (`src-N`); a folder file read on demand got its row during the turn, so it is looked up now.
    const sentIds = new Set(sent.map(([id]) => id));
    const openedNew = [...sourceIds(store.listSourceDocuments(workspaceId))].filter(([ref, doc]) => readTools.opened.has(doc.id) && !announcedNow.has(ref) && !sentIds.has(ref));
    if (openedNew.length) queueExtractDocs(store, workspaceId, openedNew.map(([, doc]) => doc.id).filter((id) => !(extracted[id]! > 0)));
    // Saved over the session as it is now, so a stage the extraction never writes is not lost to the copy read at the start.
    const current = store.getOnboardingSession(workspaceId, sessionId) ?? session;
    store.saveOnboardingSession({
      ...current, ...(threadId ? { codexThreadId: threadId } : {}),
      state: output.nextAction === "ready_for_milestones" ? "complete" : "active",
      coverage: { ...current.coverage, coverage: output.coverage, ...(output.stage ? { stage: output.stage } : {}), ...(progress ? { progress } : {}),
        announcedSources: [...announcedNow, ...sentIds, ...openedNew.map(([ref]) => ref)], heardAt, ...(week.length ? { calendarSent: weekSent } : {}), lastRound: edits,
        ...(cardMode ? { cardTools: cardMode } : {}), ...(startMetRound !== null ? { startMetRound } : {}),
        ...(hidden.size ? { redacted: [...hidden] } : {}), ...(lessonAsked ? { lesson: "asked" as const } : lesson !== "unasked" ? { lesson } : {}),
        ...(guideNow ? { guide: stageNow } : {}),
        ...(newGists.length ? { gists: { ...(current.coverage as Announced).gists, ...Object.fromEntries(newGists.map(([id, gist]) => [String(id), gist.trim()])) } } : {}),
        ...(desk.checklist.length ? { checklist: { ...(current.coverage as Announced).checklist,
          ...Object.fromEntries(desk.checklist.map((verdict) => [verdict.id, { ...verdict, round: roundSeq, at: recordedAt }])) } } : {}) },
      updatedAt: new Date().toISOString()
    });
    return { state: output.nextAction === "ready_for_milestones" ? "ready" : "asked", sessionId };
  }
}

/** The turn running now per interview (`<workspace>:<session>`), while it runs on a route with tools: what 「插入本轮」 steers. */
const activeTurns = new Map<string, { client: CodexRpcBoundary; threadId: string; turnId: string }>();
/** Where the person's queued messages wait (D17): the worker's own queue, taken whole when the running round ends. */
export const interviewQueueKey = (sessionId: string) => `onboarding.queue:${sessionId}`;
export function readQueued(store: CrosslineStore, workspaceId: string, sessionId: string): Array<{ text: string; at: string }> {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, interviewQueueKey(sessionId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is { text: string; at: string } => typeof item?.text === "string") : [];
  } catch { return []; }
}
/** Queues the person's message for the round after the running one (`createOnboardingSessionRunner` takes it). */
export function enqueueInterview(store: CrosslineStore, workspaceId: string, sessionId: string, text: string): { state: "queued"; sessionId: string; queued: number } {
  const queued = [...readQueued(store, workspaceId, sessionId), { text: text.trim().slice(0, 16_000), at: new Date().toISOString() }];
  store.setSetting(workspaceId, interviewQueueKey(sessionId), JSON.stringify(queued));
  return { state: "queued", sessionId, queued: queued.length };
}
/** Every queued message, joined in the order they came, and the queue emptied; "" when none waits. */
function takeQueued(store: CrosslineStore, workspaceId: string, sessionId: string): string {
  const queued = readQueued(store, workspaceId, sessionId);
  if (!queued.length) return "";
  store.deleteSetting(workspaceId, interviewQueueKey(sessionId));
  return queued.map((item) => item.text).filter(Boolean).join("\n\n");
}
/** A queue taken for a round that then stopped goes back in front, so nothing the person wrote is lost. */
function putBack(store: CrosslineStore, workspaceId: string, sessionId: string, text: string): void {
  const rest = readQueued(store, workspaceId, sessionId);
  store.setSetting(workspaceId, interviewQueueKey(sessionId), JSON.stringify([{ text, at: new Date().toISOString() }, ...rest]));
}

/**
 * The person's message put into the round that is running (D17, 2026-11-22: 「插入本轮」, Codex `turn/steer` with the running turn's id).
 * Saved in the conversation as their message, so the extraction reads it and the page shows it where it was said. Only a round on a
 * route with tools can be steered (one bound to an output schema cannot); otherwise, or when the round ended meanwhile, it is queued.
 */
export async function steerInterview(store: CrosslineStore, workspaceId: string, sessionId: string, text: string):
  Promise<{ state: "steered"; sessionId: string } | { state: "queued"; sessionId: string; queued: number }> {
  const said = text.trim().slice(0, 16_000);
  const active = activeTurns.get(`${workspaceId}:${sessionId}`);
  if (said && active && await steerTurn(active.client, active.threadId, active.turnId, said)) {
    store.appendOnboardingMessage({ sessionId, workspaceId, role: "user", content: { text: said, steered: true }, createdAt: new Date().toISOString() });
    return { state: "steered", sessionId };
  }
  return enqueueInterview(store, workspaceId, sessionId, said);
}

/**
 * The conversation as plain lines, for a thread that has to be rebuilt. Questions are kept; option lists are not. The whole conversation,
 * uncut (2026-11-12: it was the last 24 messages of at most 4,000 characters each); the runtime compacts the thread when it nears the
 * model's window, and the ledger keeps every message for the extraction's `search_evidence`.
 */
/* i18n-ignore-start: the rebuilt history the model reads */
export function conversationSoFar(messages: StoredOnboardingMessage[]): NonNullable<OnboardingTurnContext["history"]> {
  return messages.map((message) => {
    if (message.role === "user") return { id: `reply-${message.seq}`, role: "user" as const,
      text: String((message.content as { text?: string }).text ?? "") };
    // Each round as the person saw it (P3, docs/onboarding-agent-session.md 「重建」): the questions with their options, and the observation
    // cards with the hypothesis each asked, so a rebuilt thread neither asks a card again nor loses what the person was choosing between.
    const turn = message.content as { reply?: string; questions?: Array<{ id?: string; text?: string; options?: Array<{ label?: string }> }>;
      insight?: { text?: string; hypothesisId?: string }; moreInsights?: Array<{ text?: string; hypothesisId?: string }> };
    const cards = [turn.insight, ...(turn.moreInsights ?? [])].filter((card): card is { text: string; hypothesisId?: string } => Boolean(card?.text));
    return { id: `assistant-${message.seq}`, role: "assistant" as const,
      text: [turn.reply ?? "",
        ...(turn.questions ?? []).map((question) => {
          const labels = (question.options ?? []).map((option) => option.label ?? "").filter(Boolean);
          return `【问${question.id ? ` ${question.id}` : ""}】${question.text ?? ""}${labels.length ? `（选项：${labels.join(" / ")}）` : ""}`;
        }),
        ...cards.map((card) => `【观察卡${card.hypothesisId ? ` ${card.hypothesisId}` : ""}】${card.text}`)].filter(Boolean).join("\n") };
  });
}

/**
 * What the runtime's local compaction keeps of the interview's thread (`compact_prompt`, 2026-11-22). The ledger is the record of fact
 * (a remote compaction ignores this prompt), so the summary keeps the person's words and the material's own words with where they are
 * on record, never a paraphrase in their place.
 */
export const COMPACT_PROMPT = "把这段访谈压缩成交接记录，给接着访谈的你自己看。必须保留："
  + "（1）本人每条回复里的事实、有分量的说法和情绪，带回复编号（reply-N），关键的话逐字照抄；"
  + "（2）读过的材料里用到的原话，逐字照抄，并写明出处（文件名和文件编号，或账本里的位置），以后用 read_file、read_ledger 按出处找回全文；"
  + "（3）出过的每张观察卡：假设 id、一句话内容、本人的评价和更正；"
  + "（4）已经命名过的模式、点出过的漏洞、问过而本人还没答的题、你答应过要回来问的事；"
  + "（5）本人拒绝或说不想谈的话题（整场不再问）；"
  + "（6）交给后台调研的问题，和当场核实过的信念（本人的认知、判定、数据与链接）；"
  + "（7）你正在追的假设、访谈走到哪一部分、下一步想问什么。"
  + "开始标准、问题记录、调研线程的现状和账本里的事实可以只写指针：需要时用 read_interview_state、read_ledger 读。";
/* i18n-ignore-end */

/**
 * A reply without its sentences pointing at the end button, for a round before the start standard stands: pressed then, the button is
 * refused (2026-11-12 replay 3: 「按页面上的「结束并出报告」就会出报告」 in seven rounds while her fixed schedule was still open). A claim
 * that the app can be used now goes too (replay 4: 「你可以开始使用应用了」 seven rounds before the start standard stood).
 */
const END_HINT = /结束并出报告|End and write the report|可以开始(使用|用)|start using/iu; // i18n-ignore: the button's label and the start claim in both languages
export const endHinted = (reply: string): boolean => END_HINT.test(reply);

/** A card's tap line (`scaleAnswerLine`, 「【题】点选：5/5（…）」) as the dialogue reads it: the score is the readings' to say (2026-11-15). */
const TAP_LINE = /^(\s*【[^】\n]+】)点选：[1-5]\/5(?:（[^）\n]*）)?/gmu; // i18n-ignore: the tap line's own form
export const withoutTaps = (text: string): string => text.replace(TAP_LINE, "$1已点选（读数见 scaleReadings）"); // i18n-ignore: model-facing
/** A card's answer in the app's own notation (「【题】已点选」) copied into the reply: the person never wrote it (2026-11-23, W-315). */
export const CARD_NOTATION = /\[?【[^】\n]{1,40}】(?:已)?点选[^\n。！？\]]*\]?/gu; // i18n-ignore: the app's notation
/** A reply saying a question is still waiting for the person (2026-11-22/23, W-307, W-314: it had never been asked). */
export const PENDING_TALK = /还没答|还没回答|还在等你|上面那一?问|刚才那一?问|那一问还/u; // i18n-ignore: matched against the model's words
/** The scale talked about in its own numbers or the cards' words, which the dialogue reads off taps and gets wrong (replay 15). */
export const SCORE_TALK = /(?<![\d/])[1-5]\s*\/\s*5(?![\d/])|\d{1,3}\s*\/\s*100|自评|最重那一档/u; // i18n-ignore: matched against the model's words

/** A session id the browser can mint for itself before the first turn. */

/**
 * The person's 「结束并出报告」 (the owner, 2026-11-12): the interview is marked complete, the extraction finishes every section from what was
 * said, and `complete` resolves once it has, so the caller writes the portrait. No time limit (the owner, 2026-11-22, W-313: quality
 * first, make it fast instead): the 8-minute budget wrote the report from a half-finished record; the extraction's runs go as turns now
 * (`priority: "interactive"` while finishing). The start standard (the lower bound) is checked by the web route before it calls this; the
 * interview can be taken up again afterwards, and a new report written.
 */
export function finishInterview(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined, sessionId: string,
  /** `extract: false` leaves the extraction alone (tests of the ending itself); `lanes: false` finishes with single runs. */
  options: { extract?: boolean; lanes?: boolean } = {}):
  { outcome: { state: "finished"; sessionId: string } | { state: "blocked"; code: string; message: string }; complete: Promise<void> } {
  const session = store.getOnboardingSession(workspaceId, sessionId);
  if (!session) return { outcome: { state: "blocked", code: "ONBOARDING_SESSION_UNKNOWN", message: tFor(localeOf(store, workspaceId))("找不到这次访谈。") },
    complete: Promise.resolve() };
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
  if (options.extract === false) return { outcome: { state: "finished", sessionId }, complete: Promise.resolve() };
  const complete = (async () => {
    // Every reply recorded first (the ledger, then the inferences and the sections, side by side), then the finishing run that writes the
    // synthesis (as a round that ended the interview used to): the sections' lane, with lanes.
    if (lastReply !== undefined) {
      await extractionReached(store, workspaceId, sessionId, lastReply, ask).catch(() => false);
      if (lanes) await Promise.all((["insights", "sections"] as const).map((which) =>
        extractionReached(store, workspaceId, sessionId, lastReply, lane(which), Number.POSITIVE_INFINITY, which).catch(() => false)));
    }
    await (lanes ? lane("sections")() : ask()).catch(() => undefined);
  })();
  return { outcome: { state: "finished", sessionId }, complete };
}

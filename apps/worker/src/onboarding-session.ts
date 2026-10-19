import {
  AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary,
  PROFILE_CONFIRMED, portraitFingerprint, answeredGapFacts, keepOnboardingDialogue, droppedOnboardingItems, ONBOARDING_KEEP_EARLY_MAX, onboardingDialogueSchema,
  validateOnboardingDialogue, locateQuote,
  gapCoveredBy, screenQuestions, screenAssumption,
  type ProfileGap, type ProfileModel, type OnboardingStage, DEEP_STAGES, ONBOARDING_TONE_SETTING, ASSESS_RESULT_SETTING, TYPE_TABLE, readTone,
  type KnownSources, type OnboardingDialogue, type OnboardingTurnContext, ONBOARDING_PROGRESS_SETTING, readPartialTurn, type OnboardingProgress, calendarWeek
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary, type SkillProgress } from "@crossline/codex";
import {
  EXTRACT_REREAD_SETTING, firstSentenceOf, interviewChecklistFor, interviewGapsFor, queueExtractDocs, questionScreenFor, readExtractDocs, unfiledFilesIn,
  type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument
} from "@crossline/db";
import { sourceIds } from "./source-ids";
import { identityLines } from "./lines";
import { ledgerForModel, recordReplyAnswers, recordRound, resolveRepeats, syncGapQuestions } from "./question-ledger";
import { createOnboardingExtractor, extractionReached, requestExtraction } from "./onboarding-extract";
import { personTimeZone, readProfileModel } from "./onboarding-persist";

export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

/** Each document is cut to this much text per turn. */
const SOURCE_TEXT_PER_DOCUMENT = 14_000;
const SOURCE_TEXT_TOTAL = 60_000;
/** New files one turn reads at most; more wait for the next turn. */
const SOURCES_PER_TURN = 12;
/** How long a round with a blocking app question waits for the extraction of the reply it may answer. */
const BLOCKING_WAIT_MS = 30_000;
/** Facts the extraction recorded since the last turn, at most this many lines in `recorded`. */
const RECORDED_SHOWN = 40;

const INSTRUCTIONS = "You interview a Crossline user as the Skill describes: a life designer's interview in stages (orientation, "
  + "lines, situation, compass, energy, details), never proposing milestones. You write only the conversation: `reply`, `questions`, "
  + "`coverage`, `nextAction` and `stage`; another run records facts, dates, attributes, hours and the portrait from the same replies and "
  + "files (`recorded` says what it has written since your last turn). The first two stages gather the start standard: checklist "
  + "items marked `start` must be answered by the person or read from a file, never assumed; while one is open stay in the "
  + "current stage and keep asking, and once all are in say in `reply` that the person can start using the app while the interview goes "
  + "on here. The person already set their lines (`lines`: identity "
  + "nouns, their order, which are hard constraints); do not propose new ones. Each turn: one to three plain sentences on what was just said "
  + "in the person's chosen `tone`, addressing them as 「你」: what you took from it in their own concrete terms and, if two things they said "
  + "pull against each other, those two facts side by side (no reinterpretation, no 'the real problem is'; never judge a choice or decide "
  + "for the person). Plain voice in reply, questions and options: no dashes as connectors, no 不是……而是/与其……不如/真正的……是 frames, "
  + "no metaphors, no 先别/算清/理清 formulas, no summing-up line. In orientation, lines and details follow it with a batch of up to five fact questions that "
  + "do not depend on each other; in situation, compass and energy with two to four questions that do not need each other's answers "
  + "(usually more than one: the stage has several sides to ask about), most important first, keeping only a follow-up that builds on "
  + "another answer for the next round; follow a "
  + "thread that carries a clue before returning to the stage. Ask about the hard-constraint lines' rules first (fixed schedule, terms, "
  + "deadlines). Every single/multi question has concrete candidate options (8-14 when the "
  + "space is large) and allows the person's own answer. When the person answers 不确定 or skips, do not ask it again (the other run writes "
  + "an assumption); start items are the exception, asked once more with concrete options. Once a line has attribute candidates (`lines`), do "
  + "not ask its long-term goal: the person picks it beside the conversation. When `focusLine` is set, interview only that line (stage "
  + "`details`). Never ask which course or project a file belongs to (the app asks that itself). When `history` is present the conversation "
  + "is being resumed: continue it, do not greet again or re-ask what is answered. `questionLedger` lists what was already asked, numbered "
  + "(「#12 [已答] …」; 待问 = the app will ask it unless you do): never ask an answered question again; when a question of yours asks one "
  + "of these, put its number in `repeats`, otherwise 0. `identityId`/`projectId` are picked from the ids offered. All human-readable fields in Chinese.";

export type OnboardingTurnOutcome =
  | { state: "asked" | "ready"; sessionId: string }
  | { state: "blocked"; sessionId: string; code: string; message: string };

/** What the dialogue's thread has been shown: the files, the calendar week, and when it last heard what the extraction recorded. */
type Announced = { announcedSources?: string[]; calendarSent?: string; heardAt?: string };

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
  const extractMode = options.extract ?? "background";
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
  const openChecklist = () => checklistNow().filter((item) => !item.done).map(({ label, detail, owner, start }) => ({ label, detail, owner, ...(start ? { start } : {}) }));
  /** Whether a start item is still open: then the front stages do not move on. */
  const startOpen = () => checklistNow().some((item) => item.start && !item.done);

  /** The person's coding-agent hours, time only, when they allowed it (Settings → 隐私). */
  const workHistory = () => {
    try { return agentHistoryLines(JSON.parse(store.getSetting(workspaceId, AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null); } catch { return []; }
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
    const blocked = (code: string, message: string): OnboardingTurnOutcome => ({ state: "blocked", sessionId, code, message });
    if (!client) return blocked("CODEX_SUPERVISOR_UNAVAILABLE", "Codex 运行时不可用。");
    const text = input.text.trim().slice(0, 4000);
    const ownerId = store.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return blocked("WORKSPACE_OWNER_MISSING", "找不到这个工作区的所有者。");

    const now = new Date().toISOString();
    let session = store.getOnboardingSession(workspaceId, sessionId);
    if (!session) {
      session = { id: sessionId, ownerId, workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now };
      store.saveOnboardingSession(session);
    }
    let messages = store.listOnboardingMessages(workspaceId, sessionId);
    // A retry after a failed turn resends nothing: the person's message is already saved and still waiting.
    const last = messages.at(-1);
    const retrying = last?.role === "user" && (!text || String((last.content as { text?: string }).text ?? "") === text);
    if (!retrying) {
      if (!text) return blocked("ONBOARDING_MESSAGE_EMPTY", "请先写点什么，或选一个选项。");
      store.appendOnboardingMessage({ sessionId, workspaceId, role: "user", content: { text }, createdAt: now });
      messages = store.listOnboardingMessages(workspaceId, sessionId);
    }
    const userMessage = messages.at(-1)!;
    const replyId = `reply-${userMessage.seq}`;
    const replyText = String((userMessage.content as { text?: string }).text ?? "");
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
    const unread = [...docs].filter(([id, doc]) => doc.extractionStatus === "done" && !announced.has(id));
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
            note: "本人在公开测评（32 题自评）中的结果，由本人确认带入；只作佐证，画像四个维度仍按访谈证据评分，不照抄" } : undefined;
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
        focusLine, profile: readProfile(), stage: ((session!.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : "orientation")),
        checklist: openChecklist(), ...stagePace(messages, { startOpen: startOpen() }), tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)),
        questionLedger: ledgerForModel(store, workspaceId, sessionId),
        ...(workHistory().length ? { workHistory: workHistory() } : {}), ...(week.length ? { calendar: week } : {}),
        ...(publicAssessment ? { publicAssessment } : {}),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [],
          ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}) }))
      };
      return runCodexSkill<OnboardingDialogue>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema, keepThread: true,
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
        const pace = stagePace(messages, { startOpen: startOpen() });
        const message = JSON.stringify({ reply: { id: replyId, text: replyText }, ...(newSources.length ? { newSources } : {}), checklist: openChecklist(), ...pace,
          questionLedger: ledgerForModel(store, workspaceId, sessionId), ...(recorded.lines.length ? { recorded: recorded.lines } : {}),
          tone: readTone(store.getSetting(workspaceId, ONBOARDING_TONE_SETTING)), ...(calendarChanged ? { calendar: week } : {}),
          ...(publicAssessment ? { publicAssessment } : {}), ...(waiting > 0 ? { sourcesWaiting: waiting } : {}) });
        result = await continueSkillTurn<OnboardingDialogue>(client, session.codexThreadId, message, {
          skillName: ONBOARDING_SKILL, cwd, outputSchema, validateOutput, softAccept, keepEarly,
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
    if (!result.ok) return blocked(result.blocker.code, result.blocker.message);

    // The checklist and the app's questions are read after the extraction when the round would end the interview (so a fact this reply
    // gave is on record), or always when asked to wait; otherwise from what the ledger held, and what this reply settled joins next round.
    if (extractMode === "await") await extraction.catch(() => undefined);
    if (extractMode === "await" || result.output.nextAction === "ready_for_milestones") await caughtUp();
    // An app question that blocks is asked every round until answered: when this reply may have answered it in prose, the round waits a
    // little for the extraction, so it is not asked again right under the answer.
    else if (currentGaps().some((gap) => gap.blocking)) await caughtUp(BLOCKING_WAIT_MS);
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
    const gapsNow = currentGaps().filter((gap) => !repeated.coveredGaps.has(gap.question.id));
    const paced = paceDeepRound({ ...result.output, questions: repeated.questions }, Boolean(focusLine));
    const touched = { lines: recorded.identities, projects: recorded.projects, portrait: Boolean(readProfile().portrait) };
    const output = withSomethingToAnswer(withChecklist(paced.deep ? paced.output
      : withGapQuestions(paced.output, gapsNow, messages, { freshDocuments: sent.map(([, doc]) => doc.id), touched }),
      focusLine || options.checklist === false ? [] : openChecklist()), gapsNow, messages);
    const roundSeq = store.appendOnboardingMessage({ sessionId, workspaceId, role: "assistant", content: output, createdAt: new Date().toISOString() });
    recordRound(store, workspaceId, sessionId, roundSeq, output.questions, new Date().toISOString());
    // Saved over the session as it is now, so a stage the extraction never writes is not lost to the copy read at the start.
    const current = store.getOnboardingSession(workspaceId, sessionId) ?? session;
    store.saveOnboardingSession({
      ...current, ...(threadId ? { codexThreadId: threadId } : {}),
      state: output.nextAction === "ready_for_milestones" ? "complete" : "active",
      coverage: { ...current.coverage, coverage: output.coverage, ...(output.stage ? { stage: output.stage } : {}),
        announcedSources: [...announcedNow, ...sent.map(([id]) => id)], heardAt, ...(week.length ? { calendarSent: weekSent } : {}) },
      updatedAt: new Date().toISOString()
    });
    return { state: output.nextAction === "ready_for_milestones" ? "ready" : "asked", sessionId };
  };
}

/**
 * The interview may not call itself finished while an item of the completion list that more questions can settle is open
 * (`interviewChecklist`): a premature 「ready」 goes back to asking, says what is missing, and — when the model asked nothing — asks for it.
 * Items only the person can settle (confirming the portrait, adopting a goal) do not hold the interview; they show on the screen.
 */
export function withChecklist<T extends OnboardingDialogue>(output: T, open: Array<{ label: string; detail: string; owner: "interview" | "person" }>): T {
  const owed = open.filter((item) => item.owner === "interview");
  if (output.nextAction !== "ready_for_milestones" || !owed.length) return output;
  const missing = owed.slice(0, 6).map((item) => `${item.label}${item.detail ? `（${item.detail}）` : ""}`).join("；");
  return { ...output, nextAction: "ask", reply: `${output.reply}

完成访谈前还缺：${missing}。`,
    questions: output.questions.length ? output.questions
      : [{ id: "checklist-open", text: `完成访谈前还缺：${missing}。请补充。`, kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] };
}

/** What a round that still asks but holds no question asks, by stage: open, in the interview's own voice. */
const OPEN_QUESTION: Record<OnboardingStage, string> = {
  orientation: "还有哪条主线、哪份材料没提到？",
  lines: "哪条主线你最想先说清楚：现在在做什么、想做成什么样？",
  situation: "说说你现在的处境：这几周最占你精力、最让你担心的是什么？",
  compass: "做这些事，你最终想得到什么？",
  energy: "一天里什么时候状态最好，什么事最耗你？",
  details: "还有哪个项目的截止日、交付物或验收方式没说清楚？"
};

/**
 * A round that still asks always has something to answer. The model's questions can all be screened out (already on record, not the
 * person's to answer), and in a deep stage the app's own questions used to wait for a fact round: the hosted walkthrough of 2026-10-16 met
 * a round with a reply and an empty box the moment the start standard stood. Then the app's waiting questions join, else one open question
 * for the stage.
 */
export function withSomethingToAnswer<T extends OnboardingDialogue>(output: T, gaps: ProfileGap[], messages: StoredOnboardingMessage[]): T {
  if (output.nextAction !== "ask" || output.questions.length) return output;
  const withGaps = withGapQuestions(output, gaps, messages);
  if (withGaps.questions.length) return withGaps;
  const stage = (output.stage && output.stage in OPEN_QUESTION ? output.stage : "situation") as OnboardingStage;
  return { ...output, questions: [{ id: `open-${stage}`, text: OPEN_QUESTION[stage], kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] };
}

/** Besides those that block, at most this many of the app's own questions join one round, so a batch stays answerable. */
export const GAPS_PER_ROUND = 3;

/** At most this many of the model's own questions in one round of a deep stage. */
export const DEEP_QUESTIONS_PER_ROUND = 4;

/**
 * Pacing in the deep stages — the situation, motive and vision, energy (docs/onboarding-v3.md). Decided 2026-10-14 as one question a
 * round; changed by the owner on 2026-10-16: questions that do not depend on each other's answers are asked together (at most four), and
 * only a question that builds on another's answer waits for a later round — which the model is told to judge. The app's own fact
 * questions still wait for a fact round (the screen lists them beside the conversation meanwhile), so a deep round stays about depth.
 */
export function paceDeepRound<T extends OnboardingDialogue>(output: T, focus: boolean): { output: T; deep: boolean } {
  const deep = !focus && DEEP_STAGES.has(output.stage as OnboardingStage) && output.nextAction === "ask";
  return { deep, output: deep ? { ...output, questions: output.questions.slice(0, DEEP_QUESTIONS_PER_ROUND) } : output };
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
  } = {}): T {
  const asked = new Set(messages.flatMap((message) => message.role === "assistant"
    ? ((message.content as { questions?: Array<{ id: string }> }).questions ?? []).map((question) => question.id) : []));
  const open = gaps.filter((gap) => {
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
  const added = [...blockingGaps, ...(near.length ? near : rest.slice(0, 1)).slice(0, GAPS_PER_ROUND)];
  const blocking = gaps.some((gap) => gap.blocking);
  if (!added.length && !(blocking && output.nextAction === "ready_for_milestones")) return output;
  return {
    ...output,
    questions: [...output.questions, ...added.map((gap) => gap.question)],
    nextAction: blocking ? "ask" : output.nextAction,
    ...(blocking && output.nextAction === "ready_for_milestones"
      ? { reply: `${output.reply}

设计里程碑前尚缺以下信息：分数线均由目标倒推，目标需本人确认。` } : {})
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
  return { stageRounds: rounds, moveOn: `「${current}」阶段已问 ${rounds} 轮：本轮进入下一阶段。` };
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

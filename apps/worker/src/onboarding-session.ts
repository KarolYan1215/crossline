import { randomUUID } from "node:crypto";
import {
  AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary,
  EMPTY_PROFILE_MODEL, GOAL_EDITS_SETTING, ONBOARDING_TURN_SCHEMA, duplicateAttributes, type PendingGoalEdit, type StoredLineProfile, PROFILE_CONFIRMED, portraitFingerprint, answeredGapFacts, keepOnboardingTurn, mergeFacts, sanitizeDateExtraction, validateOnboardingTurn,
  gapCoveredBy, mergeDateExtractions, withoutOffHours, resolveAvailability, AVAILABILITY_SETTING, AVAILABILITY_PROPOSED_SETTING, type DateExtraction,
  type ProfileGap, type ProfileModel, type OnboardingStage,
  type KnownSources, type OnboardingTurn, type OnboardingTurnContext
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { interviewChecklistFor, interviewGapsFor, unfiledFilesIn, type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument } from "@crossline/db";
import { sourceIds } from "./source-ids";
import { identityLines } from "./lines";

export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

/** Each document is cut to this much text per turn; the full text stays in the ledger for citation checks. */
const SOURCE_TEXT_PER_DOCUMENT = 14_000;
const SOURCE_TEXT_TOTAL = 60_000;

const INSTRUCTIONS = "You interview a Crossline user as the Skill describes: a life designer's interview in stages (orientation, "
  + "lines, situation, compass, energy, details), never proposing milestones. The first two stages gather the start standard: checklist "
  + "items marked `start` must be answered by the person or read from a file, never written as 「假设：」; while one is open stay in the "
  + "current stage and keep asking, and once all are in say in `reply` that the person can start using the app while the interview goes "
  + "on here. The person already set their lines (`lines`: identity "
  + "nouns, their order, which are hard constraints); do not propose new ones. Each turn: a short, sharp reflection on what was just said "
  + "(name a contradiction, a self-imposed limit, or gravity mistaken for a problem; never judge a choice or decide for the person), then a "
  + "batch of up to five questions that do not depend on each other — one whose answer depends on another's waits for the next turn; follow "
  + "a thread that carries a clue before returning to the stage. Ask about the hard-constraint lines' rules first (fixed schedule, terms, "
  + "deadlines), put every fixed weekly arrangement the person states into `fileDates.recurring` quoting their reply, and as soon as the "
  + "person has said when they can work (or a stage has enough to infer it) propose weekly available hours in `availability` — do not wait "
  + "for every fixed arrangement: classes and meetings are subtracted from these hours automatically. Every single/multi question has concrete candidate options (8-14 when the "
  + "space is large) and allows the person's own answer. Rewrite `profile` in full every turn (your synthesis). In the lines stage write "
  + "each line's personal description and 6-12 attribute candidates for its long-term goal in `lineProfiles[].attributeCandidates` — never "
  + "whole sentences: each one independent quality (a field, an ability or a lasting state, labelled `kind` domain/ability/state), a short "
  + "phrase without 「成为」 or a trailing 「的」, cited by `sourceRef` to the reply-N or src-N it comes from, and no two overlapping (after removing "
  + "「的」 and punctuation neither may contain the other); the person combines them into 「成为 A 的、B 的<身份>」 themselves. Leave the list empty "
  + "while a line is still thin and ask more. When the person asks in so many words to change a line's goal (「把目标改成…」), put the new "
  + "attributes in `goalEdits` citing that reply — it is shown to them to adopt, never applied by you; otherwise `goalEdits` is empty. "
  + "Facts about the person in general use identityId \"person\". When `focusLine` is "
  + "set, interview only that line (stage `details`) and refresh its `lineProfiles` entry whenever what was said changes its description "
  + "or attributes. Every confirmed slotUpdate cites a reply-N or src-N with a verbatim sourceQuote; your "
  + "own conclusions are sourceRef 'inference', status 'inferred', empty quote. Never invent dates, numbers or names. Files that arrive "
  + "are for you to read: every date they state goes into `fileDates`, each with a verbatim quote containing the day and a title that names its course or project (「ECE 555 期末考试」, never a bare 「期末考试」); never ask which course or project a file belongs to (the app asks that itself; a settled file carries its projectId); never turn TBD into "
  + "a date (list it in `undated`). When `history` is present the conversation is being resumed: continue it, do not greet again or re-ask "
  + "what is answered. All human-readable fields in Chinese.";

export type OnboardingTurnOutcome =
  | { state: "asked" | "ready"; sessionId: string }
  | { state: "blocked"; sessionId: string; code: string; message: string };

type Announced = { announcedSources?: string[] };

export function createOnboardingSessionRunner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, options: {
    /** Hold a premature 「ready」 to the completion list (on in the app; tests of other behaviour turn it off). */
    checklist?: boolean;
  } = {}) {
  const identities = () => identityLines(store, workspaceId)
    .map((pack) => ({ id: pack.id, label: pack.label }));

  /** Everything a quote can be checked against, rebuilt from the ledger on every turn. */
  function knownSources(messages: StoredOnboardingMessage[], docs: Map<string, StoredSourceDocument>): KnownSources {
    return {
      identities: identities().map((item) => item.id),
      projectIds: store.listProjects(workspaceId, { includeArchived: true }).map((project) => project.id),
      replies: Object.fromEntries(messages.filter((message) => message.role === "user")
        .map((message) => [`reply-${message.seq}`, String((message.content as { text?: string }).text ?? "")])),
      sources: Object.fromEntries([...docs].filter(([, doc]) => doc.extractionStatus === "done")
        .map(([id, doc]) => [id, doc.extractedText]))
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

  const clipDocuments = (entries: Array<[string, StoredSourceDocument]>) => {
    let budget = SOURCE_TEXT_TOTAL;
    return entries.map(([id, doc]) => {
      const text = doc.extractedText.slice(0, Math.min(SOURCE_TEXT_PER_DOCUMENT, budget));
      budget -= text.length;
      return { id, fileName: doc.fileName, kind: doc.kind, projectId: doc.projectId ?? "", text };
    });
  };

  /** The portrait so far (`profile.model`) and the report (`profile.blueprint`), kept in settings so every page and a rebuilt thread read the same. */
  const readProfile = (): ProfileModel => {
    try { return { ...EMPTY_PROFILE_MODEL, ...(JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "{}") as Partial<ProfileModel>) }; }
    catch { return EMPTY_PROFILE_MODEL; }
  };

  /** Writes what a validated turn learned. Facts the person already confirmed are protected by the store. */
  function persistTurn(turn: OnboardingTurn, sessionId: string, ownerId: string): void {
    const now = new Date().toISOString();
    // A line's own interview adds to the facts but does not rewrite the person's whole portrait.
    if (!sessionId.startsWith("line-") && turn.profile) store.setSetting(workspaceId, "profile.model", JSON.stringify(turn.profile));
    // Each line's personal description and attribute candidates, kept by line so a later turn or a line's own interview refines one line
    // only. An empty candidate list keeps those on record; new ones replace them, except the attributes split from the adopted goal.
    if (turn.lineProfiles?.length) {
      let current: Record<string, StoredLineProfile> = {};
      try { current = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, StoredLineProfile>; } catch { /* rebuilt below */ }
      for (const line of turn.lineProfiles) {
        const previous = current[line.lineId] ?? {};
        const fresh = line.attributeCandidates ?? [];
        const fromGoal = (previous.attributes ?? []).filter((item) => item.sourceRef === "goal"
          && !duplicateAttributes([...fresh.map((other) => other.text), item.text]).some((pair) => pair.includes(item.text)));
        current[line.lineId] = fresh.length
          ? { description: line.description || previous.description || "", attributes: [...fresh, ...fromGoal] }
          : { ...previous, description: line.description || previous.description || "" };
      }
      store.setSetting(workspaceId, "lines.profiles", JSON.stringify(current));
    }
    // A goal change the person asked for waits for their click on the line's card; a newer request for the same line replaces it.
    if (turn.goalEdits?.length) {
      let edits: Record<string, PendingGoalEdit> = {};
      try { edits = JSON.parse(store.getSetting(workspaceId, GOAL_EDITS_SETTING) ?? "{}") as Record<string, PendingGoalEdit>; } catch { /* rebuilt below */ }
      // In the order the person said them: a change they worded themselves is not reordered.
      for (const edit of turn.goalEdits) edits[edit.lineId] = { parts: edit.parts.map((part) => part.text), sourceRef: edit.sourceRef, at: now };
      store.setSetting(workspaceId, GOAL_EDITS_SETTING, JSON.stringify(edits));
    }
    // Available hours worked out from a hard-constraint line's rules: a proposal, confirmed (or not) on the plan page.
    if (turn.availability?.windows.length) store.setSetting(workspaceId, "schedule.availability.proposed",
      JSON.stringify({ ...turn.availability, at: now }));
    for (const project of turn.projectsDetected) {
      const existing = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === project.id);
      store.saveProject({ id: project.id, ownerId, workspaceId, identityId: project.identityId, name: project.name,
        status: existing?.status ?? "active", summary: project.summary || existing?.summary || "",
        createdAt: existing?.createdAt ?? now, updatedAt: now });
    }
    for (const update of turn.slotUpdates) {
      store.upsertProfileFact({ workspaceId, identityId: update.identityId, projectId: update.projectId, slot: update.slot,
        value: update.value, status: update.status, sourceRef: update.sourceRef, sourceQuote: update.sourceQuote, updatedAt: now });
    }
    // A connection between lines is a guess until the person confirms it, so it is kept as an inferred fact
    // keyed by its two ends and kind, not as a milestone relation (there may not be milestones yet).
    for (const candidate of turn.flywheelCandidates) {
      store.upsertProfileFact({ workspaceId, identityId: candidate.fromIdentityId, projectId: "",
        slot: `flywheel_${candidate.toIdentityId}_${candidate.kind}`, value: candidate.explanation, status: "inferred",
        sourceRef: candidate.evidenceRefs[0] ?? "inference", sourceQuote: "", updatedAt: now });
    }
    void sessionId;
  }

  function personTimeZone(): string {
    try {
      const raw = store.getSetting(workspaceId, "schedule.preferences");
      const zone = raw ? (JSON.parse(raw) as { timeZone?: unknown }).timeZone : undefined;
      if (typeof zone === "string" && zone) return zone;
    } catch { /* an unreadable setting falls back to the default zone */ }
    return "America/Chicago";
  }

  /**
   * The dates the model read out of the files that came with this turn become one batch for the person to confirm.
   * Each is checked against the file's own text; what cannot be verified is dropped and counted, and a newer batch
   * retires an older one nobody answered, so re-reading the files never leaves two batches asking about the same dates.
   */
  function persistFileDates(turn: OnboardingTurn, ownerId: string, documentIds: string[], sources: Record<string, string>, today: string,
    reread: boolean): void {
    const read = turn.fileDates;
    if (!read || (!read.dates.length && !read.recurring.length && !read.questions.length && !(read.undated ?? []).length)) return;
    let checked;
    try { checked = sanitizeDateExtraction({ dates: read.dates, recurring: read.recurring, questions: read.questions, undated: read.undated ?? [] }, { sources, today }); }
    catch { return; /* nothing it read could be verified: no batch, and the interview itself is not failed over it */ }
    // Meals and sleep are what the available hours already leave out: only filtered against hours the person stated (this turn's, the
    // interview's earlier proposal, or what they painted), never against the generic default.
    const stated = turn.availability?.windows.length ? turn.availability.windows : (() => {
      const resolved = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
        proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: [] });
      return resolved.source === "saved" || resolved.source === "interview" ? resolved.windows : undefined;
    })();
    const fresh = { ...checked.extraction, recurring: stated ? withoutOffHours(checked.extraction.recurring, stated,
      store.listProjects(workspaceId, { includeArchived: true })) : checked.extraction.recurring };
    if (!fresh.dates.length && !fresh.recurring.length && !fresh.questions.length && !(fresh.undated ?? []).length) return;
    const answered = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
    const open = store.listEvents(workspaceId, { type: "dates.extracted" }).filter((event) => !answered.has(event.entityId));
    // A re-read replaces what nobody answered; any other turn adds to it, so an earlier batch's dates are never lost to a later turn.
    const carried = reread ? [] : open.map((event) => event.payload as unknown as DateExtraction & { documentIds?: string[] });
    const merged = mergeDateExtractions(carried, fresh);
    const batchId = randomUUID();
    for (const old of open.map((event) => event.entityId)) {
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:superseded:${old}`, type: "dates.decided", entityId: old,
        payload: { superseded: true, by: batchId, merged: !reread, included: [], excluded: [], blocks: 0 } });
    }
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:extracted:${batchId}`, type: "dates.extracted", entityId: batchId,
      payload: { documentIds: [...new Set([...carried.flatMap((batch) => batch.documentIds ?? []), ...documentIds])], dates: merged.dates,
        recurring: merged.recurring, questions: merged.questions, undated: merged.undated ?? [], past: merged.past ?? [], dropped: checked.dropped } });
  }

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

    // The person's answers to the questions the app itself asked (target grade, an unconfirmed line, a TBD date) are facts the moment they
    // are given, written here and not left for the model to remember: the label they picked is a verbatim span of their reply.
    for (const answer of answeredGapFacts(replyText, currentGaps())) {
      if (answer.file) {
        // The same record 待决事项 writes, so a file filed here is filed everywhere.
        const { documentId, projectId } = answer.file;
        if (projectId) store.assignSourceDocumentProject(workspaceId, documentId, projectId);
        if (projectId) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `source:assigned:${documentId}:${projectId}:${replyId}`, type: "source.project_assigned",
          entityId: documentId, payload: { projectId, by: "person" } });
        else store.appendEvent({ ownerId, workspaceId, idempotencyKey: `source:cleared:${documentId}:${replyId}`, type: "source.project_cleared", entityId: documentId, payload: { by: "person" } });
      } else if (answer.confirmPortrait) {
        const profile = readProfile();
        store.setSetting(workspaceId, PROFILE_CONFIRMED, JSON.stringify({ fingerprint: portraitFingerprint(profile), at: now }));
        store.appendEvent({ ownerId, workspaceId, idempotencyKey: `profile:confirmed:${replyId}`, type: "profile.confirmed", entityId: workspaceId, payload: { via: "interview" } });
      } else if (answer.slot) {
        store.upsertProfileFact({ workspaceId, identityId: answer.identityId, projectId: answer.projectId, slot: answer.slot, value: answer.value,
          status: "confirmed", sourceRef: replyId, sourceQuote: answer.quote, updatedAt: now });
      }
    }

    const docs = sourceIds(store.listSourceDocuments(workspaceId));
    const timeZone = personTimeZone();
    const today = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString().slice(0, 10);
    const known = knownSources(messages, docs);
    // A re-read hands every file over again, as if none had been seen.
    const announced = input.reread ? new Set<string>() : new Set((session.coverage as Announced).announcedSources ?? []);
    const fresh = [...docs].filter(([id, doc]) => doc.extractionStatus === "done" && !announced.has(id));

    // `line-<id>`: the interview of one line, added after the first one.
    const focus = sessionId.startsWith("line-") ? identityLines(store, workspaceId).find((line) => line.id === sessionId.slice(5)) : undefined;
    const focusLine = focus ? { id: focus.id, label: focus.label, goal: focus.goal ?? "" } : null;
    let threadId = session.codexThreadId;
    let announcedNow = announced;
    let sent = fresh;
    const validateOutput = (output: unknown) => validateOnboardingTurn(output, known);
    const softAccept = (_rejection: Error, output: unknown) => keepOnboardingTurn(output, known);

    /** A first turn: everything the ledger knows goes in, because the thread starts empty. */
    const startThread = async (documents: typeof fresh, history?: OnboardingTurnContext["history"]) => {
      const context: OnboardingTurnContext = {
        version: "crossline.onboarding.turn.v1",
        identities: identities(),
        projects: store.listProjects(workspaceId).map(({ id, identityId, name, summary }) => ({ id, identityId, name, summary })),
        facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status })),
        today, timeZone, sources: clipDocuments(documents), ...(history ? { history } : {}), reply: { id: replyId, text: replyText },
        focusLine, profile: readProfile(), stage: ((session!.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : "orientation")),
        checklist: openChecklist(), ...stagePace(messages, { startOpen: startOpen() }),
        ...(workHistory().length ? { workHistory: workHistory() } : {}),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [],
          ...(line.goalParts?.length ? { goalParts: line.goalParts } : {}) }))
      };
      return runCodexSkill<OnboardingTurn>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema: ONBOARDING_TURN_SCHEMA,
        prepareInput: () => context, validateOutput, softAccept,
        onAudit: (audit) => { if (audit.threadId) threadId = audit.threadId; },
        timeoutMs: 60 * 60_000
      });
    };

    let result;
    if (!session.codexThreadId) {
      result = await startThread(fresh);
    } else {
      // Later turns carry only what is new: the reply, and any file that arrived since the last turn.
      const newSources = clipDocuments(fresh);
      // The completion list goes with every turn, so the model knows what it still owes without being told twice in prose.
      const pace = stagePace(messages, { startOpen: startOpen() });
      const message = JSON.stringify({ reply: { id: replyId, text: replyText }, ...(newSources.length ? { newSources } : {}), checklist: openChecklist(), ...pace });
      result = await continueSkillTurn<OnboardingTurn>(client, session.codexThreadId, message, {
        skillName: ONBOARDING_SKILL, cwd, outputSchema: ONBOARDING_TURN_SCHEMA, validateOutput, softAccept,
        onAudit: () => {}, timeoutMs: 60 * 60_000
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
    if (!result.ok) return blocked(result.blocker.code, result.blocker.message);

    persistTurn(result.output, sessionId, ownerId);
    // A fixed weekly arrangement the person said (「每周二四上午组会」) is quoted from their reply, so replies count as sources here too.
    persistFileDates(result.output, ownerId, sent.map(([, doc]) => doc.id), { ...known.sources, ...known.replies }, today, input.reread === true);
    const output = withChecklist(withGapQuestions(result.output, currentGaps(), messages, { freshDocuments: sent.map(([, doc]) => doc.id) }),
      focusLine || options.checklist === false ? [] : openChecklist());
    store.appendOnboardingMessage({ sessionId, workspaceId, role: "assistant", content: output, createdAt: new Date().toISOString() });
    store.saveOnboardingSession({
      ...session, ...(threadId ? { codexThreadId: threadId } : {}),
      state: output.nextAction === "ready_for_milestones" ? "complete" : "active",
      coverage: { ...session.coverage, coverage: output.coverage, ...(output.stage ? { stage: output.stage } : {}),
        announcedSources: [...announcedNow, ...sent.map(([id]) => id)] },
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
export function withChecklist(output: OnboardingTurn, open: Array<{ label: string; detail: string; owner: "interview" | "person" }>): OnboardingTurn {
  const owed = open.filter((item) => item.owner === "interview");
  if (output.nextAction !== "ready_for_milestones" || !owed.length) return output;
  const missing = owed.slice(0, 6).map((item) => `${item.label}${item.detail ? `（${item.detail}）` : ""}`).join("；");
  return { ...output, nextAction: "ask", reply: `${output.reply}

完成访谈前还缺：${missing}。`,
    questions: output.questions.length ? output.questions
      : [{ id: "checklist-open", text: `完成访谈前还缺：${missing}。请补充。`, kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] };
}

/** Besides those that block, at most this many of the app's own questions join one round, so a batch stays answerable. */
export const GAPS_PER_ROUND = 3;

/**
 * Adds the app's own questions (`profileGaps`) to the round, **the ones about this round** first (decided 2026-10-08): a question about a
 * line or project the model is asking about now, a file that arrived with this reply, the portrait once this round wrote it. With nothing
 * relevant, one other joins, so nothing waits forever. A gap the model already asked in its own words is not asked twice; one that blocks
 * is asked every round until answered, and turns a premature 「ready」 back into 「ask」.
 */
export function withGapQuestions(output: OnboardingTurn, gaps: ProfileGap[], messages: StoredOnboardingMessage[],
  round: { freshDocuments?: string[] } = {}): OnboardingTurn {
  const asked = new Set(messages.flatMap((message) => message.role === "assistant"
    ? ((message.content as { questions?: Array<{ id: string }> }).questions ?? []).map((question) => question.id) : []));
  const open = gaps.filter((gap) => {
    if (output.questions.some((question) => question.id === gap.question.id)) return false;
    // Already asked by the model in its own words: a line it asks anything about, a project question that is about the same thing.
    if (gapCoveredBy(gap, output.questions)) return false;
    return gap.blocking || !asked.has(gap.question.id);
  });
  const lines = new Set([...output.questions.map((question) => question.identityId), ...output.slotUpdates.map((update) => update.identityId)].filter(Boolean));
  const projects = new Set([...output.questions.map((question) => question.projectId), ...output.slotUpdates.map((update) => update.projectId)].filter(Boolean));
  const fresh = new Set(round.freshDocuments ?? []);
  const relevant = (gap: ProfileGap) => gap.code === "FILE_UNFILED" ? fresh.has(gap.documentId ?? "")
    : gap.code === "PORTRAIT_UNCONFIRMED" || gap.code === "APPEARANCE" ? Boolean(output.profile?.portrait)
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
    if (message.role === "user") return { id: `reply-${message.seq}`, role: "user" as const, text: String((message.content as { text?: string }).text ?? "").slice(0, 4000) };
    const turn = message.content as { reply?: string; questions?: Array<{ text?: string }> };
    return { id: `assistant-${message.seq}`, role: "assistant" as const,
      text: [turn.reply ?? "", ...(turn.questions ?? []).map((question) => question.text ?? "")].filter(Boolean).join("\n").slice(0, 4000) };
  });
}

/** A session id the browser can mint for itself before the first turn. */

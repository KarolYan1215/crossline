import { randomUUID } from "node:crypto";
import {
  EMPTY_PROFILE_MODEL, ONBOARDING_TURN_SCHEMA, answeredGapFacts, mergeFacts, profileGaps, sanitizeDateExtraction, validateOnboardingTurn,
  type ProfileGap, type ProfileModel, type OnboardingStage,
  type KnownSources, type OnboardingTurn, type OnboardingTurnContext
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { latestFileDates, type CrosslineStore, type StoredOnboardingMessage, type StoredSourceDocument } from "@crossline/db";
import { sourceIds } from "./source-ids";
import { identityLines } from "./lines";

export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

/** Each document is cut to this much text per turn; the full text stays in the ledger for citation checks. */
const SOURCE_TEXT_PER_DOCUMENT = 14_000;
const SOURCE_TEXT_TOTAL = 60_000;

const INSTRUCTIONS = "You interview a Crossline user as the Skill describes: a life designer's interview in stages (orientation, "
  + "situation, compass, energy, lines, details), never proposing milestones. The person already set their lines (`lines`: identity "
  + "nouns, their order, which are hard constraints); do not propose new ones. Each turn: a short, sharp reflection on what was just said "
  + "(name a contradiction, a self-imposed limit, or gravity mistaken for a problem; never judge a choice or decide for the person), then a "
  + "batch of up to five questions that do not depend on each other — one whose answer depends on another's waits for the next turn; follow "
  + "a thread that carries a clue before returning to the stage. Ask about the hard-constraint lines' rules first (fixed schedule, terms, "
  + "deadlines), put every fixed weekly arrangement the person states into `fileDates.recurring` quoting their reply, and once the rules "
  + "are known propose weekly available hours in `availability`. Every single/multi question has concrete candidate options (8-14 when the "
  + "space is large) and allows the person's own answer. Rewrite `profile` in full every turn (your synthesis). In the lines stage write "
  + "each line's personal description and several long-term goal candidates, each 「成为 ___ 的 <身份>」 using only what the person said, in "
  + "`lineProfiles`; ask more when a line is still thin. Facts about the person in general use identityId \"person\". When `focusLine` is "
  + "set, interview only that line (stage `details`). Every confirmed slotUpdate cites a reply-N or src-N with a verbatim sourceQuote; your "
  + "own conclusions are sourceRef 'inference', status 'inferred', empty quote. Never invent dates, numbers or names. Files that arrive "
  + "are for you to read: every date they state goes into `fileDates`, each with a verbatim quote containing the day; never turn TBD into "
  + "a date (list it in `undated`). When `history` is present the conversation is being resumed: continue it, do not greet again or re-ask "
  + "what is answered. All human-readable fields in Chinese.";

export type OnboardingTurnOutcome =
  | { state: "asked" | "ready"; sessionId: string }
  | { state: "blocked"; sessionId: string; code: string; message: string };

type Announced = { announcedSources?: string[] };

export function createOnboardingSessionRunner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
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

  /** What the ledger still lacks, as of now. */
  const currentGaps = (): ProfileGap[] => profileGaps({
    identities: identities(),
    projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    facts: store.listProfileFacts(workspaceId),
    undated: latestFileDates(store, workspaceId).undated
  });

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
    // Each line's personal description and goal candidates, kept by line so a later turn or a line's own interview refines one line only.
    if (turn.lineProfiles?.length) {
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, unknown>; } catch { /* rebuilt below */ }
      for (const line of turn.lineProfiles) current[line.lineId] = { description: line.description, goalCandidates: line.goalCandidates };
      store.setSetting(workspaceId, "lines.profiles", JSON.stringify(current));
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
  function persistFileDates(turn: OnboardingTurn, ownerId: string, documentIds: string[], sources: Record<string, string>, today: string): void {
    const read = turn.fileDates;
    if (!read || (!read.dates.length && !read.recurring.length && !read.questions.length && !(read.undated ?? []).length)) return;
    let checked;
    try { checked = sanitizeDateExtraction({ dates: read.dates, recurring: read.recurring, questions: read.questions, undated: read.undated ?? [] }, { sources, today }); }
    catch { return; /* nothing it read could be verified: no batch, and the interview itself is not failed over it */ }
    const answered = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
    const batchId = randomUUID();
    for (const old of store.listEvents(workspaceId, { type: "dates.extracted" }).map((event) => event.entityId).filter((id) => !answered.has(id))) {
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:superseded:${old}`, type: "dates.decided", entityId: old,
        payload: { superseded: true, by: batchId, included: [], excluded: [], blocks: 0 } });
    }
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:extracted:${batchId}`, type: "dates.extracted", entityId: batchId,
      payload: { documentIds, dates: checked.extraction.dates, recurring: checked.extraction.recurring, questions: checked.extraction.questions, undated: checked.extraction.undated ?? [], dropped: checked.dropped } });
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
      store.upsertProfileFact({ workspaceId, identityId: answer.identityId, projectId: answer.projectId, slot: answer.slot, value: answer.value,
        status: "confirmed", sourceRef: replyId, sourceQuote: answer.quote, updatedAt: now });
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

    /** A first turn: everything the ledger knows goes in, because the thread starts empty. */
    const startThread = async (documents: typeof fresh, history?: OnboardingTurnContext["history"]) => {
      const context: OnboardingTurnContext = {
        version: "crossline.onboarding.turn.v1",
        identities: identities(),
        projects: store.listProjects(workspaceId).map(({ id, identityId, name, summary }) => ({ id, identityId, name, summary })),
        facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status })),
        today, timeZone, sources: clipDocuments(documents), ...(history ? { history } : {}), reply: { id: replyId, text: replyText },
        focusLine, profile: readProfile(), stage: ((session!.coverage as { stage?: OnboardingStage }).stage ?? (focusLine ? "details" : "orientation")),
        lines: identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard), goals: line.goals ?? [] }))
      };
      return runCodexSkill<OnboardingTurn>(client, context, {
        skillName: ONBOARDING_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema: ONBOARDING_TURN_SCHEMA,
        prepareInput: () => context, validateOutput,
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
      const message = JSON.stringify({ reply: { id: replyId, text: replyText }, ...(newSources.length ? { newSources } : {}) });
      result = await continueSkillTurn<OnboardingTurn>(client, session.codexThreadId, message, {
        skillName: ONBOARDING_SKILL, cwd, outputSchema: ONBOARDING_TURN_SCHEMA, validateOutput,
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
    persistFileDates(result.output, ownerId, sent.map(([, doc]) => doc.id), { ...known.sources, ...known.replies }, today);
    const output = withGapQuestions(result.output, currentGaps(), messages);
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

/** Words that say a question from the model already asks what a gap is about, so the code-built one is not asked on top of it. */
const COVERS: Record<Exclude<ProfileGap["code"], "LINE_UNCONFIRMED">, RegExp> = {
  DATE_UNDATED: /待定|TBD|日期|什么时候/i
};

/**
 * The turn as it is stored and shown. The model is not trusted to know what the app still needs: a gap that blocks (a line resting only on guesses) turns 「ready」 back into 「ask」, and the question that closes it is added with its
 * options if the model did not ask it itself. A gap that does not block (a TBD date) is asked once.
 */
export function withGapQuestions(output: OnboardingTurn, gaps: ProfileGap[], messages: StoredOnboardingMessage[]): OnboardingTurn {
  const asked = new Set(messages.flatMap((message) => message.role === "assistant"
    ? ((message.content as { questions?: Array<{ id: string }> }).questions ?? []).map((question) => question.id) : []));
  const added = gaps.filter((gap) => {
    if (output.questions.some((question) => question.id === gap.question.id)) return false;
    // Already asked by the model in its own words: a line it asks anything about, a project question that is about the same thing.
    const covered = output.questions.some((question) => gap.code === "LINE_UNCONFIRMED"
      ? question.identityId === gap.identityId
      : question.projectId === gap.projectId && COVERS[gap.code].test(question.text));
    if (covered) return false;
    return gap.blocking || !asked.has(gap.question.id);
  });
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

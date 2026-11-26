import { ONBOARDING_RESEARCH_SCHEMA, PORTRAIT_DIMENSION_LABEL, validateResearchTurn, type DimensionId, type OnboardingResearchContext,
  type ProfileModel, type ResearchThread, type ResearchTurn, withProfileFramework } from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { interviewLocale, type CrosslineStore } from "@crossline/db";
import { readProfileModel } from "./onboarding-persist";

/**
 * The interview's background research (the owner's decisions of 2026-11-12, scheme B, and 2026-11-22, D8/D16): a question the dialogue
 * does not settle on the spot with its own web search — a side topic the person raised, a base rate, the literature behind a pattern —
 * gets its own long Codex thread, kept and shown by the worker. It may ask the person something, which the page shows as a card beside the
 * conversation; the person's answer or follow-up goes straight back to that thread, never through the main dialogue. The dialogue reads
 * the threads when it wants (`read_interview_state`) and reports what they found when the interview ends.
 */
export const RESEARCH_SKILL = "crossline:crossline-onboarding-research";
export const RESEARCH_SETTING = "onboarding.research";
export const researchKey = (sessionId: string) => `${RESEARCH_SETTING}:${sessionId}`;

// i18n-ignore-start: instructions to the research Skill (model-facing)
const INSTRUCTIONS = "你是 Crossline 访谈的调研子任务。Skill crossline-onboarding-research 写了全部规则，照它做。"
  + "输入给你一个问题、为什么要查、它属于画像的哪个维度、画像摘要和线程到目前为止的消息。联网查证，只写有来源的结论。"
  + "只在确实需要本人补充时写 ask；结论写在 conclusion，没查完就留空字符串，下一轮接着查；输入带 lastRun 时没有下一轮，写出阶段性结论。"
  + "查询只放主题，不放本人的姓名、学校、邮箱或其他能认出本人的信息。";
// i18n-ignore-end
/**
 * No fixed number of runs (2026-11-22, the owner: research is not rationed; the model gate and the spend cap bound the cost). A thread
 * runs again while each run brings a source it did not have; a run that neither concludes, asks nor finds anything new is told it is
 * the last (`lastRun`) and closes the thread with what it found.
 */

export function readResearch(store: CrosslineStore, workspaceId: string, sessionId: string): ResearchThread[] {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, researchKey(sessionId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value as ResearchThread[] : [];
  } catch { return []; }
}

function saveThread(store: CrosslineStore, workspaceId: string, sessionId: string, thread: ResearchThread): void {
  const threads = readResearch(store, workspaceId, sessionId);
  const index = threads.findIndex((item) => item.id === thread.id);
  store.setSetting(workspaceId, researchKey(sessionId), JSON.stringify(index >= 0 ? threads.map((item) => item.id === thread.id ? thread : item) : [...threads, thread]));
}

const normalized = (text: string) => text.replace(/[\s，。？?！!、,.]/gu, "").toLowerCase();

/** What the dialogue is told each round: every thread, its state, and a conclusion once there is one. */
export function researchForDialogue(threads: ResearchThread[]) {
  return threads.map(({ id, question, status, conclusion, messages }) => {
    // A thread that ran out of runs without a sourced conclusion: its last finding, so the dialogue knows what was (not) found.
    const found = status === "done" && !conclusion ? [...messages].reverse().find((message) => message.role === "agent")?.text : undefined;
    return { id, question, status, ...(conclusion ? { conclusion } : {}), ...(found ? { found } : {}) };
  });
}

/**
 * The finished threads' sourced conclusions, for the extraction and the portrait writer: the only outside data they cite. They do not
 * search themselves (2026-11-12 replay: with the web on, the extraction searched job ads for 8–41 minutes a run and the portrait writer
 * spent its whole answer reasoning and returned nothing).
 */
export function researchFindings(threads: ResearchThread[]) {
  return threads.flatMap(({ status, question, conclusion, sources }) =>
    status === "done" && conclusion && sources?.length ? [{ question, conclusion, sources }] : []);
}

/** The questions of `asked` that are new: not the same as a thread already kept (by their words). Every new one gets a thread. */
export function newResearchQuestions(threads: ResearchThread[], asked: Array<{ question: string; why: string; dimension: DimensionId }>) {
  const seen = new Set(threads.map((thread) => normalized(thread.question)));
  const fresh: typeof asked = [];
  for (const item of asked) {
    const key = normalized(item.question);
    if (!key || seen.has(key)) continue;
    seen.add(key); fresh.push(item);
  }
  return fresh;
}

/** Runs the research threads of one workspace. Every run is in the background; the threads are read back from the ledger. */
export function createResearchRunner(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  const running = new Set<string>();

  /** The run's input (`OnboardingResearchContext`): the question, the portrait in brief, and the whole thread, sent on every run. */
  // The step's last run is told so (`lastRun`): the thread closes after it, so it gives what it has as a provisional conclusion
  // rather than leaving it for a next run that never comes (docs/onboarding-agent-session.md C25).
  const contextFor = (thread: ResearchThread, lastRun: boolean): OnboardingResearchContext => ({
    version: "crossline.onboarding.research.v1", today: new Date().toISOString().slice(0, 10),
    question: thread.question, why: thread.why, dimension: thread.dimension,
    profile: profileBrief(readProfileModel(store, workspaceId), thread.dimension), messages: thread.messages, ...(lastRun ? { lastRun: true as const } : {})
  });

  async function step(sessionId: string, threadId: string, said?: string): Promise<void> {
    const key = `${sessionId}:${threadId}`;
    if (running.has(key)) {
      // A run is on: the person's words join the thread, and its next run (or their next message) reads them.
      const busy = said ? readResearch(store, workspaceId, sessionId).find((item) => item.id === threadId) : undefined;
      if (busy && said) saveThread(store, workspaceId, sessionId, { ...busy, messages: [...busy.messages, { role: "person", text: said, at: new Date().toISOString() }] });
      return;
    }
    const client = getClient();
    let thread = readResearch(store, workspaceId, sessionId).find((item) => item.id === threadId);
    if (!client || !thread) return;
    running.add(key);
    const now = () => new Date().toISOString();
    try {
      if (said) thread = { ...thread, messages: [...thread.messages, { role: "person", text: said, at: now() }] };
      thread = { ...thread, status: "running", updatedAt: now() };
      delete thread.ask;
      saveThread(store, workspaceId, sessionId, thread);
      const locale = interviewLocale(store, workspaceId);
      const common = { skillName: RESEARCH_SKILL, cwd, outputSchema: ONBOARDING_RESEARCH_SCHEMA, validateOutput: validateResearchTurn,
        webResearch: true, ...(locale ? { locale } : {}), timeoutMs: 60 * 60_000 };
      let codexThread = thread.threadId;
      // The run after one that found nothing new is the last.
      let lastRun = false;
      for (;;) {
        const current: ResearchThread = readResearch(store, workspaceId, sessionId).find((item) => item.id === threadId) ?? thread;
        const input = contextFor(current, lastRun);
        const fresh = () => runCodexSkill<ResearchTurn>(client, input, { ...common, developerInstructions: withProfileFramework(INSTRUCTIONS),
          keepThread: true, prepareInput: (value) => value, onAudit: (audit) => { if (audit.threadId) codexThread = audit.threadId; } });
        let result = codexThread
          ? await continueSkillTurn<ResearchTurn>(client, codexThread, JSON.stringify(input), { ...common, onAudit: () => {} })
          : await fresh();
        if (!result.ok && result.blocker.code === "SKILL_THREAD_LOST") { codexThread = undefined; result = await fresh(); }
        const latest = readResearch(store, workspaceId, sessionId).find((item) => item.id === threadId) ?? current;
        if (!result.ok) {
          saveThread(store, workspaceId, sessionId, { ...latest, status: "failed", updatedAt: now(),
            messages: [...latest.messages, { role: "agent", text: result.blocker.message, at: now() }] });
          return;
        }
        const output = result.output;
        const added = output.sources.filter((source) => !(latest.sources ?? []).some((known) => known.url === source.url));
        const sources = [...(latest.sources ?? []), ...added];
        const last = lastRun;
        // Neither a conclusion nor a question: the thread runs again while it finds something new; the run after one that found nothing
        // closes it with what it found.
        const next: ResearchThread = { ...latest, ...(codexThread ? { threadId: codexThread } : {}), updatedAt: now(), sources,
          messages: [...latest.messages, { role: "agent", text: output.message, at: now(), ...(output.sources.length ? { sources: output.sources } : {}) }],
          status: output.conclusion ? "done" : output.ask ? "asking" : last ? "done" : "running",
          ...(output.ask && !output.conclusion ? { ask: output.ask } : {}),
          ...(output.conclusion ? { conclusion: output.conclusion } : {}) };
        if (!next.ask) delete next.ask;
        saveThread(store, workspaceId, sessionId, next);
        if (next.status !== "running") return;
        if (!added.length) lastRun = true;
      }
    } finally { running.delete(key); }
  }

  return {
    /** Opens a thread for each new question the dialogue raised and starts it; returns the threads opened. */
    start(sessionId: string, asked: Array<{ question: string; why: string; dimension: DimensionId }>): ResearchThread[] {
      const at = new Date().toISOString();
      const opened = newResearchQuestions(readResearch(store, workspaceId, sessionId), asked).map((item, index): ResearchThread => ({
        id: `r${Date.now().toString(36)}${index}`, question: item.question.slice(0, 300), why: item.why.slice(0, 500), dimension: item.dimension,
        status: "running", messages: [], createdAt: at, updatedAt: at }));
      for (const thread of opened) saveThread(store, workspaceId, sessionId, thread);
      for (const thread of opened) void step(sessionId, thread.id).catch(() => undefined);
      return opened;
    },
    /** The person's answer to a thread's question, or their own follow-up: goes to that thread alone. */
    answer(sessionId: string, threadId: string, text: string): { ok: true } | { ok: false; code: string } {
      const thread = readResearch(store, workspaceId, sessionId).find((item) => item.id === threadId);
      if (!thread) return { ok: false, code: "RESEARCH_THREAD_UNKNOWN" };
      const said = text.trim().slice(0, 12_000);
      if (!said) return { ok: false, code: "RESEARCH_MESSAGE_EMPTY" };
      void step(sessionId, threadId, said).catch(() => undefined);
      return { ok: true };
    },
    /** Threads left `running` by a worker that stopped mid-run are started again. */
    resume(sessionId: string): void {
      for (const thread of readResearch(store, workspaceId, sessionId)) if (thread.status === "running") void step(sessionId, thread.id).catch(() => undefined);
    }
  };
}

/** The portrait in brief for a research run: the dimension notes, the hypotheses of the question's dimension first, the career options. */
export function profileBrief(model: Partial<ProfileModel>, dimension: DimensionId): string[] {
  const label = (id: DimensionId) => PORTRAIT_DIMENSION_LABEL[id] ?? id;
  const hypotheses = [...(model.hypotheses ?? [])].sort((a, b) => Number(b.dimension === dimension) - Number(a.dimension === dimension));
  return [
    ...(model.dimensions ?? []).filter((note) => note.summary).map((note) => `${note.id} ${label(note.id)}：${note.summary}`),
    ...hypotheses.slice(0, 12).map((item) => `推断 ${item.id}（${item.dimension}，${item.status}）：${item.statement}`), // i18n-ignore: model-facing
    ...(model.careers ?? []).map((career) => `职业候选：${career.role}`) // i18n-ignore: model-facing
  ].slice(0, 40);
}

const runners = new Map<string, ReturnType<typeof createResearchRunner>>();
/** One runner per workspace for the worker's life, so a thread already running is not started twice from two turns. */
export function researchRunnerFor(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  let runner = runners.get(workspaceId);
  if (!runner) { runner = createResearchRunner(store, workspaceId, cwd, getClient); runners.set(workspaceId, runner); }
  return runner;
}

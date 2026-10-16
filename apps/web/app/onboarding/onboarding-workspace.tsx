"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { DateBatchCard } from "./date-batch-card";
import { DiligencePanel } from "./diligence-panel";
import { TranscriptionCard, type TranscriptionStatus } from "./transcription-card";
import { DEEP_STAGES, ONBOARDING_TONE_LABEL, ONBOARDING_TONES, type OnboardingStage, type OnboardingTone } from "@crossline/core";
import { QuestionCard } from "./question-card";
import { StageBar } from "./portrait-panel";
import { LeftColumn } from "./left-column";
import { StageView } from "./stage-view";
import { OpeningCard, openingReply, type OpeningAnswer } from "./opening-card";
import { announceRound, TurnProgress } from "./turn-progress";
import { SegmentedControl } from "../ui/controls";
import { AssessCard } from "./assess-card";
import { composeAnswers, type Answer, type AssistantTurn, type DocumentRow, type Message, type OnboardingState } from "./onboarding-types";

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.gif,.webp,.m4a,.mp3,.wav,.aac,.ogg,.flac";

/** Put in front of the tab's title when a round lands while the page is hidden. */
const NEW_ROUND_MARK = "● 新问题 · ";

const asTurn = (message: Message): AssistantTurn | undefined =>
  message.role === "assistant" ? message.content as AssistantTurn : undefined;
const userText = (message: Message) => String((message.content as { text?: string }).text ?? "");

/**
 * The interview screen (docs/onboarding-v3.md): materials and decisions on the left, the conversation in the middle, and on the right
 * what the answers are building, one picture per stage.
 *
 * The conversation lives in the ledger, so this component holds only what is in flight — the answers being
 * composed, a turn that is running, an upload — and re-reads everything else. Reloading the page, or opening
 * it on another device, picks the interview up exactly where it stopped.
 */
export function OnboardingWorkspace({ line }: { line?: string | undefined }) {
  const [state, setState] = useState<OnboardingState | undefined>();
  const [sessionId, setSessionId] = useState("");
  // A turn still running in the background after a reload: its reply is on the way, so nothing else may be sent meanwhile.
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState<"" | "turn" | "upload" | "dates" | "milestones" | "diligence">("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  // What was just sent, shown at once: the saved copy only arrives with the next read, after the turn ends.
  const [pendingText, setPendingText] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [over, setOver] = useState(false);
  const [transcription, setTranscription] = useState<TranscriptionStatus | undefined>();
  const [designed, setDesigned] = useState<Array<{ id: string; identityId: string; title: string }> | undefined>();
  // Whether this account has a model connection: every round runs on it, so until it has one the interview's first step is connecting,
  // here, instead of a red bar pointing to the bottom of the settings page (found walking the app as an invitee, 2026-10-15).
  const [connected, setConnected] = useState<boolean | undefined>();
  // Connecting the model has its own page (/connect, the first stop after signing in); arriving here without it goes back there.
  useEffect(() => {
    void fetch("/api/codex/account", { cache: "no-store" }).then((response) => response.json())
      // Only a definite "not signed in" sends the person there: with the background service unreachable /connect could not help either.
      .then((answer: { account?: unknown; blocker?: unknown }) => setConnected(answer.account ? true : answer.blocker ? undefined : false))
      .catch(() => undefined);
  }, []);
  useEffect(() => { if (connected === false && !line) location.replace("/connect?next=/onboarding"); }, [connected, line]);
  const bottom = useRef<HTMLDivElement>(null);
  const asked = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/onboarding/state${line ? `?line=${encodeURIComponent(line)}` : ""}`, { cache: "no-store" }).catch(() => undefined);
    if (!response?.ok) { setError("读不到访谈状态，请刷新。"); return undefined; }
    const loaded = await response.json() as OnboardingState;
    // Before the opening card is answered a new account still reads as the four built-in lines: none of them is the person's yet.
    const next: OnboardingState = loaded.setupLines ? { ...loaded, lines: [], identities: [], lineProfiles: {}, startMissing: [], startTotal: 0 } : loaded;
    setState(next);
    setSessionId((current) => next.session?.id ?? current ?? "");
    return next;
  }, [line]);
  useEffect(() => { void load(); }, [load]);
  // Attention time (decided 2026-10-12): every 15 seconds while the page is visible, the server is told how long ago the person last typed
  // or clicked; it counts only beats within a minute of input, so the model's thinking time while the person is away is not counted.
  useEffect(() => {
    if (line) return;
    let lastInput = Date.now();
    const touched = () => { lastInput = Date.now(); };
    const events = ["keydown", "pointerdown", "input"] as const;
    events.forEach((name) => window.addEventListener(name, touched, { passive: true }));
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/onboarding/attention", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputAgoMs: Math.min(600_000, Date.now() - lastInput) }) }).catch(() => {});
    }, 15_000);
    return () => { clearInterval(timer); events.forEach((name) => window.removeEventListener(name, touched)); };
  }, [line]);
  // A round that lands while the person is on another tab marks the tab's title until they come back.
  useEffect(() => {
    const clear = () => { if (document.visibilityState === "visible" && document.title.startsWith(NEW_ROUND_MARK)) document.title = document.title.slice(NEW_ROUND_MARK.length); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  // Within a turn's batch the questions are answered one by one, then sent together.
  const [current, setCurrent] = useState(0);
  // While a recording is waiting for text, keep looking: the model downloads and the transcription finishes
  // in the background, and the screen should show both without a refresh.
  const waitingForAudio = state?.documents.some((item) => item.kind === "audio" && item.extractionStatus === "pending") ?? false;
  useEffect(() => {
    if (!waitingForAudio) { setTranscription(undefined); return; }
    let live = true;
    const look = async () => {
      const response = await fetch("/api/transcription", { cache: "no-store" }).catch(() => undefined);
      const next = await response?.json().catch(() => undefined) as TranscriptionStatus | undefined;
      if (live && next) setTranscription(next);
      if (live) await load();
    };
    void look();
    const timer = setInterval(() => void look(), 4000);
    return () => { live = false; clearInterval(timer); };
  }, [waitingForAudio, load]);
  // The thread scrolls inside its own column on a wide screen; scrolling the window there pushed the header over the first message.
  useEffect(() => {
    // Before the first round the thread holds only the opening card, read from its top: scrolling it to the bottom hid the premise.
    if (!state?.messages.length && busy !== "turn") return;
    const thread = bottom.current?.parentElement;
    // A new round lands with its question at the top of the view, not under the cards that follow it.
    const target = asked.current;
    if (thread && thread.scrollHeight > thread.clientHeight + 1)
      thread.scrollTop = target ? thread.scrollTop + target.getBoundingClientRect().top - thread.getBoundingClientRect().top - 12 : thread.scrollHeight;
    else bottom.current?.scrollIntoView({ block: "nearest" });
  }, [state?.messages.length, busy, background]);

  const messages = state?.messages ?? [];
  const lastTurn = [...messages].reverse().map(asTurn).find(Boolean);
  const waiting = messages.at(-1)?.role === "user";
  const open = lastTurn && !waiting ? lastTurn : undefined;

  /**
   * A round's question about a line's long-term goal (「研究者长期目标保留哪些品质？」), answered by picking, is the person choosing that
   * goal: it is adopted as if from the left column's picker. Otherwise the interview said 「可以开始使用」 while the start standard still
   * waited on three goals nobody had adopted (2026-10-15 walkthrough).
   */
  const adoptGoalsFromRound = async () => {
    for (const question of batchQuestions) {
      if (!/长期目标/.test(question.text) || !question.identityId) continue;
      const line = state?.lines.find((item) => item.id === question.identityId);
      const parts = (answers[question.id]?.picked ?? []).map((id) => question.options.find((option) => option.id === id)?.label ?? "").filter(Boolean);
      if (!line || line.goals.length || !parts.length) continue;
      await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: line.id, goalParts: parts.slice(0, 3) }) }).catch(() => undefined);
    }
  };

  const runTurn = async (message: string, reread = false) => {
    setBusy("turn"); setError("");
    if (message) await adoptGoalsFromRound();
    if (message) { setPendingText(message); setText(""); setAnswers({}); }
    // A line's own interview lives in its own session; the full interview mints its id once.
    const id = line ? `line-${line}` : sessionId || crypto.randomUUID();
    setSessionId(id);
    const response = await fetch("/api/onboarding/turn", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id, text: message, reread })
    }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") setError(body?.message ?? body?.blocker?.message ?? "这一轮没有完成，可以重试。");
    // The full interview just finished: the portrait report is written now, so it is ready when the person opens it.
    if (body?.state === "ready" && !line) void fetch("/api/portrait", { method: "POST" }).catch(() => {});
    await load();
    setPendingText("");
    setCurrent(0);
    setBusy("");
    if (document.visibilityState === "hidden" && !document.title.startsWith(NEW_ROUND_MARK)) document.title = `${NEW_ROUND_MARK}${document.title}`;
    if (response?.ok && body?.state !== "blocked") announceRound();
  };

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy("upload"); setError("");
    const form = new FormData();
    list.forEach((file) => form.append("file", file));
    const response = await fetch("/api/onboarding/sources", { method: "POST", body: form }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string; code?: string; deferred?: boolean } | undefined;
    if (!response?.ok) setError(body?.message ?? "文件没有上传成功。");
    else if (body?.deferred) setError("文件已保存，但后台还没读取它（worker 没有运行）。");
    const next = await load();
    // The same model that interviews you reads what you added, in its next turn: it says what it found, asks about what
    // it cannot tell, and returns the dates the files state. Nothing separate runs, and nothing waits for you to ask. On the
    // materials step (no conversation yet) the person adds everything first and starts the interview themselves.
    const readable = list.filter((file) => next?.documents.some((doc) => doc.fileName === file.name && doc.extractionStatus === "done"));
    setBusy("");
    if (response?.ok && !body?.deferred && readable.length && (next?.messages.length ?? 0) > 0) await runTurn(`我添加了这些文件：${readable.map((file) => file.name).join("、")}。请读一下，整理里面的日期和我的情况。`);
  };

  // Dates may be confirmed while a turn runs (docs/onboarding-v3.md 「等待」): that must not end the turn's own wait.
  const decideDates = async (batchId: string, includedIds: string[]) => {
    setBusy((now) => now === "turn" ? now : "dates"); setError("");
    const response = await fetch("/api/onboarding/dates/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId, includedIds }) }).catch(() => undefined);
    if (!response?.ok) setError("没有加入成功，请重试。");
    await load();
    setBusy((now) => now === "dates" ? "" : now);
  };

  /** Designs the goals from the profile. They arrive as drafts on the Milestones page, where the person approves them. */
  const designMilestones = async () => {
    setBusy("milestones"); setError(""); setDesigned(undefined);
    const response = await fetch("/api/milestones/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "" }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; drafts?: Array<{ id: string; identityId: string; title: string }>; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") setError(body?.message ?? body?.blocker?.message ?? "里程碑没有设计成功，可以稍后重试。");
    else setDesigned(body?.drafts ?? []);
    setBusy("");
  };

  /** Researches one line on the web now. It can take minutes, so the card shows it as running until it lands. */
  const runDiligence = async (identityId: string) => {
    setBusy("diligence"); setError("");
    const response = await fetch("/api/diligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", identityId, force: true }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") setError(body?.message ?? body?.blocker?.message ?? "查证没有完成，可以稍后重试。");
    await load();
    setBusy("");
  };

  const decideDiligence = async (reportId: string, proposalId: string, decision: "accepted" | "rejected" | "pending") => {
    const response = await fetch("/api/diligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "decide", reportId, proposalId, decision }) }).catch(() => undefined);
    if (!response?.ok) setError("没有记录成功，请重试。");
    await load();
  };

  /** Only from the button that names the model's source and size. */
  const downloadModel = async () => {
    setError("");
    const response = await fetch("/api/transcription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: true }) }).catch(() => undefined);
    const next = await response?.json().catch(() => undefined) as TranscriptionStatus | undefined;
    if (!response?.ok || !next) setError("没有开始下载，请重试。"); else setTranscription(next);
  };

  const onDrop = (event: DragEvent) => { event.preventDefault(); setOver(false); void upload(event.dataTransfer.files); };
  // The app's own questions arrive inside each round (the worker adds the ones about what the round is talking about); questions the person
  // already answered on 待决事项 are not shown again — those answers go in front of this reply.
  const answeredElsewhere = new Set(state?.answeredElsewhere ?? []);
  const roundQuestions = (open?.questions ?? []).filter((question) => !answeredElsewhere.has(question.id));
  // The app's own questions not in this round (an account whose interview already ended can still answer 「没有截止」 here) join it, and
  // their answers go in the same reply, read back by the worker without the model.
  const inRound = new Set(roundQuestions.map((question) => question.id));
  const extra = waiting ? [] : (state?.extraQuestions ?? []).filter((question) => !inRound.has(question.id) && !answeredElsewhere.has(question.id));
  const batchQuestions = [...roundQuestions, ...extra];
  const composed = composeAnswers(batchQuestions, answers, text);
  const canSend = busy === "" && !background && (Boolean(composed.trim()) || waiting);


  if (!state) return <p className="ob-muted" role="status">正在读取…</p>;
  const stage = open?.stage ?? state.session?.coverage.stage ?? "orientation";
  const complete = state.session?.state === "complete";
  // Mixed pacing: in a deep stage the round is one question in the conversation; the app's own fact questions wait in the left column.
  // While a round runs the questions just answered are not shown again: emptied, they read as answers lost (2026-10-15 walkthrough).
  const deep = !state.focusLine && DEEP_STAGES.has(stage as OnboardingStage) && !waiting && busy !== "turn";
  const centre = deep ? roundQuestions : batchQuestions;
  const held = deep ? extra : [];
  const opening = !state.focusLine && messages.length === 0 && busy !== "turn" && !pendingText;
  const filesRead = state.documents.some((doc) => doc.extractionStatus === "done");

  /** The opening card's answers: tone and lines are written at once, then sent as the first reply the interview quotes. */
  const start = async (answer: OpeningAnswer) => {
    setBusy("turn"); setError("");
    await fetch("/api/onboarding/tone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tone: answer.tone }) }).catch(() => undefined);
    // The tone switch above the thread shows the chosen tone at once, not the default until the first round ends.
    setState((previous) => previous && { ...previous, tone: answer.tone });
    if (state.setupLines) {
      const ordered = answer.base ? [answer.base, ...answer.lines.filter((label) => label !== answer.base)] : answer.lines;
      const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ setup: ordered.map((label) => ({ label, ranked: label === answer.base, hard: answer.fixed.includes(label) })) }) }).catch(() => undefined);
      if (!response?.ok) { setError("主线没有保存成功，请重试。"); setBusy(""); return; }
    }
    setBusy("");
    await runTurn(openingReply(answer, filesRead));
  };
  const changeTone = async (tone: OnboardingTone) => {
    const response = await fetch("/api/onboarding/tone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tone }) }).catch(() => undefined);
    if (response?.ok) await load();
  };

  return <div className="ob3" onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} data-dragging={over}>
    <LeftColumn state={state} busy={busy !== "" && busy !== "turn"} accept={ACCEPT} onUpload={(files) => void upload(files)} onChanged={() => void load()}
      heldQuestions={held} answers={answers} onAnswer={(id, next) => setAnswers((previous) => ({ ...previous, [id]: next }))} />

    <section className="ob-centre" aria-label="访谈对话">
      <header className="ob-centre-head">
        <StageBar stage={stage} line={state.focusLine?.label} />
        {!opening && !state.focusLine && <div className="ob-tone"><span>语气</span>
          <SegmentedControl label="访谈语气" value={state.tone} onChange={(next) => void changeTone(next)}
            options={ONBOARDING_TONES.map((id) => ({ value: id, label: ONBOARDING_TONE_LABEL[id].label }))} /></div>}
      </header>
      <div className="ob-thread ob-voice" aria-live="polite">
        {!state.focusLine && <AssessCard />}
        {opening && <OpeningCard linesKnown={!state.setupLines} knownLines={state.lines.map((line) => line.label)} initialTone={state.tone}
          busy={busy !== ""} hasMaterials={filesRead} needsConnection={!state.focusLine && connected === false} onStart={(answer) => void start(answer)} />}
        {messages.length === 0 && state.focusLine && <div className="ob-turn ob-assistant"><p>{`「${state.focusLine.label}」的访谈：现状、长期目标、项目、截止日与已有文件。`}</p></div>}
        {messages.map((message) => {
          const turn = asTurn(message);
          if (!turn) return <div className="ob-turn ob-user" key={message.seq} data-user-text><p>{userText(message)}</p></div>;
          const latest = message.seq === messages.at(-1)?.seq;
          return <div className="ob-turn ob-assistant" key={message.seq}>
            <p className="gen">{turn.reply}</p>
            {latest && turn.nextAction === "ready_for_milestones" && state.readyToStart && <p className="ob-done">信息已基本完整，可以在下方设计里程碑；画像报告随后生成。</p>}
          </div>;
        })}
        {busy === "turn" && pendingText && !(messages.at(-1)?.role === "user" && userText(messages.at(-1)!) === pendingText)
          && <div className="ob-turn ob-user" data-user-text><p>{pendingText}</p></div>}
        {busy === "turn" && <div ref={asked}><TurnProgress sessionId={line ? `line-${line}` : sessionId} /></div>}
        {busy === "" && waiting && !error && <div ref={asked}><TurnProgress sessionId={line ? `line-${line}` : state.session?.id ?? ""} resumed onRunning={setBackground} onEnded={() => { setBackground(false); void load(); }} onRetry={() => void runTurn("")} /></div>}
        {answeredElsewhere.size > 0 && !waiting && <p className="ob-moved">本轮有 {answeredElsewhere.size} 题已在待决事项答过，会随这一轮一起发送。</p>}
        {deep && centre[0] && <div ref={asked} className="ob-turn ob-assistant ob-deep" aria-label="本轮问题">
          <p className="ob-deep-question gen">{centre[0].text}</p>
          {centre[0].kind !== "free" && <QuestionCard question={centre[0]} answer={answers[centre[0].id] ?? { picked: [], other: "" }} identities={state.identities}
            projects={state.projects} disabled={busy !== ""} hideText hideOther onChange={(next) => setAnswers((previous) => ({ ...previous, [centre[0]!.id]: next }))} />}
          <small className="ob-muted">在下方写下你的回答，想到什么写什么；也可以先选一个最接近的。</small>
        </div>}
        {!deep && centre.length > 0 && !waiting && busy !== "turn" && <div ref={asked} className="ob-turn ob-assistant ob-batch" aria-label="本轮问题">
          <nav className="ob-batch-nav" aria-label="问题进度">{centre.map((question, index) => <button key={question.id} type="button" aria-current={index === Math.min(current, centre.length - 1) || undefined}
            data-answered={Boolean(answers[question.id]?.picked.length || answers[question.id]?.other.trim()) || undefined} onClick={() => setCurrent(index)}>{index + 1}</button>)}</nav>
          {(() => { const question = centre[Math.min(current, centre.length - 1)]!; return <QuestionCard key={question.id} question={question}
            answer={answers[question.id] ?? { picked: [], other: "" }} identities={state.identities} projects={state.projects} disabled={busy !== ""}
            onChange={(next) => setAnswers((previous) => ({ ...previous, [question.id]: next }))} />; })()}
          <div className="ob-batch-actions">
            {current > 0 && <button type="button" className="ob-btn ob-quiet" onClick={() => setCurrent((index) => index - 1)}>上一题</button>}
            {current < centre.length - 1 && <button type="button" className="ob-btn ob-quiet" onClick={() => setCurrent((index) => index + 1)}>下一题</button>}
            <small className="ob-muted">{centre.length} 题一起作答，答完一并发送；不确定的可以跳过。</small>
          </div>
        </div>}
        {state.dateBatch && <DateBatchCard key={state.dateBatch.id} batch={state.dateBatch} busy={busy !== "" && busy !== "turn"} onDecide={(batchId, ids) => void decideDates(batchId, ids)} onRedo={() => void runTurn("请把我已添加的文件里的日期重新读一遍，只整理日期。", true)} />}
        {!state.focusLine && complete && <section className="ob-design" aria-label="画像报告">
          <b>画像报告</b>
          <span className="ob-muted">个人画像与洞察（可导出分享版），以及现况洞察与可行建议；可下载 PDF 或图片。</span>
          <a className="ob-btn" href="/portrait">查看画像报告</a>
        </section>}
        {state.readyToStart && !opening && <section className="ob-design" aria-label="设计里程碑">
          <b>{complete ? "了解得够了，可以设计里程碑了" : "随时可以先设计里程碑，之后补充再重来"}</b>
          <span className="ob-muted">由已确认的事实与日期倒推，每条主线 3–5 个前后相接的里程碑草稿，批准后生效。</span>
          {state.firstDrafts === "running" && !designed
            ? <p className="ob-muted">系统正在按访谈为每条主线设计里程碑草稿（每条主线几分钟），好了出现在 <a href="/milestones">主线</a> 页等待批准。</p>
            : designed
            ? <p className="ob-done">已生成 {designed.length} 个草稿：{designed.map((item) => item.title).join("、")}。<a href="/milestones">去审阅并批准</a></p>
            : <button type="button" className="ob-btn ob-quiet" disabled={busy !== ""} onClick={() => void designMilestones()}>
                {busy === "milestones" ? "正在设计…（通常 2–5 分钟）" : "设计里程碑草稿"}</button>}
        </section>}
        {(state.diligence.length > 0 || state.readyToStart) && !opening && <DiligencePanel reports={state.diligence}
          identities={state.identities} busy={busy !== ""} onRun={(id) => void runDiligence(id)} onDecide={(report, proposal, decision) => void decideDiligence(report, proposal, decision)} />}
        {transcription && waitingForAudio && <TranscriptionCard status={transcription} busy={busy !== ""} onDownload={() => void downloadModel()} />}
        <div ref={bottom} />
      </div>
      {error && <p className="ob-error" role="alert">{error}{waiting && busy === "" && <button type="button" className="ob-btn" onClick={() => void runTurn("")}>重试</button>}</p>}
      {!opening && <form className="ob-composer ob-voice" onSubmit={(event) => { event.preventDefault(); if (canSend) void runTurn(composed || ""); }}>
        <textarea value={text} rows={deep ? 4 : open ? 2 : 3} onChange={(event) => setText(event.target.value)} disabled={busy !== ""}
          placeholder={deep ? "写下你的回答…" : open ? "补充说明（可选）" : "想说的都可以写在这里…"} aria-label="回答" />
        <div className="ob-composer-row">
          <label className="ob-file-button">
            <input type="file" multiple accept={ACCEPT} hidden onChange={(event) => { void upload(event.target.files ?? []); event.target.value = ""; }} />
            {busy === "upload" ? "上传中…" : "添加文件"}
          </label>
          <button type="submit" className="ob-btn ob-primary" disabled={!canSend}>{deep ? "回答" : open ? "发送这一轮" : "发送"}</button>
        </div>
      </form>}
    </section>

    <div className="ob-right">
      {state.profile?.portrait && <p className="ob-portrait-now gen">{state.profile.portrait}</p>}
      <StageView state={state} stage={stage} complete={complete} onChanged={() => void load()} />
      {state.availabilityProposed && <p className="ob-note">已按说过的时间提议每周可用时段，可在 <a href="/plan#time">计划页</a> 预览后采用。</p>}
    </div>
  </div>;
}

export type { DocumentRow };

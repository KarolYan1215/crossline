"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { DateBatchCard } from "./date-batch-card";
import { DiligencePanel } from "./diligence-panel";
import { TranscriptionCard, type TranscriptionStatus } from "./transcription-card";
import { ProfilePanel } from "./profile-panel";
import { QuestionCard } from "./question-card";
import { LineSetup } from "./line-setup";
import { PortraitPanel, StageBar } from "./portrait-panel";
import { HierarchyGuide } from "./hierarchy-guide";
import {
  composeAnswers, type Answer, type AssistantTurn, type DocumentRow, type Message, type OnboardingState
} from "./onboarding-types";

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.gif,.webp,.m4a,.mp3,.wav,.aac,.ogg,.flac";
const OPENING = "当前在做的事与最想推进的事；也可直接拖入课程大纲、项目说明、笔记或录音。";

const asTurn = (message: Message): AssistantTurn | undefined =>
  message.role === "assistant" ? message.content as AssistantTurn : undefined;
const userText = (message: Message) => String((message.content as { text?: string }).text ?? "");

/**
 * The interview screen: a conversation on the left, what it has learned on the right.
 *
 * The conversation lives in the ledger, so this component holds only what is in flight — the answers being
 * composed, a turn that is running, an upload — and re-reads everything else. Reloading the page, or opening
 * it on another device, picks the interview up exactly where it stopped.
 */
export function OnboardingWorkspace({ line }: { line?: string | undefined }) {
  const [state, setState] = useState<OnboardingState | undefined>();
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState<"" | "turn" | "upload" | "dates" | "milestones" | "diligence">("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  // What was just sent, shown at once: the saved copy only arrives with the next read, after the turn ends.
  const [pendingText, setPendingText] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [over, setOver] = useState(false);
  const [transcription, setTranscription] = useState<TranscriptionStatus | undefined>();
  const [designed, setDesigned] = useState<Array<{ id: string; identityId: string; title: string }> | undefined>();
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/onboarding/state${line ? `?line=${encodeURIComponent(line)}` : ""}`, { cache: "no-store" }).catch(() => undefined);
    if (!response?.ok) { setError("读不到访谈状态，请刷新。"); return undefined; }
    const next = await response.json() as OnboardingState;
    setState(next);
    setSessionId((current) => next.session?.id ?? current ?? "");
    return next;
  }, [line]);
  useEffect(() => { void load(); }, [load]);
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
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [state?.messages.length, busy]);

  const messages = state?.messages ?? [];
  const lastTurn = [...messages].reverse().map(asTurn).find(Boolean);
  const waiting = messages.at(-1)?.role === "user";
  const open = lastTurn && !waiting ? lastTurn : undefined;

  const runTurn = async (message: string, reread = false) => {
    setBusy("turn"); setError("");
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
    // it cannot tell, and returns the dates the files state. Nothing separate runs, and nothing waits for you to ask.
    const readable = list.filter((file) => next?.documents.some((doc) => doc.fileName === file.name && doc.extractionStatus === "done"));
    setBusy("");
    if (response?.ok && !body?.deferred && readable.length) await runTurn(`我添加了这些文件：${readable.map((file) => file.name).join("、")}。请读一下，整理里面的日期和我的情况。`);
  };

  const decideDates = async (batchId: string, includedIds: string[]) => {
    setBusy("dates"); setError("");
    const response = await fetch("/api/onboarding/dates/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId, includedIds }) }).catch(() => undefined);
    if (!response?.ok) setError("没有加入成功，请重试。");
    await load();
    setBusy("");
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

  /** Puts the interview aside: its questions move to 待决事项 until the person replies here again. */
  const park = async () => {
    const response = await fetch("/api/onboarding/park", { method: "POST" }).catch(() => undefined);
    if (response?.ok) window.location.href = "/"; else setError("没有记录成功，请重试。");
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
  const composed = composeAnswers(roundQuestions, answers, text);
  const canSend = busy === "" && (Boolean(composed.trim()) || waiting);

  if (!state) return <p className="ob-muted" role="status">正在读取…</p>;
  if (state.setupLines) return <div className="ob-start"><HierarchyGuide /><LineSetup onDone={() => void load()} /></div>;
  const batch = roundQuestions;
  const stage = open?.stage ?? state.session?.coverage.stage ?? "orientation";

  return <div className="ob" onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} data-dragging={over}>
    <section className="ob-chat" aria-label="访谈对话">
      <StageBar stage={stage} line={state.focusLine?.label} />
      <div className="ob-thread" aria-live="polite">
        {messages.length === 0 && !state.focusLine && <HierarchyGuide />}
        {messages.length === 0 && <div className="ob-turn ob-assistant"><p>{state.focusLine ? `「${state.focusLine.label}」的访谈：现状、长期目标、项目、截止日与已有文件。` : OPENING}</p></div>}
        {messages.map((message) => {
          const turn = asTurn(message);
          if (!turn) return <div className="ob-turn ob-user" key={message.seq}><p>{userText(message)}</p></div>;
          const latest = message.seq === messages.at(-1)?.seq;
          return <div className="ob-turn ob-assistant" key={message.seq}>
            <p>{turn.reply}</p>
            {latest && turn.nextAction === "ready_for_milestones" && <p className="ob-done">信息已基本完整，可在下方生成画像报告与里程碑。</p>}
          </div>;
        })}
        {answeredElsewhere.size > 0 && !waiting && <p className="ob-moved">本轮有 {answeredElsewhere.size} 题已在待决事项答过，会随这一轮一起发送。</p>}
        {batch.length > 0 && !waiting && <div className="ob-turn ob-assistant ob-batch" aria-label="本轮问题">
          <nav className="ob-batch-nav" aria-label="问题进度">{batch.map((question, index) => <button key={question.id} type="button" aria-current={index === Math.min(current, batch.length - 1) || undefined}
            data-answered={Boolean(answers[question.id]?.picked.length || answers[question.id]?.other.trim()) || undefined} onClick={() => setCurrent(index)}>{index + 1}</button>)}</nav>
          {(() => { const question = batch[Math.min(current, batch.length - 1)]!; return <QuestionCard key={question.id} question={question}
            answer={answers[question.id] ?? { picked: [], other: "" }} identities={state.identities} projects={state.projects} disabled={busy !== ""}
            onChange={(next) => setAnswers((previous) => ({ ...previous, [question.id]: next }))} />; })()}
          <div className="ob-batch-actions">
            {current > 0 && <button type="button" className="ob-btn" onClick={() => setCurrent((index) => index - 1)}>上一题</button>}
            {current < batch.length - 1 && <button type="button" className="ob-btn" onClick={() => setCurrent((index) => index + 1)}>下一题</button>}
            <small className="ob-muted">{batch.length} 题互不依赖，答完一并发送；可跳过不答的题。</small>
          </div>
        </div>}
        {state.dateBatch && <DateBatchCard key={state.dateBatch.id} batch={state.dateBatch} busy={busy !== ""} onDecide={(batchId, ids) => void decideDates(batchId, ids)} onRedo={() => void runTurn("请把我已添加的文件里的日期重新读一遍，只整理日期。", true)} />}
        {!state.focusLine && state.session?.state === "complete" && <section className="ob-design" aria-label="画像报告">
          <b>画像报告</b>
          <span className="ob-muted">个人画像与洞察（可导出分享版），以及现况洞察与可行建议；可下载 PDF 或图片。</span>
          <a className="ob-btn" href="/portrait">查看画像报告 →</a>
        </section>}
        {state.facts.some((fact) => fact.status === "confirmed") && <section className="ob-design" aria-label="设计里程碑">
          <b>{state.session?.state === "complete" ? "了解得够了，可以设计里程碑了" : "随时可以先设计里程碑，之后补充再重来"}</b>
          <span className="ob-muted">由已确认的事实与日期倒推，每条主线 3–5 个前后相接的里程碑草稿，批准后生效。</span>
          {designed
            ? <p className="ob-done">已生成 {designed.length} 个草稿：{designed.map((item) => item.title).join("、")}。<a href="/milestones">去审阅并批准 →</a></p>
            : <button type="button" className="ob-btn" disabled={busy !== ""} onClick={() => void designMilestones()}>
                {busy === "milestones" ? "正在设计…（通常 2–5 分钟）" : "设计里程碑草稿"}</button>}
        </section>}
        {(state.diligence.length > 0 || state.facts.some((fact) => fact.status === "confirmed")) && <DiligencePanel reports={state.diligence}
          identities={state.identities} busy={busy !== ""} onRun={(id) => void runDiligence(id)} onDecide={(report, proposal, decision) => void decideDiligence(report, proposal, decision)} />}
        {transcription && waitingForAudio && <TranscriptionCard status={transcription} busy={busy !== ""} onDownload={() => void downloadModel()} />}
        {busy === "turn" && pendingText && !(messages.at(-1)?.role === "user" && userText(messages.at(-1)!) === pendingText)
          && <div className="ob-turn ob-user"><p>{pendingText}</p></div>}
        {busy === "turn" && <div className="ob-turn ob-assistant" role="status"><p className="ob-muted">正在整理回答并生成下一组问题…（通常 1–4 分钟，可以先离开本页）</p></div>}
        <div ref={bottom} />
      </div>
      {error && <p className="ob-error" role="alert">{error}{waiting && busy === "" && <button type="button" className="ob-btn" onClick={() => void runTurn("")}>重试</button>}</p>}
      <form className="ob-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) void runTurn(composed || ""); }}>
        <textarea value={text} rows={open ? 2 : 4} onChange={(event) => setText(event.target.value)} disabled={busy !== ""}
          placeholder={open ? "补充说明（可选）" : "当前情况…"} aria-label="回答" />
        <div className="ob-composer-row">
          <label className="ob-file-button">
            <input type="file" multiple accept={ACCEPT} hidden onChange={(event) => { void upload(event.target.files ?? []); event.target.value = ""; }} />
            {busy === "upload" ? "上传中…" : "添加文件 / 录音"}
          </label>
          <span className="ob-muted">PDF · Word · 文本 · 图片 · 录音；也可以直接拖进来</span>
          {!state.focusLine && state.session?.state === "active" && <button type="button" className="ob-btn ob-quiet" disabled={busy !== ""} onClick={() => void park()}
            title="访谈的问题会转到待决事项，可以在那里逐个回答；回到这里回复即继续">先开始使用</button>}
          <button type="submit" className="ob-btn" disabled={!canSend}>{open ? "发送这一轮" : "发送"}</button>
        </div>
      </form>
    </section>
    <div className="ob-side">
      <PortraitPanel profile={state.profile} lines={state.lines} lineProfiles={state.lineProfiles} onChanged={() => void load()} />
      {state.availabilityProposed && <p className="ob-note">已按硬约束规则提议每周可用时段，可在 <a href="/plan#time">计划页</a> 预览后采用。</p>}
      <ProfilePanel state={state} onChanged={() => void load()} />
    </div>
  </div>;
}

export type { DocumentRow };

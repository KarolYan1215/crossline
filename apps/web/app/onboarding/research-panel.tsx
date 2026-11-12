"use client";

import { useState } from "react";
import { useT } from "../locale-context";
import { Sheet } from "../ui/overlay";
import { VoiceField } from "../ui/voice/voice-input";
import type { ResearchSource, ResearchThread } from "./interview-contract";

const STATUS_LABEL: Record<ResearchThread["status"], string> = { running: "调研中", asking: "等你回答", done: "已有结论", failed: "失败" };

/** Sends the person's answer or follow-up into one research thread (contract C); true when the server took it. */
async function sendToThread(sessionId: string, threadId: string, text: string): Promise<boolean> {
  const response = await fetch("/api/onboarding/research", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, threadId, text }) }).catch(() => undefined);
  return Boolean(response?.ok);
}

function Sources({ sources }: { sources: ResearchSource[] | undefined }) {
  const t = useT();
  if (!sources?.length) return null;
  return <ul className="ob-research-sources" aria-label={t("来源")}>{sources.map((source) => <li key={source.url}>
    <a href={source.url} target="_blank" rel="noreferrer noopener" className="gen">{source.title || source.url}</a></li>)}</ul>;
}

/** A box and a send button, shared by the ask card and the thread's own conversation. */
function Reply({ sessionId, threadId, label, onSent }: { sessionId: string; threadId: string; label: string; onSent: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="ob-research-reply" onSubmit={(event) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    void sendToThread(sessionId, threadId, text.trim()).then((ok) => {
      setBusy(false);
      if (ok) { setText(""); onSent(); } else setError(t("没有发送成功，请重试。"));
    });
  }}>
    <VoiceField kind="note"><textarea value={text} rows={2} maxLength={4000} onChange={(event) => setText(event.target.value)} aria-label={label} disabled={busy} /></VoiceField>
    <span><button type="submit" className="ob-btn ob-primary" disabled={busy || !text.trim()}>{busy ? t("发送中…") : t("发送")}</button>
      {error && <small role="alert">{error}</small>}</span>
  </form>;
}

/**
 * The research the interview opened (decisions 17–18, contract C): a list of the questions being looked into, each with where it stands;
 * a thread that asks the person something comes up as a card here, and goes once answered; a thread opens into its whole conversation,
 * where the person can keep writing. None of it enters the main conversation, which takes a thread up only once it has a conclusion.
 */
export function ResearchPanel({ sessionId, threads, onChanged }: { sessionId: string; threads: ResearchThread[]; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState<string | undefined>();
  // An answered card goes at once; the thread's next state arrives with the next read.
  const [answered, setAnswered] = useState<string[]>([]);
  if (!threads.length) return null;
  const asking = threads.filter((thread) => thread.status === "asking" && thread.ask && !answered.includes(`${thread.id}@${thread.updatedAt}`));
  const thread = threads.find((item) => item.id === open);
  return <section className="ob-research" aria-label={t("正在调研")}>
    {asking.map((item) => <aside key={item.id} className="ob-research-ask" aria-label={t("调研追问")}>
      <small>{t("调研追问 · {{question}}", { question: item.question })}</small>
      <p className="gen">{item.ask}</p>
      <Reply sessionId={sessionId} threadId={item.id} label={t("回答这条追问")}
        onSent={() => { setAnswered((list) => [...list, `${item.id}@${item.updatedAt}`]); onChanged(); }} />
    </aside>)}
    <b>{t("正在调研")}</b>
    <ul className="ob-research-list">{threads.map((item) => <li key={item.id} data-status={item.status}>
      <button type="button" onClick={() => setOpen(item.id)}>
        <span className="gen">{item.question}</span>
        <small>{item.dimension} · {t(STATUS_LABEL[item.status])}</small>
      </button>
    </li>)}</ul>
    {thread && <Sheet title={t("调研：{{question}}", { question: thread.question })} side="right" open onOpenChange={(next) => { if (!next) setOpen(undefined); }}>
      <div className="ob-research-thread">
        {thread.why && <p className="ob-muted">{t("为什么查：")}<span className="gen">{thread.why}</span></p>}
        <p className="ob-research-status" data-status={thread.status}>{t(STATUS_LABEL[thread.status])}</p>
        <ol className="ob-research-messages">{thread.messages.map((message, index) => <li key={`${message.at}:${index}`} data-role={message.role}>
          <small>{message.role === "agent" ? t("调研") : t("你")}</small>
          <p className="gen">{message.text}</p>
          <Sources sources={message.sources} />
        </li>)}</ol>
        {thread.conclusion && <div className="ob-research-conclusion"><b>{t("结论")}</b><p className="gen">{thread.conclusion}</p></div>}
        <Sources sources={thread.sources} />
        <Reply sessionId={sessionId} threadId={thread.id} label={t("继续追问这条调研")} onSent={onChanged} />
      </div>
    </Sheet>}
  </section>;
}

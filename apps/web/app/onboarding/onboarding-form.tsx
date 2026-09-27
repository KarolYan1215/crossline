"use client";

import { useState } from "react";
import { CodexHistoryConsent, type HistorySource } from "./codex-history-consent";

const QUESTIONS = [
  "你目前最想推进的一件事是什么？",
  "科研 / 创业 / 自媒体 / 投资 这四条线里，哪一条最重要，为什么？",
  "你希望多长时间看到第一个可验收的成果？"
];

type Draft = { id: string; identityId: string; title: string };
type Message = { from: "you" | "ai"; text: string };
type TurnReply = {
  state?: string; reply?: string; focusIdentityId?: string | null; allIdentitiesCovered?: boolean;
  drafts?: Draft[]; relationCount?: number; threadId?: string; blocker?: { message?: string }; message?: string;
};

/**
 * Questionnaire as the opening turn, then a real multi-turn conversation on the same thread — not the old
 * single-shot form. The Skill drives identity-by-identity sequencing itself (`focusIdentityId`,
 * `allIdentitiesCovered`); this component just relays turns and shows what has accumulated so far.
 */
export function OnboardingForm() {
  const [answers, setAnswers] = useState<string[]>(QUESTIONS.map(() => ""));
  const [sources, setSources] = useState<HistorySource[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [phase, setPhase] = useState<"intro" | "chatting" | "done">("intro");
  const [threadId, setThreadId] = useState("");
  const [focusIdentityId, setFocusIdentityId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [relationCount, setRelationCount] = useState(0);

  const applyTurn = (result: TurnReply) => {
    if (result.drafts?.length) setDrafts((current) => [...current, ...result.drafts!]);
    if (result.relationCount) setRelationCount((current) => current + result.relationCount!);
    if (result.reply) setMessages((current) => [...current, { from: "ai", text: result.reply! }]);
    setFocusIdentityId(result.focusIdentityId ?? null);
    if (result.allIdentitiesCovered) setPhase("done");
  };

  const start = async () => {
    setBusy(true);
    setStatus("正在开始访谈，这一步会联网且用掉配额，可能要几分钟…");
    try {
      const response = await fetch("/api/onboarding/propose", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: QUESTIONS.map((question, index) => ({ question, answer: answers[index] ?? "" })).filter((item) => item.answer.trim()),
          sources
        })
      });
      const result = await response.json().catch(() => ({})) as TurnReply;
      setBusy(false);
      if (!response.ok || result.state === "blocked") {
        setStatus(result.blocker?.message ?? result.message ?? "没有开始访谈。");
        return;
      }
      setStatus("");
      if (result.threadId) setThreadId(result.threadId);
      applyTurn(result);
      setPhase(result.allIdentitiesCovered ? "done" : "chatting");
    } catch {
      setBusy(false);
      setStatus("网络不可用，没有开始访谈。");
    }
  };

  const send = async () => {
    const prompt = reply.trim();
    if (!prompt || !threadId) return;
    setBusy(true);
    setMessages((current) => [...current, { from: "you", text: prompt }]);
    setReply("");
    try {
      const response = await fetch("/api/onboarding/propose/continue", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, message: prompt, focusIdentityId })
      });
      const result = await response.json().catch(() => ({})) as TurnReply;
      setBusy(false);
      if (!response.ok || result.state === "blocked") {
        setMessages((current) => [...current, { from: "ai", text: result.blocker?.message ?? result.message ?? "这条消息没有处理成功。" }]);
        return;
      }
      applyTurn(result);
    } catch {
      setBusy(false);
      setMessages((current) => [...current, { from: "ai", text: "网络不可用，这条消息没有发送成功。" }]);
    }
  };

  return <div className="onboarding-form">
    {phase === "intro" && <>
      <CodexHistoryConsent onScanned={(scanned) => setSources(scanned)} />
      {QUESTIONS.map((question, index) => <label key={question}>
        <span>{question}</span>
        <textarea value={answers[index]} maxLength={2000} rows={2} disabled={busy}
          onChange={(event) => setAnswers((current) => current.map((value, i) => i === index ? event.target.value : value))} />
      </label>)}
      <button type="button" className="secondary-button" onClick={() => void start()} disabled={busy}>开始访谈 ↗</button>
      {status && <em role="alert">{status}</em>}
    </>}

    {phase !== "intro" && <div className="milestone-conversation">
      <ul>{messages.map((message, index) => <li key={index} data-from={message.from}>
        <b>{message.from === "you" ? "你" : "AI"}</b><span>{message.text}</span>
      </li>)}</ul>
      {phase === "chatting" ? <div className="milestone-conversation-reply">
        <input value={reply} disabled={busy} placeholder="回答 AI 的问题，或补充更多细节…"
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void send(); } }} />
        <button type="button" onClick={() => void send()} disabled={busy || !reply.trim()}>发送</button>
      </div> : <p role="status">访谈已覆盖所有主线。</p>}
    </div>}

    {(drafts.length > 0 || relationCount > 0) && <div>
      {drafts.length > 0 && <p>提出了 {drafts.length} 个里程碑草稿：</p>}
      {drafts.length > 0 && <ul>{drafts.map((draft) => <li key={draft.id}>{draft.identityId} · {draft.title}</li>)}</ul>}
      {relationCount > 0 && <p>另外提出了 {relationCount} 条待批准的跨主线飞轮关系。</p>}
      <a href="/milestones">前往里程碑页面查看并批准 →</a>
    </div>}
  </div>;
}

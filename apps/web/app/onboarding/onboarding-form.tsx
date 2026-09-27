"use client";

import { useState } from "react";

const QUESTIONS = [
  "你目前最想推进的一件事是什么？",
  "科研 / 创业 / 自媒体 / 投资 这四条线里，哪一条最重要，为什么？",
  "你希望多长时间看到第一个可验收的成果？"
];

type Reply = { state?: string; drafts?: Array<{ id: string; identityId: string; title: string }>; blocker?: { message?: string }; message?: string };

export function OnboardingForm() {
  const [answers, setAnswers] = useState<string[]>(QUESTIONS.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [drafts, setDrafts] = useState<Array<{ id: string; identityId: string; title: string }>>([]);

  const submit = async () => {
    setBusy(true);
    setStatus("正在生成里程碑建议，这一步会联网且用掉配额，可能要几分钟…");
    try {
      const response = await fetch("/api/onboarding/propose", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: QUESTIONS.map((question, index) => ({ question, answer: answers[index] })) })
      });
      const result = await response.json().catch(() => ({})) as Reply;
      setBusy(false);
      if (!response.ok || result.state === "blocked") {
        setStatus(result.blocker?.message ?? result.message ?? "没有生成建议。");
        return;
      }
      if (!result.drafts?.length) { setStatus("这次没有提出里程碑草案，可以补充更多细节后再试一次。"); return; }
      setStatus("");
      setDrafts(result.drafts);
    } catch {
      setBusy(false);
      setStatus("网络不可用，没有生成建议。");
    }
  };

  return <div className="onboarding-form">
    {QUESTIONS.map((question, index) => <label key={question}>
      <span>{question}</span>
      <textarea value={answers[index]} maxLength={2000} rows={2} disabled={busy}
        onChange={(event) => setAnswers((current) => current.map((value, i) => i === index ? event.target.value : value))} />
    </label>)}
    <button type="button" className="secondary-button" onClick={() => void submit()} disabled={busy}>生成里程碑建议 ↗</button>
    {status && <em role="alert">{status}</em>}
    {drafts.length > 0 && <div>
      <p>提出了 {drafts.length} 个草稿：</p>
      <ul>{drafts.map((draft) => <li key={draft.id}>{draft.identityId} · {draft.title}</li>)}</ul>
      <a href="/milestones">前往里程碑页面查看并批准 →</a>
    </div>}
  </div>;
}

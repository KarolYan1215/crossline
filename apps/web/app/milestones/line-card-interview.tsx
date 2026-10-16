"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { composeGoal } from "@crossline/core";
import { composeAnswers, type Answer, type Question } from "../onboarding/onboarding-types";
import { useLocale, useT } from "../locale-context";
import "./line-card.css";

/** What the card knows of the line's own interview, from the server (refreshed in place after every turn). */
export type LineInterviewView = { reply: string; questions: Array<Pick<Question, "id" | "text" | "kind" | "options">>; waiting: boolean; turns: number };
/** `composeAnswers` reads only the id, text and options of a question. */
const asQuestions = (list: LineInterviewView["questions"]) => list as Question[];

const RETRY_AFTER_MS = 20_000;

/** The session id a line's own interview lives in: the same one `/onboarding?line=<id>` uses. */
export const lineSessionId = (lineId: string) => `line-${lineId}`;

/**
 * The line's own interview, inside its card on 主线 (§4.2): what is said here becomes facts of this line, and the description and the
 * attribute candidates refresh in place when the turn returns. A turn takes a minute or two, so the box stays usable — a message sent
 * meanwhile waits its turn — and the elapsed time shows. Also on the card: a goal change the person asked for (adopted or dismissed with
 * one click, never applied by the interview), and 「目标已变，重算未动过的草稿」 once the goal or the facts moved after the drafts.
 */
export function LineCardInterview({ lineId, label, description, interview, pendingEdit, redraftDue }: {
  lineId: string; label: string; description: string; interview: LineInterviewView;
  pendingEdit: { parts: string[] } | null; redraftDue: boolean;
}) {
  const t = useT();
  const english = useLocale() === "en";
  const router = useRouter();
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [redraft, setRedraft] = useState<"" | "running" | string>("");
  const [editStatus, setEditStatus] = useState("");
  const queue = useRef<string[]>([]);

  // While a turn runs, the elapsed seconds; while the last message is still unanswered after a reload, look again now and then.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (busy || !interview.waiting) return;
    const timer = setInterval(() => router.refresh(), RETRY_AFTER_MS);
    return () => clearInterval(timer);
  }, [busy, interview.waiting, router]);

  /** Tells the global 小帮手 which line the person is working in (page context `line`). */
  const markPage = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("line") === lineId) return;
    url.searchParams.set("line", lineId);
    window.history.replaceState(window.history.state, "", url);
  };

  const run = async (message: string): Promise<void> => {
    setBusy(true); setFailed(false); setStarted(Date.now()); setNow(Date.now());
    setStatus(message ? "" : t("重新发送上一条…"));
    const response = await fetch("/api/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: lineSessionId(lineId), text: message }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; blocker?: { code?: string; message?: string } } | undefined;
    if (response?.status === 409 && body?.blocker?.code === "ONBOARDING_ALREADY_RUNNING") {
      // Another interview turn of this account is running (only one at a time): this message is kept and sent again shortly.
      setStatus(t("另一轮访谈正在进行，稍后自动发送"));
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
      return run(message);
    }
    if (!response?.ok || body?.state === "blocked") {
      setFailed(true);
      setStatus(t("{{reason}}；内容已保存，可以重新发送", { reason: body?.message ?? body?.blocker?.message ?? t("这一轮没有完成") }));
    } else setStatus("");
    router.refresh();
    const next = queue.current.shift();
    if (next !== undefined) return run(next);
    setBusy(false);
  };

  const send = () => {
    const message = composeAnswers(asQuestions(interview.questions), answers, text).trim();
    if (!message) return;
    setText(""); setAnswers({});
    if (busy) { queue.current.push(message); setStatus(t("已排队，上一轮结束后发送")); return; }
    void run(message);
  };

  const decideEdit = async (decision: "adopt" | "dismiss") => {
    setEditStatus(t("保存中…"));
    const response = await fetch("/api/lines/goal-edit", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineId, decision }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { message?: string } | undefined;
    if (!response?.ok) { setEditStatus(body?.message ?? t("未保存，请重试")); return; }
    setEditStatus("");
    router.refresh();
  };

  const redoDrafts = async () => {
    setRedraft("running");
    const response = await fetch("/api/milestones/propose", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "", only: [lineId] }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; drafts?: unknown[]; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") setRedraft(t("{{reason}}，可以稍后重试", { reason: body?.message ?? body?.blocker?.message ?? t("未完成") }));
    else { setRedraft(t("已重算 {{count}} 个草稿", { count: body?.drafts?.length ?? 0 })); router.refresh(); }
  };

  const seconds = busy && started ? Math.max(0, Math.round((now - started) / 1000)) : 0;
  const toggle = (question: LineInterviewView["questions"][number], optionId: string) => setAnswers((current) => {
    const answer = current[question.id] ?? { picked: [], other: "" };
    const has = answer.picked.includes(optionId);
    const picked = question.kind === "single" ? (has ? [] : [optionId]) : has ? answer.picked.filter((id) => id !== optionId) : [...answer.picked, optionId];
    return { ...current, [question.id]: { ...answer, picked } };
  });
  const open = interview.waiting ? [] : interview.questions;

  return <div className="lc-interview" onDragStart={(event) => event.stopPropagation()}>
    {description && <p className="gen lc-description">{description}</p>}
    {pendingEdit && <div className="lc-edit" role="group" aria-label={t("长期目标修改")}>
      <small className="muted">{t("访谈中提出的长期目标修改")}</small>
      <span className="gen">{english ? t("成为 {{goal}}", { goal: `${pendingEdit.parts.join(", ")} ${label}` }) : composeGoal(pendingEdit.parts, label)}</span>
      <span className="lc-row">
        <button type="button" className="primary-button" onClick={() => void decideEdit("adopt")}>{t("采用")}</button>
        <button type="button" className="text-button" onClick={() => void decideEdit("dismiss")}>{t("不改")}</button>
        {editStatus && <small role="status">{editStatus}</small>}
      </span>
    </div>}
    {(redraftDue || redraft) && <div className="lc-redraft">
      {redraft === "running" ? <small role="status">{t("正在重算该主线未动过的草稿…（通常 2–5 分钟，已批准的里程碑不变）")}</small>
        : redraft ? <small role="status">{redraft}</small>
        : <button type="button" className="secondary-button" onClick={() => void redoDrafts()}>{t("目标已变，重算未动过的草稿")}</button>}
    </div>}
    {interview.reply && !busy && <p className="gen lc-reply">{interview.reply}</p>}
    {open.length > 0 && !busy && <div className="lc-questions" aria-label={t("本轮问题")}>
      {open.map((question) => <fieldset key={question.id} className="lc-question">
        <legend className="gen">{question.text}</legend>
        {question.kind !== "free" && <div className="lc-options">{question.options.map((option) =>
          <button key={option.id} type="button" className="gen" title={option.detail || undefined} aria-pressed={Boolean(answers[question.id]?.picked.includes(option.id))}
            onClick={() => toggle(question, option.id)}>{option.label}</button>)}</div>}
      </fieldset>)}
    </div>}
    <form className="lc-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <textarea value={text} rows={2} maxLength={4000} aria-label={t("「{{label}}」的访谈", { label })} onFocus={markPage}
        placeholder={interview.turns ? t("补充这条主线的情况，或回答上面的问题") : t("这条主线的现状、进展、想法；也可以说「把长期目标改成…」")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      <span className="lc-row">
        <button type="submit" className="text-button" disabled={!composeAnswers(asQuestions(interview.questions), answers, text).trim()}>{busy ? t("排队发送") : t("发送")}</button>
        {busy && <small role="status">{t("正在整理（已 {{n}} 秒，每轮约一两分钟）", { n: seconds })}</small>}
        {!busy && interview.waiting && !failed && <small role="status">{t("上一条仍在整理或未完成")}
          <button type="button" className="text-button" onClick={() => void run("")}>{t("重新发送")}</button></small>}
        {status && <small role="status">{status}{failed && !busy && <button type="button" className="text-button" onClick={() => void run("")}>{t("重新发送")}</button>}</small>}
        <a className="lc-full" href={`/onboarding?line=${encodeURIComponent(lineId)}`}>{t("完整访谈 →")}</a>
      </span>
    </form>
  </div>;
}

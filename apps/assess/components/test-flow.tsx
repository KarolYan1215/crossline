"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api-client";
import {
  LAST_RESULT_KEY, QUIZ_LENGTH, answeredCount, back, buildRequest, emailProblem, emptyFlow, errorMessage, flowKey, next, nicknameProblem,
  parseFlow, setAnswer, startQuiz, type Flow
} from "../lib/flow";
import { AppearanceStep } from "./appearance-step";
import { EmailStep } from "./email-step";
import { LastResultLink } from "./last-result-link";
import { QuizStep } from "./quiz-step";
import { readStored, writeStored } from "./storage";

/** How long a chosen answer stays on screen before the next statement, so the person sees what they picked. */
const ADVANCE_MS = 260;

/**
 * The whole test: the intro the page passes in, 32 statements, appearance, email, then off to the result (or, through an invitation,
 * straight to the pair card). Kept in sessionStorage per invitation so a reload resumes; cleared once the result exists.
 */
export function TestFlow({ inviteToken, startLabel = "开始", children, after }: {
  inviteToken?: string; startLabel?: string; children?: ReactNode;
  /** Shown below the start button on the intro only (the landing page's examples). */
  after?: ReactNode;
}) {
  const router = useRouter();
  const [flow, setFlow] = useState<Flow>(emptyFlow);
  const [loaded, setLoaded] = useState(false);
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; inviteGone: boolean; full: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = flowKey(inviteToken);

  useEffect(() => {
    const stored = parseFlow(readStored("session", key));
    if (stored) setFlow(stored);
    setLoaded(true);
  }, [key]);
  useEffect(() => { if (loaded) writeStored("session", key, JSON.stringify(flow)); }, [flow, key, loaded]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [flow.step]);

  const move = (update: (flow: Flow) => Flow) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setFlow(update);
  };
  const choose = useCallback((value: number, advance: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    setFlow((current) => setAnswer(current, value));
    timer.current = advance ? setTimeout(() => { timer.current = null; setFlow(next); }, ADVANCE_MS) : null;
  }, []);

  useEffect(() => {
    if (flow.step !== "quiz") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "BUTTON" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "radio"))) return;
      if (/^[1-5]$/.test(event.key)) { event.preventDefault(); choose(Number(event.key), true); }
      else if (event.key === "Enter") { event.preventDefault(); move(next); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow.step, choose]);

  const submit = async (withInvite = true) => {
    setTouched(true);
    const request = buildRequest(flow, { website, inviteToken: withInvite ? inviteToken : undefined });
    if (!request) return;
    setBusy(true);
    setError(null);
    const response = await api.submitResult(request);
    if (!response.ok) {
      setBusy(false);
      setError({ text: errorMessage(response.code), inviteGone: response.code === "INVITE_NOT_FOUND", full: response.code === "EMAIL_LIMIT_REACHED" });
      return;
    }
    writeStored("local", LAST_RESULT_KEY, response.data.resultToken);
    writeStored("session", key, null);
    router.push(response.data.pairToken ? `/p/${response.data.pairToken}` : `/r/${response.data.resultToken}`);
  };

  const answered = answeredCount(flow);
  return <>
    {flow.step === "intro" && <section className="as-sheet as-intro">
      {children}
      <button type="button" className="as-primary as-start" onClick={() => move((current) => startQuiz(current, Date.now()))}>
        {answered > 0 && answered < QUIZ_LENGTH ? `接着答（已答 ${answered} / ${QUIZ_LENGTH}）` : startLabel}
      </button>
      {after}
    </section>}
    {flow.step === "quiz" && <QuizStep flow={flow} onChoose={choose} onBack={() => move(back)} onNext={() => move(next)} />}
    {flow.step === "appearance" && <AppearanceStep draft={flow.appearance} onChange={(appearance) => setFlow((current) => ({ ...current, appearance }))}
      onBack={() => move(back)} onNext={() => move((current) => ({ ...current, step: "email" }))} />}
    {flow.step === "email" && <EmailStep
      fields={{ email: flow.email, nickname: flow.nickname, sendEmail: flow.sendEmail, website }}
      problems={{ email: touched ? emailProblem(flow.email) : null, nickname: nicknameProblem(flow.nickname) }}
      error={error?.text ?? null} busy={busy} invited={Boolean(inviteToken)}
      onChange={({ website: trap, ...patch }) => { if (trap !== undefined) setWebsite(trap); setFlow((current) => ({ ...current, ...patch })); }}
      onSubmit={() => void submit()} onBack={() => move(back)}
      onSubmitWithoutInvite={error?.inviteGone ? () => void submit(false) : undefined}
      latestLink={error?.full ? <LastResultLink label="查看我的最新结果" /> : undefined} />}
  </>;
}

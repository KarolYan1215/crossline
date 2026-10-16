"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api-client";
import {
  LAST_RESULT_KEY, QUIZ_LENGTH, afterSubmit, answeredCount, back, buildRequest, destination, emailProblem, emptyFlow, errorMessage, flowKey, next,
  nicknameProblem, parseFlow, setAnswer, startQuiz, type Flow
} from "../lib/flow";
import { LOCALE_SWITCH_EVENT } from "../lib/i18n";
import { AppearanceStep } from "./appearance-step";
import { EmailStep } from "./email-step";
import { LastResultLink } from "./last-result-link";
import { useLocale, useT } from "./locale-context";
import { QuizStep } from "./quiz-step";
import { readStored, writeStored } from "./storage";
import { WantsStep } from "./wants-step";

/** How long a chosen answer stays on screen before the next statement, so the person sees what they picked. */
const ADVANCE_MS = 260;

/**
 * The whole test: the intro the page passes in, 32 statements, appearance, email — which makes the result and starts the figure —
 * then what the person wants to do, answered while the figure is drawn, then off to the result (or, through an invitation, to the pair
 * card). Kept in sessionStorage per invitation so a reload resumes; cleared once the last step is done or skipped.
 */
export function TestFlow({ inviteToken, startLabel, children, after }: {
  inviteToken?: string; startLabel?: string; children?: ReactNode;
  /** Shown below the start button on the intro only (the landing page's examples). */
  after?: ReactNode;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
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
  // Switching the language reloads the page: write the latest state first (a pending auto-advance included), so the test resumes on
  // the same statement with every answer kept.
  const latest = useRef(flow);
  latest.current = flow;
  useEffect(() => {
    if (!loaded) return;
    const save = () => writeStored("session", key, JSON.stringify(latest.current));
    window.addEventListener(LOCALE_SWITCH_EVENT, save);
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener(LOCALE_SWITCH_EVENT, save); window.removeEventListener("pagehide", save); };
  }, [key, loaded]);
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
      setError({ text: errorMessage(response.code, locale), inviteGone: response.code === "INVITE_NOT_FOUND", full: response.code === "EMAIL_LIMIT_REACHED" });
      return;
    }
    writeStored("local", LAST_RESULT_KEY, response.data.resultToken);
    setBusy(false);
    // The result exists and its figure is being drawn: one more step, answered meanwhile.
    move((current) => afterSubmit(current, response.data));
  };

  const finish = (submitted: NonNullable<Flow["submitted"]>) => {
    writeStored("session", key, null);
    router.push(destination(submitted));
  };
  const sendWants = async () => {
    if (!flow.submitted) return;
    setBusy(true);
    setError(null);
    const response = await api.setWants(flow.submitted.resultToken, { picks: flow.wants.picks, text: flow.wants.text.trim() });
    if (!response.ok && response.code !== "WANTS_LIMIT_REACHED") {
      setBusy(false);
      setError({ text: errorMessage(response.code, locale), inviteGone: false, full: false });
      return;
    }
    finish(flow.submitted);
  };

  const answered = answeredCount(flow);
  return <>
    {flow.step === "intro" && <section className="as-sheet as-intro">
      {children}
      <button type="button" className="as-primary as-start" onClick={() => move((current) => startQuiz(current, Date.now()))}>
        {answered > 0 && answered < QUIZ_LENGTH ? t("接着答（已答 {{answered}} / {{total}}）", { answered, total: QUIZ_LENGTH }) : startLabel ?? t("开始")}
      </button>
      {after}
    </section>}
    {flow.step === "quiz" && <QuizStep flow={flow} onChoose={choose} onBack={() => move(back)} onNext={() => move(next)} />}
    {flow.step === "appearance" && <AppearanceStep draft={flow.appearance} onChange={(appearance) => setFlow((current) => ({ ...current, appearance }))}
      onBack={() => move(back)} onNext={() => move((current) => ({ ...current, step: "email" }))} />}
    {flow.step === "email" && <EmailStep
      fields={{ email: flow.email, nickname: flow.nickname, sendEmail: flow.sendEmail, website }}
      problems={{ email: touched ? emailProblem(flow.email, locale) : null, nickname: nicknameProblem(flow.nickname, locale) }}
      error={error?.text ?? null} busy={busy} invited={Boolean(inviteToken)}
      onChange={({ website: trap, ...patch }) => { if (trap !== undefined) setWebsite(trap); setFlow((current) => ({ ...current, ...patch })); }}
      onSubmit={() => void submit()} onBack={() => move(back)}
      onSubmitWithoutInvite={error?.inviteGone ? () => void submit(false) : undefined}
      latestLink={error?.full ? <LastResultLink label={t("查看我的最新结果")} /> : undefined} />}
    {flow.step === "wants" && flow.submitted && <WantsStep wants={flow.wants} busy={busy} error={error?.text ?? null}
      onChange={(wants) => setFlow((current) => ({ ...current, wants }))}
      onSubmit={() => void sendWants()} onSkip={() => finish(flow.submitted!)} />}
  </>;
}

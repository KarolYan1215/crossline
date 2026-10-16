"use client";

import { useT } from "../locale-context";
import type { Answer, Identity, Project, Question } from "./onboarding-types";

/**
 * One question with its candidate answers as chips. People recognise their own situation in a list far more
 * easily than they recall it cold, so the interview offers many candidates; picking is one click, and the
 * box underneath is always there for anything the list did not think of.
 */
export function QuestionCard({ question, answer, onChange, identities, projects, disabled, hideText, hideOther }: {
  question: Question; answer: Answer; onChange: (next: Answer) => void;
  identities: Identity[]; projects: Project[]; disabled: boolean;
  /** A deep question shows its words in the conversation itself and takes its answer from the composer below (docs/onboarding-v3.md). */
  hideText?: boolean; hideOther?: boolean;
}) {
  const t = useT();
  const about = [identities.find((identity) => identity.id === question.identityId)?.label,
    projects.find((project) => project.id === question.projectId)?.name].filter(Boolean).join(" · ");
  const toggle = (id: string) => {
    const has = answer.picked.includes(id);
    onChange({ ...answer, picked: question.kind === "single" ? (has ? [] : [id]) : has ? answer.picked.filter((item) => item !== id) : [...answer.picked, id] });
  };
  return <fieldset className="ob-question" disabled={disabled}>
    <legend className={hideText ? "sr-only" : undefined}>{about && <span className="ob-about">{about}</span>}{question.text}</legend>
    {question.kind !== "free" && <div className="ob-chips" role={question.kind === "single" ? "radiogroup" : "group"}>
      {question.options.map((option) => <button key={option.id} type="button" title={option.detail || undefined}
        role={question.kind === "single" ? "radio" : "checkbox"} aria-checked={answer.picked.includes(option.id)}
        data-picked={answer.picked.includes(option.id)} onClick={() => toggle(option.id)}>
        {option.label}{option.detail && <small>{option.detail}</small>}
      </button>)}
    </div>}
    {!hideOther && (question.allowOther || question.kind === "free") && <input className="ob-other" value={answer.other} aria-label={t("{{question}} — 其他", { question: question.text })}
      placeholder={question.kind === "free" ? t("回答…") : t("其他（可不填）…")} onChange={(event) => onChange({ ...answer, other: event.target.value })} />}
  </fieldset>;
}

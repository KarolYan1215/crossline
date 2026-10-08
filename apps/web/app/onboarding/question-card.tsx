"use client";

import type { Answer, Identity, Project, Question } from "./onboarding-types";

/**
 * One question with its candidate answers as chips. People recognise their own situation in a list far more
 * easily than they recall it cold, so the interview offers many candidates; picking is one click, and the
 * box underneath is always there for anything the list did not think of.
 */
export function QuestionCard({ question, answer, onChange, identities, projects, disabled }: {
  question: Question; answer: Answer; onChange: (next: Answer) => void;
  identities: Identity[]; projects: Project[]; disabled: boolean;
}) {
  const about = [identities.find((identity) => identity.id === question.identityId)?.label,
    projects.find((project) => project.id === question.projectId)?.name].filter(Boolean).join(" · ");
  const toggle = (id: string) => {
    const has = answer.picked.includes(id);
    onChange({ ...answer, picked: question.kind === "single" ? (has ? [] : [id]) : has ? answer.picked.filter((item) => item !== id) : [...answer.picked, id] });
  };
  return <fieldset className="ob-question" disabled={disabled}>
    <legend>{about && <span className="ob-about">{about}</span>}{question.text}</legend>
    {question.kind !== "free" && <div className="ob-chips" role={question.kind === "single" ? "radiogroup" : "group"}>
      {question.options.map((option) => <button key={option.id} type="button" title={option.detail || undefined}
        role={question.kind === "single" ? "radio" : "checkbox"} aria-checked={answer.picked.includes(option.id)}
        data-picked={answer.picked.includes(option.id)} onClick={() => toggle(option.id)}>
        {option.label}{option.detail && <small>{option.detail}</small>}
      </button>)}
    </div>}
    {(question.allowOther || question.kind === "free") && <input className="ob-other" value={answer.other} aria-label={`${question.text} — 其他`}
      placeholder={question.kind === "free" ? "回答…" : "其他（可不填）…"} onChange={(event) => onChange({ ...answer, other: event.target.value })} />}
  </fieldset>;
}

import type { ReactNode } from "react";

export type StepState = "done" | "current" | "todo";
export type Step = { title: ReactNode; detail?: ReactNode; state?: StepState; action?: ReactNode };

/**
 * Numbered steps joined by a rail (2026-11-06): each step says whether it is done, the one to do now, or still ahead, and carries its own
 * button or link. Used where a connection takes several steps (the model sign-in, the person's own computer, every setup tutorial), so
 * the person sees where they are instead of reading a paragraph.
 */
export function Stepper({ steps, label }: { steps: Step[]; label?: string }) {
  return <ol className="ui-stepper" {...(label ? { "aria-label": label } : {})}>
    {steps.map((step, index) => <li key={index} data-state={step.state ?? "todo"} {...(step.state === "current" ? { "aria-current": "step" as const } : {})}>
      <span className="ui-stepper-mark" aria-hidden="true">{step.state === "done" ? "✓" : index + 1}</span>
      <div className="ui-stepper-body">
        <b>{step.title}</b>
        {step.detail && <small>{step.detail}</small>}
        {step.action && <div className="ui-stepper-action">{step.action}</div>}
      </div>
    </li>)}
  </ol>;
}

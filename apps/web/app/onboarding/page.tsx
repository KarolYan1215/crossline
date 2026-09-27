import { SubpageShell } from "../subpage-shell";
import { OnboardingForm } from "./onboarding-form";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

/**
 * The first-login interview `crossline-onboarding` was written for: a short questionnaire as the opening
 * turn, then a real multi-turn conversation on the same thread — the Skill digs into one identity at a
 * time until it can ground a specific, business-linked milestone, rather than a single free-text box
 * turned into a draft in one shot. Milestones still land as `draft` and relations as `candidate` through
 * the exact same propose-then-approve/batch-approve paths the Milestones page's own "让 AI 提议" and the
 * nightly flywheel scout already use. Not in the main nav — this is a rare, deliberate flow, not something
 * to click every day — reached from the Connectors page instead.
 */
export default async function OnboardingPage() {
  await requireSessionContext();
  return <SubpageShell eyebrow="首次设置" title="入职访谈"
    description="先答几个问题，AI 会一条主线一条主线地追问，挖出具体、和真实业务挂钩的里程碑与飞轮关系；一切仍以草稿/候选形式落地，批准是你的动作。">
    <OnboardingForm />
  </SubpageShell>;
}

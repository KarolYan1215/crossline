import { SubpageShell } from "../subpage-shell";
import { OnboardingForm } from "./onboarding-form";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

/**
 * The first-login interview `crossline-onboarding` was written for: three fixed questions, turned into
 * milestone drafts through the exact same propose-then-approve path the Milestones page's "让 AI 提议"
 * already uses. Not in the main nav — this is a one-time flow, not something to click every day — reached
 * from the Connectors page instead.
 */
export default async function OnboardingPage() {
  await requireSessionContext();
  return <SubpageShell eyebrow="首次设置" title="入职访谈"
    description="回答几个问题，AI 会提出可能的里程碑草案；一切仍以草稿形式落地，批准是你的动作。">
    <OnboardingForm />
  </SubpageShell>;
}

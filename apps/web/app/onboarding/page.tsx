import { SubpageShell } from "../subpage-shell";
import { OnboardingWorkspace } from "./onboarding-workspace";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

/**
 * Learning who you are, before anything is planned. A conversation (several questions at a time, with many
 * candidate answers to pick from) plus the files you already have, and — beside it — a live view of what has
 * been understood so far. Milestones are designed afterwards, from this profile.
 */
export default async function OnboardingPage() {
  await requireSessionContext();
  return <SubpageShell active="设置" eyebrow="首次设置" title="先了解你" description="聊几轮，或直接把你已有的文件拖进来；我会据此理解你的每条主线和项目。右侧是我目前的理解，随时可以改。">
    <OnboardingWorkspace />
  </SubpageShell>;
}

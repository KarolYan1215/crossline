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
  return <SubpageShell active="设置" eyebrow="首次设置" title="访谈" description="回答几轮问题，或直接拖入已有文件；据此整理每条主线与项目。右侧为当前画像，可随时修改。">
    <OnboardingWorkspace />
  </SubpageShell>;
}

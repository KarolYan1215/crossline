import { SubpageShell } from "../subpage-shell";
import { OnboardingWorkspace } from "./onboarding-workspace";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

/**
 * Learning who you are, before anything is planned. A conversation (several questions at a time, with many
 * candidate answers to pick from) plus the files you already have, and — beside it — a live view of what has
 * been understood so far. Milestones are designed afterwards, from this profile.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ line?: string }> }) {
  await requireSessionContext();
  const { line } = await searchParams;
  const valid = line && /^[a-z0-9-]{1,40}$/.test(line) ? line : undefined;
  return <SubpageShell active="设置" eyebrow={valid ? "主线访谈" : "首次设置"} title="访谈"
    description="先设定主线，再分阶段回答问题，可随时拖入已有文件。右侧为实时画像与各主线的长期目标候选。">
    <OnboardingWorkspace line={valid} />
  </SubpageShell>;
}

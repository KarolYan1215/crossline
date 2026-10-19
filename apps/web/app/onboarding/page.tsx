import { AppShell } from "../app-shell";
import { OnboardingWorkspace } from "./onboarding-workspace";
import "./onboarding-v3.css";
import { requireSessionContext } from "../../lib/access-guard";
import { startReadiness } from "../../lib/start-gate";

export const dynamic = "force-dynamic";

/**
 * Learning who someone is, before anything is planned (docs/onboarding-v3.md): materials and decisions on the left, the conversation in the
 * middle, and on the right what the answers are building. Until the start standard stands, the frame offers nothing else to go to.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ line?: string }> }) {
  const ctx = await requireSessionContext();
  const { line } = await searchParams;
  const valid = line && /^[a-z0-9-]{1,40}$/.test(line) ? line : undefined;
  // The frame opens once the person can use every page: the start standard stands and they confirmed it.
  const focus = !valid && !startReadiness(ctx).ready;
  return <AppShell active="设置" className="ob-page" focus={focus} corner={false}>
    <h1 className="sr-only">访谈</h1>
    <OnboardingWorkspace line={valid} />
  </AppShell>;
}

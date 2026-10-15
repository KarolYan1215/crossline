"use client";

import { TutorialView } from "../tutorial-view";
import { stepAnchor } from "../tutorial-model";

/** The reading page's tutorial: 回到步骤 goes to the step on the task's own page. */
export function TutorialStandalone({ workOrderId, building }: { workOrderId: string; building: boolean }) {
  return <TutorialView workOrderId={workOrderId} building={building} layout="page"
    stepHref={(stepId) => `/workbench/${encodeURIComponent(workOrderId)}#${stepAnchor(stepId)}`} />;
}

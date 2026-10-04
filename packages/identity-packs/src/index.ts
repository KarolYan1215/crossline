export type IdentityPack = {
  id: string;
  label: string;
  kind: "identity" | "capacity";
  masterClock: boolean;
  workflowTemplates: string[];
  evidencePolicy: "tiered" | "telemetry";
  /** What the weekly web research on this line is about. Absent means "external opportunities". */
  diligenceTopic?: "opportunities" | "positioning" | "literature" | "tracking_framework";
  durationPriors: Record<string, { p25Minutes: number; p50Minutes: number; p85Minutes: number }>;
};

const commonPriors = {
  preparation: { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 },
  review: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
  deep_work: { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 }
};

export function defaultIdentityPacks(): IdentityPack[] {
  return [
    {
      id: "research",
      label: "科研",
      kind: "identity",
      masterClock: true,
      workflowTemplates: ["paper-reading", "experiment-prep", "meeting-prep", "research-writing"],
      evidencePolicy: "tiered",
      diligenceTopic: "literature",
      durationPriors: commonPriors
    },
    {
      id: "startup",
      label: "创业",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["public-prospect-research", "outreach-draft", "milestone-review"],
      evidencePolicy: "tiered",
      diligenceTopic: "opportunities",
      durationPriors: commonPriors
    },
    {
      id: "media",
      label: "自媒体",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["evidence-to-topic", "script-package", "content-ops-job"],
      evidencePolicy: "tiered",
      diligenceTopic: "positioning",
      durationPriors: commonPriors
    },
    {
      id: "investment",
      label: "投资",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["pre-market-brief", "midday-check", "close-review"],
      evidencePolicy: "tiered",
      diligenceTopic: "tracking_framework",
      durationPriors: commonPriors
    },
    {
      id: "health",
      label: "健康容量",
      kind: "capacity",
      masterClock: false,
      workflowTemplates: ["training-window", "meal-prep", "minimum-recovery"],
      evidencePolicy: "telemetry",
      durationPriors: {
        preparation: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
        review: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15 }
      }
    }
  ];
}
